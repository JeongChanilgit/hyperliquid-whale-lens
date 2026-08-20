import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { HyperliquidUserFillsMonitor } from "./hyperliquid-ws";
import type {
  HyperliquidCloneOrderRequest,
  HyperliquidCloneResult,
  HyperliquidExecutionPort,
} from "../copy-types";

const ADDRESS = /^0x[a-f0-9]{40}$/;
const PRIVATE_KEY = /^0x[a-fA-F0-9]{64}$/;
const CLIENT_ORDER_ID = /^0x[a-f0-9]{32}$/;
const DEFAULT_BRIDGE = fileURLToPath(new URL("../../../services/copy-runner/hyperliquid_bridge.py", import.meta.url));

interface TargetAccount {
  accountAddress: string;
  vaultAddress?: string;
}

interface BridgeReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingReply {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface HyperliquidExecutionOptions {
  testnet: boolean;
  agentPrivateKey: string;
  masterAccountAddress: string;
  targets: Record<string, TargetAccount>;
  pythonPath?: string;
  bridgePath?: string;
  requestTimeoutMs?: number;
  catchUpSlippage?: number;
}

const normaliseAddress = (value: string): string => value.trim().toLowerCase();

const parseTargets = (raw: string, masterAccountAddress: string): Record<string, TargetAccount> => {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new Error("HYPERLIQUID_TARGETS_JSON must be valid JSON"); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("HYPERLIQUID_TARGETS_JSON must be an object keyed by source whale");
  const targets: Record<string, TargetAccount> = {};
  for (const [sourceRaw, targetRaw] of Object.entries(decoded as Record<string, unknown>)) {
    const source = normaliseAddress(sourceRaw);
    if (!ADDRESS.test(source)) throw new Error(`Invalid source whale in HYPERLIQUID_TARGETS_JSON: ${sourceRaw}`);
    const targetRecord = targetRaw && typeof targetRaw === "object" && !Array.isArray(targetRaw)
      ? targetRaw as Record<string, unknown>
      : undefined;
    const accountAddress = normaliseAddress(typeof targetRaw === "string"
      ? targetRaw
      : typeof targetRecord?.accountAddress === "string" ? targetRecord.accountAddress : "");
    const vaultAddress = normaliseAddress(typeof targetRaw === "string"
      ? accountAddress === masterAccountAddress ? "" : accountAddress
      : typeof targetRecord?.vaultAddress === "string" ? targetRecord.vaultAddress : "");
    if (!ADDRESS.test(accountAddress)) throw new Error(`Invalid target account for ${source}`);
    if (vaultAddress && !ADDRESS.test(vaultAddress)) throw new Error(`Invalid target subaccount for ${source}`);
    if (vaultAddress && accountAddress !== vaultAddress) {
      throw new Error(`Target account and vault/subaccount must be the same address for ${source}`);
    }
    if (!vaultAddress && accountAddress !== masterAccountAddress) {
      throw new Error(`Direct target for ${source} must be the configured master account; use vaultAddress for a subaccount or vault`);
    }
    targets[source] = { accountAddress, ...(vaultAddress ? { vaultAddress } : {}) };
  }
  const accountAddresses = Object.values(targets).map((target) => target.accountAddress);
  if (new Set(accountAddresses).size !== accountAddresses.length) throw new Error("Every whale must map to a distinct Hyperliquid target account/subaccount");
  return targets;
};

const pythonDefault = (): string => {
  const local = resolve(process.cwd(), ".venv", "Scripts", "python.exe");
  return existsSync(local) ? local : "python";
};

export const hyperliquidClientOrderId = (sourceWhale: string, sourceOid: string): string =>
  `0x${createHash("sha256").update(`${normaliseAddress(sourceWhale)}|${sourceOid}`).digest("hex").slice(0, 32)}`;

class JsonLineBridge {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingReply>();
  private stderr = "";
  private closed = false;

  constructor(private readonly options: HyperliquidExecutionOptions) {}

