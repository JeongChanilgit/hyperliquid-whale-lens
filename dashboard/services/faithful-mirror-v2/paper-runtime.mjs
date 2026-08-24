import { createHash } from "node:crypto";
import { FiveWhaleFaithfulMirrorEngine } from "./engine.mjs";
import { canonicalTargetCloid, normalizeAddress, normalizeCoin } from "./domain.mjs";
import { PaperExecutionPort } from "./paper-venue.mjs";
import {
  HyperliquidInfoClient,
  UserSocket,
  parseAllDexsAccountSnapshot,
  parseOrderUpdate,
  parseUserFill,
  parseUserFunding,
  fillId,
  BoundedFillDeduper,
  ActiveLeverageCache,
} from "./runtime.mjs";

const MAINNET_WS = "wss://api.hyperliquid.xyz/ws";
const TESTNET_WS = "wss://api.hyperliquid-testnet.xyz/ws";
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;

const syntheticTargetAddress = (pairId) => `0x${createHash("sha256").update(`faithful-paper|${pairId}`).digest("hex").slice(0, 40)}`;

const targetSnapshotFor = (sourceSnapshot, capitalUsd) => {
  const sourcePools = Object.entries(sourceSnapshot.marginPools ?? {});
  const total = sourcePools.reduce((sum, [, pool]) => sum + Number(pool.equityUsd), 0);
  if (!(total > 0)) throw new Error("source margin pools have no usable equity");
  const marginPools = Object.fromEntries(sourcePools.map(([poolId, pool]) => [poolId, {
    ...pool,
    equityUsd: Number(capitalUsd) * Number(pool.equityUsd) / total,
  }]));
  return {
    accountMode: sourceSnapshot.accountMode,
    accountEquityUsd: Number(capitalUsd),
    marginPools,
    positions: [],
    receivedAt: Date.now(),
  };
};

class PublicMarketSocket {
  constructor({ testnet, WebSocketImpl = WebSocket, onBook, onTrade, log = () => {}, heartbeatMs = 20_000, staleConnectionMs = 50_000 }) {
    this.url = testnet ? TESTNET_WS : MAINNET_WS;
    this.WebSocketImpl = WebSocketImpl;
    this.onBook = onBook;
    this.onTrade = onTrade;
    this.log = log;
    this.coins = new Set();
    this.socket = null;
    this.running = false;
    this.reconnectAttempt = 0;
    this.heartbeatMs = heartbeatMs;
    this.staleConnectionMs = staleConnectionMs;
    this.lastMessageAt = 0;
    this.heartbeatTimer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.#connect();
  }

  stop() {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.socket?.close(1000, "paper market runtime stopped");
    this.socket = null;
  }

  subscribe(coin) {
    const normalized = normalizeCoin(coin);
    if (this.coins.has(normalized)) return;
    this.coins.add(normalized);
    if (this.socket?.readyState === 1) this.#sendSubscriptions(normalized);
  }

