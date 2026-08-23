import { setTimeout as delay } from "node:timers/promises";
import { FiveWhaleFaithfulMirrorEngine } from "./engine.mjs";
import { normalizeAddress, normalizeCoin } from "./domain.mjs";

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

export const normalizeAccountMode = (value) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized || ["disabled", "standard", "standardaccount"].includes(normalized)) return "STANDARD";
  if (["unified", "unifiedaccount", "unifiedmargin"].includes(normalized)) return "UNIFIED";
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

export const parseAllDexsAccountSnapshot = ({ payload, accountMode = "STANDARD", portfolioEquityUsd = null, at = Date.now() }) => {
  const mode = normalizeAccountMode(accountMode);
  if (mode === "PORTFOLIO_MARGIN") throw new Error("Portfolio Margin is not supported by Faithful Mirror V2");
  const marginPools = {};
  const positions = [];
  let summedEquityUsd = 0;
  for (const [dex, stateValue] of clearinghouseEntries(payload)) {
    const state = record(stateValue);
    const marginSummary = record(state?.marginSummary);
    const crossSummary = record(state?.crossMarginSummary);
    const accountValue = asNumber(marginSummary?.accountValue);
    if (accountValue == null) continue;
    const poolId = mode === "UNIFIED" ? "unified" : dex || "main";
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
    pool.dexes.push(dex || "main");
    marginPools[poolId] = pool;
    summedEquityUsd += accountValue;
    for (const item of Array.isArray(state?.assetPositions) ? state.assetPositions : []) {
      const position = record(record(item)?.position);
      if (!position) continue;
      const signedSize = asNumber(position.szi);
      if (typeof position.coin !== "string" || signedSize == null) continue;
      const coin = dex && !position.coin.includes(":") ? `${dex}:${position.coin}` : position.coin;
      const positionValueUsd = asNumber(position.positionValue);
      const markPriceUsd = positionValueUsd != null && Math.abs(signedSize) > 1e-12 ? Math.abs(positionValueUsd / signedSize) : null;
      const leverage = parseLeverage(position.leverage);
      if (!leverage) throw new Error(`Source leverage is unavailable for ${coin}`);
      positions.push({
        coin: normalizeCoin(coin),
        poolId,
        signedSize,
        ...(positionValueUsd != null ? { positionValueUsd: Math.abs(positionValueUsd) } : {}),
        ...(markPriceUsd != null ? { markPriceUsd } : {}),
        ...(asNumber(position.entryPx) != null ? { entryPriceUsd: asNumber(position.entryPx) } : {}),
        ...(asNumber(position.marginUsed) != null ? { marginUsedUsd: asNumber(position.marginUsed) } : {}),
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
  if (!raw || typeof raw.coin !== "string" || !["B", "A"].includes(String(raw.side).toUpperCase())) return null;
  const size = asNumber(raw.sz);
  const price = asNumber(raw.px);
  const startPosition = asNumber(raw.startPosition);
  const time = asNumber(raw.time);
  if (!(size > 0) || !(price > 0) || startPosition == null || time == null) return null;
  return {
    coin: normalizeCoin(raw.coin),
    side: String(raw.side).toUpperCase(),
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
  const side = String(raw.side ?? "").toUpperCase();
  if (side !== "B" && side !== "A" && side !== "BUY" && side !== "SELL") return null;
  const price = asNumber(raw.limitPx ?? raw.price);
  const remainingSize = asNumber(raw.sz ?? raw.remainingSize);
  const size = asNumber(raw.origSz ?? raw.size ?? remainingSize);
  if (!(price > 0) || remainingSize == null || size == null) return null;
  const triggerPrice = asNumber(raw.triggerPx ?? raw.triggerPrice);
  return {
    id: String(raw.oid),
    coin: normalizeCoin(raw.coin),
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

  async allDexsState(user) {
    return this.post({ type: "allDexsClearinghouseState", user: normalizeAddress(user) });
  }

  async openOrders(user) {
    const payload = await this.post({ type: "frontendOpenOrders", user: normalizeAddress(user) });
    return Array.isArray(payload) ? payload.flatMap((item) => {
      const parsed = parseOrder(item, "OPEN");
      return parsed ? [parsed] : [];
    }) : [];
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
      if (maximumTime < cursor) throw new Error("Hyperliquid fill pagination cursor regressed");
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
  if (pairs.length !== 5) throw new Error("Live faithful mirror requires exactly five source-target pairs to match the 10-user WebSocket topology");
  const engine = new FiveWhaleFaithfulMirrorEngine({ pairs, executionFactory, actorConfig, log });
  return { engine };
};

export class HyperliquidMirrorRuntime {
  constructor({ engine, pairs, testnet = false, infoClient = null, WebSocketImpl = WebSocket, heartbeatMs = 20_000, staleConnectionMs = 50_000, reconnectMaxMs = 30_000, allowApproxUnified = false, log = () => {} }) {
    if (!Array.isArray(pairs) || pairs.length !== 5) throw new Error("Hyperliquid live runtime requires exactly five pairs");
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
    this.seenFillIds = new Set();
    this.eventSequence = 0;
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
      };
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
    const address = role === "source" ? context.sourceAddress : context.targetAddress;
    const orders = await this.info.openOrders(address);
    if (role === "source") context.sourceOrders = orders;
    else {
      context.targetOrders = orders;
      if (context.bootstrapped) this.engine.syncTargetOrders(context.targetAddress, orders);
    }
    const lastFillTime = role === "source" ? context.sourceLastFillTime : context.targetLastFillTime;
    if (lastFillTime != null) {
      const fills = await this.info.fillsSince(address, Math.max(0, lastFillTime - 1_000));
      for (const fill of fills) this.#handleFill(context, role, fill, true);
      if (context.bootstrapped && role === "source") await this.engine.syncSourceOrders(context.sourceAddress, orders);
    }
    await this.#tryBootstrap(context);
  }

  async #onMessage(context, role, message, error) {
    if (error) {
      this.log({ type: "RUNTIME_ERROR", pairId: context.pairId, role, message: error instanceof Error ? error.message : String(error), at: Date.now() });
      return;
    }
    if (message?.channel === "allDexsClearinghouseState") {
      const portfolioEquityUsd = context.accountMode === "UNIFIED"
        ? await this.info.portfolioEquity(role === "source" ? context.sourceAddress : context.targetAddress)
        : null;
      const snapshot = parseAllDexsAccountSnapshot({ payload: message.data, accountMode: context.accountMode, portfolioEquityUsd });
      if (role === "source") {
        context.sourceSnapshot = snapshot;
        if (context.bootstrapped) this.engine.onSourceSnapshot(context.sourceAddress, snapshot);
      } else {
        context.targetSnapshot = snapshot;
        if (context.bootstrapped) this.engine.onTargetSnapshot(context.targetAddress, snapshot);
      }
      await this.#tryBootstrap(context);
      return;
    }
    if (message?.channel === "userFills") {
      const data = record(message.data);
      const isSnapshot = data?.isSnapshot === true;
      const last = role === "source" ? context.sourceLastFillTime : context.targetLastFillTime;
      if (isSnapshot && last == null) return;
      for (const raw of Array.isArray(data?.fills) ? data.fills : []) {
        const fill = parseUserFill(raw);
        if (fill) this.#handleFill(context, role, fill, false);
      }
      return;
    }
    if (message?.channel === "orderUpdates") {
      const values = Array.isArray(message.data) ? message.data : Array.isArray(record(message.data)?.orderUpdates) ? record(message.data).orderUpdates : [];
      for (const raw of values) {
        const update = parseOrderUpdate(raw);
        if (!update) continue;
        if (role === "source") {
          update.order.leverage = await this.info.activeLeverage(context.sourceAddress, update.order.coin);
          update.order.poolId = context.accountMode === "UNIFIED" ? "unified" : update.order.coin.includes(":") ? update.order.coin.split(":", 1)[0] : "main";
          if (context.bootstrapped) await this.engine.onSourceOrder(context.sourceAddress, update);
          else context.buffer.push({ type: "sourceOrder", update, sequence: ++this.eventSequence });
        } else {
          this.engine.onTargetOrder(context.targetAddress, {
            targetOrderId: update.order.clientOrderId,
            exchangeOrderId: update.order.id,
            coin: update.order.coin,
            status: update.status,
            remainingSize: update.order.remainingSize,
            filledSize: Math.max(0, update.order.size - update.order.remainingSize),
            order: update.order,
          });
        }
      }
    }
  }

  #handleFill(context, role, fill, backfill) {
    const address = role === "source" ? context.sourceAddress : context.targetAddress;
    const key = fillId(address, fill);
    if (this.seenFillIds.has(key)) return;
    this.seenFillIds.add(key);
    if (this.seenFillIds.size > 100_000) this.seenFillIds.clear();
    if (role === "source") context.sourceLastFillTime = Math.max(context.sourceLastFillTime ?? 0, fill.time);
    else context.targetLastFillTime = Math.max(context.targetLastFillTime ?? 0, fill.time);
    const snapshot = role === "source" ? context.sourceSnapshot : context.targetSnapshot;
    const existing = snapshot?.positions?.find((position) => position.coin === fill.coin);
    fill.leverage = existing?.leverage;
    fill.marginUsedUsd = existing?.marginUsedUsd;
    fill.poolId = existing?.poolId ?? (context.accountMode === "UNIFIED" ? "unified" : fill.coin.includes(":") ? fill.coin.split(":", 1)[0] : "main");
    if (role === "source") {
      if (context.bootstrapped) this.engine.onSourceFill(context.sourceAddress, fill);
      else context.buffer.push({ type: "sourceFill", fill, sequence: ++this.eventSequence });
    } else if (context.bootstrapped) this.engine.onTargetFill(context.targetAddress, fill);
    this.log({ type: backfill ? "BACKFILL_FILL" : "REALTIME_FILL", pairId: context.pairId, role, coin: fill.coin, at: Date.now() });
  }

  async #tryBootstrap(context) {
    if (context.bootstrapped || !context.sourceSnapshot || !context.targetSnapshot || !context.sourceOrders || !context.targetOrders) return;
    await this.engine.bootstrapPair(context.pairId, {
      sourceSnapshot: context.sourceSnapshot,
      targetSnapshot: context.targetSnapshot,
      sourceOpenOrders: context.sourceOrders,
    });
    context.bootstrapped = true;
    this.engine.syncTargetOrders(context.targetAddress, context.targetOrders);
    for (const event of context.buffer.splice(0).sort((left, right) => left.sequence - right.sequence)) {
      if (event.type === "sourceFill") this.engine.onSourceFill(context.sourceAddress, event.fill);
      else await this.engine.onSourceOrder(context.sourceAddress, event.update);
    }
    await this.engine.whenIdle();
    this.log({ type: "PAIR_BOOTSTRAPPED", pairId: context.pairId, accountMode: context.accountMode, at: Date.now() });
  }
}
