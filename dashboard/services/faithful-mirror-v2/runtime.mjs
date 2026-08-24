import { setTimeout as delay } from "node:timers/promises";
import { FiveWhaleFaithfulMirrorEngine } from "./engine.mjs";
import { canonicalTargetCloid, normalizeAddress, normalizeCoin } from "./domain.mjs";

const MAINNET_INFO = "https://api.hyperliquid.xyz/info";
const TESTNET_INFO = "https://api.hyperliquid-testnet.xyz/info";
const MAINNET_WS = "wss://api.hyperliquid.xyz/ws";
const TESTNET_WS = "wss://api.hyperliquid-testnet.xyz/ws";
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const asNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const valueAt = (value, key, fallback = null) => record(value)?.[key] ?? fallback;
const orderStatusOpen = (status) => ["open", "resting", "partial", "triggered", "pending"].includes(String(status ?? "open").toLowerCase());
const DEFAULT_FILL_DEDUP_MAX = 100_000;
const DEFAULT_FILL_DEDUP_AGE_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_LEVERAGE_CACHE_TTL_MS = 5 * 60 * 1_000;

export const normalizeSide = (value) => {
  const side = String(value ?? "").trim().toUpperCase();
  if (side === "B" || side === "BUY") return "BUY";
  if (side === "A" || side === "SELL") return "SELL";
  return null;
};

/**
 * Bounded insertion-order fill deduplication.  It deliberately never clears
 * the whole window: doing so can replay an entire reconnect overlap.
 */
export class BoundedFillDeduper {
  constructor({ maxEntries = DEFAULT_FILL_DEDUP_MAX, maxAgeMs = DEFAULT_FILL_DEDUP_AGE_MS, now = Date.now } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer");
    if (!(Number(maxAgeMs) >= 0)) throw new Error("maxAgeMs must be non-negative");
    this.maxEntries = maxEntries;
    this.maxAgeMs = Number(maxAgeMs);
    this.now = now;
    this.entries = new Map();
  }

  has(key, at = this.now()) {
    this.#evict(at);
    return this.entries.has(String(key));
  }

  add(key, at = this.now()) {
    const normalized = String(key);
    this.#evict(at);
    if (this.entries.has(normalized)) this.entries.delete(normalized);
    this.entries.set(normalized, Number(at));
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }

  get size() { return this.entries.size; }

  snapshot({ limit = this.maxEntries, at = this.now() } = {}) {
    this.#evict(at);
    const safeLimit = Math.max(0, Math.min(this.maxEntries, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : this.maxEntries));
    if (safeLimit === 0) return [];
    return [...this.entries.entries()].slice(-safeLimit).map(([id, seenAt]) => ({ id, seenAt }));
  }

  #evict(at) {
    if (this.maxAgeMs <= 0) return;
    const cutoff = Number(at) - this.maxAgeMs;
    for (const [key, seenAt] of this.entries) {
      if (seenAt < cutoff) this.entries.delete(key);
    }
  }
}

/** Coalesces/limits source activeAssetData reads; source order events never own a REST hot path. */
export class ActiveLeverageCache {
  constructor({ ttlMs = DEFAULT_LEVERAGE_CACHE_TTL_MS, now = Date.now } = {}) {
    this.ttlMs = Number(ttlMs);
    this.now = now;
    this.entries = new Map();
  }

  seed(coin, leverage) {
    const parsed = parseLeverage(leverage);
    if (parsed) this.entries.set(normalizeCoin(coin), { value: parsed, expiresAt: this.now() + this.ttlMs, promise: null });
    return parsed;
  }

  async resolve(coin, loader) {
    const normalized = normalizeCoin(coin);
    const current = this.entries.get(normalized);
    if (current?.value && current.expiresAt >= this.now()) return current.value;
    if (current?.promise) return current.promise;
    const promise = Promise.resolve().then(loader).then((value) => {
      const parsed = parseLeverage(value);
      if (!parsed) throw new Error(`Hyperliquid did not return leverage for ${normalized}`);
      this.entries.set(normalized, { value: parsed, expiresAt: this.now() + this.ttlMs, promise: null });
      return parsed;
    }).catch((error) => {
      if (this.entries.get(normalized)?.promise === promise) this.entries.delete(normalized);
      throw error;
    });
    this.entries.set(normalized, { value: current?.value ?? null, expiresAt: 0, promise });
    return promise;
  }
}

export const normalizeAccountMode = (value) => {
  const raw = record(value);
  const candidate = raw?.accountMode ?? raw?.mode ?? raw?.abstraction ?? raw?.type ?? value;
  const normalized = String(candidate ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized || ["disabled", "standard", "standardaccount", "standard_account"].includes(normalized)) return "STANDARD";
  if (["unified", "unifiedaccount", "unifiedmargin", "unified_account", "unified_margin"].includes(normalized)) return "UNIFIED";
  if (["portfolio", "portfoliomargin", "portfolio_margin"].includes(normalized)) return "PORTFOLIO_MARGIN";
  throw new Error(`Unsupported Hyperliquid account mode: ${value}`);
};

const parseLeverage = (value) => {
  const raw = record(value);
  const type = String(raw?.type ?? "").toLowerCase();
  const leverage = Number(raw?.value);
  if ((type !== "cross" && type !== "isolated") || !Number.isInteger(leverage) || leverage < 1) return null;
  return { type, value: leverage };
};

const clearinghouseEntries = (payload) => {
  const raw = record(payload);
  const states = raw?.clearinghouseStates;
  if (Array.isArray(states)) return states.flatMap((item) => Array.isArray(item) && item.length === 2 ? [[String(item[0]), item[1]]] : []);
  return record(states) ? Object.entries(states) : [];
};

