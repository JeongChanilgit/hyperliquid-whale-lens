import {
  DEFAULT_MIRROR_CONFIG,
  deterministicTargetOrderId,
  normalizeAddress,
  normalizeCoin,
  positionSizeForCoin,
  reconciliationDelta,
  residualBps,
  scaleSourceOrder,
  signedFillQuantity,
  sourcePositionAfterFill,
  targetFlatPosition,
  targetPositionFromSource,
  ZERO_EPSILON,
} from "./domain.mjs";

const clone = (value) => structuredClone(value);
const OPEN_STATUSES = new Set(["OPEN", "RESTING", "PARTIAL", "TRIGGERED", "PENDING"]);
const TERMINAL_STATUSES = new Set(["FILLED", "CANCELED", "CANCELLED", "REJECTED", "MARGIN_CANCELED"]);

const statusIsOpen = (status) => OPEN_STATUSES.has(String(status ?? "OPEN").toUpperCase());
const statusIsTerminal = (status) => TERMINAL_STATUSES.has(String(status ?? "").toUpperCase());
const sameLeverage = (left, right) => Boolean(left && right && left.type === right.type && Number(left.value) === Number(right.value));
const sourcePositionForCoin = (snapshot, coin) => (snapshot?.positions ?? []).find((position) => normalizeCoin(position.coin) === normalizeCoin(coin));
const cloneSnapshot = (snapshot) => clone(snapshot);
const orderFingerprint = (order) => [
  order.coin,
  order.side,
  order.price,
  order.triggerPrice ?? "",
  order.orderType,
  order.tif,
  order.reduceOnly,
  order.targetRemainingSize,
  order.poolId,
  order.leverage.type,
  order.leverage.value,
].join("|");

export class FaithfulPairActor {
  constructor({ pairId, sourceAddress, targetAddress, execution, config = {}, now = Date.now, log = () => {} }) {
    this.pairId = String(pairId);
    this.sourceAddress = normalizeAddress(sourceAddress);
    this.targetAddress = normalizeAddress(targetAddress);
    this.execution = execution;
    this.config = { ...DEFAULT_MIRROR_CONFIG, ...config };
    this.now = now;
    this.log = log;
    this.sourceSnapshot = null;
    this.targetSnapshot = null;
    this.sourceOrders = new Map();
    this.targetOrderBySource = new Map();
    this.sourceOrderByTarget = new Map();
    this.targetOrderState = new Map();
    this.shadowStateBySource = new Map();
    this.leverageCache = new Map();
    this.dirtyCoins = new Set();
    this.dirtyReasons = new Map();
    this.reconciliationRunning = false;
    this.reconciliationPromise = null;
    this.verificationTimers = new Map();
    this.terminalTimers = new Map();
    this.generationByCoin = new Map();
    this.pendingOrderCancellations = new Map();
    this.initialized = false;
    this.stopped = false;
    this.lastError = null;
    this.stats = {
      sourceFills: 0,
      targetFills: 0,
      sourceOrderUpdates: 0,
      targetOrderUpdates: 0,
      catchUpOrders: 0,
      mirroredOrders: 0,
      canceledOrders: 0,
      reconciliations: 0,
      terminalResiduals: 0,
    };
  }

