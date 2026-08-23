import { normalizeCoin, positionSizeForCoin, ZERO_EPSILON } from "./domain.mjs";

const clone = (value) => structuredClone(value);
const sideSign = (side) => String(side).toUpperCase() === "BUY" || String(side).toUpperCase() === "B" ? 1 : -1;

export const walkBook = ({ side, size, bids = [], asks = [], limitPrice = null }) => {
  let remaining = Math.max(0, Number(size));
  const levels = sideSign(side) > 0 ? asks : bids;
  let filledSize = 0;
  let filledNotionalUsd = 0;
  const fills = [];
  for (const raw of levels) {
    if (remaining <= ZERO_EPSILON) break;
    const price = Number(raw.price ?? raw.px ?? raw[0]);
    const available = Number(raw.size ?? raw.sz ?? raw[1]);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(available) || available <= 0) continue;
    if (limitPrice != null) {
      if (sideSign(side) > 0 && price > limitPrice + 1e-12) break;
      if (sideSign(side) < 0 && price < limitPrice - 1e-12) break;
    }
    const quantity = Math.min(remaining, available);
    fills.push({ price, size: quantity });
    filledSize += quantity;
    filledNotionalUsd += quantity * price;
    remaining -= quantity;
  }
  return {
    requestedSize: Number(size),
    filledSize,
    averagePrice: filledSize > 0 ? filledNotionalUsd / filledSize : null,
    filledNotionalUsd,
    unfilledSize: Math.max(0, remaining),
    fills,
  };
};

export class PaperExecutionPort {
  constructor(options = {}) {
    this.pairs = new Map();
    this.books = new Map();
    this.now = options.now ?? Date.now;
    this.defaultSlippageBps = options.defaultSlippageBps ?? 50;
    this.takerFeeRate = options.takerFeeRate ?? 0.00045;
    this.makerFeeRate = options.makerFeeRate ?? 0.00015;
    this.events = [];
  }

  registerPair(pairOrId, snapshot) {
    const pairId = typeof pairOrId === "object" ? pairOrId.pairId : pairOrId;
    const targetSnapshot = typeof pairOrId === "object" ? pairOrId.targetSnapshot : snapshot;
    if (!pairId || !targetSnapshot) throw new Error("paper pair registration requires pairId and targetSnapshot");
    const prior = this.pairs.get(pairId);
    const poolCash = prior?.poolCash ?? new Map(Object.entries(targetSnapshot.marginPools ?? { default: { equityUsd: targetSnapshot.accountEquityUsd } })
      .map(([poolId, pool]) => [poolId, Number(pool.equityUsd)]));
    const pair = {
      snapshot: clone(targetSnapshot),
      leverage: prior?.leverage ?? new Map(),
      isolatedMargin: prior?.isolatedMargin ?? new Map(),
      orders: prior?.orders ?? new Map(),
      poolCash,
      realizedPnlUsd: prior?.realizedPnlUsd ?? 0,
      feesUsd: prior?.feesUsd ?? 0,
      fundingUsd: prior?.fundingUsd ?? 0,
    };
    this.pairs.set(pairId, pair);
    this.#recomputeEquity(pair);
    return { accepted: true };
  }

  setBook(coin, book) {
    const normalized = normalizeCoin(coin);
    this.books.set(normalized, clone(book));
    const mark = this.#mid(book);
    if (mark == null) return;
    for (const pair of this.pairs.values()) {
      const position = (pair.snapshot.positions ?? []).find((item) => normalizeCoin(item.coin) === normalized);
      if (position) {
        position.markPriceUsd = mark;
        position.positionValueUsd = Math.abs(Number(position.signedSize)) * mark;
        this.#recomputeEquity(pair);
      }
    }
  }

  hasPair(pairId) {
    return this.pairs.has(String(pairId));
  }

  getSnapshot(pairId) {
    const pair = this.#pair(pairId);
    this.#recomputeEquity(pair);
    return clone(pair.snapshot);
  }

  getPerformance(pairId) {
    const pair = this.#pair(pairId);
    this.#recomputeEquity(pair);
    return {
      accountEquityUsd: pair.snapshot.accountEquityUsd,
      realizedPnlUsd: pair.realizedPnlUsd,
      unrealizedPnlUsd: (pair.snapshot.positions ?? []).reduce((sum, position) => sum + Number(position.unrealizedPnlUsd ?? 0), 0),
      feesUsd: pair.feesUsd,
      fundingUsd: pair.fundingUsd,
    };
  }

  getEvents() {
    return clone(this.events);
  }