export const dexesFromAllDexsState = (payload) => {
  const dexes = new Set();
  for (const [dex] of clearinghouseEntries(payload)) {
    const normalized = String(dex ?? "").trim();
    if (normalized && !["main", "default", "perp"].includes(normalized.toLowerCase())) dexes.add(normalized);
  }
  const raw = record(payload);
  const candidates = Array.isArray(raw?.perpDexs) ? raw.perpDexs : Array.isArray(raw?.dexes) ? raw.dexes : [];
  for (const candidate of candidates) {
    const name = typeof candidate === "string" ? candidate : record(candidate)?.name ?? record(candidate)?.dex;
    if (typeof name === "string" && name.trim() && !["main", "default", "perp"].includes(name.trim().toLowerCase())) dexes.add(name.trim());
  }
  return [...dexes].sort((left, right) => left.localeCompare(right));
};

export const parseAllDexsAccountSnapshot = ({ payload, accountMode = "STANDARD", portfolioEquityUsd = null, at = Date.now() }) => {
  const mode = normalizeAccountMode(accountMode);
  if (mode === "PORTFOLIO_MARGIN") throw new Error("Portfolio Margin is not supported by Faithful Mirror V2");
  const marginPools = {};
  const positions = [];
  let summedEquityUsd = 0;
  for (const [dex, stateValue] of clearinghouseEntries(payload)) {
    const rawDex = String(dex ?? "").trim();
    const isMainDex = !rawDex || ["main", "default", "perp"].includes(rawDex.toLowerCase());
    const dexLabel = isMainDex ? "main" : rawDex;
    const state = record(stateValue);
    const marginSummary = record(state?.marginSummary);
    const crossSummary = record(state?.crossMarginSummary);
    const accountValue = asNumber(marginSummary?.accountValue);
    if (accountValue == null) continue;
    const poolId = mode === "UNIFIED" ? "unified" : dexLabel;
    const pool = marginPools[poolId] ?? {
      equityUsd: 0,
      crossEquityUsd: 0,
      marginUsedUsd: 0,
      maintenanceMarginUsedUsd: 0,
      withdrawableUsd: 0,
      dexes: [],
    };
    pool.equityUsd += accountValue;
    pool.crossEquityUsd += asNumber(crossSummary?.accountValue) ?? accountValue;
    pool.marginUsedUsd += asNumber(marginSummary?.totalMarginUsed) ?? 0;
    pool.maintenanceMarginUsedUsd += asNumber(state?.crossMaintenanceMarginUsed) ?? 0;
    pool.withdrawableUsd += asNumber(state?.withdrawable) ?? 0;
    pool.dexes.push(dexLabel);
    marginPools[poolId] = pool;
    summedEquityUsd += accountValue;
    for (const item of Array.isArray(state?.assetPositions) ? state.assetPositions : []) {
      const position = record(record(item)?.position);
      if (!position) continue;
      const signedSize = asNumber(position.szi);
      if (typeof position.coin !== "string" || signedSize == null) continue;
      const coin = !isMainDex && !position.coin.includes(":") ? `${dexLabel}:${position.coin}` : position.coin;
      const positionValueUsd = asNumber(position.positionValue);
      const markPriceUsd = positionValueUsd != null && Math.abs(signedSize) > 1e-12 ? Math.abs(positionValueUsd / signedSize) : null;
      const leverage = parseLeverage(position.leverage);
      if (!leverage) throw new Error(`Source leverage is unavailable for ${coin}`);
      const marginUsedUsd = asNumber(position.marginUsed);
      if (leverage.type === "isolated" && !(marginUsedUsd > 0)) throw new Error(`Isolated marginUsed is unavailable for ${coin}`);
      positions.push({
        coin: normalizeCoin(coin),
        poolId,
        signedSize,
        ...(positionValueUsd != null ? { positionValueUsd: Math.abs(positionValueUsd) } : {}),
        ...(markPriceUsd != null ? { markPriceUsd } : {}),
        ...(asNumber(position.entryPx) != null ? { entryPriceUsd: asNumber(position.entryPx) } : {}),
        ...(marginUsedUsd != null ? { marginUsedUsd } : {}),
        ...(asNumber(position.liquidationPx) != null ? { liquidationPriceUsd: asNumber(position.liquidationPx) } : {}),
        leverage,
      });
    }
  }
  const accountEquityUsd = mode === "UNIFIED" && Number.isFinite(Number(portfolioEquityUsd))
    ? Number(portfolioEquityUsd)
    : summedEquityUsd;
  if (!(accountEquityUsd >= 0)) throw new Error("Hyperliquid account snapshot has no usable account equity");
  if (mode === "UNIFIED" && marginPools.unified) marginPools.unified.equityUsd = accountEquityUsd;
  return { accountMode: mode, accountEquityUsd, marginPools, positions, receivedAt: at };
};

export const parseUserFill = (value) => {
  const raw = record(value);
  const side = normalizeSide(raw?.side);
  if (!raw || typeof raw.coin !== "string" || !side) return null;
  const size = asNumber(raw.sz);
  const price = asNumber(raw.px);
  const startPosition = asNumber(raw.startPosition);
  const time = asNumber(raw.time);
  if (!(size > 0) || !(price > 0) || startPosition == null || time == null) return null;
  return {
    coin: normalizeCoin(raw.coin),
    side,
    size,
    price,
    startPosition,
    time,
    oid: raw.oid == null ? null : String(raw.oid),
    tid: raw.tid == null ? null : String(raw.tid),
    hash: raw.hash == null ? null : String(raw.hash),
  };
};

