import {
  DEFAULT_MIRROR_CONFIG,
  deterministicTargetOrderId,
  marginPoolEquityUsd,
  normalizeAddress,
  normalizeCoin,
  positionMarkPrice,
  positionSizeForCoin,
  reconciliationDelta,
  residualBps,
  scaleSourceOrder,
  sourcePositionAfterFill,
  targetFlatPosition,
  targetPositionFromSource,
  ZERO_EPSILON,
} from "./domain.mjs";

const clone = (value) => structuredClone(value);
const sameLeverage = (left, right) => left?.type === right?.type && Number(left?.value) === Number(right?.value);

const replacePosition = (snapshot, position) => {
  const coin = normalizeCoin(position.coin);
  const positions = snapshot.positions ?? (snapshot.positions = []);
  const index = positions.findIndex((item) => normalizeCoin(item.coin) === coin);
  if (Math.abs(Number(position.signedSize)) <= ZERO_EPSILON) {
    if (index >= 0) positions.splice(index, 1);
    return;
  }
  if (index >= 0) positions[index] = { ...positions[index], ...clone(position), coin };
  else positions.push({ ...clone(position), coin });
};

const removeOrder = (orders, sourceOrderId) => orders.delete(String(sourceOrderId));

export class FaithfulPairActor {
  constructor({ pairId, sourceAddress, targetAddress, execution, config = {}, now = Date.now, log = () => {} }) {
    this.pairId = String(pairId);
    this.sourceAddress = normalizeAddress(sourceAddress);
    this.targetAddress = normalizeAddress(targetAddress);
    if (this.sourceAddress === this.targetAddress) throw new Error("source and target addresses must differ");
    if (!execution) throw new Error("execution port is required");
    this.execution = execution;
    this.config = { ...DEFAULT_MIRROR_CONFIG, ...config };
    this.now = now;
    this.log = log;
    this.sourceSnapshot = null;
    this.targetSnapshot = null;
    this.sourceOrders = new Map();
    this.targetOrderBySource = new Map();
    this.shadowStateBySource = new Map();
    this.leverageCache = new Map();
    this.dirtyCoins = new Set();
    this.dirtyReasons = new Map();
    this.pendingOrderCancellations = new Map();
    this.reconcileRunning = false;
    this.idleWaiters = [];
    this.verifyTimers = new Map();
    this.terminalTimers = new Map();
    this.generationByCoin = new Map();
    this.initialized = false;
    this.stopped = false;
    this.events = [];
  }