  #connect() {
    if (!this.running) return;
    const socket = new this.WebSocketImpl(this.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket || !this.running) return;
      this.reconnectAttempt = 0;
      this.lastMessageAt = Date.now();
      for (const coin of this.coins) this.#sendSubscriptions(coin);
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (this.socket !== socket || !this.running) return;
        if (Date.now() - this.lastMessageAt > this.staleConnectionMs) {
          socket.close(4001, "stale market connection");
          return;
        }
        try { socket.send(JSON.stringify({ method: "ping" })); }
        catch { socket.close(4002, "market heartbeat failed"); }
      }, this.heartbeatMs);
      this.heartbeatTimer.unref?.();
      this.log({ type: "MARKET_WS_OPEN", at: Date.now() });
    });
    socket.addEventListener("message", async (event) => {
      this.lastMessageAt = Date.now();
      try {
        const text = typeof event.data === "string" ? event.data : await event.data.text?.();
        const message = JSON.parse(text);
        if (message.channel === "l2Book") {
          const data = record(message.data);
          const coin = normalizeCoin(data?.coin);
          const levels = Array.isArray(data?.levels) ? data.levels : [];
          const parse = (side) => Array.isArray(side) ? side.flatMap((level) => {
            const raw = record(level);
            const price = Number(raw?.px ?? level?.[0]);
            const size = Number(raw?.sz ?? level?.[1]);
            return Number.isFinite(price) && price > 0 && Number.isFinite(size) && size > 0 ? [[price, size]] : [];
          }) : [];
          this.onBook(coin, { bids: parse(levels[0]), asks: parse(levels[1]) });
        } else if (message.channel === "trades") {
          for (const raw of Array.isArray(message.data) ? message.data : []) {
            const trade = record(raw);
            if (!trade || typeof trade.coin !== "string") continue;
            const price = Number(trade.px);
            const size = Number(trade.sz);
            const side = String(trade.side).toUpperCase();
            if (Number.isFinite(price) && Number.isFinite(size) && size > 0) {
              this.onTrade({ coin: normalizeCoin(trade.coin), price, size, aggressorSide: side === "B" ? "BUY" : "SELL" });
            }
          }
        }
      } catch (error) {
        this.log({ type: "MARKET_WS_ERROR", message: error instanceof Error ? error.message : String(error), at: Date.now() });
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (!this.running) return;
      const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempt++);
      setTimeout(() => this.#connect(), delay);
    });
    socket.addEventListener("error", () => socket.close(4000, "market socket error"));
  }

  #sendSubscriptions(coin) {
    this.socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin } }));
    this.socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin } }));
  }
}

export const createPaperMirrorSystem = ({
  pairs,
  testnet = true,
  infoClient = null,
  WebSocketImpl = WebSocket,
  actorConfig = {},
  venueOptions = {},
  heartbeatMs = 20_000,
  staleConnectionMs = 50_000,
  reconnectMaxMs = 30_000,
  allowApproxUnified = false,
  log = () => {},
}) => {
  if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > 5) throw new Error("paper mirror requires 1-5 whales");
  const normalizedPairs = pairs.map((pair, index) => ({
    pairId: String(pair.pairId ?? `pair-${index + 1}`),
    sourceAddress: normalizeAddress(pair.sourceAddress),
    targetAddress: normalizeAddress(pair.targetAddress ?? syntheticTargetAddress(pair.pairId ?? `pair-${index + 1}`)),
    capitalUsd: Number(pair.capitalUsd),
  }));
  for (const pair of normalizedPairs) if (!(pair.capitalUsd > 0)) throw new Error(`${pair.pairId}.capitalUsd must be positive`);
  const venues = new Map();
  const engine = new FiveWhaleFaithfulMirrorEngine({
    pairs: normalizedPairs,
    actorConfig,
    log,
    executionFactory: ({ pairId }) => {
      const venue = new PaperExecutionPort(venueOptions);
      venues.set(pairId, venue);
      return venue;
    },
  });
  const runtime = new PaperSourceRuntime({
    engine,
    pairs: normalizedPairs,
    venues,
    testnet,
    infoClient,
    WebSocketImpl,
    heartbeatMs,
    staleConnectionMs,
    reconnectMaxMs,
    allowApproxUnified,
    log,
  });
  return { engine, runtime, venues, pairs: normalizedPairs };
};