  async request(payload: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error("Hyperliquid execution bridge is closed");
    const child = this.ensureStarted();
    const id = this.nextId++;
    return new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Hyperliquid execution bridge timed out"));
      }, this.options.requestTimeoutMs ?? 15_000);
      this.pending.set(id, { resolve: resolveReply, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  close(): void {
    this.closed = true;
    const error = new Error("Hyperliquid execution bridge closed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.child?.kill();
    this.child = undefined;
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.options.pythonPath ?? pythonDefault(), [this.options.bridgePath ?? DEFAULT_BRIDGE], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        HL_AGENT_PRIVATE_KEY: this.options.agentPrivateKey,
        HL_MASTER_ACCOUNT_ADDRESS: this.options.masterAccountAddress,
        HL_TARGETS_JSON: JSON.stringify(this.options.targets),
        HL_TESTNET: String(this.options.testnet),
        HL_CATCHUP_SLIPPAGE: String(this.options.catchUpSlippage ?? 0.05),
      },
    });
    this.child = child;
    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => this.onLine(line));
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-4_000);
    });
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code) => {
      this.child = undefined;
      if (!this.closed) this.failAll(new Error(`Hyperliquid execution bridge exited (${code ?? "unknown"})${this.stderr ? `: ${this.stderr.trim()}` : ""}`));
    });
    return child;
  }

  private onLine(line: string): void {
    let reply: BridgeReply;
    try { reply = JSON.parse(line) as BridgeReply; }
    catch { return; }
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(reply.id);
    if (reply.ok) pending.resolve(reply.result);
    else pending.reject(new Error(reply.error || "Hyperliquid execution bridge rejected the request"));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class DisabledHyperliquidExecutionAdapter implements HyperliquidExecutionPort {
  readonly enabled = false;
  readonly testnet = true;
  constructor(readonly reason = "Hyperliquid execution is disabled") {}
  async preflight(): Promise<{ ok: boolean; reason: string }> { return { ok: false, reason: this.reason }; }
  followerAccountState(): undefined { return undefined; }
  async cloneOrder(request: HyperliquidCloneOrderRequest): Promise<HyperliquidCloneResult> {
    return { accepted: false, clientOrderId: request.clientOrderId, error: this.reason };
  }
  async settleFilledOrder(request: HyperliquidCloneOrderRequest): Promise<HyperliquidCloneResult> {
    return { accepted: false, clientOrderId: request.clientOrderId, error: this.reason };
  }
}

export class HyperliquidExecutionAdapter implements HyperliquidExecutionPort {
  readonly enabled = true;
  readonly testnet: boolean;
  private readonly bridge: JsonLineBridge;
  private readonly targets: Record<string, TargetAccount>;
  private readonly followerStates = new Map<string, { accountValueUsd: number; receivedAt: number }>();
  private targetStateMonitor: HyperliquidUserFillsMonitor | undefined;

  constructor(private readonly options: HyperliquidExecutionOptions) {
    this.testnet = options.testnet;
    this.targets = options.targets;
    this.bridge = new JsonLineBridge(options);
  }

  static fromEnvironment(env: Record<string, string | undefined> = process.env): HyperliquidExecutionPort {
    if (env.HYPERLIQUID_ENABLED !== "true") return new DisabledHyperliquidExecutionAdapter();
    const testnet = env.HYPERLIQUID_TESTNET !== "false";
    if (!testnet && env.HYPERLIQUID_PRODUCTION_CONFIRMED !== "I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS") {
      return new DisabledHyperliquidExecutionAdapter("Hyperliquid mainnet requires explicit production confirmation");
    }
    const agentPrivateKey = env.HYPERLIQUID_AGENT_PRIVATE_KEY?.trim() ?? "";
    const masterAccountAddress = normaliseAddress(env.HYPERLIQUID_MASTER_ACCOUNT_ADDRESS ?? "");
    if (!PRIVATE_KEY.test(agentPrivateKey)) throw new Error("HYPERLIQUID_AGENT_PRIVATE_KEY is missing or invalid");
    if (!ADDRESS.test(masterAccountAddress)) throw new Error("HYPERLIQUID_MASTER_ACCOUNT_ADDRESS is missing or invalid");
    const targets = parseTargets(env.HYPERLIQUID_TARGETS_JSON ?? "", masterAccountAddress);
    if (Object.keys(targets).length === 0) throw new Error("HYPERLIQUID_TARGETS_JSON must map every source whale to a target account");
    const catchUpSlippage = Number(env.HYPERLIQUID_CATCHUP_SLIPPAGE ?? 0.05);
    if (!Number.isFinite(catchUpSlippage) || catchUpSlippage <= 0 || catchUpSlippage > 0.25) {
      throw new Error("HYPERLIQUID_CATCHUP_SLIPPAGE must be in (0, 0.25]");
    }
    return new HyperliquidExecutionAdapter({
      testnet,
      agentPrivateKey,
      masterAccountAddress,
      targets,
      ...(env.HYPERLIQUID_PYTHON?.trim() ? { pythonPath: env.HYPERLIQUID_PYTHON.trim() } : {}),
      ...(env.HYPERLIQUID_BRIDGE_PATH?.trim() ? { bridgePath: env.HYPERLIQUID_BRIDGE_PATH.trim() } : {}),
      catchUpSlippage,
    });
  }

  async preflight(sourceWhales: string[]): Promise<{ ok: boolean; reason?: string; targets?: Record<string, { accountValueUsd: number }> }> {
    const sources = sourceWhales.map(normaliseAddress);
    const missing = sources.filter((source) => !this.targets[source]);
    const extra = Object.keys(this.targets).filter((source) => !sources.includes(source));
    if (missing.length > 0 || extra.length > 0) return { ok: false, reason: "Hyperliquid target mapping must exactly match the monitored whales" };
    try {
      const result = await this.bridge.request({ op: "preflight", sourceWhales: sources }) as { targets?: Record<string, { accountValueUsd?: unknown }> };
      const targets = Object.fromEntries(Object.entries(result.targets ?? {}).map(([source, target]) => [source, { accountValueUsd: Number(target.accountValueUsd) }]));
      const unfunded = Object.entries(targets).find(([, target]) => !Number.isFinite(target.accountValueUsd) || target.accountValueUsd <= 0);
      if (unfunded) return { ok: false, reason: `Target account for ${unfunded[0]} has no usable perp account value` };
      const now = Date.now();
      for (const [source, target] of Object.entries(targets)) this.followerStates.set(source, { accountValueUsd: target.accountValueUsd, receivedAt: now });
      this.startTargetStateMonitor();
      return { ok: true, targets };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "Hyperliquid preflight failed" };
    }
  }

  followerAccountState(sourceWhale: string): { accountValueUsd: number; receivedAt: number } | undefined {
    return this.followerStates.get(normaliseAddress(sourceWhale));
  }

  async cloneOrder(request: HyperliquidCloneOrderRequest): Promise<HyperliquidCloneResult> {
    this.validate(request);
    try {
      const result = await this.bridge.request({ op: "cloneOrder", request }) as HyperliquidCloneResult;
      return { ...result, clientOrderId: request.clientOrderId };
    } catch (error) {
      return { accepted: false, clientOrderId: request.clientOrderId, error: error instanceof Error ? error.message : "Hyperliquid clone failed" };
    }
  }

  async settleFilledOrder(request: HyperliquidCloneOrderRequest): Promise<HyperliquidCloneResult> {
    this.validate(request);
    try {
      const result = await this.bridge.request({ op: "settleFilledOrder", request }) as HyperliquidCloneResult;
      return { ...result, clientOrderId: request.clientOrderId };
    } catch (error) {
      return { accepted: false, clientOrderId: request.clientOrderId, error: error instanceof Error ? error.message : "Hyperliquid one-second fill settlement failed" };
    }
  }

  close(): void {
    this.targetStateMonitor?.stop();
    this.targetStateMonitor = undefined;
    this.bridge.close();
  }

  private startTargetStateMonitor(): void {
    if (this.targetStateMonitor) return;
    const sourceByTarget = new Map(Object.entries(this.targets).map(([source, target]) => [target.accountAddress, source]));
    const monitor = new HyperliquidUserFillsMonitor({
      whales: [...sourceByTarget.keys()],
      includeFills: false,
      includeOrderUpdates: false,
      includePortfolioAccountValue: false,
    });
    monitor.subscribe((event) => {
      // Heartbeats prove only that the socket transport is alive. They must not
      // make an old target equity snapshot pass the live sizing freshness gate.
      if (event.type === "heartbeat") return;
      if (event.type === "accountState" && event.whale && event.accountState) {
        const source = sourceByTarget.get(normaliseAddress(event.whale));
        if (source) this.followerStates.set(source, { accountValueUsd: event.accountState.accountValueUsd, receivedAt: event.accountState.receivedAt });
      }
    });
    monitor.start();
    this.targetStateMonitor = monitor;
  }

  private validate(request: HyperliquidCloneOrderRequest): void {
    const source = normaliseAddress(request.sourceWhale);
    if (!this.targets[source]) throw new Error(`No target Hyperliquid account is mapped for ${source}`);
    if (!CLIENT_ORDER_ID.test(request.clientOrderId)) throw new Error("Hyperliquid cloid must be a 128-bit lowercase hex string");
    if (!request.coin || !Number.isFinite(request.quantity) || request.quantity <= 0 || !Number.isFinite(request.price) || request.price <= 0) {
      throw new Error("Hyperliquid clone request has invalid coin, quantity, or price");
    }
    if (request.action !== "CANCEL" && !request.reduceOnly && !request.leverage) throw new Error("An exact source leverage setting is required before an entry order can be cloned");
  }
}
