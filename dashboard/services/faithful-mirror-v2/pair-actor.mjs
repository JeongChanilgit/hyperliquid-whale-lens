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
const sourceOrderDebtFingerprint = (order) => [
  order.id,
  order.coin,
  order.poolId,
  order.side,
  order.price,
  order.triggerPrice ?? "",
  order.orderType,
  order.tif,
  order.reduceOnly,
  order.size,
  order.remainingSize,
  order.status,
  order.leverage.type,
  order.leverage.value,
].join("|");
const debtMaterial = (debt) => ({
  ...(debt.sourceOrderId != null
    ? {
      kind: "ORDER",
      coin: String(debt.coin),
      sourceOrderId: String(debt.sourceOrderId),
      // A source-order edit is material; follower equity/mark scaling is not.
      sourceOrderFingerprint: String(debt.sourceOrderFingerprint ?? ""),
    }
    : {
      kind: "POSITION",
      coin: String(debt.coin),
      // Position residuals below the immediate execution threshold are a
      // single durable debt. Their amount, mark-derived notional, or even
      // side may oscillate while the exchange catches up; audit only its
      // lifecycle, not every transient state.
      reason: String(debt.reason ?? ""),
    }),
});
const sameTrackingDebt = (left, right) => JSON.stringify(debtMaterial(left)) === JSON.stringify(debtMaterial(right));