export const fillId = (address, fill) => [normalizeAddress(address), fill.coin, fill.time, fill.tid ?? "", fill.oid ?? "", fill.hash ?? "", fill.startPosition, fill.size, fill.price].join("|");

export const parseOrder = (value, status = "OPEN") => {
  const raw = record(value);
  if (!raw || typeof raw.coin !== "string" || raw.oid == null) return null;
  const side = normalizeSide(raw.side);
  if (!side) return null;
  const dex = String(raw.dex ?? raw.perpDex ?? (String(raw.coin).includes(":") ? String(raw.coin).split(":", 1)[0] : "main")).trim() || "main";
  const rawCoin = dex.toLowerCase() !== "main" && !String(raw.coin).includes(":") ? `${dex}:${raw.coin}` : raw.coin;
  const price = asNumber(raw.limitPx ?? raw.price);
  const remainingSize = asNumber(raw.sz ?? raw.remainingSize);
  const size = asNumber(raw.origSz ?? raw.size ?? remainingSize);
  if (!(price > 0) || remainingSize == null || size == null) return null;
  const rawTriggerPrice = asNumber(raw.triggerPx ?? raw.triggerPrice);
  // Hyperliquid serializes non-trigger orders with triggerPx = "0.0".
  // Zero means absent; it is not a valid trigger price.
  const triggerPrice = rawTriggerPrice != null && rawTriggerPrice > 0 ? rawTriggerPrice : null;
  return {
    id: String(raw.oid),
    coin: normalizeCoin(rawCoin),
    dex,
    side,
    price,
    triggerPrice,
    orderType: String(raw.orderType ?? (raw.isTrigger ? "TRIGGER" : "LIMIT")).toUpperCase(),
    tif: String(raw.tif ?? "GTC").toUpperCase(),
    reduceOnly: raw.reduceOnly === true,
    size,
    remainingSize,
    status: String(status ?? "OPEN").toUpperCase(),
    clientOrderId: raw.cloid == null ? null : String(raw.cloid),
    timestamp: asNumber(raw.timestamp) ?? Date.now(),
  };
};

export const parseOrderUpdate = (value) => {
  const raw = record(value);
  if (!raw) return null;
  const status = String(raw.status ?? "open").toUpperCase();
  const order = parseOrder(raw.order ?? raw, status);
  if (!order) return null;
  return { status, statusTimestamp: asNumber(raw.statusTimestamp) ?? order.timestamp, order };
};

export const parseUserFunding = (value) => {
  const raw = record(value);
  if (!raw || typeof raw.coin !== "string") return null;
  const usdc = asNumber(raw.usdc);
  const sourceSize = asNumber(raw.szi);
  const time = asNumber(raw.time);
  if (usdc == null || sourceSize == null || time == null) return null;
  return { coin: normalizeCoin(raw.coin), usdc, sourceSize, time };
};

export class HyperliquidInfoClient {
  constructor({ testnet = false, fetchImpl = fetch, retries = 4 }) {
    this.url = testnet ? TESTNET_INFO : MAINNET_INFO;
    this.fetchImpl = fetchImpl;
    this.retries = retries;
    this.perpDexNamesPromise = null;
  }

  async post(body) {
    let attempt = 0;
    while (true) {
      try {
        const response = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (response.status === 429 || response.status >= 500) throw new Error(`retryable:${response.status}`);
        if (!response.ok) throw new Error(`Hyperliquid info request failed (${response.status})`);
        return await response.json();
      } catch (error) {
        if (attempt >= this.retries) throw error;
        await delay(Math.min(5_000, 250 * 2 ** attempt));
        attempt += 1;
      }
    }
  }

  async accountMode(user) {
    return normalizeAccountMode(await this.post({ type: "userAbstraction", user: normalizeAddress(user) }));
  }

  async perpDexNames() {
    if (!this.perpDexNamesPromise) {
      this.perpDexNamesPromise = this.post({ type: "perpDexs" }).then((payload) => {
        if (!Array.isArray(payload)) throw new Error("Hyperliquid perpDexs response is not an array");
        return payload.flatMap((item) => {
          const name = record(item)?.name;
          return typeof name === "string" && name.trim() ? [name.trim()] : [];
        });
      }).catch((error) => {
        this.perpDexNamesPromise = null;
        throw error;
      });
    }
    return this.perpDexNamesPromise;
  }

  async allDexsState(user) {
    // `allDexsClearinghouseState` is a WebSocket subscription name, not a
    // supported REST info request. REST bootstrap must enumerate perpDexs and
    // query clearinghouseState once per DEX.
    const address = normalizeAddress(user);
    const dexNames = await this.perpDexNames();
    const dexes = [["main", ""], ...dexNames.map((name) => [name, name])];
    const states = await Promise.all(dexes.map(async ([label, dex]) => [
      label,
      await this.post({ type: "clearinghouseState", user: address, dex }),
    ]));
    return { clearinghouseStates: states };
  }

  async openOrders(user, { allDexsState = null } = {}) {
    const address = normalizeAddress(user);
    const state = allDexsState ?? await this.allDexsState(address);
    const dexes = dexesFromAllDexsState(state);
    const requests = [null, ...dexes];
    const responses = await Promise.all(requests.map(async (dex) => ({
      dex: dex ?? "main",
      // Hyperliquid requires the dex field even for the default perp DEX.
      // An omitted field receives HTTP 422, while the canonical main-Dex
      // representation is the empty string.
      payload: await this.post({ type: "frontendOpenOrders", user: address, dex: dex ?? "" }),
    })));
    const seen = new Set();
    const orders = [];
    for (const { dex, payload } of responses) {
      if (!Array.isArray(payload)) continue;
      for (const item of payload) {
        const parsed = parseOrder({ ...record(item), dex: record(item)?.dex ?? dex }, "OPEN");
        if (!parsed) continue;
        const key = [address, parsed.dex, parsed.id].join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        orders.push(parsed);
      }
    }
    return orders;
  }