  async bootstrap({ sourceSnapshot, targetSnapshot, sourceOpenOrders = [] }) {
    if (this.stopped) throw new Error("pair actor is stopped");
    this.sourceSnapshot = clone(sourceSnapshot);
    this.targetSnapshot = clone(targetSnapshot);
    await this.execution.registerPair?.({
      pairId: this.pairId,
      sourceAddress: this.sourceAddress,
      targetAddress: this.targetAddress,
      targetSnapshot: clone(targetSnapshot),
    });
    const startupOrders = sourceOpenOrders.map((order) => this.#normalizeSourceOrder(order));
    const coins = new Set([
      ...(this.sourceSnapshot.positions ?? []).map((position) => normalizeCoin(position.coin)),
      ...(this.targetSnapshot.positions ?? []).map((position) => normalizeCoin(position.coin)),
    ]);
    for (const coin of coins) this.dirtyCoins.add(coin);
    // Establish current exposure and margin first. Existing reduce-only and
    // trigger orders are installed only after the target position exists.
    await this.#drain();
    for (const order of startupOrders) this.sourceOrders.set(order.id, order);
    for (const order of startupOrders) await this.#mirrorOrder(order);
    this.initialized = true;
    this.#record("BOOTSTRAP_COMPLETE", { coinCount: coins.size, sourceOrderCount: this.sourceOrders.size });
    return this.snapshot();
  }

  async onSourceOrder(update) {
    this.#requireReady();
    const order = this.#normalizeSourceOrder(update.order ?? update);
    const status = String(update.status ?? order.status ?? "OPEN").toUpperCase();
    order.status = status;
    if (["CANCELED", "CANCELLED", "FILLED", "REJECTED", "EXPIRED", "MARGIN_CANCELED"].includes(status)) {
      removeOrder(this.sourceOrders, order.id);
      this.pendingOrderCancellations.set(order.id, `SOURCE_${status}`);
    } else {
      this.sourceOrders.set(order.id, order);
    }
    this.#record("SOURCE_ORDER", { sourceOrderId: order.id, status, coin: order.coin });
    this.#markDirty(order.coin, "SOURCE_ORDER");
    await this.whenIdle();
    return this.snapshot();
  }

  onSourceFill(fill) {
    this.#requireReady();
    const coin = normalizeCoin(fill.coin);
    const afterSize = sourcePositionAfterFill(fill);
    const existing = (this.sourceSnapshot.positions ?? []).find((position) => normalizeCoin(position.coin) === coin);
    const markPriceUsd = Number(fill.price ?? fill.px ?? existing?.markPriceUsd ?? (existing ? positionMarkPrice(existing) : NaN));
    if (!Number.isFinite(markPriceUsd) || markPriceUsd <= 0) throw new Error(`No usable fill price for ${coin}`);
    const leverage = fill.leverage ?? existing?.leverage;
    if (!leverage) throw new Error(`No leverage state for ${coin}`);
    replacePosition(this.sourceSnapshot, {
      ...(existing ?? {}),
      coin,
      signedSize: afterSize,
      markPriceUsd,
      positionValueUsd: Math.abs(afterSize) * markPriceUsd,
      leverage,
      marginUsedUsd: fill.marginUsedUsd ?? existing?.marginUsedUsd,
      poolId: fill.poolId ?? existing?.poolId ?? "default",
    });

    const sourceOrderId = fill.sourceOrderId ?? fill.oid;
    if (sourceOrderId != null) {
      const order = this.sourceOrders.get(String(sourceOrderId));
      if (order) {
        const fillSize = Math.abs(Number(fill.size ?? fill.sz));
        order.remainingSize = Math.max(0, order.remainingSize - fillSize);
        if (order.remainingSize <= ZERO_EPSILON) {
          this.sourceOrders.delete(order.id);
          this.pendingOrderCancellations.set(order.id, "SOURCE_FILLED");
        }
      }
    }

    this.#record("SOURCE_FILL", { coin, afterSize, sourceOrderId: sourceOrderId == null ? null : String(sourceOrderId) });
    this.#markDirty(coin, "SOURCE_FILL");
  }

  onTargetFill(fill) {
    this.#requireReady();
    const coin = normalizeCoin(fill.coin);
    const afterSize = Number.isFinite(Number(fill.positionAfter))
      ? Number(fill.positionAfter)
      : Number.isFinite(Number(fill.startPosition))
        ? sourcePositionAfterFill(fill)
        : positionSizeForCoin(this.targetSnapshot, coin) + (String(fill.side).toUpperCase() === "BUY" || String(fill.side).toUpperCase() === "B" ? 1 : -1) * Number(fill.size ?? fill.sz);
    const existing = (this.targetSnapshot.positions ?? []).find((position) => normalizeCoin(position.coin) === coin);
    const markPriceUsd = Number(fill.price ?? fill.px ?? existing?.markPriceUsd ?? 0);
    replacePosition(this.targetSnapshot, {
      ...(existing ?? {}),
      coin,
      signedSize: afterSize,
      markPriceUsd: markPriceUsd > 0 ? markPriceUsd : existing?.markPriceUsd,
      positionValueUsd: markPriceUsd > 0 ? Math.abs(afterSize) * markPriceUsd : existing?.positionValueUsd,
      leverage: fill.leverage ?? existing?.leverage ?? this.leverageCache.get(coin) ?? { type: "cross", value: 1 },
      marginUsedUsd: fill.marginUsedUsd ?? existing?.marginUsedUsd,
      poolId: fill.poolId ?? existing?.poolId ?? "default",
    });
    this.#record("TARGET_FILL", { coin, afterSize });
    this.#markDirty(coin, "TARGET_FILL");
  }

  onTargetOrder(update) {
    this.#requireReady();
    this.execution.onTargetOrder?.({ pairId: this.pairId, update: clone(update) });
    const coinRaw = update?.order?.coin ?? update?.coin;
    this.#record("TARGET_ORDER", {
      coin: coinRaw ? normalizeCoin(coinRaw) : null,
      status: String(update?.status ?? "UNKNOWN").toUpperCase(),
      targetOrderId: update?.order?.cloid ?? update?.order?.oid ?? null,
    });
  }

  async syncTargetOrders(targetOpenOrders) {
    this.#requireReady();
    await this.execution.syncTargetOpenOrders?.({ pairId: this.pairId, orders: clone(targetOpenOrders) });
    // A reconnect may have hidden a target fill/cancel. Force each source
    // order through the execution adapter again; the adapter decides create
    // versus modify from the fresh target open-order snapshot.
    this.shadowStateBySource.clear();
    for (const order of this.sourceOrders.values()) this.#markDirty(order.coin, "TARGET_ORDER_SNAPSHOT");
    await this.whenIdle();
  }

  onSourceSnapshot(snapshot) {
    this.#requireReady();
    this.sourceSnapshot = clone(snapshot);
    this.#record("SOURCE_SNAPSHOT", { receivedAt: snapshot.receivedAt ?? this.now() });
    this.#markAllCoinsDirty("SOURCE_SNAPSHOT");
  }

  onTargetSnapshot(snapshot) {
    this.#requireReady();
    this.targetSnapshot = clone(snapshot);
    this.#record("TARGET_SNAPSHOT", { receivedAt: snapshot.receivedAt ?? this.now() });
    this.#markAllCoinsDirty("TARGET_SNAPSHOT");
  }

  async syncSourceOrders(sourceOpenOrders) {
    this.#requireReady();
    const next = new Map(sourceOpenOrders.map((order) => {
      const normalized = this.#normalizeSourceOrder(order);
      return [normalized.id, normalized];
    }));
    for (const [sourceOrderId, prior] of this.sourceOrders.entries()) {
      if (!next.has(sourceOrderId)) {
        this.pendingOrderCancellations.set(sourceOrderId, "SOURCE_SNAPSHOT_REMOVED");
        this.#markDirty(prior.coin, "SOURCE_ORDER_SNAPSHOT");
      }
    }
    this.sourceOrders = next;
    for (const order of this.sourceOrders.values()) this.#markDirty(order.coin, "SOURCE_ORDER_SNAPSHOT");
    await this.whenIdle();
  }

  whenIdle() {
    if (!this.reconcileRunning && this.dirtyCoins.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  snapshot() {
    return {
      pairId: this.pairId,
      sourceAddress: this.sourceAddress,
      targetAddress: this.targetAddress,
      initialized: this.initialized,
      stopped: this.stopped,
      reconcileRunning: this.reconcileRunning,
      dirtyCoins: [...this.dirtyCoins],
      sourceSnapshot: clone(this.sourceSnapshot),
      targetSnapshot: clone(this.targetSnapshot),
      sourceOrders: [...this.sourceOrders.values()].map(clone),
      targetOrderBySource: Object.fromEntries(this.targetOrderBySource),
      shadowStateBySource: Object.fromEntries(this.shadowStateBySource),
      events: clone(this.events.slice(-250)),
    };
  }

  async emergencyStop(reason = "EMERGENCY_STOP") {
    if (this.stopped) return;
    for (const sourceOrderId of [...this.targetOrderBySource.keys()]) {
      try { await this.#cancelMirroredOrder(sourceOrderId, reason); }
      catch (error) { this.#record("ERROR", { message: error instanceof Error ? error.message : String(error), reason }); }
    }
    try { await this.execution.emergencyCancelAll?.(reason); }
    catch (error) { this.#record("ERROR", { message: error instanceof Error ? error.message : String(error), reason }); }
    this.stop();
  }

  stop() {
    this.stopped = true;
    for (const timer of this.verifyTimers.values()) clearTimeout(timer);
    for (const timer of this.terminalTimers.values()) clearTimeout(timer);
    this.verifyTimers.clear();
    this.terminalTimers.clear();
    this.execution.close?.();
    this.#resolveIdle();
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
    if (this.stopped) return;
    const normalized = normalizeCoin(coin);
    this.dirtyCoins.add(normalized);
    const reasons = this.dirtyReasons.get(normalized) ?? new Set();
    reasons.add(reason);
    this.dirtyReasons.set(normalized, reasons);
    this.#record("RECONCILE_REQUESTED", { coin: normalized, reason });
    if (!this.reconcileRunning) void this.#drain().catch(() => {});
  }

  async #drain() {
    if (this.reconcileRunning || this.stopped) return;
    this.reconcileRunning = true;
    try {
      while (this.dirtyCoins.size > 0 && !this.stopped) {
        const coin = this.dirtyCoins.values().next().value;
        this.dirtyCoins.delete(coin);
        const reasons = this.dirtyReasons.get(coin) ?? new Set();
        this.dirtyReasons.delete(coin);
        await this.#reconcileCoin(coin, reasons);
      }
    } catch (error) {
      this.#record("ERROR", { message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.reconcileRunning = false;
      this.#resolveIdle();
    }
  }

  async #reconcileCoin(coin, reasons = new Set()) {
    if (!this.sourceSnapshot || !this.targetSnapshot) return;
    let actionTaken = false;
    for (const [sourceOrderId, reason] of [...this.pendingOrderCancellations.entries()]) {
      const targetOrderId = this.targetOrderBySource.get(sourceOrderId);
      if (!targetOrderId) {
        this.pendingOrderCancellations.delete(sourceOrderId);
        continue;
      }
      const orderCoin = this.#coinForTargetOrder(sourceOrderId);
      if (orderCoin && normalizeCoin(orderCoin) !== coin) continue;
      await this.#cancelMirroredOrder(sourceOrderId, reason);
      this.pendingOrderCancellations.delete(sourceOrderId);
      actionTaken = true;
    }
    const sourcePosition = (this.sourceSnapshot.positions ?? []).find((position) => normalizeCoin(position.coin) === coin);
    const targetPosition = (this.targetSnapshot.positions ?? []).find((position) => normalizeCoin(position.coin) === coin);
    const shadowActions = await this.#mirrorOrdersForCoin(coin);
    actionTaken = actionTaken || shadowActions > 0;
    let desired;
    if (sourcePosition && Math.abs(Number(sourcePosition.signedSize)) > ZERO_EPSILON) {
      desired = targetPositionFromSource({ sourcePosition, sourceSnapshot: this.sourceSnapshot, targetSnapshot: this.targetSnapshot });
    } else if (targetPosition && Math.abs(Number(targetPosition.signedSize)) > ZERO_EPSILON) {
      desired = targetFlatPosition({
        coin,
        poolId: targetPosition.poolId ?? "default",
        targetSnapshot: this.targetSnapshot,
        markPriceUsd: targetPosition.markPriceUsd ?? positionMarkPrice(targetPosition),
        leverage: targetPosition.leverage ?? this.leverageCache.get(coin) ?? { type: "cross", value: 1 },
      });
    } else {
      if (actionTaken && !reasons.has("VERIFY_250MS") && !reasons.has("VERIFY_1000MS")) this.#scheduleVerification(coin);
      return;
    }

    const cachedLeverage = this.leverageCache.get(coin);
    if (!sameLeverage(cachedLeverage, desired.leverage)) {
      const leverageResult = await this.execution.setLeverage({ pairId: this.pairId, coin, leverage: desired.leverage });
      if (!leverageResult?.accepted) throw new Error(`Unable to set leverage for ${coin}`);
      this.leverageCache.set(coin, clone(desired.leverage));
      actionTaken = true;
    }

    const actualSize = positionSizeForCoin(this.targetSnapshot, coin);
    const delta = reconciliationDelta({
      desiredSize: desired.targetSignedSize,
      actualSize,
      markPriceUsd: desired.markPriceUsd,
      minNotionalUsd: this.config.immediateResidualNotionalUsd,
      sizeStep: this.config.sizeStepByCoin?.[coin] ?? 0,
    });
    if (delta.tradeable) {
      const reduceOnly = actualSize !== 0 && Math.sign(delta.deltaSize) !== Math.sign(actualSize) && Math.abs(delta.deltaSize) <= Math.abs(actualSize) + ZERO_EPSILON;
      const result = await this.execution.protectedIoc({
        pairId: this.pairId,
        coin,
        deltaSize: delta.deltaSize,
        markPriceUsd: desired.markPriceUsd,
        maxSlippageBps: this.config.maxCatchUpSlippageBps,
        reduceOnly,
        desiredSignedSize: desired.targetSignedSize,
        actualSignedSize: actualSize,
        leverage: desired.leverage,
        poolId: desired.poolId,
      });
      const authoritativeSnapshot = await this.execution.getSnapshot?.(this.pairId);
      if (authoritativeSnapshot) {
        this.targetSnapshot = clone(authoritativeSnapshot);
      } else if (Number.isFinite(Number(result?.actualSignedSize))) {
        replacePosition(this.targetSnapshot, {
          ...(targetPosition ?? {}),
          coin,
          signedSize: Number(result.actualSignedSize),
          markPriceUsd: Number(result.averagePrice ?? desired.markPriceUsd),
          positionValueUsd: Math.abs(Number(result.actualSignedSize)) * Number(result.averagePrice ?? desired.markPriceUsd),
          leverage: desired.leverage,
          poolId: desired.poolId,
          marginUsedUsd: targetPosition?.marginUsedUsd,
        });
      }
      actionTaken = true;
      this.#record("CATCH_UP", {
        coin,
        desiredSize: desired.targetSignedSize,
        actualSizeBefore: actualSize,
        requestedDeltaSize: delta.deltaSize,
        accepted: result?.accepted === true,
        filledSize: result?.filledSize ?? null,
        unfilledSize: result?.unfilledSize ?? null,
      });
    }

    if (desired.leverage.type === "isolated" && desired.targetIsolatedMarginUsd != null) {
      const latestTargetPosition = (this.targetSnapshot.positions ?? []).find((position) => normalizeCoin(position.coin) === coin);
      const currentMarginUsd = Number(latestTargetPosition?.marginUsedUsd ?? 0);
      const marginDeltaUsd = desired.targetIsolatedMarginUsd - currentMarginUsd;
      if (Math.abs(marginDeltaUsd) >= 0.01) {
        const result = await this.execution.adjustIsolatedMargin({
          pairId: this.pairId,
          coin,
          targetMarginUsd: desired.targetIsolatedMarginUsd,
          marginDeltaUsd,
        });
        if (!result?.accepted) throw new Error(`Unable to adjust isolated margin for ${coin}`);
        if (latestTargetPosition) latestTargetPosition.marginUsedUsd = Number(result.marginUsedUsd ?? desired.targetIsolatedMarginUsd);
        actionTaken = true;
      }
    }

    if (actionTaken && !reasons.has("VERIFY_250MS") && !reasons.has("VERIFY_1000MS")) this.#scheduleVerification(coin);
    else if (actionTaken && reasons.has("VERIFY_250MS")) this.#scheduleTerminalVerificationOnly(coin);
  }

  async #mirrorOrdersForCoin(coin) {
    let count = 0;
    for (const order of this.sourceOrders.values()) {
      if (normalizeCoin(order.coin) !== coin) continue;
      if (await this.#mirrorOrder(order)) count += 1;
    }
    return count;
  }

  async #mirrorOrder(order) {
    if (!this.sourceSnapshot || !this.targetSnapshot) return;
    const coin = normalizeCoin(order.coin);
    const targetPositionSize = positionSizeForCoin(this.targetSnapshot, coin);
    const scaled = scaleSourceOrder({
      sourceOrder: order,
      sourceSnapshot: this.sourceSnapshot,
      targetSnapshot: this.targetSnapshot,
      targetPositionSize,
    });
    const targetOrderId = this.targetOrderBySource.get(order.id) ?? deterministicTargetOrderId(this.pairId, order.id);
    this.targetOrderBySource.set(order.id, targetOrderId);
    const markPriceUsd = this.#markForCoin(coin, Number(order.price));
    const targetNotionalUsd = scaled.targetRemainingSize * markPriceUsd;
    if (scaled.targetRemainingSize <= ZERO_EPSILON || targetNotionalUsd + 1e-9 < this.config.immediateResidualNotionalUsd) {
      const existed = this.shadowStateBySource.has(order.id);
      await this.#cancelMirroredOrder(order.id, "SCALED_ORDER_BELOW_MINIMUM");
      return existed;
    }
    const shadowFingerprint = JSON.stringify({
      coin,
      side: scaled.side,
      price: scaled.price,
      triggerPrice: scaled.triggerPrice,
      orderType: scaled.orderType,
      tif: scaled.tif,
      reduceOnly: scaled.reduceOnly,
      quantity: scaled.targetRemainingSize,
      leverage: scaled.leverage,
      poolId: scaled.poolId,
    });
    if (this.shadowStateBySource.get(order.id) === shadowFingerprint) return false;
    const cachedLeverage = this.leverageCache.get(coin);
    if (!sameLeverage(cachedLeverage, scaled.leverage)) {
      const leverageResult = await this.execution.setLeverage({ pairId: this.pairId, coin, leverage: scaled.leverage });
      if (!leverageResult?.accepted) throw new Error(`Unable to set leverage for ${coin} order shadow`);
      this.leverageCache.set(coin, clone(scaled.leverage));
    }
    const result = await this.execution.upsertOrder({
      pairId: this.pairId,
      order: {
        targetOrderId,
        sourceOrderId: order.id,
        coin,
        side: scaled.side,
        price: scaled.price,
        triggerPrice: scaled.triggerPrice,
        orderType: scaled.orderType,
        tif: scaled.tif,
        reduceOnly: scaled.reduceOnly,
        quantity: scaled.targetRemainingSize,
        leverage: scaled.leverage,
        poolId: scaled.poolId,
      },
    });
    if (result?.accepted === true) this.shadowStateBySource.set(order.id, shadowFingerprint);
    this.#record("ORDER_SHADOW", {
      coin,
      sourceOrderId: order.id,
      targetOrderId,
      targetQuantity: scaled.targetRemainingSize,
      accepted: result?.accepted === true,
      status: result?.status ?? null,
    });
    return true;
  }

  async #cancelMirroredOrder(sourceOrderId, reason) {
    const key = String(sourceOrderId);
    const targetOrderId = this.targetOrderBySource.get(key);
    if (!targetOrderId) return;
    const coin = this.#coinForTargetOrder(key);
    await this.execution.cancelOrder({ pairId: this.pairId, targetOrderId, sourceOrderId: key, coin, reason });
    this.targetOrderBySource.delete(key);
    this.shadowStateBySource.delete(key);
    this.#record("ORDER_SHADOW_CANCELED", { sourceOrderId: key, targetOrderId, reason });
  }

  #scheduleVerification(coin) {
    const generation = (this.generationByCoin.get(coin) ?? 0) + 1;
    this.generationByCoin.set(coin, generation);
    const priorVerify = this.verifyTimers.get(coin);
    const priorTerminal = this.terminalTimers.get(coin);
    if (priorVerify) clearTimeout(priorVerify);
    if (priorTerminal) clearTimeout(priorTerminal);
    const verifyTimer = setTimeout(() => {
      this.verifyTimers.delete(coin);
      if (this.generationByCoin.get(coin) !== generation || this.stopped) return;
      this.#markDirty(coin, "VERIFY_250MS");
    }, this.config.verificationDelayMs);
    const terminalTimer = setTimeout(async () => {
      this.terminalTimers.delete(coin);
      if (this.generationByCoin.get(coin) !== generation || this.stopped) return;
      this.#markDirty(coin, "VERIFY_1000MS");
      await this.whenIdle();
      const residual = this.#currentResidual(coin);
      if (residual && residual.residualBps > this.config.targetPositionToleranceBps && residual.notionalUsd >= this.config.immediateResidualNotionalUsd) {
        await this.execution.onUnresolvedResidual?.({
          pairId: this.pairId,
          coin,
          ...residual,
          killSwitchRequested: this.config.killOnTerminalResidual,
        });
        this.#record("TERMINAL_RESIDUAL", residual);
      }
    }, this.config.terminalVerificationDelayMs);
    verifyTimer.unref?.();
    terminalTimer.unref?.();
    this.verifyTimers.set(coin, verifyTimer);
    this.terminalTimers.set(coin, terminalTimer);
  }

  #scheduleTerminalVerificationOnly(coin) {
    const generation = (this.generationByCoin.get(coin) ?? 0) + 1;
    this.generationByCoin.set(coin, generation);
    const priorTerminal = this.terminalTimers.get(coin);
    if (priorTerminal) clearTimeout(priorTerminal);
    const terminalTimer = setTimeout(async () => {
      this.terminalTimers.delete(coin);
      if (this.generationByCoin.get(coin) !== generation || this.stopped) return;
      this.#markDirty(coin, "VERIFY_1000MS");
      await this.whenIdle();
      const residual = this.#currentResidual(coin);
      if (residual && residual.residualBps > this.config.targetPositionToleranceBps && residual.notionalUsd >= this.config.immediateResidualNotionalUsd) {
        await this.execution.onUnresolvedResidual?.({
          pairId: this.pairId,
          coin,
          ...residual,
          killSwitchRequested: this.config.killOnTerminalResidual,
        });
        this.#record("TERMINAL_RESIDUAL", residual);
      }
    }, Math.max(0, this.config.terminalVerificationDelayMs - this.config.verificationDelayMs));
    terminalTimer.unref?.();
    this.terminalTimers.set(coin, terminalTimer);
  }

  #currentResidual(coin) {
    if (!this.sourceSnapshot || !this.targetSnapshot) return null;
    const sourcePosition = (this.sourceSnapshot.positions ?? []).find((position) => normalizeCoin(position.coin) === coin);
    const targetPosition = (this.targetSnapshot.positions ?? []).find((position) => normalizeCoin(position.coin) === coin);
    let desiredSize = 0;
    let markPriceUsd = Number(targetPosition?.markPriceUsd ?? sourcePosition?.markPriceUsd ?? 0);
    if (sourcePosition && Math.abs(Number(sourcePosition.signedSize)) > ZERO_EPSILON) {
      const desired = targetPositionFromSource({ sourcePosition, sourceSnapshot: this.sourceSnapshot, targetSnapshot: this.targetSnapshot });
      desiredSize = desired.targetSignedSize;
      markPriceUsd = desired.markPriceUsd;
    }
    const actualSize = positionSizeForCoin(this.targetSnapshot, coin);
    return {
      desiredSize,
      actualSize,
      residualSize: desiredSize - actualSize,
      residualBps: residualBps({ desiredSize, actualSize }),
      notionalUsd: Math.abs(desiredSize - actualSize) * markPriceUsd,
    };
  }

  #markForCoin(coin, fallback) {
    const sourcePosition = (this.sourceSnapshot?.positions ?? []).find((position) => normalizeCoin(position.coin) === coin);
    if (sourcePosition) return positionMarkPrice(sourcePosition);
    return Number(fallback);
  }

  #coinForTargetOrder(sourceOrderId) {
    const source = this.sourceOrders.get(String(sourceOrderId));
    if (source) return source.coin;
    const event = [...this.events].reverse().find((entry) => entry.sourceOrderId === String(sourceOrderId) && entry.coin);
    return event?.coin ?? null;
  }

  #normalizeSourceOrder(order) {
    const id = String(order.id ?? order.oid ?? order.sourceOrderId ?? "").trim();
    if (!id) throw new Error("source order id is required");
    const side = String(order.side ?? "").toUpperCase();
    const normalizedSide = side === "B" ? "BUY" : side === "A" ? "SELL" : side;
    if (normalizedSide !== "BUY" && normalizedSide !== "SELL") throw new Error(`Unsupported order side: ${order.side}`);
    const leverage = order.leverage ?? this.#sourceLeverageForCoin(order.coin);
    if (!leverage) throw new Error(`Source leverage is unavailable for ${order.coin}`);
    return {
      ...clone(order),
      id,
      coin: normalizeCoin(order.coin),
      side: normalizedSide,
      price: Number(order.price ?? order.limitPrice ?? order.limitPx),
      triggerPrice: order.triggerPrice ?? order.triggerPx ?? null,
      remainingSize: Number(order.remainingSize ?? order.sz ?? order.size),
      size: Number(order.size ?? order.origSz ?? order.sz ?? order.remainingSize),
      orderType: String(order.orderType ?? "LIMIT").toUpperCase(),
      tif: String(order.tif ?? "GTC").toUpperCase(),
      reduceOnly: order.reduceOnly === true,
      leverage: clone(leverage),
      poolId: order.poolId ?? "default",
      status: String(order.status ?? "OPEN").toUpperCase(),
    };
  }

  #sourceLeverageForCoin(coin) {
    const normalized = normalizeCoin(coin);
    return (this.sourceSnapshot?.positions ?? []).find((position) => normalizeCoin(position.coin) === normalized)?.leverage;
  }

  #requireReady() {
    if (this.stopped) throw new Error("pair actor is stopped");
    if (!this.sourceSnapshot || !this.targetSnapshot) throw new Error("pair actor has not been bootstrapped");
  }

  #record(type, detail) {
    const entry = { type, pairId: this.pairId, at: this.now(), ...clone(detail) };
    this.events.push(entry);
    if (this.events.length > 2_000) this.events.splice(0, this.events.length - 2_000);
    this.log(entry);
  }

  #resolveIdle() {
    if (this.reconcileRunning || this.dirtyCoins.size > 0) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
