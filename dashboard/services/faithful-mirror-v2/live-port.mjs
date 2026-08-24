import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalTargetCloid, normalizeAddress, normalizeCoin, positionSizeForCoin } from "./domain.mjs";

const PRIVATE_KEY = /^0x[a-f0-9]{64}$/i;
const MAINNET_CONFIRMATION = "I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS";
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BRIDGE_PATH = resolve(HERE, "hyperliquid_pair_bridge.py");

const actionPayload = (response) => {
  if (response?.type === "action") return response.payload;
  return response?.payload ?? response;
};

const actionStatus = (response) => {
  const payload = actionPayload(response);
  if (!payload || payload.status !== "ok") return { accepted: false, status: String(payload?.status ?? "rejected"), error: payload?.response ?? payload };
  const statuses = payload.response?.data?.statuses ?? [];
  const rejected = statuses.find((status) => status?.error);
  return rejected
    ? { accepted: false, status: "rejected", error: rejected.error, statuses }
    : { accepted: true, status: "ok", statuses };
};

export class JsonLineSignerBridge {
  constructor({ pythonPath = process.env.FMV2_PYTHON ?? "python", bridgePath = process.env.FMV2_BRIDGE_PATH ?? DEFAULT_BRIDGE_PATH, environment = process.env }) {
    this.pythonPath = pythonPath;
    this.bridgePath = bridgePath;
    this.environment = environment;
    this.child = null;
    this.reader = null;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.stderr = "";
  }

