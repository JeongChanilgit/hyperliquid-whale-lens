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
    this.minOrderSize = Number(options.minOrderSize ?? 0);
    this.minNotionalUsd = Number(options.minNotionalUsd ?? 0);
    this.maintenanceMarginRatio = Number(options.maintenanceMarginRatio ?? 0.025);
    this.simulationModelVersion = String(options.simulationModelVersion ?? "FMV2_PAPER_APPROX_MARGIN_V1");
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
      marginState: prior?.marginState ?? { status: "HEALTHY", reason: null, approximateLiquidationRisk: false },
    };
    pair.snapshot.simulationModelVersion = this.simulationModelVersion;
    pair.snapshot.liquidationModel = "APPROXIMATE";
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
      simulationModelVersion: this.simulationModelVersion,
      liquidationModel: "APPROXIMATE",
      marginState: clone(pair.marginState),
    };
  }

  getEvents() {
    return clone(this.events);
  }

  async setLeverage({ pairId, coin, leverage }) {
    const pair = this.#pair(pairId);
    if (!leverage || !["cross", "isolated"].includes(String(leverage.type).toLowerCase()) || !(Number(leverage.value) >= 1)) {
      return { accepted: false, status: "REJECTED", reason: "INVALID_LEVERAGE" };
    }
    pair.leverage.set(normalizeCoin(coin), clone(leverage));
    this.#record("SET_LEVERAGE", { pairId, coin: normalizeCoin(coin), leverage });
    return { accepted: true };
  }

  async adjustIsolatedMargin({ pairId, coin, targetMarginUsd }) {
    const pair = this.#pair(pairId);
    const normalized = normalizeCoin(coin);
    const nextMargin = Number(targetMarginUsd);
    if (!(nextMargin >= 0) || !Number.isFinite(nextMargin)) return { accepted: false, status: "REJECTED", reason: "INVALID_ISOLATED_MARGIN" };
    const position = (pair.snapshot.positions ?? []).find((item) => normalizeCoin(item.coin) === normalized);
    const poolId = position?.poolId ?? "default";
    const currentMargin = Number(pair.isolatedMargin.get(normalized) ?? position?.marginUsedUsd ?? 0);
    const available = this.#poolEquity(pair, poolId) - this.#reservedIsolatedMargin(pair, poolId, normalized);
    if (nextMargin > available + currentMargin + 1e-9) {
      this.#blockMargin(pair, pairId, "ISOLATED_MARGIN_INSUFFICIENT", { coin: normalized, targetMarginUsd: nextMargin, availableUsd: available + currentMargin });
      return { accepted: false, status: "REJECTED", reason: "ISOLATED_MARGIN_INSUFFICIENT" };
    }
    pair.isolatedMargin.set(normalized, nextMargin);
    if (position) position.marginUsedUsd = nextMargin;
    this.#record("ADJUST_ISOLATED_MARGIN", { pairId, coin: normalized, targetMarginUsd: nextMargin });
    return { accepted: true, marginUsedUsd: nextMargin };
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
    const validation = this.#validateOrder(order);
    if (!validation.accepted) {
      this.#record("ORDER_REJECTED", { pairId, order: clone(order), reason: validation.reason });
      return validation;
    }
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
    const validation = this.#validateOrder({ coin: normalized, quantity: size, price: reference, side, poolId, leverage });
    if (!validation.accepted) {
      this.#record("PROTECTED_IOC_REJECTED", { pairId, coin: normalized, side, requestedSize: size, reason: validation.reason });
      return { accepted: false, status: "REJECTED", reason: validation.reason, actualSignedSize: positionSizeForCoin(pair.snapshot, normalized), filledSize: 0, unfilledSize: size, averagePrice: null };
    }
    const slippage = Number(maxSlippageBps) / 10_000;
    const limitPrice = side === "BUY" ? reference * (1 + slippage) : reference * (1 - slippage);
    const result = walkBook({ side, size, ...(this.books.get(normalized) ?? {}), limitPrice });
    if (result.filledSize > 0) {
      let signedFill = sideSign(side) * result.filledSize;
      const current = positionSizeForCoin(pair.snapshot, normalized);
      if (reduceOnly && current !== 0 && current * signedFill < 0 && Math.abs(signedFill) > Math.abs(current)) signedFill = -current;
      const marginCheck = this.#canApplyFill(pair, { coin: normalized, signedFillSize: signedFill, price: result.averagePrice ?? reference, poolId, leverage: leverage ?? pair.leverage.get(normalized) ?? { type: "cross", value: 1 } });
      if (!marginCheck.accepted) {
        this.#blockMargin(pair, pairId, marginCheck.reason, { coin: normalized, requestedSize: signedFill, price: result.averagePrice ?? reference });
        result.unfilledSize += result.filledSize;
        result.filledSize = 0;
        result.filledNotionalUsd = 0;
        result.fills = [];
        result.averagePrice = null;
      } else this.#applyFill(pairId, pair, {
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
      const marginCheck = this.#canApplyFill(pair, {
        coin: normalized,
        signedFillSize: orderSide * fillSize,
        price: Number(order.price),
        poolId: order.poolId,
        leverage: order.leverage ?? pair.leverage.get(normalized) ?? { type: "cross", value: 1 },
      });
      if (!marginCheck.accepted) {
        order.remainingSize += fillSize;
        order.filledSize -= fillSize;
        remainingTradeSize += fillSize;
        this.#blockMargin(pair, pairId, marginCheck.reason, { coin: normalized, requestedSize: orderSide * fillSize, price: Number(order.price) });
        break;
      }
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
      const signedFillSize = sideSign(order.side) * result.filledSize;
      const marginCheck = this.#canApplyFill(pair, {
        coin: order.coin,
        signedFillSize,
        price: result.averagePrice ?? order.price,
        poolId: order.poolId,
        leverage: order.leverage ?? pair.leverage.get(order.coin) ?? { type: "cross", value: 1 },
      });
      if (!marginCheck.accepted) {
        this.#blockMargin(pair, pairId, marginCheck.reason, { coin: order.coin, requestedSize: signedFillSize, price: result.averagePrice ?? order.price });
        return { ...result, filledSize: 0, filledNotionalUsd: 0, averagePrice: null, unfilledSize: result.requestedSize, fills: [] };
      }
      this.#applyFill(pairId, pair, {
        coin: order.coin,
        signedFillSize,
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
    pair.snapshot.simulationModelVersion = this.simulationModelVersion;
    pair.snapshot.liquidationModel = "APPROXIMATE";
    const maintenanceMarginUsd = (pair.snapshot.positions ?? []).reduce((sum, position) => sum + Math.abs(Number(position.positionValueUsd ?? 0)) * this.maintenanceMarginRatio, 0);
    const negativeEquity = total < -ZERO_EPSILON;
    const liquidationRisk = total <= maintenanceMarginUsd + ZERO_EPSILON && (pair.snapshot.positions?.length ?? 0) > 0;
    if (negativeEquity) {
      pair.marginState = { status: "NEGATIVE_EQUITY", reason: "NEGATIVE_EQUITY", approximateLiquidationRisk: true, maintenanceMarginUsd };
    } else if (liquidationRisk && pair.marginState.status === "HEALTHY") {
      pair.marginState = { status: "LIQUIDATION_RISK_BLOCKED", reason: "APPROXIMATE_MAINTENANCE_MARGIN", approximateLiquidationRisk: true, maintenanceMarginUsd };
    } else {
      pair.marginState = { ...pair.marginState, maintenanceMarginUsd, approximateLiquidationRisk: pair.marginState.approximateLiquidationRisk || liquidationRisk };
    }
    pair.snapshot.marginState = clone(pair.marginState);
    pair.snapshot.receivedAt = this.now();
  }

  #validateOrder(order) {
    const quantity = Number(order.quantity ?? order.remainingSize ?? order.size);
    const price = Number(order.price ?? order.limitPrice);
    if (!(quantity > ZERO_EPSILON) || !Number.isFinite(quantity)) return { accepted: false, status: "REJECTED", reason: "MIN_SIZE" };
    if (!(price > 0) || !Number.isFinite(price)) return { accepted: false, status: "REJECTED", reason: "INVALID_PRICE" };
    if (this.minOrderSize > 0 && quantity + ZERO_EPSILON < this.minOrderSize) return { accepted: false, status: "REJECTED", reason: "MIN_SIZE" };
    if (this.minNotionalUsd > 0 && quantity * price + ZERO_EPSILON < this.minNotionalUsd) return { accepted: false, status: "REJECTED", reason: "MIN_NOTIONAL" };
    return { accepted: true };
  }

  #poolEquity(pair, poolId) {
    const value = Number(pair.snapshot.marginPools?.[poolId]?.equityUsd ?? pair.snapshot.accountEquityUsd);
    return Number.isFinite(value) ? value : 0;
  }

  #reservedIsolatedMargin(pair, poolId, excludedCoin = null) {
    let reserved = 0;
    for (const position of pair.snapshot.positions ?? []) {
      if (String(position.poolId ?? "default") !== String(poolId) || normalizeCoin(position.coin) === excludedCoin) continue;
      if (String(position.leverage?.type).toLowerCase() !== "isolated") continue;
      reserved += Math.max(0, Number(pair.isolatedMargin.get(normalizeCoin(position.coin)) ?? position.marginUsedUsd ?? 0));
    }
    return reserved;
  }

  #canApplyFill(pair, { coin, signedFillSize, price, poolId = "default", leverage }) {
    const current = (pair.snapshot.positions ?? []).find((position) => normalizeCoin(position.coin) === normalizeCoin(coin));
    const currentSize = Number(current?.signedSize ?? 0);
    const nextSize = currentSize + Number(signedFillSize);
    const riskReducing = Math.abs(currentSize) > ZERO_EPSILON
      && Math.abs(nextSize) <= Math.abs(currentSize) + ZERO_EPSILON
      && (Math.abs(nextSize) <= ZERO_EPSILON || Math.sign(nextSize) === Math.sign(currentSize));
    if ((pair.marginState.status === "NEGATIVE_EQUITY" || pair.marginState.status === "LIQUIDATION_RISK_BLOCKED") && !riskReducing) {
      return { accepted: false, reason: pair.marginState.reason ?? pair.marginState.status };
    }
    const effectiveLeverage = leverage ?? pair.leverage.get(normalizeCoin(coin));
    const leverageValue = Number(effectiveLeverage?.value);
    const leverageType = String(effectiveLeverage?.type ?? "").toLowerCase();
    if (!(leverageValue >= 1) || !["cross", "isolated"].includes(leverageType)) return { accepted: false, reason: "INVALID_LEVERAGE" };
    const requiredForCoin = Math.abs(nextSize) * Number(price) / leverageValue;
    const poolEquity = this.#poolEquity(pair, poolId);
    if (!(poolEquity > 0)) return { accepted: false, reason: "POOL_COLLATERAL_UNAVAILABLE" };
    if (leverageType === "isolated") {
      const available = poolEquity - this.#reservedIsolatedMargin(pair, poolId, normalizeCoin(coin));
      return requiredForCoin <= available + ZERO_EPSILON ? { accepted: true } : { accepted: false, reason: "ISOLATED_MARGIN_INSUFFICIENT" };
    }
    let requiredCross = requiredForCoin;
    for (const position of pair.snapshot.positions ?? []) {
      if (normalizeCoin(position.coin) === normalizeCoin(coin) || String(position.poolId ?? "default") !== String(poolId)) continue;
      if (String(position.leverage?.type ?? "cross").toLowerCase() !== "cross") continue;
      const otherLeverage = Math.max(1, Number(position.leverage?.value ?? 1));
      requiredCross += Math.abs(Number(position.signedSize)) * Number(position.markPriceUsd ?? position.entryPriceUsd ?? 0) / otherLeverage;
    }
    const availableCross = poolEquity - this.#reservedIsolatedMargin(pair, poolId);
    return requiredCross <= availableCross + ZERO_EPSILON ? { accepted: true } : { accepted: false, reason: "CROSS_MARGIN_INSUFFICIENT" };
  }

  #blockMargin(pair, pairId, reason, detail) {
    pair.marginState = { ...pair.marginState, status: "LIQUIDATION_RISK_BLOCKED", reason, approximateLiquidationRisk: true };
    pair.snapshot.marginState = clone(pair.marginState);
    this.#record("MARGIN_RISK_BLOCKED", { pairId, reason, ...detail, simulationModelVersion: this.simulationModelVersion });
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