  async setLeverage({ pairId, coin, leverage }) {
    const pair = this.#pair(pairId);
    pair.leverage.set(normalizeCoin(coin), clone(leverage));
    this.#record("SET_LEVERAGE", { pairId, coin: normalizeCoin(coin), leverage });
    return { accepted: true };
  }

  async adjustIsolatedMargin({ pairId, coin, targetMarginUsd }) {
    const pair = this.#pair(pairId);
    const normalized = normalizeCoin(coin);
    pair.isolatedMargin.set(normalized, Number(targetMarginUsd));
    const position = (pair.snapshot.positions ?? []).find((item) => normalizeCoin(item.coin) === normalized);
    if (position) position.marginUsedUsd = Number(targetMarginUsd);
    this.#record("ADJUST_ISOLATED_MARGIN", { pairId, coin: normalized, targetMarginUsd: Number(targetMarginUsd) });
    return { accepted: true, marginUsedUsd: Number(targetMarginUsd) };
  }

  applyFunding({ pairId, coin, amountUsd }) {
    const pair = this.#pair(pairId);
    const normalized = normalizeCoin(coin);
    const position = (pair.snapshot.positions ?? []).find((item) => normalizeCoin(item.coin) === normalized);
    const poolId = position?.poolId ?? "default";
    pair.poolCash.set(poolId, (pair.poolCash.get(poolId) ?? 0) + Number(amountUsd));
    pair.fundingUsd += Number(amountUsd);
    this.#recomputeEquity(pair);
    this.#record("FUNDING", { pairId, coin: normalized, amountUsd: Number(amountUsd) });
  }

  async upsertOrder({ pairId, order }) {
    const pair = this.#pair(pairId);
    const coin = normalizeCoin(order.coin);
    const book = this.books.get(coin);
    const existing = pair.orders.get(order.targetOrderId);
    const record = {
      ...clone(order),
      coin,
      poolId: order.poolId ?? "default",
      targetOrderId: order.targetOrderId,
      remainingSize: Number(order.quantity),
      filledSize: existing?.filledSize ?? 0,
      queueAheadSize: this.#queueAhead(book, order),
      placedAt: this.now(),
      status: "OPEN",
    };
    if (record.tif === "IOC" || this.#marketable(book, record)) {
      if (record.tif === "ALO") {
        this.#record("ORDER_REJECTED", { pairId, order: record, reason: "ALO_WOULD_CROSS" });
        return { accepted: false, status: "REJECTED", reason: "ALO_WOULD_CROSS" };
      }
      const result = this.#executeAgainstBook(pairId, pair, record, book, record.price, this.takerFeeRate);
      record.filledSize += result.filledSize;
      record.remainingSize = result.unfilledSize;
      record.status = record.remainingSize <= ZERO_EPSILON ? "FILLED" : record.tif === "IOC" ? "CANCELED" : "OPEN";
    }
    if (record.status === "OPEN") pair.orders.set(record.targetOrderId, record);
    else pair.orders.delete(record.targetOrderId);
    this.#record(existing ? "MODIFY_ORDER" : "PLACE_ORDER", { pairId, order: record });
    return { accepted: true, status: record.status, order: clone(record) };
  }

  async cancelOrder({ pairId, targetOrderId, reason = "SOURCE_CANCEL" }) {
    const pair = this.#pair(pairId);
    const existing = pair.orders.get(targetOrderId);
    pair.orders.delete(targetOrderId);
    this.#record("CANCEL_ORDER", { pairId, targetOrderId, reason, existed: Boolean(existing) });
    return { accepted: true, status: existing ? "CANCELED" : "ALREADY_TERMINAL" };
  }

