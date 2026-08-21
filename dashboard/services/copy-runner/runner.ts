import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { HyperliquidExecutionAdapter } from "../../app/lib/realtime/hyperliquid-execution";
import { RealtimeCopyEngine } from "../../app/lib/realtime/copy-engine";
import { HyperliquidClient, THIRTY_DAYS_MS } from "../../app/lib/hyperliquid";
import { buildOpenEpisodeReplay } from "../../app/lib/realtime/open-episode-replay";
import type { CopyRunnerConfig } from "./config";
import { CopyRunnerStore } from "./database";
import type { CopyEngineConfig } from "../../app/lib/copy-types";

const send = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 16_384) throw new Error("Control request is too large");
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("Control request must be a JSON object");
  return parsed as Record<string, unknown>;
};

export const LIVE_ARM_CONFIRMATION = "I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS";
const LIVE_ARM_TTL_MS = 60_000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export class StandaloneCopyRunner {
  private readonly store: CopyRunnerStore;
  private engine: RealtimeCopyEngine | undefined;
  private server: Server | undefined;
  private executionEnabled = false;
  private executionTestnet = true;
  private engineConfig: CopyEngineConfig;
  private sessionStopTimer: ReturnType<typeof setTimeout> | undefined;
  private liveArmedUntil = 0;

  constructor(private readonly config: CopyRunnerConfig) {
    this.store = new CopyRunnerStore(config.databasePath);
    this.engineConfig = config.engine;
    const execution = HyperliquidExecutionAdapter.fromEnvironment();
    this.executionEnabled = execution.enabled;
    this.executionTestnet = execution.testnet;
    execution.close?.();
  }

  async start(): Promise<void> {
    await this.listen();
    if (this.config.autoStart && !this.sessionExpired() && (this.engineConfig.mode ?? "SIMULATION") === "SIMULATION") await this.startEngine();
    else if (this.config.autoStart && (this.engineConfig.mode ?? "SIMULATION") === "HYPERLIQUID") {
      console.log("[copy-runner] live auto-start is disabled; a fresh server-side arm is required");
    }
    else if (this.config.autoStart && this.config.session) {
      console.log(`[copy-runner] configured session already ended at ${new Date(this.config.session.endsAtMs).toISOString()}; engine remains stopped`);
    }
    this.armSessionStop();
  }

  async startEngine(forceRestart = false): Promise<void> {
    if (this.sessionExpired()) {
      throw new Error(`Configured simulation session ended at ${new Date(this.config.session!.endsAtMs).toISOString()}`);
    }
    if (!forceRestart && this.engine?.snapshot().state === "RUNNING") return;
    if ((this.engineConfig.mode ?? "SIMULATION") === "HYPERLIQUID" && !this.liveArmed()) {
      throw new Error("Live Hyperliquid start requires a fresh server-side arm");
    }
    this.engine?.stop();
    const execution = HyperliquidExecutionAdapter.fromEnvironment();
    this.executionEnabled = execution.enabled;
    this.executionTestnet = execution.testnet;
    const initial = this.store.restoreEngineState();
    let preflight: { ok: boolean; reason?: string } = { ok: true };
    if ((this.engineConfig.mode ?? "SIMULATION") === "HYPERLIQUID") {
      preflight = execution.enabled
        ? await execution.preflight(this.engineConfig.whales.map((whale) => whale.address))
        : { ok: false, reason: "Hyperliquid server environment is disabled or incomplete" };
    }
    this.executionEnabled = execution.enabled && preflight.ok;
    // One shared, deliberately slow client prevents the per-whale engine
    // queues from bursting the public 30-day fill endpoint at startup.
    // `rateWeightMs` is multiplied by the endpoint's weight (20), so 75ms
    // yields a conservative 1.5s gap between these serialized requests.
    const replayHistoryClient = new HyperliquidClient({ retries: 6, rateWeightMs: 75 });
    let replayHistoryTail = Promise.resolve();
    const loadReplayHistory = async (address: string, startTime: number, endTime: number) => {
      let release: (() => void) | undefined;
      const turn = new Promise<void>((resolve) => { release = resolve; });
      const prior = replayHistoryTail;
      replayHistoryTail = turn;
      await prior;
      try {
        return await replayHistoryClient.unaggregatedUserFillsByTime(address, startTime, endTime);
      } finally {
        release?.();
      }
    };
    this.engine = new RealtimeCopyEngine({
      config: this.engineConfig,
      execution,
      auditSink: this.store,
      initialState: initial,
      openEpisodeReplayProvider: async ({ whale, cutoffAccountState, followerAllocationUsd, sourceAccountValueUsd }) => {
        const endTime = cutoffAccountState.receivedAt;
        const planForHistory = (history: Awaited<ReturnType<typeof loadReplayHistory>>) => buildOpenEpisodeReplay({
          sourcePositions: cutoffAccountState.positions.map((position) => ({
            coin: position.coin,
            szi: position.signedSize,
            entryPx: position.entryPriceUsd,
          })),
          // Planner validation treats missing fill identities as a block for
          // the affected residual rather than accepting a cast/guessed ID.
          fills: history.fills.map((fill) => ({
            coin: fill.coin,
            startPosition: fill.startPosition,
            side: fill.side,
            sz: fill.sz,
            px: fill.px,
            time: fill.time,
            hash: fill.hash ?? "",
            oid: fill.oid ?? "",
            tid: fill.tid ?? "",
            fee: fill.fee,
          })),
          followerAllocationUsd,
          sourceTotalEquityUsd: sourceAccountValueUsd,
        });
        const history30d = await loadReplayHistory(whale.address, endTime - THIRTY_DAYS_MS, endTime);
        if (!history30d.coverage.complete) {
          throw new Error(`Open-episode replay history is incomplete: ${history30d.coverage.reason ?? history30d.coverage.incompleteReason ?? "unknown coverage gap"}`);
        }
        const plan30d = planForHistory(history30d);
        if (plan30d.blocked.length === 0) return plan30d;

        // An open episode may predate 30 days. Retry once with a wider window
        // only after retaining the complete 30-day partial plan; a 90-day
        // timeout/429 must not discard already verified current coins.
        try {
          const history90d = await loadReplayHistory(whale.address, endTime - NINETY_DAYS_MS, endTime);
          return history90d.coverage.complete
            ? planForHistory(history90d)
            : plan30d;
        } catch {
          return plan30d;
        }
      },
    });
    if (!preflight.ok) this.engine.setKillSwitch(true);
    this.engine.start();
    if ((this.engineConfig.mode ?? "SIMULATION") === "HYPERLIQUID") this.liveArmedUntil = 0;
    if (!preflight.ok) console.error(`[copy-runner] startup reconciliation failed; kill switch enabled: ${preflight.reason}`);
    else console.log(`[copy-runner] engine started (${this.engineConfig.mode ?? "SIMULATION"}; Hyperliquid enabled=${execution.enabled}, testnet=${execution.testnet})`);
    this.armSessionStop();
  }

  async configureSimulationSizing(input: { marginPerWhaleUsd: number }): Promise<void> {
    if ((this.engineConfig.mode ?? "SIMULATION") !== "SIMULATION") throw new Error("Sizing can be changed here only in simulation mode");
    if (!Number.isFinite(input.marginPerWhaleUsd) || input.marginPerWhaleUsd < 1 || input.marginPerWhaleUsd > 100_000_000) {
      throw new Error("marginPerWhaleUsd must be between 1 and 100000000");
    }
    this.engineConfig = {
      ...this.engineConfig,
      sizing: {
        ...this.engineConfig.sizing,
        mode: "SOURCE_EQUITY_RATIO",
        followerCapitalUsd: input.marginPerWhaleUsd * this.engineConfig.whales.length,
      },
    };
    await this.startEngine(true);
  }

  stopEngine(): void {
    this.engine?.stop();
    this.liveArmedUntil = 0;
  }

  armLive(confirmation: unknown): number {
    if ((this.engineConfig.mode ?? "SIMULATION") !== "HYPERLIQUID") {
      throw new Error("The configured runner is not a Hyperliquid live runner");
    }
    if (confirmation !== LIVE_ARM_CONFIRMATION) throw new Error("Live arm confirmation is invalid");
    if (!this.executionEnabled) throw new Error("Hyperliquid execution credentials are disabled or incomplete");
    this.liveArmedUntil = Date.now() + LIVE_ARM_TTL_MS;
    return this.liveArmedUntil;
  }

  status(): Record<string, unknown> {
    const engineSnapshot = this.engine?.snapshot();
    const persistedOrders = this.store.recentMirroredOrders();
    const equityHistory = this.store.accountEquityHistory();
    // A prior process can leave an OPEN row behind while it was offline. Only
    // the new session's startup snapshot/order stream is authoritative for open
    // orders; completed historical rows remain available from SQLite.
    const persistedHistory = persistedOrders.filter((order) => order.status !== "OPEN");
    const mirroredOrders = engineSnapshot
      ? [...new Map([...persistedHistory, ...engineSnapshot.mirroredOrders].map((order) => [order.id, order])).values()]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 500)
      : persistedOrders;
    return {
      databasePath: this.config.databasePath,
      canonical: this.config.canonical,
      engine: engineSnapshot ? { ...engineSnapshot, mirroredOrders, equityHistory } : null,
      executionEnabled: this.executionEnabled,
      liveArmed: this.liveArmed(),
      liveArmExpiresAt: this.liveArmed() ? this.liveArmedUntil : null,
      testnet: this.executionTestnet,
      session: this.config.session ? {
        startedAtMs: this.config.session.startedAtMs,
        startedAt: new Date(this.config.session.startedAtMs).toISOString(),
        endsAtMs: this.config.session.endsAtMs,
        endsAt: new Date(this.config.session.endsAtMs).toISOString(),
        expired: this.sessionExpired(),
        remainingMs: Math.max(0, this.config.session.endsAtMs - Date.now()),
      } : null,
      expectedPositions: this.store.expectedPositions(),
      unresolvedOrders: this.store.unresolvedOrders(),
    };
  }

  async close(): Promise<void> {
    if (this.sessionStopTimer) clearTimeout(this.sessionStopTimer);
    this.sessionStopTimer = undefined;
    this.stopEngine();
    if (this.server) await new Promise<void>((resolve, reject) => this.server?.close((error) => error ? reject(error) : resolve()));
    this.server = undefined;
    this.store.close();
  }

  private async listen(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.config.port, this.config.host, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
    console.log(`[copy-runner] control server listening on http://${this.config.host}:${this.config.port}`);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET" && request.url === "/health") {
      send(response, 200, { ok: true });
      return;
    }
    if (!this.authorized(request)) {
      send(response, 401, { error: "Unauthorized" });
      return;
    }
    if (request.method === "GET" && request.url === "/status") {
      send(response, 200, this.status());
      return;
    }
    if (request.method !== "POST") {
      send(response, 404, { error: "Not found" });
      return;
    }
    try {
      if (request.url === "/start") {
        await this.startEngine();
        send(response, 200, this.status());
      } else if (request.url === "/arm") {
        const body = await readJson(request);
        this.armLive(body.confirmation);
        send(response, 200, this.status());
      } else if (request.url === "/stop") {
        this.stopEngine();
        send(response, 200, this.status());
      } else if (request.url === "/kill") {
        const body = await readJson(request);
        if (typeof body.enabled !== "boolean") throw new Error("enabled must be a boolean");
        this.engine?.setKillSwitch(body.enabled);
        send(response, 200, this.status());
      } else if (request.url === "/configure") {
        const body = await readJson(request);
        const marginPerWhaleUsd = Number(body.marginPerWhaleUsd);
        await this.configureSimulationSizing({ marginPerWhaleUsd });
        send(response, 200, this.status());
      } else {
        send(response, 404, { error: "Not found" });
      }
    } catch (error) {
      send(response, 400, { error: error instanceof Error ? error.message : "Control request failed" });
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const header = request.headers["x-copy-runner-control-token"];
    const received = Array.isArray(header) ? header[0] : header;
    if (!received) return false;
    const expectedBytes = Buffer.from(this.config.controlToken);
    const receivedBytes = Buffer.from(received);
    return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
  }

  private sessionExpired(): boolean {
    return Boolean(this.config.session && Date.now() >= this.config.session.endsAtMs);
  }

  private liveArmed(): boolean {
    return this.liveArmedUntil > Date.now();
  }

  private armSessionStop(): void {
    if (this.sessionStopTimer) clearTimeout(this.sessionStopTimer);
    this.sessionStopTimer = undefined;
    if (!this.config.session) return;
    const remainingMs = this.config.session.endsAtMs - Date.now();
    if (remainingMs <= 0) {
      this.stopEngine();
      return;
    }
    const maximumTimerMs = 2_147_483_647;
    this.sessionStopTimer = setTimeout(() => {
      this.sessionStopTimer = undefined;
      if (this.sessionExpired()) {
        console.log(`[copy-runner] simulation session ended at ${new Date(this.config.session!.endsAtMs).toISOString()}; stopping engine`);
        this.stopEngine();
      } else {
        this.armSessionStop();
      }
    }, Math.min(remainingMs, maximumTimerMs));
    this.sessionStopTimer.unref?.();
  }
}