  async request(operation, payload = {}) {
    if (this.closed) throw new Error("Signer bridge is closed");
    const child = this.#ensureChild();
    const id = this.nextId++;
    return new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Signer bridge timeout for ${operation}`));
      }, 15_000);
      this.pending.set(id, { resolve: resolveReply, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, operation, payload })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close() {
    this.closed = true;
    this.reader?.close();
    this.child?.kill();
    const error = new Error("Signer bridge closed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #ensureChild() {
    if (this.child) return this.child;
    const child = spawn(this.pythonPath, [this.bridgePath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...this.environment, PYTHONUNBUFFERED: "1" },
    });
    this.child = child;
    this.reader = createInterface({ input: child.stdout });
    this.reader.on("line", (line) => {
      let reply;
      try { reply = JSON.parse(line); }
      catch { return; }
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.result);
      else pending.reject(new Error(reply.error ?? "Signer bridge rejected request"));
    });
    child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${String(chunk)}`.slice(-8_000); });
    child.once("exit", (code) => {
      this.child = null;
      if (this.closed) return;
      const error = new Error(`Signer bridge exited (${code ?? "unknown"})${this.stderr ? `: ${this.stderr}` : ""}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
    child.once("error", (error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
    return child;
  }
}

export class HyperliquidLiveExecutionPort {
  constructor({ pairId, sourceAddress, targetAddress, bridge, log = () => {} }) {
    this.pairId = String(pairId);
    this.sourceAddress = normalizeAddress(sourceAddress);
    this.targetAddress = normalizeAddress(targetAddress);
    this.bridge = bridge;
    this.log = log;
    this.transport = null;
    this.targetSnapshot = null;
    this.orders = new Map();
    this.killSwitch = false;
    this.positionSideByCoin = new Map();
    this.recoveredSourceOrderByCloid = new Map();
  }

  static fromEnvironment({ pairId, sourceAddress, targetAddress, index, testnet, log = () => {} }) {
    const agentPrivateKey = String(process.env[`FMV2_AGENT_PRIVATE_KEY_${index + 1}`] ?? "").trim();
    const masterAccountAddress = normalizeAddress(process.env.FMV2_MASTER_ACCOUNT_ADDRESS ?? "");
    if (!PRIVATE_KEY.test(agentPrivateKey)) throw new Error(`FMV2_AGENT_PRIVATE_KEY_${index + 1} is missing or invalid`);
    if (!testnet && process.env.FMV2_PRODUCTION_CONFIRMED !== MAINNET_CONFIRMATION) {
      throw new Error(`Mainnet requires FMV2_PRODUCTION_CONFIRMED=${MAINNET_CONFIRMATION}`);
    }
    const bridge = new JsonLineSignerBridge({
      environment: {
        ...process.env,
        FMV2_AGENT_PRIVATE_KEY: agentPrivateKey,
        FMV2_MASTER_ACCOUNT_ADDRESS: masterAccountAddress,
        FMV2_TARGET_ACCOUNT_ADDRESS: normalizeAddress(targetAddress),
        FMV2_TESTNET: String(Boolean(testnet)),
      },
    });
    return new HyperliquidLiveExecutionPort({ pairId, sourceAddress, targetAddress, bridge, log });
  }

  attachActionTransport(transport) {
    if (!transport || typeof transport.postAction !== "function") throw new Error("Live port requires a target-socket action transport");
    this.transport = transport;
  }

  restoreOrderOwnership({ sourceOrderToTargetCloid } = {}) {
    if (!sourceOrderToTargetCloid || typeof sourceOrderToTargetCloid !== "object" || Array.isArray(sourceOrderToTargetCloid)) {
      throw new Error(`Live recovery order mapping is required for ${this.pairId}`);
    }
    const next = new Map();
    for (const [rawSourceOrderId, rawTargetCloid] of Object.entries(sourceOrderToTargetCloid)) {
      const sourceOrderId = String(rawSourceOrderId);
      const targetCloid = String(rawTargetCloid);
      if (!sourceOrderId || !targetCloid || targetCloid !== canonicalTargetCloid(this.pairId, sourceOrderId)) {
        throw new Error(`Live recovery target Cloid is non-canonical for ${this.pairId}/${sourceOrderId || "<missing>"}`);
      }
      next.set(targetCloid, sourceOrderId);
    }
    this.recoveredSourceOrderByCloid = next;
    return { accepted: true, recoveredOrders: next.size };
  }

  async registerPair({ targetSnapshot = null } = {}) {
    this.targetSnapshot = targetSnapshot == null ? null : structuredClone(targetSnapshot);
    for (const position of targetSnapshot?.positions ?? []) {
      const size = Number(position.signedSize);
      if (Number.isFinite(size) && Math.abs(size) > 1e-12) this.positionSideByCoin.set(normalizeCoin(position.coin), size > 0);
    }
    const result = await this.bridge.request("preflight", { sourceAddress: this.sourceAddress, targetAddress: this.targetAddress });
    if (!result?.ok) throw new Error(result?.error ?? `Live preflight failed for ${this.pairId}`);
    const observedRecoveredCloids = new Set();
    for (const order of result.openOrders ?? []) {
      const cloid = order?.cloid ?? order?.clientOrderId;
      const sourceOrderId = cloid == null ? null : this.recoveredSourceOrderByCloid.get(String(cloid));
      if (sourceOrderId) {
        const targetOrderId = String(cloid);
        observedRecoveredCloids.add(targetOrderId);
        this.orders.set(targetOrderId, {
          sourceOrderId,
          targetOrderId,
          exchangeOrderId: order.oid == null ? null : String(order.oid),
          order: structuredClone(order),
          status: String(order.status ?? "OPEN").toUpperCase(),
        });
        continue;
      }
      const signed = await this.bridge.request("signCancelOrder", { coin: order.coin, oid: order.oid, cloid: order.cloid });
      const response = await this.#post(signed);
      const status = actionStatus(response);
      if (!status.accepted) throw new Error(`Unable to clean existing target order for ${this.pairId}: ${JSON.stringify(status.error)}`);
    }
    for (const targetCloid of this.recoveredSourceOrderByCloid.keys()) {
      if (!observedRecoveredCloids.has(targetCloid)) throw new Error(`Recovered target Cloid was not observed during live preflight for ${this.pairId}: ${targetCloid}`);
    }
    return { accepted: true };
  }

  onTargetOrder({ update }) {
    this.#rememberPositionSideFromFill(update?.fill ?? update);
    this.#rememberPositionSideFromFill(update?.order?.fill ?? update?.order);
    const targetOrderId = update.targetOrderId ?? update.order?.clientOrderId;
    if (!targetOrderId) return;
    const prior = this.orders.get(String(targetOrderId)) ?? {};
    this.orders.set(String(targetOrderId), { ...prior, ...structuredClone(update), targetOrderId: String(targetOrderId), status: String(update.status ?? "UNKNOWN").toUpperCase() });
  }

  onTargetFill({ fill }) {
    this.#rememberPositionSideFromFill(fill);
  }

  onTargetSnapshot(snapshot) {
    this.targetSnapshot = structuredClone(snapshot);
    for (const position of snapshot?.positions ?? []) this.#rememberPositionSideFromFill(position);
  }

  async setLeverage({ coin, leverage }) {
    this.#requireLive();
    const signed = await this.bridge.request("signSetLeverage", { coin: normalizeCoin(coin), leverage });
    const response = await this.#post(signed);
    const status = actionStatus(response);
    this.log({ type: "LIVE_SET_LEVERAGE", pairId: this.pairId, coin: normalizeCoin(coin), leverage, accepted: status.accepted, at: Date.now() });
    return status;
  }

  async adjustIsolatedMargin({ coin, marginDeltaUsd, targetMarginUsd, isBuy = null, positionSide = null }) {
    this.#requireLive();
    const normalized = normalizeCoin(coin);
    const inferredIsBuy = typeof isBuy === "boolean" ? isBuy : this.positionSideByCoin.get(normalized);
    if (typeof inferredIsBuy !== "boolean") throw new Error(`Cannot determine isolated position side for ${normalized}`);
    const signed = await this.bridge.request("signAdjustIsolatedMargin", {
      coin: normalized,
      marginDeltaUsd,
      targetMarginUsd,
      isBuy: inferredIsBuy,
      positionSide: positionSide ?? (inferredIsBuy ? "LONG" : "SHORT"),
    });
    const response = await this.#post(signed);
    const status = actionStatus(response);
    return { ...status, marginUsedUsd: status.accepted ? Number(targetMarginUsd) : null };
  }

  async upsertOrder({ sourceOrderId, targetOrderId, order }) {
    this.#requireLive();
    const current = this.orders.get(String(targetOrderId));
    const signed = await this.bridge.request("signUpsertOrder", {
      sourceOrderId,
      targetOrderId,
      existingOid: current?.exchangeOrderId ?? current?.order?.id ?? null,
      order,
    });
    const response = await this.#post(signed);
    const status = actionStatus(response);
    if (status.accepted) {
      const resting = status.statuses.find((item) => item?.resting)?.resting;
      const filled = status.statuses.find((item) => item?.filled)?.filled;
      this.#rememberPositionSideFromFill(filled);
      this.orders.set(String(targetOrderId), {
        sourceOrderId,
        targetOrderId: String(targetOrderId),
        exchangeOrderId: String(resting?.oid ?? filled?.oid ?? current?.exchangeOrderId ?? ""),
        order: structuredClone(order),
        status: resting ? "OPEN" : filled ? "FILLED" : "ACCEPTED",
      });
    }
    return { ...status, targetOrderId: String(targetOrderId) };
  }

  async cancelOrder({ targetOrderId }) {
    this.#requireLive();
    const current = this.orders.get(String(targetOrderId));
    if (!current) return { accepted: true, status: "ALREADY_TERMINAL" };
    const signed = await this.bridge.request("signCancelOrder", {
      coin: current.order?.coin ?? current.coin,
      oid: current.exchangeOrderId ?? current.order?.id ?? null,
      cloid: String(targetOrderId),
    });
    const response = await this.#post(signed);
    const status = actionStatus(response);
    if (status.accepted) this.orders.delete(String(targetOrderId));
    return status;
  }

  async protectedIoc({ coin, deltaSize, markPriceUsd, maxSlippageBps, desiredSignedSize, actualSignedSize, reduceOnly, leverage }) {
    this.#requireLive();
    const normalized = normalizeCoin(coin);
    const signed = await this.bridge.request("signProtectedIoc", {
      coin: normalized,
      deltaSize,
      markPriceUsd,
      maxSlippageBps,
      reduceOnly,
      leverage,
    });
    const response = await this.#post(signed);
    const status = actionStatus(response);
    const filled = status.statuses.find((item) => item?.filled)?.filled;
    const filledSize = Math.abs(Number(filled?.totalSz ?? filled?.sz ?? 0));
    const direction = Math.sign(Number(deltaSize));
    const nextActual = Number(actualSignedSize) + direction * filledSize;
    if (Math.abs(nextActual) > 1e-12) this.positionSideByCoin.set(normalized, nextActual > 0);
    this.log({
      type: "LIVE_CATCH_UP",
      pairId: this.pairId,
      coin: normalized,
      desiredSignedSize,
      actualSignedSize,
      nextActualSignedSize: nextActual,
      filledSize,
      averagePrice: Number(filled?.avgPx ?? 0) || null,
      accepted: status.accepted,
      at: Date.now(),
    });
    return {
      ...status,
      filledSize,
      unfilledSize: Math.max(0, Math.abs(Number(deltaSize)) - filledSize),
      averagePrice: Number(filled?.avgPx ?? 0) || null,
      actualSignedSize: nextActual,
    };
  }

  async onUnresolvedResidual(payload) {
    this.killSwitch = payload.killSwitchRequested === true;
    this.log({ type: "LIVE_UNRESOLVED_RESIDUAL", pairId: this.pairId, ...payload, at: Date.now() });
    return { accepted: true, killSwitch: this.killSwitch };
  }

  close() {
    this.bridge.close();
  }

  async #post(signed) {
    this.#requireLive();
    const payload = signed?.signedPayload ?? signed;
    if (!payload?.action || !payload?.signature || !Number.isFinite(Number(payload?.nonce))) throw new Error("Signer bridge returned an invalid signed action payload");
    return this.transport.postAction(payload);
  }

  #requireLive() {
    if (this.killSwitch) throw new Error(`Faithful Mirror V2 kill switch is enabled for ${this.pairId}`);
    if (!this.transport) throw new Error(`Target action transport is not attached for ${this.pairId}`);
  }

  #rememberPositionSideFromFill(value) {
    if (!value || typeof value !== "object") return false;
    const rawCoin = value.coin ?? value.asset ?? value.order?.coin;
    if (typeof rawCoin !== "string") return false;
    const explicitAfter = Number(value.positionAfter ?? value.signedSize ?? value.szi ?? value.position?.szi);
    let signedSize = explicitAfter;
    if (!Number.isFinite(signedSize)) {
      const start = Number(value.startPosition);
      const size = Number(value.size ?? value.sz ?? value.totalSz);
      const side = String(value.side ?? value.dir ?? value.order?.side ?? "").toUpperCase();
      if (Number.isFinite(start) && Number.isFinite(size) && size > 0 && (side === "B" || side === "BUY" || side === "A" || side === "SELL")) {
        signedSize = start + ((side === "B" || side === "BUY") ? size : -size);
      }
    }
    if (!Number.isFinite(signedSize) || Math.abs(signedSize) <= 1e-12) return false;
    this.positionSideByCoin.set(normalizeCoin(rawCoin), signedSize > 0);
    return true;
  }
}

export const targetPositionFromSnapshot = (snapshot, coin) => positionSizeForCoin(snapshot, normalizeCoin(coin));