  async protectedIoc({ pairId, coin, deltaSize, markPriceUsd, maxSlippageBps = this.defaultSlippageBps, reduceOnly = false, poolId = "default", leverage }) {
    const pair = this.#pair(pairId);
    const normalized = normalizeCoin(coin);
    const side = deltaSize > 0 ? "BUY" : "SELL";
    const size = Math.abs(Number(deltaSize));
    const reference = Number(markPriceUsd);
    const slippage = Number(maxSlippageBps) / 10_000;
    const limitPrice = side === "BUY" ? reference * (1 + slippage) : reference * (1 - slippage);
    const result = walkBook({ side, size, ...(this.books.get(normalized) ?? {}), limitPrice });
    if (result.filledSize > 0) {
      let signedFill = sideSign(side) * result.filledSize;
      const current = positionSizeForCoin(pair.snapshot, normalized);
      if (reduceOnly && current !== 0 && current * signedFill < 0 && Math.abs(signedFill) > Math.abs(current)) signedFill = -current;
      this.#applyFill(pairId, pair, {
        coin: normalized,
        signedFillSize: signedFill,
        price: result.averagePrice ?? reference,
        feeRate: this.takerFeeRate,
        poolId,
        leverage: leverage ?? pair.leverage.get(normalized) ?? { type: "cross", value: 1 },
      });
    }
    const actualSignedSize = positionSizeForCoin(pair.snapshot, normalized);
    this.#record("PROTECTED_IOC", {
      pairId,
      coin: normalized,
      side,
      requestedSize: size,
      filledSize: result.filledSize,
      unfilledSize: result.unfilledSize,
      averagePrice: result.averagePrice,
      actualSignedSize,
      reduceOnly,
    });
    return {
      accepted: result.unfilledSize <= ZERO_EPSILON,
      actualSignedSize,
      ...result,
    };
  }

  applyPublicTrade({ pairId, coin, price, size, aggressorSide }) {
    const pair = this.#pair(pairId);
    const normalized = normalizeCoin(coin);
    let remainingTradeSize = Number(size);
    const emittedFills = [];
    const orders = [...pair.orders.values()]
      .filter((order) => order.coin === normalized && order.status === "OPEN")
      .sort((a, b) => a.placedAt - b.placedAt);
    for (const order of orders) {
      if (remainingTradeSize <= ZERO_EPSILON) break;
      const orderSide = sideSign(order.side);
      const hit = orderSide > 0
        ? String(aggressorSide).toUpperCase() === "SELL" && Number(price) <= Number(order.price)
        : String(aggressorSide).toUpperCase() === "BUY" && Number(price) >= Number(order.price);
      if (!hit) continue;
      const queueConsumed = Math.min(order.queueAheadSize, remainingTradeSize);
      order.queueAheadSize -= queueConsumed;
      remainingTradeSize -= queueConsumed;
      if (remainingTradeSize <= ZERO_EPSILON || order.queueAheadSize > ZERO_EPSILON) continue;
      const fillSize = Math.min(order.remainingSize, remainingTradeSize);
      order.remainingSize -= fillSize;
      order.filledSize += fillSize;
      remainingTradeSize -= fillSize;
      const fill = this.#applyFill(pairId, pair, {
        coin: normalized,
        signedFillSize: orderSide * fillSize,
        price: Number(order.price),
        feeRate: this.makerFeeRate,
        poolId: order.poolId,
        leverage: order.leverage ?? pair.leverage.get(normalized) ?? { type: "cross", value: 1 },
      });
      emittedFills.push({
        coin: normalized,
        side: orderSide > 0 ? "B" : "A",
        size: fillSize,
        price: Number(order.price),
        positionAfter: fill.nextSize,
        leverage: clone(order.leverage ?? pair.leverage.get(normalized) ?? { type: "cross", value: 1 }),
        poolId: order.poolId,
        targetOrderId: order.targetOrderId,
      });
      if (order.remainingSize <= ZERO_EPSILON) {
        order.status = "FILLED";
        pair.orders.delete(order.targetOrderId);
      }
      this.#record("RESTING_FILL", { pairId, coin: normalized, targetOrderId: order.targetOrderId, fillSize, price: Number(order.price) });
    }
    return emittedFills;
  }

  async onUnresolvedResidual(payload) {
    this.#record("UNRESOLVED_RESIDUAL", payload);
    return { accepted: true };
  }

  #executeAgainstBook(pairId, pair, order, book, limitPrice, feeRate) {
    const result = walkBook({ side: order.side, size: order.remainingSize, ...(book ?? {}), limitPrice });
    if (result.filledSize > 0) {
      this.#applyFill(pairId, pair, {
        coin: order.coin,
        signedFillSize: sideSign(order.side) * result.filledSize,
        price: result.averagePrice ?? order.price,
        feeRate,
        poolId: order.poolId,
        leverage: order.leverage ?? pair.leverage.get(order.coin) ?? { type: "cross", value: 1 },
      });
    }
    return result;
  }

  #applyFill(pairId, pair, { coin, signedFillSize, price, feeRate, poolId, leverage }) {
    if (Math.abs(signedFillSize) <= ZERO_EPSILON) return { nextSize: positionSizeForCoin(pair.snapshot, coin), realizedPnlUsd: 0, feeUsd: 0 };
    const positions = pair.snapshot.positions ?? (pair.snapshot.positions = []);
    const index = positions.findIndex((position) => normalizeCoin(position.coin) === coin);
    const current = index >= 0 ? positions[index] : null;
    const currentSize = Number(current?.signedSize ?? 0);
    const entry = Number(current?.averageEntryPriceUsd ?? current?.entryPriceUsd ?? price);
    const nextSize = currentSize + signedFillSize;
    let realizedPnlUsd = 0;
    let nextEntry = entry;
    if (Math.abs(currentSize) <= ZERO_EPSILON || Math.sign(currentSize) === Math.sign(signedFillSize)) {
      nextEntry = (Math.abs(currentSize) * entry + Math.abs(signedFillSize) * price) / Math.abs(nextSize);
    } else {
      const closingSize = Math.min(Math.abs(currentSize), Math.abs(signedFillSize));
      realizedPnlUsd = closingSize * (price - entry) * Math.sign(currentSize);
      if (Math.abs(signedFillSize) > Math.abs(currentSize) + ZERO_EPSILON) nextEntry = price;
    }
    const feeUsd = Math.abs(signedFillSize) * price * feeRate;
    pair.poolCash.set(poolId, (pair.poolCash.get(poolId) ?? 0) + realizedPnlUsd - feeUsd);
    pair.realizedPnlUsd += realizedPnlUsd;
    pair.feesUsd += feeUsd;
    if (Math.abs(nextSize) <= ZERO_EPSILON) {
      if (index >= 0) positions.splice(index, 1);
    } else {
      const next = {
        ...(current ?? {}),
        coin,
        poolId,
        signedSize: nextSize,
        averageEntryPriceUsd: nextEntry,
        entryPriceUsd: nextEntry,
        markPriceUsd: price,
        positionValueUsd: Math.abs(nextSize) * price,
        leverage: clone(leverage),
      };
      if (index >= 0) positions[index] = next;
      else positions.push(next);
    }
    this.#recomputeEquity(pair);
    this.#record("PAPER_FILL", { pairId, coin, signedFillSize, price, realizedPnlUsd, feeUsd, nextSize });
    return { nextSize, realizedPnlUsd, feeUsd };
  }

  #recomputeEquity(pair) {
    const poolUnrealized = new Map();
    for (const position of pair.snapshot.positions ?? []) {
      const mark = Number(position.markPriceUsd ?? position.entryPriceUsd ?? 0);
      const entry = Number(position.averageEntryPriceUsd ?? position.entryPriceUsd ?? mark);
      const unrealized = Number(position.signedSize) * (mark - entry);
      position.unrealizedPnlUsd = unrealized;
      position.positionValueUsd = Math.abs(Number(position.signedSize)) * mark;
      const poolId = position.poolId ?? "default";
      poolUnrealized.set(poolId, (poolUnrealized.get(poolId) ?? 0) + unrealized);
    }
    const marginPools = pair.snapshot.marginPools ?? (pair.snapshot.marginPools = {});
    const poolIds = new Set([...pair.poolCash.keys(), ...poolUnrealized.keys()]);
    let total = 0;
    for (const poolId of poolIds) {
      const equityUsd = (pair.poolCash.get(poolId) ?? 0) + (poolUnrealized.get(poolId) ?? 0);
      marginPools[poolId] = { ...(marginPools[poolId] ?? {}), equityUsd };
      total += equityUsd;
    }
    pair.snapshot.accountEquityUsd = total;
    pair.snapshot.receivedAt = this.now();
  }

  #queueAhead(book, order) {
    if (!book) return 0;
    const levels = sideSign(order.side) > 0 ? book.bids ?? [] : book.asks ?? [];
    return levels.reduce((sum, raw) => {
      const price = Number(raw.price ?? raw.px ?? raw[0]);
      const size = Number(raw.size ?? raw.sz ?? raw[1]);
      return Math.abs(price - Number(order.price)) <= 1e-12 && Number.isFinite(size) ? sum + size : sum;
    }, 0);
  }

  #marketable(book, order) {
    if (!book) return false;
    if (sideSign(order.side) > 0) {
      const bestAsk = Number((book.asks?.[0] ?? [])[0] ?? book.asks?.[0]?.price);
      return Number.isFinite(bestAsk) && Number(order.price) >= bestAsk;
    }
    const bestBid = Number((book.bids?.[0] ?? [])[0] ?? book.bids?.[0]?.price);
    return Number.isFinite(bestBid) && Number(order.price) <= bestBid;
  }

  #mid(book) {
    const bid = Number((book?.bids?.[0] ?? [])[0] ?? book?.bids?.[0]?.price);
    const ask = Number((book?.asks?.[0] ?? [])[0] ?? book?.asks?.[0]?.price);
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) return (bid + ask) / 2;
    return Number.isFinite(bid) && bid > 0 ? bid : Number.isFinite(ask) && ask > 0 ? ask : null;
  }

  #pair(pairId) {
    const pair = this.pairs.get(pairId);
    if (!pair) throw new Error(`Unknown paper pair: ${pairId}`);
    return pair;
  }

  #record(type, payload) {
    this.events.push({ type, at: this.now(), ...clone(payload) });
  }
}
