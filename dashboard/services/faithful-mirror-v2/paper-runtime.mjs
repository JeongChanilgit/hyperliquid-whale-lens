import { createHash } from "node:crypto";
import { FiveWhaleFaithfulMirrorEngine } from "./engine.mjs";
import { normalizeAddress, normalizeCoin } from "./domain.mjs";
import { PaperExecutionPort } from "./paper-venue.mjs";
import {
  HyperliquidInfoClient,
  UserSocket,
  parseAllDexsAccountSnapshot,
  parseOrderUpdate,
  parseUserFill,
  parseUserFunding,
  fillId,
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
    this.seenFillIds = new Set();
    this.eventSequence = 0;
    this.sockets = [];
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
      const context = { ...pair, mode, snapshot: null, orders: null, bootstrapped: false, buffer: [], lastFillTime: null, firstFundingSnapshotSeen: false };
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

  async #onOpen(context) {
    context.orders = (await this.info.openOrders(context.sourceAddress)).map((order) => ({
      ...order,
      poolId: context.mode === "UNIFIED" ? "unified" : order.poolId,
    }));
    for (const order of context.orders) await this.#ensureBook(order.coin);
    if (context.lastFillTime != null) {
      const fills = await this.info.fillsSince(context.sourceAddress, Math.max(0, context.lastFillTime - 1_000));
      for (const fill of fills) await this.#handleFill(context, fill, true);
      if (context.bootstrapped) await this.engine.syncSourceOrders(context.sourceAddress, context.orders);
    }
    await this.#tryBootstrap(context);
  }

  async #onMessage(context, message, error) {
    if (error) {
      this.log({ type: "PAPER_SOURCE_WS_ERROR", sourceAddress: context.sourceAddress, message: error instanceof Error ? error.message : String(error), at: Date.now() });
      return;
    }
    if (message?.channel === "allDexsClearinghouseState") {
      const portfolioEquityUsd = context.mode === "UNIFIED" ? await this.info.portfolioEquity(context.sourceAddress) : null;
      const snapshot = parseAllDexsAccountSnapshot({ payload: message.data, accountMode: context.mode, portfolioEquityUsd });
      context.snapshot = snapshot;
      for (const position of snapshot.positions) await this.#ensureBook(position.coin);
      if (context.bootstrapped) this.engine.onSourceSnapshot(context.sourceAddress, snapshot);
      await this.#tryBootstrap(context);
      return;
    }
    if (message?.channel === "userFills") {
      const data = record(message.data);
      const isSnapshot = data?.isSnapshot === true;
      if (isSnapshot && context.lastFillTime == null) return;
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
        update.order.leverage = await this.info.activeLeverage(context.sourceAddress, update.order.coin);
        update.order.poolId = context.mode === "UNIFIED" ? "unified" : update.order.coin.includes(":") ? update.order.coin.split(":", 1)[0] : "main";
        await this.#ensureBook(update.order.coin);
        if (context.bootstrapped) await this.engine.onSourceOrder(context.sourceAddress, update);
        else context.buffer.push({ type: "order", update, sequence: ++this.eventSequence });
      }
    }
  }

  async #handleFill(context, fill, backfill) {
    const key = fillId(context.sourceAddress, fill);
    if (this.seenFillIds.has(key)) return;
    this.seenFillIds.add(key);
    if (this.seenFillIds.size > 100_000) this.seenFillIds.clear();
    context.lastFillTime = Math.max(context.lastFillTime ?? 0, fill.time);
    const existing = context.snapshot?.positions?.find((position) => position.coin === fill.coin);
    fill.leverage = existing?.leverage ?? await this.info.activeLeverage(context.sourceAddress, fill.coin);
    fill.marginUsedUsd = existing?.marginUsedUsd;
    fill.poolId = existing?.poolId ?? (context.mode === "UNIFIED" ? "unified" : fill.coin.includes(":") ? fill.coin.split(":", 1)[0] : "main");
    await this.#ensureBook(fill.coin);
    if (context.bootstrapped) this.engine.onSourceFill(context.sourceAddress, fill);
    else context.buffer.push({ type: "fill", fill, sequence: ++this.eventSequence });
    this.log({ type: backfill ? "PAPER_BACKFILL_FILL" : "PAPER_SOURCE_FILL", sourceAddress: context.sourceAddress, coin: fill.coin, at: Date.now() });
  }

  #applyScaledFunding(context, funding) {
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
    const book = await this.info.l2Book(normalized);
    this.#onBook(normalized, book);
  }

  #onBook(coin, book) {
    for (const [pairId, venue] of this.venues) {
      venue.setBook(coin, book);
      if (!venue.hasPair(pairId)) continue;
      const pair = this.pairs.find((item) => item.pairId === pairId);
      const snapshot = venue.getSnapshot(pairId);
      const hasPosition = snapshot.positions.some((position) => normalizeCoin(position.coin) === normalizeCoin(coin));
      if (pair && hasPosition) this.engine.onTargetSnapshot(pair.targetAddress, snapshot);
    }
  }

  #onTrade(trade) {
    for (const [pairId, venue] of this.venues) {
      if (!venue.hasPair(pairId)) continue;
      const pair = this.pairs.find((item) => item.pairId === pairId);
      if (!pair) continue;
      const fills = venue.applyPublicTrade({ pairId, ...trade });
      for (const fill of fills) this.engine.onTargetFill(pair.targetAddress, fill);
      if (fills.length > 0) this.engine.onTargetSnapshot(pair.targetAddress, venue.getSnapshot(pairId));
    }
  }

  async #tryBootstrap(context) {
    if (context.bootstrapped || !context.snapshot || !context.orders) return;
    const targetSnapshot = targetSnapshotFor(context.snapshot, context.capitalUsd);
    await this.engine.bootstrapPair(context.pairId, { sourceSnapshot: context.snapshot, targetSnapshot, sourceOpenOrders: context.orders });
    context.bootstrapped = true;
    for (const event of context.buffer.splice(0).sort((left, right) => left.sequence - right.sequence)) {
      if (event.type === "fill") this.engine.onSourceFill(context.sourceAddress, event.fill);
      else await this.engine.onSourceOrder(context.sourceAddress, event.update);
    }
    await this.engine.whenIdle();
    this.log({ type: "PAPER_PAIR_BOOTSTRAPPED", pairId: context.pairId, sourceAddress: context.sourceAddress, capitalUsd: context.capitalUsd, at: Date.now() });
  }
}