export class PaperSourceRuntime {
  constructor({ engine, pairs, venues, testnet, infoClient, WebSocketImpl, heartbeatMs, staleConnectionMs, reconnectMaxMs, allowApproxUnified, log }) {
    this.engine = engine;
    this.pairs = pairs;
    this.venues = venues;
    this.testnet = testnet;
    this.info = infoClient ?? new HyperliquidInfoClient({ testnet });
    this.WebSocketImpl = WebSocketImpl;
    this.log = log ?? (() => {});
    this.heartbeatMs = heartbeatMs;
    this.staleConnectionMs = staleConnectionMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.allowApproxUnified = allowApproxUnified;
    this.context = new Map();
    this.seenFillIds = new BoundedFillDeduper();
    this.eventSequence = 0;
    this.sockets = [];
    this.bookRequests = new Map();
    this.readyBooks = new Set();
    this.currentMarks = new Map();
    this.restBootstrapQueue = Promise.resolve();
    this.recoveryByPair = new Map();
    this.market = new PublicMarketSocket({
      testnet,
      WebSocketImpl,
      log: this.log,
      onBook: (coin, book) => this.#onBook(coin, book),
      onTrade: (trade) => this.#onTrade(trade),
      heartbeatMs,
      staleConnectionMs,
    });
  }

  async start() {
    this.market.start();
    for (const pair of this.pairs) {
      const mode = await this.info.accountMode(pair.sourceAddress);
      if (mode === "PORTFOLIO_MARGIN") throw new Error(`Portfolio margin paper source is unsupported: ${pair.sourceAddress}`);
      if (mode === "UNIFIED" && !this.allowApproxUnified) throw new Error(`Unified paper source requires explicit allowApproxUnified: ${pair.sourceAddress}`);
      const context = {
        ...pair,
        mode,
        snapshot: null,
        orders: null,
        bootstrapped: false,
        bootstrapPromise: null,
        buffer: [],
        lastFillTime: null,
        targetLastFillTime: null,
        firstFundingSnapshotSeen: false,
        firstFillSnapshotSeen: false,
        leverage: new ActiveLeverageCache(),
        recoveredOrderOwnership: new Map(),
      };
      this.#applyRecovery(context, this.recoveryByPair.get(context.pairId));
      this.context.set(pair.sourceAddress, context);
      const socket = new UserSocket({
        address: pair.sourceAddress,
        role: "source",
        testnet: this.testnet,
        WebSocketImpl: this.WebSocketImpl,
        onOpen: () => this.#onOpen(context),
        onMessage: (event) => this.#onMessage(context, event.message, event.error),
        onClose: () => this.log({ type: "PAPER_SOURCE_WS_CLOSE", sourceAddress: pair.sourceAddress, at: Date.now() }),
        heartbeatMs: this.heartbeatMs,
        staleConnectionMs: this.staleConnectionMs,
        reconnectMaxMs: this.reconnectMaxMs,
        subscriptions: [
          { type: "allDexsClearinghouseState", user: pair.sourceAddress },
          { type: "userFills", user: pair.sourceAddress, aggregateByTime: false },
          { type: "orderUpdates", user: pair.sourceAddress },
          { type: "userFundings", user: pair.sourceAddress },
        ],
      });
      this.sockets.push(socket);
      socket.start();
    }
  }