  async activeLeverage(user, coin) {
    const payload = record(await this.post({ type: "activeAssetData", user: normalizeAddress(user), coin: normalizeCoin(coin) }));
    const leverage = parseLeverage(payload?.leverage);
    if (!leverage) throw new Error(`Hyperliquid did not return leverage for ${coin}`);
    return leverage;
  }

  async portfolioEquity(user) {
    const payload = await this.post({ type: "portfolio", user: normalizeAddress(user) });
    if (!Array.isArray(payload)) return null;
    for (const windowName of ["perpDay", "perpWeek", "perpMonth", "perpAllTime", "day", "week", "month", "allTime"]) {
      const entry = payload.find((item) => Array.isArray(item) && item[0] === windowName);
      const history = valueAt(Array.isArray(entry) ? entry[1] : null, "accountValueHistory", []);
      if (!Array.isArray(history)) continue;
      for (let index = history.length - 1; index >= 0; index -= 1) {
        const value = asNumber(Array.isArray(history[index]) ? history[index][1] : record(history[index])?.value);
        if (value != null && value >= 0) return value;
      }
    }
    return null;
  }

  async fillsSince(user, startTime, endTime = Date.now()) {
    const parsed = [];
    const seen = new Set();
    let cursor = Math.max(0, Number(startTime));
    let loops = 0;
    while (cursor <= endTime && loops < 100) {
      const payload = await this.post({
        type: "userFillsByTime",
        user: normalizeAddress(user),
        startTime: cursor,
        endTime,
        aggregateByTime: false,
      });
      if (!Array.isArray(payload) || payload.length === 0) break;
      let maximumTime = cursor;
      for (const raw of payload) {
        const fill = parseUserFill(raw);
        if (!fill || fill.time < startTime || fill.time > endTime) continue;
        const key = fillId(user, fill);
        if (!seen.has(key)) {
          seen.add(key);
          parsed.push(fill);
        }
        maximumTime = Math.max(maximumTime, fill.time);
      }
      if (payload.length < 2_000) break;
      if (maximumTime <= cursor) throw new Error("Hyperliquid fill pagination cursor stalled");
      cursor = maximumTime;
      loops += 1;
    }
    if (loops >= 100) throw new Error("Hyperliquid fill pagination did not converge");
    return parsed.sort((left, right) => left.time - right.time || String(left.tid).localeCompare(String(right.tid)));
  }

  async l2Book(coin) {
    const payload = record(await this.post({ type: "l2Book", coin: normalizeCoin(coin) }));
    const levels = Array.isArray(payload?.levels) ? payload.levels : [];
    const parse = (side) => Array.isArray(side) ? side.flatMap((level) => {
      const raw = record(level);
      const price = asNumber(raw?.px ?? level?.[0]);
      const size = asNumber(raw?.sz ?? level?.[1]);
      return price != null && size != null && price > 0 && size > 0 ? [[price, size]] : [];
    }) : [];
    return { bids: parse(levels[0]), asks: parse(levels[1]) };
  }
}

export class UserSocket {
  constructor({ address, role, testnet = false, WebSocketImpl = WebSocket, subscriptions, onMessage, onOpen = () => {}, onClose = () => {}, heartbeatMs = 20_000, staleConnectionMs = 50_000, reconnectMaxMs = 30_000 }) {
    this.address = normalizeAddress(address);
    this.role = role;
    this.url = testnet ? TESTNET_WS : MAINNET_WS;
    this.WebSocketImpl = WebSocketImpl;
    this.subscriptions = subscriptions;
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.heartbeatMs = heartbeatMs;
    this.staleConnectionMs = staleConnectionMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.socket = null;
    this.running = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.lastMessageAt = 0;
    this.nextPostId = 1;
    this.pendingPosts = new Map();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.#connect();
  }

  stop() {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.#rejectPendingPosts(new Error("Hyperliquid user socket stopped"));
    this.socket?.close(1000, "faithful mirror stopped");
    this.socket = null;
  }