  async bootstrap({ sourceSnapshot, targetSnapshot, sourceOpenOrders = [] }) {
    if (this.initialized) throw new Error(`Pair ${this.pairId} is already initialized`);
    if (this.stopped) throw new Error(`Pair ${this.pairId} is stopped`);
    this.sourceSnapshot = cloneSnapshot(sourceSnapshot);
    this.targetSnapshot = cloneSnapshot(targetSnapshot);
    if (!(this.sourceSnapshot.accountEquityUsd > 0) || !(this.targetSnapshot.accountEquityUsd > 0)) {
      throw new Error(`Pair ${this.pairId} bootstrap requires positive source and target equity`);
    }
    if (typeof this.execution.registerPair === "function") {
      await this.execution.registerPair({
        pairId: this.pairId,
        sourceAddress: this.sourceAddress,
        targetAddress: this.targetAddress,
        targetSnapshot: cloneSnapshot(this.targetSnapshot),
      });
    }
    const startupOrders = sourceOpenOrders.map((order) => this.#normalizeSourceOrder(order));
    const initialCoins = new Set([
      ...(this.sourceSnapshot.positions ?? []).map((position) => normalizeCoin(position.coin)),
      ...(this.targetSnapshot.positions ?? []).map((position) => normalizeCoin(position.coin)),
    ]);
    this.initialized = true;
    for (const coin of initialCoins) this.#markDirty(coin, "BOOTSTRAP_POSITION");
    await this.whenIdle();
    for (const order of startupOrders) this.sourceOrders.set(order.id, order);
    for (const order of startupOrders) await this.#mirrorOrder(order);
    this.#record("PAIR_READY", { sourceOpenOrderCount: startupOrders.length });
    return this.snapshot();
  }

  async onSourceOrder(update) {
    this.#requireReady();
    this.stats.sourceOrderUpdates += 1;
    const order = this.#normalizeSourceOrder(update.order ?? update);
    const status = String(update.status ?? order.status ?? "OPEN").toUpperCase();
    order.status = status;
    if (statusIsTerminal(status)) {
      this.sourceOrders.delete(order.id);
      this.shadowStateBySource.delete(order.id);
      await this.#cancelMirroredOrder(order.id, `SOURCE_${status}`);
    } else {
      this.sourceOrders.set(order.id, order);
      await this.#mirrorOrder(order);
    }
    this.#record("SOURCE_ORDER", { sourceOrderId: order.id, status, coin: order.coin });
    this.#markDirty(order.coin, "SOURCE_ORDER");
  }

  async syncSourceOrders(openOrders) {
    this.#requireReady();
    const incoming = new Map();
    for (const raw of openOrders ?? []) {
      const order = this.#normalizeSourceOrder(raw);
      if (statusIsOpen(order.status)) incoming.set(order.id, order);
    }
    for (const sourceOrderId of [...this.sourceOrders.keys()]) {
      if (incoming.has(sourceOrderId)) continue;
      const removed = this.sourceOrders.get(sourceOrderId);
      this.sourceOrders.delete(sourceOrderId);
      this.shadowStateBySource.delete(sourceOrderId);
      await this.#cancelMirroredOrder(sourceOrderId, "SOURCE_SNAPSHOT_REMOVED");
      if (removed) this.#markDirty(removed.coin, "SOURCE_ORDER_SNAPSHOT");
    }
    for (const order of incoming.values()) {
      this.sourceOrders.set(order.id, order);
      await this.#mirrorOrder(order);
      this.#markDirty(order.coin, "SOURCE_ORDER_SNAPSHOT");
    }
  }

  onSourceFill(fill) {
    this.#requireReady();
    this.stats.sourceFills += 1;
    const coin = normalizeCoin(fill.coin);
    const afterSize = sourcePositionAfterFill(fill);
    const sourcePosition = sourcePositionForCoin(this.sourceSnapshot, coin);
    const markPriceUsd = Number(fill.price ?? fill.px ?? sourcePosition?.markPriceUsd ?? sourcePosition?.entryPriceUsd);
    const leverage = fill.leverage ?? sourcePosition?.leverage;
    if (!leverage) throw new Error(`Source leverage is unavailable for ${coin}`);
    const nextPosition = {
      ...(sourcePosition ?? {}),
      coin,
      signedSize: afterSize,
      markPriceUsd,
      positionValueUsd: Math.abs(afterSize) * markPriceUsd,
      leverage: clone(leverage),
      poolId: fill.poolId ?? sourcePosition?.poolId ?? "default",
      ...(fill.marginUsedUsd != null ? { marginUsedUsd: Number(fill.marginUsedUsd) } : {}),
    };
    this.#replacePosition(this.sourceSnapshot, coin, nextPosition);

    const sourceOrderId = fill.sourceOrderId ?? fill.oid;
    if (sourceOrderId != null) {
      const order = this.sourceOrders.get(String(sourceOrderId));
      if (order) {
        order.remainingSize = Math.max(0, order.remainingSize - Math.abs(signedFillQuantity(fill)));
        if (order.remainingSize <= ZERO_EPSILON) {
          this.sourceOrders.delete(order.id);
          this.shadowStateBySource.delete(order.id);
          this.#queueOrderCancellation(coin, this.#cancelMirroredOrder(order.id, "SOURCE_FILLED"));
        } else {
          this.shadowStateBySource.delete(order.id);
        }
      }
    }

    this.#record("SOURCE_FILL", { coin, afterSize, sourceOrderId: sourceOrderId == null ? null : String(sourceOrderId) });
    this.#markDirty(coin, "SOURCE_FILL");
  }

  onTargetFill(fill) {
    this.#requireReady();
    this.stats.targetFills += 1;
    const coin = normalizeCoin(fill.coin);
    const targetPosition = sourcePositionForCoin(this.targetSnapshot, coin);
    const afterSize = Number.isFinite(Number(fill.positionAfter))
      ? Number(fill.positionAfter)
      : Number(fill.startPosition) + signedFillQuantity(fill);
    const markPriceUsd = Number(fill.price ?? fill.px ?? targetPosition?.markPriceUsd ?? targetPosition?.entryPriceUsd);
    const leverage = fill.leverage ?? targetPosition?.leverage ?? sourcePositionForCoin(this.sourceSnapshot, coin)?.leverage;
    if (!leverage) throw new Error(`Target leverage is unavailable for ${coin}`);
    this.#replacePosition(this.targetSnapshot, coin, {
      ...(targetPosition ?? {}),
      coin,
      signedSize: afterSize,
      markPriceUsd,
      positionValueUsd: Math.abs(afterSize) * markPriceUsd,
      leverage: clone(leverage),
      poolId: fill.poolId ?? targetPosition?.poolId ?? "default",
    });
    this.#record("TARGET_FILL", { coin, afterSize });
    this.#markDirty(coin, "TARGET_FILL");
  }

  onTargetOrder(update) {
    this.#requireReady();
    this.stats.targetOrderUpdates += 1;
    this.execution.onTargetOrder?.({ pairId: this.pairId, update: clone(update) });
    const sourceOrderId = update.sourceOrderId != null ? String(update.sourceOrderId) : null;
    const targetOrderId = update.targetOrderId != null
      ? String(update.targetOrderId)
      : sourceOrderId != null
        ? this.targetOrderBySource.get(sourceOrderId)
        : null;
    if (!targetOrderId) return;
    const status = String(update.status ?? "UNKNOWN").toUpperCase();
    const current = this.targetOrderState.get(targetOrderId) ?? { targetOrderId };
    this.targetOrderState.set(targetOrderId, {
      ...current,
      ...clone(update),
      targetOrderId,
      status,
    });
    if (sourceOrderId) {
      this.targetOrderBySource.set(sourceOrderId, targetOrderId);
      this.sourceOrderByTarget.set(targetOrderId, sourceOrderId);
    }
    const coin = update.coin ?? update.order?.coin ?? current.coin;
    this.#record("TARGET_ORDER", { targetOrderId, sourceOrderId, status, coin: coin ? normalizeCoin(coin) : null });
    if (coin) this.#markDirty(coin, "TARGET_ORDER");
  }

  syncTargetOrders(openOrders) {
    this.#requireReady();
    const openByTargetId = new Map();
    for (const raw of openOrders ?? []) {
      const targetOrderId = raw.targetOrderId != null ? String(raw.targetOrderId) : raw.clientOrderId != null ? String(raw.clientOrderId) : null;
      if (!targetOrderId) continue;
      openByTargetId.set(targetOrderId, { ...clone(raw), targetOrderId, status: String(raw.status ?? "OPEN").toUpperCase() });
    }
    for (const [targetOrderId, sourceOrderId] of this.sourceOrderByTarget) {
      const observed = openByTargetId.get(targetOrderId);
      if (observed) this.targetOrderState.set(targetOrderId, observed);
      else {
        const previous = this.targetOrderState.get(targetOrderId);
        this.targetOrderState.set(targetOrderId, { ...(previous ?? {}), targetOrderId, status: "TERMINAL_OR_MISSING" });
        const sourceOrder = this.sourceOrders.get(sourceOrderId);
        if (sourceOrder) this.#markDirty(sourceOrder.coin, "TARGET_ORDER_SNAPSHOT");
      }
    }
  }

  onSourceSnapshot(snapshot) {
    this.#requireReady();
    this.sourceSnapshot = cloneSnapshot(snapshot);
    this.#markAllCoinsDirty("SOURCE_SNAPSHOT");
  }

  onTargetSnapshot(snapshot) {
    this.#requireReady();
    this.targetSnapshot = cloneSnapshot(snapshot);
    this.#markAllCoinsDirty("TARGET_SNAPSHOT");
  }

  async whenIdle() {
    while (this.reconciliationPromise) await this.reconciliationPromise;
  }

  stop() {
    this.stopped = true;
    for (const timer of this.verificationTimers.values()) clearTimeout(timer);
    for (const timer of this.terminalTimers.values()) clearTimeout(timer);
    this.verificationTimers.clear();
    this.terminalTimers.clear();
  }

  snapshot() {
    return {
      pairId: this.pairId,
      sourceAddress: this.sourceAddress,
      targetAddress: this.targetAddress,
      initialized: this.initialized,
      stopped: this.stopped,
      lastError: this.lastError,
      sourceSnapshot: clone(this.sourceSnapshot),
      targetSnapshot: clone(this.targetSnapshot),
      sourceOrders: [...this.sourceOrders.values()].map(clone),
      targetOrderState: [...this.targetOrderState.values()].map(clone),
      dirtyCoins: [...this.dirtyCoins],
      stats: clone(this.stats),
    };
  }

  async #drain() {
    if (this.reconciliationRunning || this.stopped) return;
    this.reconciliationRunning = true;
    this.reconciliationPromise = (async () => {
      try {
        while (!this.stopped && this.dirtyCoins.size > 0) {
          const coin = this.dirtyCoins.values().next().value;
          this.dirtyCoins.delete(coin);
          const reasons = [...(this.dirtyReasons.get(coin) ?? [])];
          this.dirtyReasons.delete(coin);
          try {
            await this.#reconcileCoin(coin, reasons);
          } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
            this.#record("RECONCILE_ERROR", { coin, reasons, message: this.lastError });
            throw error;
          }
        }
      } finally {
        this.reconciliationRunning = false;
        this.reconciliationPromise = null;
      }
    })();
    await this.reconciliationPromise;
  }

  async #reconcileCoin(coin, reasons = []) {
    this.stats.reconciliations += 1;
    const pendingCancel = this.pendingOrderCancellations.get(coin);
    if (pendingCancel) {
      try { await pendingCancel; }
      finally {
        if (this.pendingOrderCancellations.get(coin) === pendingCancel) this.pendingOrderCancellations.delete(coin);
      }
    }
    await this.#mirrorOrdersForCoin(coin);
    const desired = this.#desiredPosition(coin);
    const actualSize = positionSizeForCoin(this.targetSnapshot, coin);
    const leverage = desired.leverage;
    const previousLeverage = this.leverageCache.get(coin);
    if (!sameLeverage(previousLeverage, leverage)) {
      const leverageResult = await this.execution.setLeverage({ pairId: this.pairId, coin, leverage });
      if (!leverageResult?.accepted) throw new Error(`Unable to set target leverage for ${coin}`);
      this.leverageCache.set(coin, clone(leverage));
    }
    const delta = reconciliationDelta({
      desiredSize: desired.targetSignedSize,
      actualSize,
      markPriceUsd: desired.markPriceUsd,
      minNotionalUsd: this.config.immediateResidualNotionalUsd,
      sizeStep: desired.sizeStep ?? 0,
    });
    let catchUpSubmitted = false;
    if (delta.tradeable) {
      catchUpSubmitted = true;
      const reduceOnly = actualSize !== 0 && actualSize * delta.deltaSize < 0 && Math.abs(delta.deltaSize) <= Math.abs(actualSize) + ZERO_EPSILON;
      const result = await this.execution.protectedIoc({
        pairId: this.pairId,
        coin,
        deltaSize: delta.deltaSize,
        desiredSignedSize: desired.targetSignedSize,
        markPriceUsd: desired.markPriceUsd,
        maxSlippageBps: this.config.maxCatchUpSlippageBps,
        reduceOnly,
        actualSignedSize: actualSize,
        leverage,
        poolId: desired.poolId,
      });
      this.stats.catchUpOrders += 1;
      this.#record("CATCH_UP", {
        coin,
        reasons,
        desiredSize: desired.targetSignedSize,
        actualSize,
        deltaSize: delta.deltaSize,
        accepted: result?.accepted === true,
        filledSize: result?.filledSize ?? 0,
        unfilledSize: result?.unfilledSize ?? 0,
        averagePrice: result?.averagePrice ?? null,
      });
      if (Number.isFinite(Number(result?.actualSignedSize))) {
        this.#replacePosition(this.targetSnapshot, coin, {
          ...(sourcePositionForCoin(this.targetSnapshot, coin) ?? {}),
          coin,
          signedSize: Number(result.actualSignedSize),
          markPriceUsd: desired.markPriceUsd,
          positionValueUsd: Math.abs(Number(result.actualSignedSize)) * desired.markPriceUsd,
          leverage: clone(leverage),
          poolId: desired.poolId,
        });
      }
    }
    await this.#reconcileIsolatedMargin(desired);
    if (catchUpSubmitted) this.#scheduleVerification(coin);
  }

  async #mirrorOrdersForCoin(coin) {
    const expected = [...this.sourceOrders.values()].filter((order) => order.coin === coin && statusIsOpen(order.status));
    const expectedIds = new Set(expected.map((order) => order.id));
    for (const sourceOrderId of [...this.targetOrderBySource.keys()]) {
      if (expectedIds.has(sourceOrderId)) continue;
      const prior = this.sourceOrderByTarget.get(this.targetOrderBySource.get(sourceOrderId));
      if (prior === sourceOrderId) await this.#cancelMirroredOrder(sourceOrderId, "SOURCE_ORDER_ABSENT");
    }
    for (const order of expected) await this.#mirrorOrder(order);
  }

  async #mirrorOrder(order) {
    const scaled = scaleSourceOrder({
      sourceOrder: order,
      sourceSnapshot: this.sourceSnapshot,
      targetSnapshot: this.targetSnapshot,
      targetPositionSize: positionSizeForCoin(this.targetSnapshot, order.coin),
    });
    const priorShadow = this.shadowStateBySource.get(order.id);
    const fingerprint = orderFingerprint(scaled);
    if (scaled.targetRemainingSize <= ZERO_EPSILON) {
      await this.#cancelMirroredOrder(order.id, "SCALED_TO_ZERO");
      return;
    }
    if (priorShadow?.fingerprint === fingerprint && this.targetOrderBySource.has(order.id)) return;
    const targetOrderId = this.targetOrderBySource.get(order.id) ?? deterministicTargetOrderId(this.pairId, order.id);
    const cachedLeverage = this.leverageCache.get(order.coin);
    if (!sameLeverage(cachedLeverage, scaled.leverage)) {
      const leverageResult = await this.execution.setLeverage({ pairId: this.pairId, coin: order.coin, leverage: scaled.leverage });
      if (!leverageResult?.accepted) throw new Error(`Unable to set leverage for ${order.coin} order shadow`);
      this.leverageCache.set(order.coin, clone(scaled.leverage));
    }
    const result = await this.execution.upsertOrder({
      pairId: this.pairId,
      sourceOrderId: order.id,
      targetOrderId,
      order: {
        ...scaled,
        targetOrderId,
        quantity: scaled.targetRemainingSize,
        leverage: scaled.leverage,
        poolId: scaled.poolId,
      },
    });
    if (!result?.accepted) {
      this.#record("ORDER_SHADOW_REJECTED", { sourceOrderId: order.id, targetOrderId, coin: order.coin, reason: result?.reason ?? result?.status ?? "unknown" });
      return;
    }
    this.targetOrderBySource.set(order.id, targetOrderId);
    this.sourceOrderByTarget.set(targetOrderId, order.id);
    this.shadowStateBySource.set(order.id, { fingerprint, at: this.now() });
    this.targetOrderState.set(targetOrderId, {
      targetOrderId,
      sourceOrderId: order.id,
      coin: order.coin,
      status: String(result.status ?? "OPEN").toUpperCase(),
      quantity: scaled.targetRemainingSize,
      price: scaled.price,
      triggerPrice: scaled.triggerPrice,
      orderType: scaled.orderType,
      tif: scaled.tif,
      reduceOnly: scaled.reduceOnly,
    });
    this.stats.mirroredOrders += 1;
  }

  async #cancelMirroredOrder(sourceOrderId, reason) {
    const targetOrderId = this.targetOrderBySource.get(String(sourceOrderId));
    this.shadowStateBySource.delete(String(sourceOrderId));
    if (!targetOrderId) return;
    const result = await this.execution.cancelOrder({ pairId: this.pairId, targetOrderId, sourceOrderId: String(sourceOrderId), reason });
    if (!result?.accepted) throw new Error(`Unable to cancel target order ${targetOrderId}`);
    this.targetOrderBySource.delete(String(sourceOrderId));
    this.sourceOrderByTarget.delete(targetOrderId);
    this.targetOrderState.set(targetOrderId, { ...(this.targetOrderState.get(targetOrderId) ?? {}), targetOrderId, status: "CANCELED", reason });
    this.stats.canceledOrders += 1;
  }

  #desiredPosition(coin) {
    const sourcePosition = sourcePositionForCoin(this.sourceSnapshot, coin);
    if (sourcePosition && Math.abs(Number(sourcePosition.signedSize)) > ZERO_EPSILON) {
      return targetPositionFromSource({ sourcePosition, sourceSnapshot: this.sourceSnapshot, targetSnapshot: this.targetSnapshot });
    }
    const targetPosition = sourcePositionForCoin(this.targetSnapshot, coin);
    const sourceOrder = [...this.sourceOrders.values()].find((order) => order.coin === coin);
    const leverage = sourcePosition?.leverage ?? sourceOrder?.leverage ?? targetPosition?.leverage ?? this.leverageCache.get(coin);
    const markPriceUsd = sourcePosition?.markPriceUsd ?? targetPosition?.markPriceUsd ?? sourceOrder?.price;
    if (!leverage || !markPriceUsd) throw new Error(`Cannot construct a flat target for ${coin}`);
    return targetFlatPosition({
      coin,
      poolId: sourcePosition?.poolId ?? sourceOrder?.poolId ?? targetPosition?.poolId ?? "default",
      targetSnapshot: this.targetSnapshot,
      markPriceUsd,
      leverage,
    });
  }

  async #reconcileIsolatedMargin(desired) {
    if (desired.leverage.type !== "isolated" || desired.targetIsolatedMarginUsd == null) return;
    const current = sourcePositionForCoin(this.targetSnapshot, desired.coin);
    const currentMargin = Number(current?.marginUsedUsd ?? 0);
    const delta = desired.targetIsolatedMarginUsd - currentMargin;
    if (Math.abs(delta) < 0.01) return;
    const result = await this.execution.adjustIsolatedMargin({
      pairId: this.pairId,
      coin: desired.coin,
      targetMarginUsd: desired.targetIsolatedMarginUsd,
      marginDeltaUsd: delta,
    });
    if (!result?.accepted) throw new Error(`Unable to adjust isolated margin for ${desired.coin}`);
    if (current) current.marginUsedUsd = Number(result.marginUsedUsd ?? desired.targetIsolatedMarginUsd);
  }

  #scheduleVerification(coin) {
    const generation = (this.generationByCoin.get(coin) ?? 0) + 1;
    this.generationByCoin.set(coin, generation);
    const existingFast = this.verificationTimers.get(coin);
    const existingTerminal = this.terminalTimers.get(coin);
    if (existingFast) clearTimeout(existingFast);
    if (existingTerminal) clearTimeout(existingTerminal);
    const fast = setTimeout(() => {
      this.verificationTimers.delete(coin);
      if (this.generationByCoin.get(coin) !== generation || this.stopped) return;
      this.#markDirty(coin, "VERIFY_250MS");
    }, this.config.verificationDelayMs);
    const terminal = setTimeout(async () => {
      this.terminalTimers.delete(coin);
      if (this.generationByCoin.get(coin) !== generation || this.stopped) return;
      this.#markDirty(coin, "VERIFY_1000MS");
      await this.whenIdle();
      const desired = this.#desiredPosition(coin);
      const actual = positionSizeForCoin(this.targetSnapshot, coin);
      const residual = residualBps({ desiredSize: desired.targetSignedSize, actualSize: actual });
      if (residual > this.config.targetPositionToleranceBps) {
        this.stats.terminalResiduals += 1;
        await this.execution.onUnresolvedResidual?.({
          pairId: this.pairId,
          coin,
          desiredSignedSize: desired.targetSignedSize,
          actualSignedSize: actual,
          residualBps: residual,
          killSwitchRequested: this.config.killOnTerminalResidual,
        });
        this.#record("TERMINAL_RESIDUAL", { coin, desiredSize: desired.targetSignedSize, actualSize: actual, residualBps: residual });
      }
    }, this.config.terminalVerificationDelayMs);
    fast.unref?.();
    terminal.unref?.();
    this.verificationTimers.set(coin, fast);
    this.terminalTimers.set(coin, terminal);
  }

  #queueOrderCancellation(coin, promise) {
    const normalized = normalizeCoin(coin);
    const prior = this.pendingOrderCancellations.get(normalized) ?? Promise.resolve();
    const chained = prior.then(() => promise);
    this.pendingOrderCancellations.set(normalized, chained);
    void chained.finally(() => {
      if (this.pendingOrderCancellations.get(normalized) === chained) this.pendingOrderCancellations.delete(normalized);
    });
  }

  #markAllCoinsDirty(reason) {
    const coins = new Set([
      ...(this.sourceSnapshot?.positions ?? []).map((position) => normalizeCoin(position.coin)),
      ...(this.targetSnapshot?.positions ?? []).map((position) => normalizeCoin(position.coin)),
      ...[...this.sourceOrders.values()].map((order) => normalizeCoin(order.coin)),
    ]);
    for (const coin of coins) this.#markDirty(coin, reason);
  }

  #markDirty(coin, reason) {
    const normalized = normalizeCoin(coin);
    this.dirtyCoins.add(normalized);
    const reasons = this.dirtyReasons.get(normalized) ?? new Set();
    reasons.add(reason);
    this.dirtyReasons.set(normalized, reasons);
    if (!this.reconciliationRunning) void this.#drain();
  }

  #normalizeSourceOrder(input) {
    const id = String(input.id ?? input.oid ?? "");
    if (!id) throw new Error("Source order ID is required");
    return {
      id,
      coin: normalizeCoin(input.coin),
      poolId: input.poolId ?? "default",
      side: String(input.side).toUpperCase() === "B" ? "BUY" : String(input.side).toUpperCase() === "A" ? "SELL" : String(input.side).toUpperCase(),
      price: Number(input.price ?? input.limitPrice ?? input.limitPx),
      triggerPrice: input.triggerPrice == null && input.triggerPx == null ? null : Number(input.triggerPrice ?? input.triggerPx),
      orderType: String(input.orderType ?? "LIMIT").toUpperCase(),
      tif: String(input.tif ?? "GTC").toUpperCase(),
      reduceOnly: input.reduceOnly === true,
      size: Number(input.size ?? input.originalSize ?? input.origSz ?? input.remainingSize ?? input.sz),
      remainingSize: Number(input.remainingSize ?? input.sz ?? input.size),
      status: String(input.status ?? "OPEN").toUpperCase(),
      leverage: clone(input.leverage),
    };
  }

  #replacePosition(snapshot, coin, position) {
    const positions = snapshot.positions ?? (snapshot.positions = []);
    const index = positions.findIndex((item) => normalizeCoin(item.coin) === coin);
    if (Math.abs(Number(position.signedSize)) <= ZERO_EPSILON) {
      if (index >= 0) positions.splice(index, 1);
      return;
    }
    if (index >= 0) positions[index] = position;
    else positions.push(position);
  }

  #requireReady() {
    if (!this.initialized) throw new Error(`Pair ${this.pairId} is not initialized`);
    if (this.stopped) throw new Error(`Pair ${this.pairId} is stopped`);
  }

  #record(type, detail) {
    this.log({ type, at: this.now(), detail: clone(detail) });
  }
}