  stop() {
    for (const socket of this.sockets) socket.stop();
    this.market.stop();
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
    for (const context of this.context.values()) this.#applyRecovery(context, this.recoveryByPair.get(context.pairId));
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
    return {
      schemaVersion: 1,
      generatedAt: Date.now(),
      pairs: [...this.context.values()].map((context) => this.#recoveryPair(context, enginePairs[context.pairId])),
    };
  }

  async reconcile() {
    for (const context of this.context.values()) {
      if (this.#isTerminalContext(context)) continue;
      const state = await this.info.allDexsState(context.sourceAddress);
      await this.#acceptSnapshot(context, state);
      context.orders = await this.#decorateOrders(context, await this.info.openOrders(context.sourceAddress, { allDexsState: state }));
      for (const order of context.orders) await this.#ensureBook(order.coin);
      if (context.bootstrapped) await this.engine.syncSourceOrders(context.sourceAddress, context.orders);
      await this.#tryBootstrap(context);
    }
    await this.engine.whenIdle();
    return { accepted: true, pairCount: this.context.size };
  }

  #isTerminalContext(context) {
    if (!context) return true;
    if (typeof this.engine.isPairTerminal === "function") return this.engine.isPairTerminal(context.pairId);
    const actor = this.engine?.snapshot?.()?.pairs?.[context.pairId];
    return actor?.killed === true || actor?.blocked === true || actor?.stopped === true;
  }

  async #onOpen(context) {
    if (this.#isTerminalContext(context)) return { ignored: true, reason: "PAIR_TERMINAL" };
    // REST bootstrap is serialized across the five whales. Each wallet fans
    // out across every perp DEX, so allowing all five sockets to bootstrap at
    // once can exhaust the shared public info quota and leave a partial state.
    const task = this.restBootstrapQueue.catch(() => {}).then(async () => {
      if (this.#isTerminalContext(context)) return;
      const allDexsState = await this.info.allDexsState(context.sourceAddress);
      await this.#acceptSnapshot(context, allDexsState);
      context.orders = await this.#decorateOrders(context, await this.info.openOrders(context.sourceAddress, { allDexsState }));
      for (const order of context.orders) await this.#ensureBook(order.coin);
      if (context.lastFillTime != null) {
        const fills = await this.info.fillsSince(context.sourceAddress, Math.max(0, context.lastFillTime - 1_000));
        for (const fill of fills) await this.#handleFill(context, fill, true);
        if (context.bootstrapped) await this.engine.syncSourceOrders(context.sourceAddress, context.orders);
      }
      await this.#tryBootstrap(context);
    });
    this.restBootstrapQueue = task.catch(() => {});
    return task;
  }

  async #onMessage(context, message, error) {
    // A terminal pair keeps its socket alive so active pairs need no global
    // reconnect, but its late/queued source events are deliberate no-ops.
    if (this.#isTerminalContext(context)) return;
    if (error) {
      this.log({ type: "PAPER_SOURCE_WS_ERROR", sourceAddress: context.sourceAddress, message: error instanceof Error ? error.message : String(error), at: Date.now() });
      return;
    }
    if (message?.channel === "allDexsClearinghouseState") {
      await this.#acceptSnapshot(context, message.data);
      await this.#tryBootstrap(context);
      return;
    }
    if (message?.channel === "userFills") {
      const data = record(message.data);
      const isSnapshot = data?.isSnapshot === true;
      if (isSnapshot && !context.firstFillSnapshotSeen) {
        context.firstFillSnapshotSeen = true;
        return;
      }
      for (const raw of Array.isArray(data?.fills) ? data.fills : []) {
        const fill = parseUserFill(raw);
        if (fill) await this.#handleFill(context, fill, false);
      }
      return;
    }
    if (message?.channel === "userFundings") {
      const data = record(message.data);
      const isSnapshot = data?.isSnapshot === true;
      const values = Array.isArray(data?.fundings) ? data.fundings : Array.isArray(data?.funding) ? data.funding : [];
      if (isSnapshot && !context.firstFundingSnapshotSeen) {
        context.firstFundingSnapshotSeen = true;
        return;
      }
      for (const raw of values) {
        const funding = parseUserFunding(raw);
        if (funding) this.#applyScaledFunding(context, funding);
      }
      return;
    }
    if (message?.channel === "orderUpdates") {
      const values = Array.isArray(message.data) ? message.data : Array.isArray(record(message.data)?.orderUpdates) ? record(message.data).orderUpdates : [];
      for (const raw of values) {
        const update = parseOrderUpdate(raw);
        if (!update) continue;
        update.order.leverage = await context.leverage.resolve(update.order.coin, () => this.info.activeLeverage(context.sourceAddress, update.order.coin));
        update.order.poolId = context.mode === "UNIFIED" ? "unified" : update.order.coin.includes(":") ? update.order.coin.split(":", 1)[0] : "main";
        await this.#ensureBook(update.order.coin);
        if (context.bootstrapped) await this.engine.onSourceOrder(context.sourceAddress, update);
        else context.buffer.push({ type: "order", update, sequence: ++this.eventSequence });
      }
    }
  }

  async #handleFill(context, fill, backfill) {
    if (this.#isTerminalContext(context)) return { ignored: true, reason: "PAIR_TERMINAL" };
    const key = fillId(context.sourceAddress, fill);
    if (this.seenFillIds.has(key, fill.time)) return;
    this.seenFillIds.add(key, fill.time);
    context.lastFillTime = Math.max(context.lastFillTime ?? 0, fill.time);
    const existing = context.snapshot?.positions?.find((position) => position.coin === fill.coin);
    fill.leverage = existing?.leverage ?? await context.leverage.resolve(fill.coin, () => this.info.activeLeverage(context.sourceAddress, fill.coin));
    fill.marginUsedUsd = existing?.marginUsedUsd;
    fill.poolId = existing?.poolId ?? (context.mode === "UNIFIED" ? "unified" : fill.coin.includes(":") ? fill.coin.split(":", 1)[0] : "main");
    await this.#ensureBook(fill.coin);
    if (context.bootstrapped) this.engine.onSourceFill(context.sourceAddress, fill);
    else context.buffer.push({ type: "fill", fill, sequence: ++this.eventSequence });
    this.log({ type: backfill ? "PAPER_BACKFILL_FILL" : "PAPER_SOURCE_FILL", sourceAddress: context.sourceAddress, coin: fill.coin, at: Date.now() });
  }

  #applyScaledFunding(context, funding) {
    if (this.#isTerminalContext(context)) return;
    if (!context.bootstrapped || Math.abs(funding.sourceSize) <= 1e-12) return;
    const pair = this.pairs.find((item) => item.pairId === context.pairId);
    const venue = this.venues.get(context.pairId);
    if (!pair || !venue) return;
    const targetSize = venue.getSnapshot(context.pairId).positions.find((position) => position.coin === funding.coin)?.signedSize ?? 0;
    const scale = targetSize / funding.sourceSize;
    const amountUsd = funding.usdc * scale;
    if (!Number.isFinite(amountUsd) || Math.abs(amountUsd) <= 1e-12) return;
    venue.applyFunding({ pairId: context.pairId, coin: funding.coin, amountUsd });
    this.engine.onTargetSnapshot(pair.targetAddress, venue.getSnapshot(context.pairId));
    this.log({ type: "PAPER_FUNDING", pairId: context.pairId, coin: funding.coin, sourceFundingUsd: funding.usdc, targetFundingUsd: amountUsd, at: Date.now() });
  }

  async #ensureBook(coin) {
    const normalized = normalizeCoin(coin);
    this.market.subscribe(normalized);
    if (this.readyBooks.has(normalized)) return;
    const current = this.bookRequests.get(normalized);
    if (current) return current;
    const request = Promise.resolve().then(() => this.info.l2Book(normalized)).then((book) => {
      this.#onBook(normalized, book);
      return book;
    }).finally(() => this.bookRequests.delete(normalized));
    this.bookRequests.set(normalized, request);
    return request;
  }

  #onBook(coin, book) {
    const normalizedCoin = normalizeCoin(coin);
    this.readyBooks.add(normalizedCoin);
    const bestBid = Number(book?.bids?.[0]?.price ?? book?.bids?.[0]?.px ?? book?.bids?.[0]?.[0]);
    const bestAsk = Number(book?.asks?.[0]?.price ?? book?.asks?.[0]?.px ?? book?.asks?.[0]?.[0]);
    const mark = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid > 0 ? bestBid : bestAsk > 0 ? bestAsk : null;
    if (mark != null) this.currentMarks.set(normalizedCoin, mark);
    for (const [pairId, venue] of this.venues) {
      const pair = this.pairs.find((item) => item.pairId === pairId);
      const context = pair ? this.context.get(pair.sourceAddress) : null;
      if (context && this.#isTerminalContext(context)) continue;
      venue.setBook(coin, book);
      if (!venue.hasPair(pairId)) continue;
      const snapshot = venue.getSnapshot(pairId);
      const hasPosition = snapshot.positions.some((position) => normalizeCoin(position.coin) === normalizeCoin(coin));
      const sourceTracksCoin = Boolean(context?.snapshot?.positions?.some((position) => normalizeCoin(position.coin) === normalizedCoin)
        || context?.orders?.some((order) => normalizeCoin(order.coin) === normalizedCoin));
      if (pair && mark != null && (sourceTracksCoin || hasPosition)) this.engine.onCurrentMark(pair.sourceAddress, normalizedCoin, mark);
      if (pair && hasPosition) this.engine.onTargetSnapshot(pair.targetAddress, snapshot);
    }
  }

  #onTrade(trade) {
    for (const [pairId, venue] of this.venues) {
      if (!venue.hasPair(pairId)) continue;
      const pair = this.pairs.find((item) => item.pairId === pairId);
      if (!pair) continue;
      const context = this.context.get(pair.sourceAddress);
      if (this.#isTerminalContext(context)) continue;
      const fills = venue.applyPublicTrade({ pairId, ...trade });
      for (const rawFill of fills) {
        const observedAt = Date.now();
        const signedSize = (String(rawFill.side).toUpperCase() === "B" || String(rawFill.side).toUpperCase() === "BUY") ? Number(rawFill.size) : -Number(rawFill.size);
        const fill = {
          ...rawFill,
          time: Number.isFinite(Number(rawFill.time)) ? Number(rawFill.time) : observedAt,
          startPosition: Number.isFinite(Number(rawFill.startPosition)) ? Number(rawFill.startPosition) : Number(rawFill.positionAfter) - signedSize,
          oid: rawFill.oid ?? rawFill.targetOrderId ?? null,
        };
        const key = fillId(pair.targetAddress, fill);
        if (this.seenFillIds.has(key, fill.time)) continue;
        this.seenFillIds.add(key, fill.time);
        if (context) context.targetLastFillTime = Math.max(context.targetLastFillTime ?? 0, fill.time);
        this.engine.onTargetFill(pair.targetAddress, fill);
      }
      if (fills.length > 0) this.engine.onTargetSnapshot(pair.targetAddress, venue.getSnapshot(pairId));
    }
  }

  async #tryBootstrap(context) {
    if (this.#isTerminalContext(context)) return;
    if (context.bootstrapped || !context.snapshot || !context.orders) return;
    if (context.bootstrapPromise) return context.bootstrapPromise;
    context.bootstrapPromise = (async () => {
      if (context.recoveredOrderOwnership.size) {
        if (typeof this.engine.restoreOrderOwnership !== "function") throw new Error(`Engine does not support fail-closed order ownership recovery for ${context.pairId}`);
        this.engine.restoreOrderOwnership(context.pairId, {
          sourceOrderToTargetCloid: Object.fromEntries(context.recoveredOrderOwnership),
          // A virtual PAPER venue is recreated independently. It must retain
          // the canonical Cloid, but cannot claim an unobserved live order.
          targetOpenOrders: [],
          requireTargetOpen: false,
          preserveExistingShadow: false,
        });
        context.recoveredOrderOwnership.clear();
      }
      const targetSnapshot = targetSnapshotFor(context.snapshot, context.capitalUsd);
      await this.engine.bootstrapPair(context.pairId, {
        sourceSnapshot: context.snapshot,
        targetSnapshot,
        sourceOpenOrders: context.orders,
        currentMarks: this.currentMarks,
      });
      context.bootstrapped = true;
      for (const event of context.buffer.splice(0).sort((left, right) => left.sequence - right.sequence)) {
        if (event.type === "fill") this.engine.onSourceFill(context.sourceAddress, event.fill);
        else await this.engine.onSourceOrder(context.sourceAddress, event.update);
      }
      await this.engine.whenIdle();
      this.log({ type: "PAPER_PAIR_BOOTSTRAPPED", pairId: context.pairId, sourceAddress: context.sourceAddress, capitalUsd: context.capitalUsd, at: Date.now() });
    })();
    try {
      return await context.bootstrapPromise;
    } finally {
      context.bootstrapPromise = null;
    }
  }

  async #decorateOrders(context, orders) {
    return Promise.all(orders.map(async (order) => ({
      ...order,
      leverage: await context.leverage.resolve(order.coin, () => this.info.activeLeverage(context.sourceAddress, order.coin)),
      poolId: context.mode === "UNIFIED" ? "unified" : order.poolId,
    })));
  }