  async postAction(payload, timeoutMs = 15_000) {
    const socket = this.socket;
    if (!this.running || !socket || socket.readyState !== 1) throw new Error(`${this.role} socket is not open for signed action post`);
    const id = this.nextPostId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPosts.delete(id);
        reject(new Error(`Hyperliquid signed action post timed out (${id})`));
      }, timeoutMs);
      this.pendingPosts.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ method: "post", id, request: { type: "action", payload } }));
      } catch (error) {
        clearTimeout(timer);
        this.pendingPosts.delete(id);
        reject(error);
      }
    });
  }

  #connect() {
    if (!this.running) return;
    const socket = new this.WebSocketImpl(this.url);
    this.socket = socket;
    socket.addEventListener("open", async () => {
      if (this.socket !== socket || !this.running) return;
      this.reconnectAttempt = 0;
      this.lastMessageAt = Date.now();
      for (const subscription of this.subscriptions) socket.send(JSON.stringify({ method: "subscribe", subscription }));
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (this.socket !== socket || !this.running) return;
        if (Date.now() - this.lastMessageAt > this.staleConnectionMs) {
          socket.close(4001, "stale connection");
          return;
        }
        try { socket.send(JSON.stringify({ method: "ping" })); }
        catch { socket.close(4002, "heartbeat failed"); }
      }, this.heartbeatMs);
      this.heartbeatTimer.unref?.();
      try { await this.onOpen({ address: this.address, role: this.role }); }
      catch (error) { await this.onMessage({ error, address: this.address, role: this.role }); }
    });
    socket.addEventListener("message", async (event) => {
      this.lastMessageAt = Date.now();
      try {
        const text = typeof event.data === "string" ? event.data : await event.data.text?.();
        const message = JSON.parse(text);
        if (message.channel === "post") {
          const data = record(message.data);
          const id = Number(data?.id ?? message.id);
          const pending = this.pendingPosts.get(id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingPosts.delete(id);
            const response = data?.response ?? message.response;
            if (response == null) pending.reject(new Error(`Hyperliquid post ${id} returned no response`));
            else pending.resolve(response);
            return;
          }
        }
        await this.onMessage({ message, address: this.address, role: this.role });
      } catch (error) {
        await this.onMessage({ error, address: this.address, role: this.role });
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.#rejectPendingPosts(new Error(`${this.role} socket closed before signed action response`));
      this.onClose({ address: this.address, role: this.role });
      if (!this.running) return;
      const wait = Math.min(this.reconnectMaxMs, 500 * 2 ** this.reconnectAttempt++);
      this.reconnectTimer = setTimeout(() => this.#connect(), wait);
    });
    socket.addEventListener("error", () => socket.close(4000, "socket error"));
  }

  #rejectPendingPosts(error) {
    for (const pending of this.pendingPosts.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingPosts.clear();
  }
}

export const createLiveMirrorSystem = ({ pairs, executionFactory, actorConfig = {}, log = () => {} }) => {
  if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > 5) throw new Error("Live faithful mirror requires 1-5 source-target pairs");
  const engine = new FiveWhaleFaithfulMirrorEngine({ pairs, executionFactory, actorConfig, log });
  return { engine };
};