export class FaithfulPairActor {
  constructor({ pairId, sourceAddress, targetAddress, execution, config = {}, now = Date.now, log = () => {} }) {
    this.pairId = String(pairId);
    this.sourceAddress = normalizeAddress(sourceAddress);
    this.targetAddress = normalizeAddress(targetAddress);
    if (this.sourceAddress === this.targetAddress) {
      throw new Error(`Pair ${this.pairId} cannot use the same source and target address`);
    }
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
    this.pendingOrderOwnershipRecovery = null;
    this.leverageCache = new Map();
    this.currentMarks = new Map();
    this.positionTrackingDebtByCoin = new Map();
    this.orderTrackingDebtBySource = new Map();
    this.dirtyCoins = new Set();
    this.dirtyReasons = new Map();
    this.reconciliationRunning = false;
    this.reconciliationPromise = null;
    this.verificationTimers = new Map();
    this.terminalTimers = new Map();
    this.generationByCoin = new Map();
    this.pendingOrderCancellations = new Map();
    this.initialized = false;
    this.bootstrapping = false;
    this.bufferedEvents = [];
    this.stopped = false;
    this.blocked = false;
    this.killed = false;
    this.state = "STARTING";
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
      shadowCreates: 0,
      shadowModifies: 0,
      shadowCancels: 0,
      immediateCatchUps: 0,
      verification250ms: 0,
      verification1000ms: 0,
      pairFailures: 0,
    };
  }

  /**
   * Queue checked ownership for the next bootstrap. Recovery is deliberately
   * pre-bootstrap only, so it cannot overwrite a newer exchange observation.
   */
  restoreOrderOwnership({ sourceOrderToTargetCloid, targetOpenOrders = [], requireTargetOpen = true, preserveExistingShadow = requireTargetOpen } = {}) {
    if (this.initialized) throw new Error(`Pair ${this.pairId} can only restore order ownership before bootstrap`);
    if (!sourceOrderToTargetCloid || typeof sourceOrderToTargetCloid !== "object" || Array.isArray(sourceOrderToTargetCloid)) {
      throw new Error(`Pair ${this.pairId} recovery order mapping is required`);
    }
    if (!Array.isArray(targetOpenOrders)) throw new Error(`Pair ${this.pairId} recovery target orders must be an array`);
    const ownership = new Map();
    for (const [rawSourceOrderId, rawTargetCloid] of Object.entries(sourceOrderToTargetCloid)) {
      const sourceOrderId = String(rawSourceOrderId);
      const targetCloid = String(rawTargetCloid);
      if (!sourceOrderId || !targetCloid || sourceOrderId.trim() !== sourceOrderId || targetCloid !== deterministicTargetOrderId(this.pairId, sourceOrderId)) {
        throw new Error(`Pair ${this.pairId} recovery target Cloid is non-canonical for ${sourceOrderId || "<missing>"}`);
      }
      ownership.set(sourceOrderId, targetCloid);
    }
    this.pendingOrderOwnershipRecovery = {
      ownership,
      targetOpenOrders: targetOpenOrders.map(clone),
      requireTargetOpen: requireTargetOpen !== false,
      preserveExistingShadow: preserveExistingShadow === true,
    };
    return { accepted: true, recoveredOrders: ownership.size };
  }

  async bootstrap({ sourceSnapshot, targetSnapshot, sourceOpenOrders = [], currentMarks = null }) {
    if (this.initialized) throw new Error(`Pair ${this.pairId} is already initialized`);
    if (this.stopped) throw new Error(`Pair ${this.pairId} is stopped`);
    this.state = "BOOTSTRAPPING";
    this.sourceSnapshot = cloneSnapshot(sourceSnapshot);
    this.targetSnapshot = cloneSnapshot(targetSnapshot);
    this.#ingestCurrentMarks(currentMarks);
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
    this.bootstrapping = true;
    for (const coin of initialCoins) this.#markDirty(coin, "BOOTSTRAP_POSITION");
    await this.whenIdle();
    if (this.blocked || this.killed) {
      this.bootstrapping = false;
      this.bufferedEvents.length = 0;
      return this.snapshot();
    }
    for (const order of startupOrders) this.sourceOrders.set(order.id, order);
    this.#hydrateRecoveredOrderOwnership(startupOrders);
    for (const order of startupOrders) await this.#mirrorOrder(order);
    this.bootstrapping = false;
    for (const event of this.bufferedEvents.splice(0)) {
      if (event.type === "SOURCE_FILL") this.onSourceFill(event.payload);
      else if (event.type === "SOURCE_ORDER") await this.onSourceOrder(event.payload);
      else if (event.type === "SOURCE_ORDERS") await this.syncSourceOrders(event.payload);
      else if (event.type === "SOURCE_SNAPSHOT") this.onSourceSnapshot(event.payload);
      else if (event.type === "TARGET_FILL") this.onTargetFill(event.payload);
      else if (event.type === "TARGET_ORDER") this.onTargetOrder(event.payload);
      else if (event.type === "TARGET_ORDERS") this.syncTargetOrders(event.payload);
      else if (event.type === "TARGET_SNAPSHOT") this.onTargetSnapshot(event.payload);
      else if (event.type === "CURRENT_MARK") this.onCurrentMark(event.payload.coin, event.payload.markPriceUsd);
    }
    await this.whenIdle();
    if (!this.blocked && !this.killed) {
      this.state = "RUNNING";
      this.#record("PAIR_READY", { sourceOpenOrderCount: startupOrders.length });
    }
    return this.snapshot();
  }

  async onSourceOrder(update) {
    this.#requireReady();
    if (this.bootstrapping) {
      this.#buffer("SOURCE_ORDER", update);
      return;
    }
    this.stats.sourceOrderUpdates += 1;
    const order = this.#normalizeSourceOrder(update.order ?? update);
    const status = String(update.status ?? order.status ?? "OPEN").toUpperCase();
    order.status = status;
    if (statusIsTerminal(status)) {
      this.sourceOrders.delete(order.id);
      this.shadowStateBySource.delete(order.id);
      this.#clearOrderTrackingDebt(order.id, "SOURCE_TERMINAL");
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
    if (this.bootstrapping) {
      this.#buffer("SOURCE_ORDERS", openOrders);
      return;
    }
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
      this.#clearOrderTrackingDebt(sourceOrderId, "SOURCE_SNAPSHOT_REMOVED");
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
    if (this.bootstrapping) {
      this.#buffer("SOURCE_FILL", fill);
      return;
    }
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
          this.#clearOrderTrackingDebt(order.id, "SOURCE_FILLED");
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
    if (this.bootstrapping) {
      this.#buffer("TARGET_FILL", fill);
      return;
    }
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
    if (this.bootstrapping) {
      this.#buffer("TARGET_ORDER", update);
      return;
    }
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
    if (this.bootstrapping) {
      this.#buffer("TARGET_ORDERS", openOrders);
      return;
    }
    const openByTargetId = new Map();
    for (const raw of openOrders ?? []) {
      const targetOrderId = raw.targetOrderId != null ? String(raw.targetOrderId) : raw.clientOrderId != null ? String(raw.clientOrderId) : null;
      if (!targetOrderId) continue;
      openByTargetId.set(targetOrderId, { ...clone(raw), targetOrderId, status: String(raw.status ?? "OPEN").toUpperCase() });
    }
    for (const [targetOrderId, sourceOrderId] of this.sourceOrderByTarget) {
      const observed = openByTargetId.get(targetOrderId);
      if (observed) {
        const previous = this.targetOrderState.get(targetOrderId) ?? {};
        // A REST target snapshot has exchange facts but no source OID. Keep
        // recovered ownership so the next checkpoint remains replay-safe.
        this.targetOrderState.set(targetOrderId, { ...previous, ...observed, targetOrderId, sourceOrderId });
      }
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
    if (this.bootstrapping) {
      this.#buffer("SOURCE_SNAPSHOT", snapshot);
      return;
    }
    this.sourceSnapshot = cloneSnapshot(snapshot);
    this.#markAllCoinsDirty("SOURCE_SNAPSHOT");
  }

  onTargetSnapshot(snapshot) {
    this.#requireReady();
    if (this.bootstrapping) {
      this.#buffer("TARGET_SNAPSHOT", snapshot);
      return;
    }
    this.targetSnapshot = cloneSnapshot(snapshot);
    this.#markAllCoinsDirty("TARGET_SNAPSHOT");
  }

  onCurrentMark(coin, markPriceUsd) {
    this.#requireReady();
    const normalizedCoin = normalizeCoin(coin);
    const mark = Number(markPriceUsd);
    if (!Number.isFinite(mark) || mark <= 0) throw new Error(`Current mark for ${normalizedCoin} must be positive`);
    this.currentMarks.set(normalizedCoin, mark);
    if (this.bootstrapping) {
      this.#buffer("CURRENT_MARK", { coin: normalizedCoin, markPriceUsd: mark });
      return;
    }
    this.#markDirty(normalizedCoin, "CURRENT_MARK");
  }

  async whenIdle() {
    // A websocket callback can mark a coin dirty immediately before its async
    // drain publishes reconciliationPromise. Yield once, then wait for both
    // the published promise and any still-pending dirty state.
    await Promise.resolve();
    while (this.reconciliationPromise || this.reconciliationRunning || this.dirtyCoins.size > 0) {
      if (this.reconciliationPromise) await this.reconciliationPromise;
      else await Promise.resolve();
    }
  }

  isTerminal() {
    return this.killed || this.blocked || this.stopped;
  }

  stop() {
    this.stopped = true;
    if (!this.killed) this.state = "STOPPED";
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
      state: this.state,
      stopped: this.stopped,
      blocked: this.blocked,
      killed: this.killed,
      lastError: this.lastError,
      sourceSnapshot: clone(this.sourceSnapshot),
      targetSnapshot: clone(this.targetSnapshot),
      sourceOrders: [...this.sourceOrders.values()].map(clone),
      targetOrderState: [...this.targetOrderState.values()].map(clone),
      trackingDebt: {
        positions: [...this.positionTrackingDebtByCoin.values()].map(clone),
        orders: [...this.orderTrackingDebtBySource.values()].map(clone),
      },
      dirtyCoins: [...this.dirtyCoins],
      stats: clone(this.stats),
      metrics: {
        source_fill_count: this.stats.sourceFills,
        source_order_update_count: this.stats.sourceOrderUpdates,
        shadow_create_count: this.stats.shadowCreates,
        shadow_modify_count: this.stats.shadowModifies,
        shadow_cancel_count: this.stats.shadowCancels,
        immediate_catchup_count: this.stats.immediateCatchUps,
        terminal_residual_count: this.stats.terminalResiduals,
        pair_failure_count: this.stats.pairFailures,
      },
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
            await this.#blockPair(error, { coin, reasons, phase: "RECONCILIATION" });
            break;
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
    if (!delta.tradeable && Math.abs(delta.rawDeltaSize) > ZERO_EPSILON) {
      this.#setPositionTrackingDebt(coin, desired, actualSize, delta, reasons);
    } else {
      this.#clearPositionTrackingDebt(coin, "POSITION_RECONCILED");
    }
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
      if (!reasons.some((reason) => String(reason).startsWith("VERIFY_"))) this.stats.immediateCatchUps += 1;
      this.#record("CATCH_UP", {
        coin,
        reasons,
        desiredSize: desired.targetSignedSize,
        actualSize,
        deltaSize: delta.deltaSize,
        accepted: result?.accepted === true,
        reason: result?.reason ?? null,
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
    if (catchUpSubmitted && !reasons.some((reason) => String(reason).startsWith("VERIFY_"))) {
      this.#scheduleVerification(coin);
    }
  }

  #hydrateRecoveredOrderOwnership(startupOrders) {
    const recovery = this.pendingOrderOwnershipRecovery;
    this.pendingOrderOwnershipRecovery = null;
    if (!recovery?.ownership?.size) return;
    const sourceById = new Map(startupOrders.map((order) => [order.id, order]));
    const targetByCloid = new Map(recovery.targetOpenOrders.flatMap((order) => {
      const targetCloid = order?.targetOrderId ?? order?.clientOrderId;
      return targetCloid ? [[String(targetCloid), order]] : [];
    }));
    for (const [sourceOrderId, targetCloid] of recovery.ownership) {
      const sourceOrder = sourceById.get(sourceOrderId);
      // The source order closed while offline; do not resurrect or cancel a
      // stale target order solely because a recovery checkpoint mentioned it.
      if (!sourceOrder) continue;
      const targetOrder = targetByCloid.get(targetCloid);
      if (recovery.requireTargetOpen && !targetOrder) {
        throw new Error(`Pair ${this.pairId} recovered target Cloid is absent for ${sourceOrderId}`);
      }
      this.targetOrderBySource.set(sourceOrderId, targetCloid);
      this.sourceOrderByTarget.set(targetCloid, sourceOrderId);
      if (!targetOrder) continue;
      const update = {
        ...clone(targetOrder),
        sourceOrderId,
        targetOrderId: targetCloid,
        exchangeOrderId: targetOrder.id ?? null,
        status: String(targetOrder.status ?? "OPEN").toUpperCase(),
      };
      this.targetOrderState.set(targetCloid, update);
      this.execution.onTargetOrder?.({ pairId: this.pairId, update: clone(update) });
      if (!recovery.preserveExistingShadow) continue;
      const scaled = scaleSourceOrder({
        sourceOrder,
        sourceSnapshot: this.sourceSnapshot,
        targetSnapshot: this.targetSnapshot,
        targetPositionSize: positionSizeForCoin(this.targetSnapshot, sourceOrder.coin),
        minNotionalUsd: this.config.minimumOrderNotionalUsd,
        sizeStep: this.config.minimumOrderSize,
      });
      if (scaled.targetRemainingSize > ZERO_EPSILON) this.shadowStateBySource.set(sourceOrderId, { fingerprint: orderFingerprint(scaled), at: this.now() });
    }
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
      minNotionalUsd: this.config.minimumOrderNotionalUsd,
      sizeStep: this.config.minimumOrderSize,
    });
    const priorShadow = this.shadowStateBySource.get(order.id);
    const fingerprint = orderFingerprint(scaled);
    if (scaled.targetRemainingSize <= ZERO_EPSILON) {
      if (scaled.targetUnroundedRemainingSize > ZERO_EPSILON) {
        this.#setOrderTrackingDebt(order.id, {
          sourceOrderId: order.id,
          coin: order.coin,
          targetUnroundedRemainingSize: scaled.targetUnroundedRemainingSize,
          targetNotionalUsd: scaled.targetUnroundedRemainingSize * scaled.price,
          priceUsd: scaled.price,
          sourceOrderFingerprint: sourceOrderDebtFingerprint(order),
          reason: scaled.belowMinimum ? "SCALED_BELOW_MINIMUM" : "SCALED_TO_ZERO",
          at: this.now(),
        });
      }
      await this.#cancelMirroredOrder(order.id, "SCALED_TO_ZERO");
      return;
    }
    this.#clearOrderTrackingDebt(order.id, "ORDER_BECAME_TRACKABLE");
    if (priorShadow?.fingerprint === fingerprint && this.targetOrderBySource.has(order.id)) return;
    const targetOrderId = this.targetOrderBySource.get(order.id) ?? deterministicTargetOrderId(this.pairId, order.id);
    const isModify = this.targetOrderBySource.has(order.id);
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
    if (isModify) this.stats.shadowModifies += 1;
    else this.stats.shadowCreates += 1;
  }

  async #cancelMirroredOrder(sourceOrderId, reason) {
    const targetOrderId = this.targetOrderBySource.get(String(sourceOrderId));
    this.shadowStateBySource.delete(String(sourceOrderId));
    if (reason !== "SCALED_TO_ZERO") this.#clearOrderTrackingDebt(String(sourceOrderId), reason);
    if (!targetOrderId) return;
    const result = await this.execution.cancelOrder({ pairId: this.pairId, targetOrderId, sourceOrderId: String(sourceOrderId), reason });
    if (!result?.accepted) throw new Error(`Unable to cancel target order ${targetOrderId}`);
    this.targetOrderBySource.delete(String(sourceOrderId));
    this.sourceOrderByTarget.delete(targetOrderId);
    this.targetOrderState.set(targetOrderId, { ...(this.targetOrderState.get(targetOrderId) ?? {}), targetOrderId, status: "CANCELED", reason });
    this.stats.canceledOrders += 1;
    this.stats.shadowCancels += 1;
  }

  #desiredPosition(coin) {
    const sourcePosition = sourcePositionForCoin(this.sourceSnapshot, coin);
    if (sourcePosition && Math.abs(Number(sourcePosition.signedSize)) > ZERO_EPSILON) {
      const currentMark = this.currentMarks.get(normalizeCoin(coin));
      const markedSourcePosition = currentMark == null
        ? sourcePosition
        : {
          ...sourcePosition,
          markPriceUsd: currentMark,
          positionValueUsd: Math.abs(Number(sourcePosition.signedSize)) * currentMark,
        };
      return targetPositionFromSource({ sourcePosition: markedSourcePosition, sourceSnapshot: this.sourceSnapshot, targetSnapshot: this.targetSnapshot });
    }
    const targetPosition = sourcePositionForCoin(this.targetSnapshot, coin);
    const sourceOrder = [...this.sourceOrders.values()].find((order) => order.coin === coin);
    const leverage = sourcePosition?.leverage ?? sourceOrder?.leverage ?? targetPosition?.leverage ?? this.leverageCache.get(coin);
    const markPriceUsd = this.currentMarks.get(normalizeCoin(coin)) ?? sourcePosition?.markPriceUsd ?? targetPosition?.markPriceUsd ?? sourceOrder?.price;
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

  #setPositionTrackingDebt(coin, desired, actualSize, delta, reasons) {
    const debt = {
      coin,
      desiredSignedSize: desired.targetSignedSize,
      actualSignedSize: actualSize,
      deltaSize: delta.rawDeltaSize,
      notionalUsd: Math.abs(delta.rawDeltaSize) * desired.markPriceUsd,
      thresholdNotionalUsd: this.config.immediateResidualNotionalUsd,
      markPriceUsd: desired.markPriceUsd,
      reason: "POSITION_BELOW_MINIMUM",
      causes: [...reasons],
      at: this.now(),
    };
    this.#replaceTrackingDebt(this.positionTrackingDebtByCoin, coin, debt);
  }

  #setOrderTrackingDebt(sourceOrderId, debt) {
    this.#replaceTrackingDebt(this.orderTrackingDebtBySource, String(sourceOrderId), debt);
  }

  #clearOrderTrackingDebt(sourceOrderId, resolution) {
    this.#clearTrackingDebt(this.orderTrackingDebtBySource, String(sourceOrderId), resolution);
  }

  #clearPositionTrackingDebt(coin, resolution) {
    this.#clearTrackingDebt(this.positionTrackingDebtByCoin, normalizeCoin(coin), resolution);
  }

  #replaceTrackingDebt(collection, key, debt) {
    const prior = collection.get(key);
    // Always replace the in-memory state, including its fresh timestamp and
    // causes, even when its material audit representation has not changed.
    collection.set(key, debt);
    if (!prior || !sameTrackingDebt(prior, debt)) this.#record("TRACKING_DEBT", debt);
  }

  #clearTrackingDebt(collection, key, resolution) {
    const prior = collection.get(key);
    if (!prior) return;
    collection.delete(key);
    this.#record("TRACKING_DEBT_CLEARED", {
      ...prior,
      resolution: String(resolution),
      clearedAt: this.now(),
    });
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
      this.stats.verification250ms += 1;
      this.#markDirty(coin, "VERIFY_250MS");
    }, this.config.verificationDelayMs);
    const terminal = setTimeout(async () => {
      this.terminalTimers.delete(coin);
      if (this.generationByCoin.get(coin) !== generation || this.stopped) return;
      this.stats.verification1000ms += 1;
      try {
        this.#markDirty(coin, "VERIFY_1000MS");
        await this.whenIdle();
        if (this.stopped || this.blocked) return;
        const desired = this.#desiredPosition(coin);
        const actual = positionSizeForCoin(this.targetSnapshot, coin);
        const residual = residualBps({ desiredSize: desired.targetSignedSize, actualSize: actual });
        const terminalDelta = reconciliationDelta({
          desiredSize: desired.targetSignedSize,
          actualSize: actual,
          markPriceUsd: desired.markPriceUsd,
          minNotionalUsd: this.config.immediateResidualNotionalUsd,
          sizeStep: desired.sizeStep ?? 0,
        });
        // A sub-minimum residual is explicit tracking debt, not a terminal
        // execution failure. Killing the pair here would contradict the
        // required accumulate-until-tradeable behavior.
        if (terminalDelta.tradeable && residual > this.config.targetPositionToleranceBps) {
          this.stats.terminalResiduals += 1;
          const residualDetail = {
            pairId: this.pairId,
            coin,
            desiredSignedSize: desired.targetSignedSize,
            actualSignedSize: actual,
            residualBps: residual,
            killSwitchRequested: this.config.killOnTerminalResidual,
          };
          try {
            await this.execution.onUnresolvedResidual?.(residualDetail);
          } catch (hookError) {
            this.#record("TERMINAL_RESIDUAL_HOOK_ERROR", { coin, message: hookError instanceof Error ? hookError.message : String(hookError) });
          }
          this.#record("TERMINAL_RESIDUAL", { coin, desiredSize: desired.targetSignedSize, actualSize: actual, residualBps: residual });
          if (this.config.killOnTerminalResidual) await this.#killPair(residualDetail);
        }
      } catch (error) {
        await this.#blockPair(error, { coin, phase: "TERMINAL_VERIFICATION" });
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
    if (this.stopped || this.blocked) return;
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
    if (this.killed) throw new Error(`Pair ${this.pairId} is killed`);
    if (this.blocked) throw new Error(`Pair ${this.pairId} is recovery-blocked`);
    if (this.stopped) throw new Error(`Pair ${this.pairId} is stopped`);
  }

  #buffer(type, payload) {
    this.bufferedEvents.push({ type, payload: clone(payload) });
  }

  #ingestCurrentMarks(currentMarks) {
    if (!currentMarks) return;
    const entries = currentMarks instanceof Map
      ? [...currentMarks.entries()]
      : Array.isArray(currentMarks)
        ? currentMarks.map((value) => [value.coin, value.markPriceUsd ?? value.price])
        : Object.entries(currentMarks);
    for (const [coin, rawMark] of entries) {
      const normalizedCoin = normalizeCoin(coin);
      const mark = Number(rawMark);
      if (!Number.isFinite(mark) || mark <= 0) throw new Error(`Current mark for ${normalizedCoin} must be positive`);
      this.currentMarks.set(normalizedCoin, mark);
    }
  }

  async #blockPair(error, detail = {}) {
    if (this.blocked || this.killed) return;
    this.blocked = true;
    this.state = "PAIR_RECOVERY_BLOCKED";
    this.lastError = error instanceof Error ? error.message : String(error);
    this.stats.pairFailures += 1;
    this.dirtyCoins.clear();
    this.dirtyReasons.clear();
    for (const timer of this.verificationTimers.values()) clearTimeout(timer);
    for (const timer of this.terminalTimers.values()) clearTimeout(timer);
    this.verificationTimers.clear();
    this.terminalTimers.clear();
    this.#record("PAIR_RECOVERY_BLOCKED", { ...detail, message: this.lastError });
    try {
      await this.execution.onPairFailure?.({
        pairId: this.pairId,
        sourceAddress: this.sourceAddress,
        targetAddress: this.targetAddress,
        error: this.lastError,
        ...clone(detail),
      });
    } catch (hookError) {
      this.#record("PAIR_FAILURE_HOOK_ERROR", { message: hookError instanceof Error ? hookError.message : String(hookError) });
    }
  }

  async #killPair(detail = {}) {
    if (this.killed) return;
    this.killed = true;
    this.stopped = true;
    this.state = "KILLED";
    this.dirtyCoins.clear();
    this.dirtyReasons.clear();
    for (const timer of this.verificationTimers.values()) clearTimeout(timer);
    for (const timer of this.terminalTimers.values()) clearTimeout(timer);
    this.verificationTimers.clear();
    this.terminalTimers.clear();
    this.#record("PAIR_KILLED", clone(detail));
    try {
      await this.execution.killPair?.({
        pairId: this.pairId,
        sourceAddress: this.sourceAddress,
        targetAddress: this.targetAddress,
        ...clone(detail),
      });
    } catch (hookError) {
      this.#record("PAIR_KILL_HOOK_ERROR", { message: hookError instanceof Error ? hookError.message : String(hookError) });
    }
  }

  #record(type, detail) {
    const at = this.now();
    this.log({ type, at, receivedAt: at, detail: clone(detail) });
  }
}