  async #acceptSnapshot(context, payload) {
    if (this.#isTerminalContext(context)) return;
    const portfolioEquityUsd = context.mode === "UNIFIED" ? await this.info.portfolioEquity(context.sourceAddress) : null;
    const snapshot = parseAllDexsAccountSnapshot({ payload, accountMode: context.mode, portfolioEquityUsd });
    context.snapshot = snapshot;
    for (const position of snapshot.positions) {
      context.leverage.seed(position.coin, position.leverage);
      await this.#ensureBook(position.coin);
    }
    if (context.bootstrapped) this.engine.onSourceSnapshot(context.sourceAddress, snapshot);
  }

  #applyRecovery(context, checkpoint) {
    if (!checkpoint) return;
    if (checkpoint.sourceAddress && normalizeAddress(checkpoint.sourceAddress) !== context.sourceAddress) throw new Error(`Recovery source mismatch for ${context.pairId}`);
    if (checkpoint.targetAddress && normalizeAddress(checkpoint.targetAddress) !== context.targetAddress) throw new Error(`Recovery target mismatch for ${context.pairId}`);
    const recoveredMode = String(checkpoint.accountMode ?? "").trim().toUpperCase();
    if (recoveredMode && recoveredMode !== "UNKNOWN" && recoveredMode !== context.mode) throw new Error(`Recovery account mode changed for ${context.pairId}`);
    context.lastFillTime = Number.isFinite(Number(checkpoint.lastSourceFillTime ?? checkpoint.lastFillTime))
      ? Number(checkpoint.lastSourceFillTime ?? checkpoint.lastFillTime)
      : context.lastFillTime;
    context.targetLastFillTime = Number.isFinite(Number(checkpoint.lastTargetFillTime))
      ? Number(checkpoint.lastTargetFillTime)
      : context.targetLastFillTime;
    for (const key of checkpoint.recentSourceFillIds ?? checkpoint.recentFillIds ?? []) this.seenFillIds.add(key, context.lastFillTime ?? Date.now());
    for (const key of checkpoint.recentTargetFillIds ?? []) this.seenFillIds.add(key, context.targetLastFillTime ?? Date.now());
    context.recoveredOrderOwnership = this.#parseRecoveredOrderOwnership(context.pairId, checkpoint.sourceOrderToTargetCloid);
  }

  #recoveryPair(context, actor) {
    const ids = this.seenFillIds.snapshot();
    const sourcePrefix = `${context.sourceAddress}|`;
    const targetPrefix = `${context.targetAddress}|`;
    const sourceOrderToTargetCloid = Object.fromEntries((actor?.targetOrderState ?? []).flatMap((order) => {
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
      lastSourceFillTime: context.lastFillTime,
      lastTargetFillTime: context.targetLastFillTime,
      recentSourceFillIds: ids.filter((entry) => entry.id.startsWith(sourcePrefix)).map((entry) => entry.id),
      recentTargetFillIds: ids.filter((entry) => entry.id.startsWith(targetPrefix)).map((entry) => entry.id),
      sourceOrderToTargetCloid,
      accountMode: context.mode ?? "UNKNOWN",
      lastSourceSnapshotAt: Number.isFinite(Number(context.snapshot?.receivedAt)) ? Number(context.snapshot.receivedAt) : null,
      lastTargetSnapshotAt: Number.isFinite(Number(actor?.targetSnapshot?.receivedAt)) ? Number(actor.targetSnapshot.receivedAt) : null,
      killSwitch: actor?.killed === true || actor?.blocked === true,
    };
  }
}