export class HyperliquidMirrorRuntime {
  constructor({ engine, pairs, testnet = false, infoClient = null, WebSocketImpl = WebSocket, heartbeatMs = 20_000, staleConnectionMs = 50_000, reconnectMaxMs = 30_000, allowApproxUnified = false, log = () => {} }) {
    if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > 5) throw new Error("Hyperliquid live runtime requires 1-5 pairs");
    this.engine = engine;
    this.pairs = pairs.map((pair) => ({ ...pair, sourceAddress: normalizeAddress(pair.sourceAddress), targetAddress: normalizeAddress(pair.targetAddress) }));
    this.testnet = testnet;
    this.info = infoClient ?? new HyperliquidInfoClient({ testnet });
    this.WebSocketImpl = WebSocketImpl;
    this.heartbeatMs = heartbeatMs;
    this.staleConnectionMs = staleConnectionMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.allowApproxUnified = allowApproxUnified;
    this.log = log;
    this.sockets = [];
    this.contextByAddress = new Map();
    this.seenFillIds = new BoundedFillDeduper();
    this.eventSequence = 0;
    this.recoveryByPair = new Map();
  }

  async start() {
    const contexts = [];
    for (const pair of this.pairs) {
      const [sourceMode, targetMode] = await Promise.all([
        this.info.accountMode(pair.sourceAddress),
        this.info.accountMode(pair.targetAddress),
      ]);
      if (sourceMode !== targetMode) throw new Error(`Account-mode mismatch for ${pair.pairId}: source=${sourceMode}, target=${targetMode}`);
      if (sourceMode === "PORTFOLIO_MARGIN") throw new Error(`Portfolio margin is unsupported for ${pair.pairId}`);
      if (sourceMode === "UNIFIED" && !this.allowApproxUnified) throw new Error(`Unified account support is approximate and disabled for ${pair.pairId}`);
      const context = {
        ...pair,
        accountMode: sourceMode,
        sourceSnapshot: null,
        targetSnapshot: null,
        sourceOrders: null,
        targetOrders: null,
        bootstrapped: false,
        buffer: [],
        sourceLastFillTime: null,
        targetLastFillTime: null,
        sourceLeverage: new ActiveLeverageCache(),
        targetLeverage: new ActiveLeverageCache(),
        sourceFillSnapshotSeen: false,
        targetFillSnapshotSeen: false,
        recoveredOrderOwnership: new Map(),
      };
      this.#applyRecovery(context, this.recoveryByPair.get(context.pairId));
      contexts.push(context);
      this.contextByAddress.set(pair.sourceAddress, { context, role: "source" });
      this.contextByAddress.set(pair.targetAddress, { context, role: "target" });
    }
    for (const context of contexts) {
      const targetSocket = this.#makeSocket(context, "target");
      this.engine.attachActionTransport(context.pairId, { postAction: (payload, timeoutMs) => targetSocket.postAction(payload, timeoutMs) });
      const sourceSocket = this.#makeSocket(context, "source");
      this.sockets.push(sourceSocket, targetSocket);
      targetSocket.start();
      sourceSocket.start();
    }
    this.log({ type: "RUNTIME_STARTED", socketCount: this.sockets.length, pairCount: contexts.length, at: Date.now() });
  }

  stop() {
    for (const socket of this.sockets) socket.stop();
    this.engine.stop();
  }

  restoreRecoveryCheckpoint(checkpoint) {
    const candidates = Array.isArray(checkpoint?.pairs)
      ? checkpoint.pairs
      : Object.values(checkpoint?.pairs ?? checkpoint?.contexts ?? {});
    for (const value of candidates) {
      this.#validateRecoveryCheckpoint(value);
      this.recoveryByPair.set(String(value.pairId), structuredClone(value));
    }
    for (const { context } of this.contextByAddress.values()) this.#applyRecovery(context, this.recoveryByPair.get(context.pairId));
    return { accepted: true, restoredPairs: this.recoveryByPair.size };
  }

  #validateRecoveryCheckpoint(checkpoint) {
    const value = record(checkpoint);
    if (!value?.pairId) throw new Error("Recovery checkpoint pairId is required");
    const pair = this.pairs.find((candidate) => candidate.pairId === String(value.pairId));
    if (!pair) throw new Error(`Recovery checkpoint references unknown pair ${value.pairId}`);
    if (value.sourceAddress && normalizeAddress(value.sourceAddress) !== pair.sourceAddress) throw new Error(`Recovery source mismatch for ${pair.pairId}`);
    if (value.targetAddress && normalizeAddress(value.targetAddress) !== pair.targetAddress) throw new Error(`Recovery target mismatch for ${pair.pairId}`);
    this.#parseRecoveredOrderOwnership(pair.pairId, value.sourceOrderToTargetCloid);
  }

  #parseRecoveredOrderOwnership(pairId, rawMappings) {
    if (rawMappings == null) return new Map();
    const mappings = record(rawMappings);
    if (!mappings) throw new Error(`Recovery order mapping must be an object for ${pairId}`);
    const ownership = new Map();
    for (const [rawSourceOrderId, rawTargetCloid] of Object.entries(mappings)) {
      const sourceOrderId = String(rawSourceOrderId);
      const targetCloid = String(rawTargetCloid);
      if (!sourceOrderId || !targetCloid || sourceOrderId.trim() !== sourceOrderId || targetCloid !== canonicalTargetCloid(pairId, sourceOrderId)) {
        throw new Error(`Recovery target Cloid is non-canonical for ${pairId}/${sourceOrderId || "<missing>"}`);
      }
      ownership.set(sourceOrderId, targetCloid);
    }
    return ownership;
  }

  recoveryCheckpoint() {
    const enginePairs = this.engine?.snapshot?.()?.pairs ?? {};
    const contexts = [...new Map([...this.contextByAddress.values()].map(({ context }) => [context.pairId, context])).values()];
    return {
      schemaVersion: 1,
      generatedAt: Date.now(),
      pairs: contexts.map((context) => this.#recoveryPair(context, enginePairs[context.pairId])),
    };
  }

  async reconcile() {
    const contexts = [...new Map([...this.contextByAddress.values()].map(({ context }) => [context.pairId, context])).values()];
    for (const context of contexts) {
      if (this.#isTerminalContext(context)) continue;
      for (const role of ["source", "target"]) {
        const address = role === "source" ? context.sourceAddress : context.targetAddress;
        const state = await this.info.allDexsState(address);
        await this.#acceptSnapshot(context, role, state);
        const orders = await this.info.openOrders(address, { allDexsState: state });
        if (role === "source") {
          context.sourceOrders = orders;
          if (context.bootstrapped) await this.engine.syncSourceOrders(address, orders);
        } else {
          context.targetOrders = orders;
          if (context.bootstrapped) this.engine.syncTargetOrders(address, orders);
        }
      }
      await this.#tryBootstrap(context);
    }
    await this.engine.whenIdle();
    return { accepted: true, pairCount: contexts.length };
  }

  #isTerminalContext(context) {
    if (!context) return true;
    if (typeof this.engine.isPairTerminal === "function") return this.engine.isPairTerminal(context.pairId);
    const actor = this.engine?.snapshot?.()?.pairs?.[context.pairId];
    return actor?.killed === true || actor?.blocked === true || actor?.stopped === true;
  }

  #makeSocket(context, role) {
    const address = role === "source" ? context.sourceAddress : context.targetAddress;
    return new UserSocket({
      address,
      role,
      testnet: this.testnet,
      WebSocketImpl: this.WebSocketImpl,
      heartbeatMs: this.heartbeatMs,
      staleConnectionMs: this.staleConnectionMs,
      reconnectMaxMs: this.reconnectMaxMs,
      subscriptions: [
        { type: "allDexsClearinghouseState", user: address },
        { type: "userFills", user: address, aggregateByTime: false },
        { type: "orderUpdates", user: address },
      ],
      onOpen: () => this.#onOpen(context, role),
      onMessage: (event) => this.#onMessage(context, role, event.message, event.error),
      onClose: () => this.log({ type: "USER_WS_CLOSE", pairId: context.pairId, role, address, at: Date.now() }),
    });
  }

  async #onOpen(context, role) {
    if (this.#isTerminalContext(context)) return { ignored: true, reason: "PAIR_TERMINAL" };
    const address = role === "source" ? context.sourceAddress : context.targetAddress;
    // The REST bootstrap is intentionally outside the order-event hot path. It
    // supplies both every DEX name and an authoritative state before an open
    // order snapshot is trusted.
    const allDexsState = await this.info.allDexsState(address);
    await this.#acceptSnapshot(context, role, allDexsState);
    const orders = await this.info.openOrders(address, { allDexsState });
    if (role === "source") context.sourceOrders = orders;
    else {
      context.targetOrders = orders;
      if (context.bootstrapped) this.engine.syncTargetOrders(context.targetAddress, orders);
    }
    const lastFillTime = role === "source" ? context.sourceLastFillTime : context.targetLastFillTime;
    if (lastFillTime != null) {
      const fills = await this.info.fillsSince(address, Math.max(0, lastFillTime - 1_000));
      for (const fill of fills) await this.#handleFill(context, role, fill, true);
      if (context.bootstrapped && role === "source") await this.engine.syncSourceOrders(context.sourceAddress, orders);
    }
    await this.#tryBootstrap(context);
  }

  async #onMessage(context, role, message, error) {
    if (this.#isTerminalContext(context)) return;
    if (error) {
      this.log({ type: "RUNTIME_ERROR", pairId: context.pairId, role, message: error instanceof Error ? error.message : String(error), at: Date.now() });
      return;
    }
    if (message?.channel === "allDexsClearinghouseState") {
      await this.#acceptSnapshot(context, role, message.data);
      await this.#tryBootstrap(context);
      return;
    }
    if (message?.channel === "userFills") {
      const data = record(message.data);
      const isSnapshot = data?.isSnapshot === true;
      const snapshotFlag = role === "source" ? "sourceFillSnapshotSeen" : "targetFillSnapshotSeen";
      if (isSnapshot && !context[snapshotFlag]) {
        context[snapshotFlag] = true;
        return;
      }
      for (const raw of Array.isArray(data?.fills) ? data.fills : []) {
        const fill = parseUserFill(raw);
        if (fill) await this.#handleFill(context, role, fill, false);
      }
      return;
    }
    if (message?.channel === "orderUpdates") {
      const values = Array.isArray(message.data) ? message.data : Array.isArray(record(message.data)?.orderUpdates) ? record(message.data).orderUpdates : [];
      for (const raw of values) {
        const update = parseOrderUpdate(raw);
        if (!update) continue;
        if (role === "source") {
          update.order.leverage = await context.sourceLeverage.resolve(update.order.coin, () => this.info.activeLeverage(context.sourceAddress, update.order.coin));
          update.order.poolId = context.accountMode === "UNIFIED" ? "unified" : update.order.coin.includes(":") ? update.order.coin.split(":", 1)[0] : "main";
          if (context.bootstrapped) await this.engine.onSourceOrder(context.sourceAddress, update);
          else context.buffer.push({ type: "sourceOrder", update, sequence: ++this.eventSequence });
        } else {
          const targetUpdate = {
            targetOrderId: update.order.clientOrderId,
            exchangeOrderId: update.order.id,
            coin: update.order.coin,
            status: update.status,
            remainingSize: update.order.remainingSize,
            filledSize: Math.max(0, update.order.size - update.order.remainingSize),
            order: update.order,
          };
          if (context.bootstrapped) this.engine.onTargetOrder(context.targetAddress, targetUpdate);
          else context.buffer.push({ type: "targetOrder", update: targetUpdate, sequence: ++this.eventSequence });
        }
      }
    }
  }

  async #handleFill(context, role, fill, backfill) {
    if (this.#isTerminalContext(context)) return { ignored: true, reason: "PAIR_TERMINAL" };
    const address = role === "source" ? context.sourceAddress : context.targetAddress;
    const key = fillId(address, fill);
    if (this.seenFillIds.has(key, fill.time)) return;
    this.seenFillIds.add(key, fill.time);
    if (role === "source") context.sourceLastFillTime = Math.max(context.sourceLastFillTime ?? 0, fill.time);
    else context.targetLastFillTime = Math.max(context.targetLastFillTime ?? 0, fill.time);
    const snapshot = role === "source" ? context.sourceSnapshot : context.targetSnapshot;
    const existing = snapshot?.positions?.find((position) => position.coin === fill.coin);
    if (role === "source") {
      fill.leverage = existing?.leverage ?? await context.sourceLeverage.resolve(fill.coin, () => this.info.activeLeverage(context.sourceAddress, fill.coin));
    } else fill.leverage = existing?.leverage;
    fill.marginUsedUsd = existing?.marginUsedUsd;
    fill.poolId = existing?.poolId ?? (context.accountMode === "UNIFIED" ? "unified" : fill.coin.includes(":") ? fill.coin.split(":", 1)[0] : "main");
    if (role === "source") {
      if (context.bootstrapped) this.engine.onSourceFill(context.sourceAddress, fill);
      else context.buffer.push({ type: "sourceFill", fill, sequence: ++this.eventSequence });
    } else if (context.bootstrapped) {
      this.engine.onTargetFill(context.targetAddress, fill);
      this.engine.executionByPair?.get?.(context.pairId)?.onTargetFill?.({ pairId: context.pairId, fill: structuredClone(fill) });
    }
    else context.buffer.push({ type: "targetFill", fill, sequence: ++this.eventSequence });
    this.log({ type: backfill ? "BACKFILL_FILL" : "REALTIME_FILL", pairId: context.pairId, role, coin: fill.coin, at: Date.now() });
  }

  async #tryBootstrap(context) {
    if (this.#isTerminalContext(context)) return;
    if (context.bootstrapped || !context.sourceSnapshot || !context.targetSnapshot || !context.sourceOrders || !context.targetOrders) return;
    if (context.recoveredOrderOwnership.size) {
      if (typeof this.engine.restoreOrderOwnership !== "function") throw new Error(`Engine does not support fail-closed order ownership recovery for ${context.pairId}`);
      this.engine.restoreOrderOwnership(context.pairId, {
        sourceOrderToTargetCloid: Object.fromEntries(context.recoveredOrderOwnership),
        targetOpenOrders: context.targetOrders,
        requireTargetOpen: true,
        preserveExistingShadow: true,
      });
      context.recoveredOrderOwnership.clear();
    }
    await this.engine.bootstrapPair(context.pairId, {
      sourceSnapshot: context.sourceSnapshot,
      targetSnapshot: context.targetSnapshot,
      sourceOpenOrders: context.sourceOrders,
    });
    context.bootstrapped = true;
    this.engine.syncTargetOrders(context.targetAddress, context.targetOrders);
    for (const event of context.buffer.splice(0).sort((left, right) => left.sequence - right.sequence)) {
      if (event.type === "sourceFill") this.engine.onSourceFill(context.sourceAddress, event.fill);
      else if (event.type === "sourceOrder") await this.engine.onSourceOrder(context.sourceAddress, event.update);
      else if (event.type === "targetFill") {
        this.engine.onTargetFill(context.targetAddress, event.fill);
        this.engine.executionByPair?.get?.(context.pairId)?.onTargetFill?.({ pairId: context.pairId, fill: structuredClone(event.fill) });
      }
      else if (event.type === "targetOrder") this.engine.onTargetOrder(context.targetAddress, event.update);
    }
    await this.engine.whenIdle();
    this.log({ type: "PAIR_BOOTSTRAPPED", pairId: context.pairId, accountMode: context.accountMode, at: Date.now() });
  }

  async #acceptSnapshot(context, role, payload) {
    if (this.#isTerminalContext(context)) return;
    const address = role === "source" ? context.sourceAddress : context.targetAddress;
    const portfolioEquityUsd = context.accountMode === "UNIFIED"
      ? await this.info.portfolioEquity(address)
      : null;
    const snapshot = parseAllDexsAccountSnapshot({ payload, accountMode: context.accountMode, portfolioEquityUsd });
    const leverageCache = role === "source" ? context.sourceLeverage : context.targetLeverage;
    for (const position of snapshot.positions) leverageCache.seed(position.coin, position.leverage);
    if (role === "source") {
      context.sourceSnapshot = snapshot;
      if (context.bootstrapped) this.engine.onSourceSnapshot(context.sourceAddress, snapshot);
    } else {
      // A target state is authoritative over prior target fill/local optimistic
      // state; the actor receives it immediately after parsing.
      context.targetSnapshot = snapshot;
      this.engine.executionByPair?.get?.(context.pairId)?.onTargetSnapshot?.(structuredClone(snapshot));
      if (context.bootstrapped) this.engine.onTargetSnapshot(context.targetAddress, snapshot);
    }
  }

  #applyRecovery(context, checkpoint) {
    if (!checkpoint) return;
    if (checkpoint.sourceAddress && normalizeAddress(checkpoint.sourceAddress) !== context.sourceAddress) throw new Error(`Recovery source mismatch for ${context.pairId}`);
    if (checkpoint.targetAddress && normalizeAddress(checkpoint.targetAddress) !== context.targetAddress) throw new Error(`Recovery target mismatch for ${context.pairId}`);
    const recoveredMode = String(checkpoint.accountMode ?? "").trim().toUpperCase();
    if (recoveredMode && recoveredMode !== "UNKNOWN" && normalizeAccountMode(recoveredMode) !== context.accountMode) throw new Error(`Recovery account mode changed for ${context.pairId}`);
    context.sourceLastFillTime = Number.isFinite(Number(checkpoint.lastSourceFillTime)) ? Number(checkpoint.lastSourceFillTime) : context.sourceLastFillTime;
    context.targetLastFillTime = Number.isFinite(Number(checkpoint.lastTargetFillTime)) ? Number(checkpoint.lastTargetFillTime) : context.targetLastFillTime;
    for (const key of checkpoint.recentSourceFillIds ?? []) this.seenFillIds.add(key, context.sourceLastFillTime ?? Date.now());
    for (const key of checkpoint.recentTargetFillIds ?? []) this.seenFillIds.add(key, context.targetLastFillTime ?? Date.now());
    context.recoveredOrderOwnership = this.#parseRecoveredOrderOwnership(context.pairId, checkpoint.sourceOrderToTargetCloid);
  }

  #recoveryPair(context, actor) {
    const ids = this.seenFillIds.snapshot();
    const sourcePrefix = `${context.sourceAddress}|`;
    const targetPrefix = `${context.targetAddress}|`;
    const targetOrders = Array.isArray(actor?.targetOrderState) ? actor.targetOrderState : [];
    const sourceOrderToTargetCloid = Object.fromEntries(targetOrders.flatMap((order) => {
      const sourceOrderId = order?.sourceOrderId;
      const targetOrderId = order?.targetOrderId ?? order?.clientOrderId;
      if (sourceOrderId == null || targetOrderId == null) return [];
      const normalizedSourceOrderId = String(sourceOrderId);
      const normalizedTargetCloid = String(targetOrderId);
      if (canonicalTargetCloid(context.pairId, normalizedSourceOrderId) !== normalizedTargetCloid) {
        throw new Error(`Engine emitted a non-canonical target Cloid for ${context.pairId}/${normalizedSourceOrderId}`);
      }
      return [[normalizedSourceOrderId, normalizedTargetCloid]];
    }));
    return {
      pairId: context.pairId,
      sourceAddress: context.sourceAddress,
      targetAddress: context.targetAddress,
      lastSourceFillTime: context.sourceLastFillTime,
      lastTargetFillTime: context.targetLastFillTime,
      recentSourceFillIds: ids.filter((entry) => entry.id.startsWith(sourcePrefix)).map((entry) => entry.id),
      recentTargetFillIds: ids.filter((entry) => entry.id.startsWith(targetPrefix)).map((entry) => entry.id),
      sourceOrderToTargetCloid,
      accountMode: context.accountMode ?? "UNKNOWN",
      lastSourceSnapshotAt: Number.isFinite(Number(context.sourceSnapshot?.receivedAt)) ? Number(context.sourceSnapshot.receivedAt) : null,
      lastTargetSnapshotAt: Number.isFinite(Number(context.targetSnapshot?.receivedAt)) ? Number(context.targetSnapshot.receivedAt) : null,
      killSwitch: actor?.killed === true || actor?.blocked === true,
    };
  }
}
