import { DisabledHyperliquidExecutionAdapter, hyperliquidClientOrderId } from "./hyperliquid-execution";
import { HyperliquidUserFillsMonitor, type HyperliquidMonitorOptions } from "./hyperliquid-ws";
import { CopyRiskGate, type RiskGateInitialState } from "./risk-gates";
import { CopySimulationLedger } from "./simulation-ledger";
import { CopyOrderMirrorLedger } from "./order-mirror-ledger";
import type { OpenEpisodeReplayPlan } from "./open-episode-replay";
import type {
  CopyEngineConfig,
  CopyEngineSnapshot,
  CopyEngineState,
  CopyMode,
  CopyPerformance,
  EngineLogEntry,
  HyperliquidAccountState,
  HyperliquidCloneOrderRequest,
  HyperliquidExecutionPort,
  HyperliquidRealtimeFill,
  HyperliquidRealtimeOrderUpdate,
  MirroredOrderEvent,
  MirroredOrder,
  RealtimeMonitorEvent,
  SimulationLedgerEvent,
  SimulationPositionSnapshot,
  WhaleConfig,
} from "../copy-types";

const blankPerformance = (): CopyPerformance => ({ realizedPnl: 0, fees: 0, executedNotionalUsd: 0, simulatedFills: 0, executions: 0, blockedExecutions: 0, errors: 0 });
const normaliseAddress = (address: string): string => address.trim().toLowerCase();

export interface CopyEngineOptions {
  config: CopyEngineConfig;
  monitor?: HyperliquidUserFillsMonitor;
  monitorOptions?: Omit<HyperliquidMonitorOptions, "whales">;
  execution?: HyperliquidExecutionPort;
  auditSink?: CopyEngineAuditSink;
  /**
   * Server-side history/reconciliation source used only by the simulation-only
   * REPLAY_OPEN_EPISODES policy. Keeping this injected prevents the engine
   * itself from making browser-visible history calls.
   */
  openEpisodeReplayProvider?: (input: {
    whale: WhaleConfig;
    cutoffAccountState: HyperliquidAccountState;
    followerAllocationUsd: number;
    sourceAccountValueUsd: number;
  }) => Promise<OpenEpisodeReplayPlan>;
  initialState?: {
    performance?: CopyPerformance;
    performanceByWhale?: Record<string, CopyPerformance>;
    risk?: RiskGateInitialState;
    simulationPositions?: SimulationPositionSnapshot[];
  };
  now?: () => number;
}

export interface CopyEngineAuditSink {
  onLog?(entry: EngineLogEntry): void;
  onSimulation?(event: SimulationLedgerEvent): void;
  onSimulationPosition?(position: SimulationPositionSnapshot): void;
  onMirrorOrder?(event: MirroredOrderEvent): void;
  onSnapshot?(snapshot: CopyEngineSnapshot): void;
}

/** Legacy Binance reconciler contract retained for historical ledger tests only. */
export interface CopyExecutionReconciler {
  afterOrder(input: {
    intent: NonNullable<SimulationLedgerEvent["intent"]>;
    segmentIndex: number;
    segment: NonNullable<SimulationLedgerEvent["intent"]>["segments"][number];
    result: { orderId?: string; clientOrderId: string; status?: string };
    expectedPositionAfter: number;
  }): Promise<{ ok: boolean; reason?: string }>;
}

/**
 * Server-side coordinator for realtime source fills. It can run as a local bridge
 * in a long-lived Node process; serverless request lifetimes are not durable workers.
 */
export class RealtimeCopyEngine {
  private readonly config: CopyEngineConfig;
  private readonly mode: CopyMode;
  private readonly whales = new Map<string, WhaleConfig>();
  private readonly ledger: CopySimulationLedger;
  private readonly orderMirror: CopyOrderMirrorLedger;
  private readonly risk: CopyRiskGate;
  private readonly auditSink: CopyEngineAuditSink | undefined;
  private readonly monitor: HyperliquidUserFillsMonitor;
  private readonly execution: HyperliquidExecutionPort;
  private readonly now: () => number;
  private readonly subscribers = new Set<(snapshot: CopyEngineSnapshot) => void>();
  private readonly accountStates = new Map<string, HyperliquidAccountState>();
  private readonly sourceLeverageByAsset = new Map<string, NonNullable<HyperliquidCloneOrderRequest["leverage"]>>();
  private readonly positionSyncedWhales = new Set<string>();
  private readonly replayBootstrapScheduledWhales = new Set<string>();
  private readonly pendingOrderUpdates = new Map<string, { whale: string; update: HyperliquidRealtimeOrderUpdate }>();
  private readonly sizingByWhale = new Map<string, CopyEngineSnapshot["sizingByWhale"][string]>();
  private state: CopyEngineState = "STOPPED";
  private startedAt: number | undefined;
  private lastError: string | undefined;
  private performance: CopyPerformance;
  private performanceByWhale = new Map<string, CopyPerformance>();
  private logs: EngineLogEntry[] = [];
  private readonly processingByWhale = new Map<string, Promise<void>>();
  private readonly dispatchedOrders = new Set<string>();
  private readonly settlementTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribeMonitor: (() => void) | undefined;
  private readonly openEpisodeReplayProvider: CopyEngineOptions["openEpisodeReplayProvider"];

  constructor(options: CopyEngineOptions) {
    if (options.config.whales.length === 0 || options.config.whales.length > 10) throw new Error("Copy engine requires 1-10 whale addresses");
    for (const config of options.config.whales) {
      const address = normaliseAddress(config.address);
      if (!/^0x[a-f0-9]{40}$/.test(address)) throw new Error(`Invalid Hyperliquid address: ${config.address}`);
      if (this.whales.has(address)) throw new Error(`Duplicate whale address: ${config.address}`);
      if (!Number.isFinite(config.copyRatio) || config.copyRatio <= 0 || config.copyRatio > 1) throw new Error("copyRatio must be in (0, 1]");
      this.whales.set(address, { ...config, address });
    }
    if (options.config.sizing) {
      if (!Number.isFinite(options.config.sizing.followerCapitalUsd) || options.config.sizing.followerCapitalUsd <= 0) {
        throw new Error("followerCapitalUsd must be greater than zero");
      }
      if (options.config.sizing.maxAccountStateAgeMs !== undefined && (
        !Number.isFinite(options.config.sizing.maxAccountStateAgeMs) || options.config.sizing.maxAccountStateAgeMs <= 0
      )) throw new Error("maxAccountStateAgeMs must be greater than zero");
      if (options.config.sizing.minSourceAccountValueUsd !== undefined && (
        !Number.isFinite(options.config.sizing.minSourceAccountValueUsd) || options.config.sizing.minSourceAccountValueUsd < 0
      )) throw new Error("minSourceAccountValueUsd must not be negative");
    }
    this.config = options.config;
    this.mode = options.config.mode ?? "SIMULATION";
    if ((options.config.entryPolicy ?? "INCLUDE_EXISTING") === "REPLAY_OPEN_EPISODES" && this.mode !== "SIMULATION") {
      throw new Error("REPLAY_OPEN_EPISODES is available only in simulation mode");
    }
    const restoredSimulationPositions = options.initialState?.simulationPositions
      ?.filter((position) => this.whales.has(position.whale.toLowerCase())) ?? [];
    this.ledger = new CopySimulationLedger({
      symbolForCoin: options.config.binanceSymbolForCoin,
      initialPositions: restoredSimulationPositions,
    });
    // A durable paper position is already the result of this session's prior
    // fills. Re-basing it to the latest equity on every process restart creates
    // a phantom trade with no source fill, so only first-ever carry-ins sync.
    for (const position of restoredSimulationPositions) {
      if (Math.abs(position.sourcePosition) > 1e-9 || Math.abs(position.followerPosition) > 1e-9) {
        this.positionSyncedWhales.add(position.whale.toLowerCase());
        this.replayBootstrapScheduledWhales.add(position.whale.toLowerCase());
      }
    }
    for (const [whale, restoredPerformance] of Object.entries(options.initialState?.performanceByWhale ?? {})) {
      if (restoredPerformance.simulatedFills > 0) {
        this.positionSyncedWhales.add(whale.toLowerCase());
        this.replayBootstrapScheduledWhales.add(whale.toLowerCase());
      }
    }
    if ((options.initialState?.performance?.simulatedFills ?? 0) > 0) {
      // Older durable stores may have only aggregate replay events. Replaying
      // them again is worse than conservatively waiting for a fresh episode.
      for (const whale of this.whales.keys()) {
        this.positionSyncedWhales.add(whale);
        this.replayBootstrapScheduledWhales.add(whale);
      }
    }
    this.orderMirror = new CopyOrderMirrorLedger({ symbolForCoin: options.config.binanceSymbolForCoin });
    this.risk = new CopyRiskGate({ ...options.config.risk, allowedWhales: options.config.risk.allowedWhales ?? [...this.whales.keys()] }, options.initialState?.risk);
    this.auditSink = options.auditSink;
    this.openEpisodeReplayProvider = options.openEpisodeReplayProvider;
    this.execution = options.execution ?? new DisabledHyperliquidExecutionAdapter();
    this.monitor = options.monitor ?? new HyperliquidUserFillsMonitor({ whales: [...this.whales.keys()], ...options.monitorOptions, ignoreSnapshotFills: true });
    this.now = options.now ?? Date.now;
    this.performance = { ...blankPerformance(), ...options.initialState?.performance };
    for (const [whale, performance] of Object.entries(options.initialState?.performanceByWhale ?? {})) {
      this.performanceByWhale.set(whale.toLowerCase(), { ...blankPerformance(), ...performance });
    }
  }

  start(): void {
    if (this.state === "RUNNING" || this.state === "STARTING") return;
    this.state = "STARTING";
    this.startedAt = this.now();
    this.lastError = undefined;
    this.log("LIFECYCLE", "Realtime copy engine starting");
    this.unsubscribeMonitor = this.monitor.subscribe((event) => this.onMonitorEvent(event));
    this.monitor.start();
    this.state = "RUNNING";
    this.log("LIFECYCLE", `Realtime copy engine running in ${this.mode} mode`);
    this.publish();
  }

  stop(): void {
    if (this.state === "STOPPED" || this.state === "STOPPING") return;
    this.state = "STOPPING";
    this.monitor.stop();
    this.unsubscribeMonitor?.();
    this.unsubscribeMonitor = undefined;
    for (const timer of this.settlementTimers.values()) clearTimeout(timer);
    this.settlementTimers.clear();
    void this.execution.close?.();
    this.state = "STOPPED";
    this.log("LIFECYCLE", "Realtime copy engine stopped");
    this.publish();
  }

  setKillSwitch(enabled: boolean): void {
    this.risk.setKillSwitch(enabled);
    this.log("LIFECYCLE", enabled ? "Kill switch enabled" : "Kill switch disabled");
    this.publish();
  }

  subscribe(listener: (snapshot: CopyEngineSnapshot) => void): () => void {
    this.subscribers.add(listener);
    listener(this.snapshot());
    return () => this.subscribers.delete(listener);
  }

  snapshot(): CopyEngineSnapshot {
    return {
      state: this.state,
      mode: this.mode,
      entryPolicy: this.config.entryPolicy ?? "INCLUDE_EXISTING",
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      watchedWhales: [...this.whales.keys()],
      whaleLabels: Object.fromEntries(
        [...this.whales.entries()]
          .filter(([, config]) => Boolean(config.label))
          .map(([whale, config]) => [whale, config.label as string]),
      ),
      performance: { ...this.performance },
      performanceByWhale: Object.fromEntries(
        [...this.performanceByWhale.entries()].map(([whale, performance]) => [whale, { ...performance }]),
      ),
      sizing: this.config.sizing
        ? {
            mode: this.config.sizing.mode,
            followerCapitalUsd: this.config.sizing.followerCapitalUsd,
            allocationPerWhaleUsd: this.config.sizing.followerCapitalUsd / this.whales.size,
          }
        : { mode: "FIXED_SOURCE_RATIO" },
      sizingByWhale: Object.fromEntries(
        [...this.whales.keys()].map((whale) => {
          const current = this.sizingByWhale.get(whale);
          const accountState = this.accountStates.get(whale);
          const sourcePositionNotionalUsd = accountState?.positions.reduce((sum, position) => sum + (
            position.positionValueUsd !== undefined
              ? Math.abs(position.positionValueUsd)
              : Math.abs(position.signedSize) * (position.entryPriceUsd ?? 0)
          ), 0);
          return [whale, {
            ...current,
            ...(accountState ? {
              accountValueUsd: accountState.accountValueUsd,
              accountStateAt: accountState.receivedAt,
              sourcePositionNotionalUsd,
              sourceExposurePct: accountState.accountValueUsd > 0 ? sourcePositionNotionalUsd! / accountState.accountValueUsd * 100 : 0,
            } : {}),
            followerAccountValueUsd: this.followerAccountValueUsd(whale),
            stateFresh: Boolean(accountState && this.accountStateIsFresh(accountState)),
            sizingReady: Boolean(accountState && this.accountStateIsUsable(accountState)),
          }];
        }),
      ),
      simulationPositions: this.ledger.snapshot(),
      mirroredOrders: this.orderMirror.snapshot(),
      logs: [...this.logs],
      killSwitch: this.risk.snapshot().killSwitch,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private onMonitorEvent(event: RealtimeMonitorEvent): void {
    const receivedMonotonicMs = globalThis.performance?.now() ?? this.now();
    if (event.type === "accountState" && event.whale && event.accountState) {
      const whale = normaliseAddress(event.whale);
      const accountState = event.accountState;
      this.accountStates.set(whale, accountState);
      const entryPolicy = this.config.entryPolicy ?? "INCLUDE_EXISTING";
      let initialized = false;
      if (this.mode === "SIMULATION" &&
        this.config.sizing?.mode === "SOURCE_EQUITY_RATIO" &&
        !this.positionSyncedWhales.has(whale) &&
        this.accountStateIsUsable(accountState)) {
        if (entryPolicy === "NEW_POSITIONS_ONLY") {
          initialized = this.initializeNewPositionOnlyPolicy(whale, accountState);
        } else if (entryPolicy === "INCLUDE_EXISTING") {
          initialized = this.synchronizeSimulationPositions(whale, accountState);
        } else if (!this.replayBootstrapScheduledWhales.has(whale)) {
          // The queued bootstrap is deliberately installed before any later
          // source fills/order updates for this whale, preserving wire order.
          this.replayBootstrapScheduledWhales.add(whale);
          this.setEpisodeReplayStatus(whale, accountState, "PENDING");
          this.enqueue(whale, () => this.bootstrapOpenEpisodeReplay(whale, accountState));
          initialized = true;
        }
      }
      const pending = this.accountStateIsUsable(accountState) && this.followerAccountValueUsd(whale) > 0
        ? [...this.pendingOrderUpdates.entries()].filter(([, item]) => item.whale === whale)
        : [];
      for (const [key, item] of pending) {
        this.pendingOrderUpdates.delete(key);
        this.enqueue(item.whale, () => this.processOrderUpdate(item.whale, item.update, receivedMonotonicMs));
      }
      if (initialized) this.publish();
      return;
    }
    if (event.type === "fill" && event.whale && event.fill) {
      // Serialize source fills so partial entries/exits and reversals retain wire order.
      this.enqueue(event.whale, () => this.processFill(event.whale!, event.fill!, receivedMonotonicMs));
      return;
    }
    if (event.type === "order" && event.whale && event.orderUpdate) {
      // Order updates and fills share one queue so partial fills cannot race a cancel/modify.
      this.enqueue(event.whale, () => this.processOrderUpdate(event.whale!, event.orderUpdate!, receivedMonotonicMs));
      return;
    }
    if (event.type === "error") this.log("ERROR", event.message ?? "Realtime monitor error", { whale: event.whale });
    else if (event.type === "heartbeat") this.log("HEARTBEAT", event.message ?? "Realtime monitor heartbeat");
    else this.log("LIFECYCLE", event.message ?? "Realtime monitor status", { whale: event.whale });
    this.publish();
  }

  private async processFill(whaleAddress: string, fill: HyperliquidRealtimeFill, receivedMonotonicMs: number): Promise<void> {
    if (this.state !== "RUNNING") return;
    const whale = this.whales.get(normaliseAddress(whaleAddress));
    if (!whale) return;
    const started = this.now();
    const accountState = this.accountStates.get(whale.address);
    const followerAccountValueUsd = this.followerAccountValueUsd(whale.address);
    const equitySizing = this.config.sizing?.mode === "SOURCE_EQUITY_RATIO" && accountState && this.accountStateIsUsable(accountState) && followerAccountValueUsd > 0
      ? {
          sourceAccountValueUsd: accountState.accountValueUsd,
          allocatedFollowerCapitalUsd: this.config.sizing.followerCapitalUsd / this.whales.size,
          followerAccountValueUsd,
        }
      : undefined;
    if (this.config.sizing?.mode === "SOURCE_EQUITY_RATIO" && !equitySizing) {
      this.log("RISK_BLOCK", "Source account value is unavailable, stale, or below the minimum; proportional copy skipped", {
        whale: whale.address,
        coin: fill.coin,
        detail: {
          accountValueUsd: accountState?.accountValueUsd,
          accountStateAt: accountState?.receivedAt,
          maxAccountStateAgeMs: this.maxAccountStateAgeMs(),
          minSourceAccountValueUsd: this.minSourceAccountValueUsd(),
        },
      });
    }
    const ledgerEvent = this.ledger.apply(
      whale,
      fill,
      equitySizing ?? (this.config.sizing?.mode === "SOURCE_EQUITY_RATIO"
        ? { sourceAccountValueUsd: 0, allocatedFollowerCapitalUsd: this.config.sizing.followerCapitalUsd / this.whales.size }
        : undefined),
      { copyCarryInAdds: (this.config.entryPolicy ?? "INCLUDE_EXISTING") === "NEW_POSITIONS_ONLY" },
    );
    const positionAfterFill = this.ledger.getPositionSnapshot(whale.address, fill.coin);
    if (positionAfterFill) this.auditSink?.onSimulationPosition?.(positionAfterFill);
    const mirroredAfterFill = this.orderMirror.applySourceFill(whale.address, fill);
    if (mirroredAfterFill) this.auditSink?.onMirrorOrder?.({ action: mirroredAfterFill.lastAction, copied: true, order: mirroredAfterFill });
    if (this.mode === "HYPERLIQUID" && mirroredAfterFill?.status === "FILLED") {
      this.scheduleFilledOrderSettlement(mirroredAfterFill, this.sourceLeverageFor(whale.address, fill.coin), receivedMonotonicMs);
    }
    this.sizingByWhale.set(whale.address, {
      ...(this.sizingByWhale.get(whale.address) ?? {}),
      ...(accountState ? { accountValueUsd: accountState.accountValueUsd, accountStateAt: accountState.receivedAt } : {}),
      followerAccountValueUsd,
      ...(ledgerEvent.sourcePositionNotionalUsd !== undefined ? { sourcePositionNotionalUsd: ledgerEvent.sourcePositionNotionalUsd } : {}),
      ...(ledgerEvent.sourceExposurePct !== undefined ? { sourceExposurePct: ledgerEvent.sourceExposurePct } : {}),
      ...(ledgerEvent.targetFollowerNotionalUsd !== undefined ? { targetFollowerNotionalUsd: ledgerEvent.targetFollowerNotionalUsd } : {}),
      ...(ledgerEvent.requestedTargetFollowerNotionalUsd !== undefined ? { requestedTargetFollowerNotionalUsd: ledgerEvent.requestedTargetFollowerNotionalUsd } : {}),
      ...(ledgerEvent.followerLeverage !== undefined ? { followerLeverage: ledgerEvent.followerLeverage } : {}),
      ...(ledgerEvent.leverageCapped !== undefined ? { leverageCapped: ledgerEvent.leverageCapped } : {}),
      followerPositionAfter: ledgerEvent.followerPositionAfter,
      lastCoin: fill.coin.toUpperCase(),
      updatedAt: this.now(),
      stateFresh: Boolean(accountState && this.accountStateIsFresh(accountState)),
      sizingReady: Boolean(accountState && this.accountStateIsUsable(accountState)),
      ...((this.config.entryPolicy ?? "INCLUDE_EXISTING") === "NEW_POSITIONS_ONLY" ? {
        waitingForNewPosition: Math.abs(ledgerEvent.followerPositionAfter) <= 1e-9,
        ignoredExistingPositionCount: Math.abs(ledgerEvent.sourcePositionAfter) <= 1e-9 ||
          (Math.abs(ledgerEvent.sourcePositionBefore) > 1e-9 && Math.sign(ledgerEvent.sourcePositionBefore) !== Math.sign(ledgerEvent.sourcePositionAfter))
          ? 0
          : (this.sizingByWhale.get(whale.address)?.ignoredExistingPositionCount ?? 0),
      } : {}),
    });
    this.recordSimulation(ledgerEvent);
    const currentSizing = this.sizingByWhale.get(whale.address);
    this.sizingByWhale.set(whale.address, {
      ...currentSizing,
      followerAccountValueUsd: this.followerAccountValueUsd(whale.address),
      stateFresh: currentSizing?.stateFresh ?? false,
      sizingReady: currentSizing?.sizingReady ?? false,
    });
    this.log("SOURCE_FILL", ledgerEvent.copied ? "Source fill copied to simulation ledger" : `Source fill ignored: ${ledgerEvent.ignoredReason ?? "no position change"}`, {
      whale: whale.address,
      coin: fill.coin,
      idempotencyKey: ledgerEvent.sourceFillId,
      latencyMs: this.now() - started,
      detail: {
        sourcePositionAfter: ledgerEvent.sourcePositionAfter,
        followerPositionAfter: ledgerEvent.followerPositionAfter,
        sizingMode: ledgerEvent.sizingMode,
        sourceAccountValueUsd: ledgerEvent.sourceAccountValueUsd,
        sourcePositionNotionalUsd: ledgerEvent.sourcePositionNotionalUsd,
        sourceExposurePct: ledgerEvent.sourceExposurePct,
        targetFollowerNotionalUsd: ledgerEvent.targetFollowerNotionalUsd,
        requestedTargetFollowerNotionalUsd: ledgerEvent.requestedTargetFollowerNotionalUsd,
        followerLeverage: ledgerEvent.followerLeverage,
        leverageCapped: ledgerEvent.leverageCapped,
      },
    });
    if (!ledgerEvent.intent) {
      this.publish();
      return;
    }
    if (this.mode === "SIMULATION") {
      this.log("SIMULATION", "Simulated copy intent", { whale: whale.address, coin: fill.coin, symbol: ledgerEvent.intent.symbol, idempotencyKey: ledgerEvent.intent.idempotencyKey, detail: { notionalUsd: ledgerEvent.intent.notionalUsd, realizedPnl: ledgerEvent.realizedPnl } });
      this.publish();
      return;
    }
    this.log("EXECUTION", "Source fill observed; live Hyperliquid execution remains order-lifecycle driven", {
      whale: whale.address,
      coin: fill.coin,
      symbol: ledgerEvent.intent.symbol,
      idempotencyKey: ledgerEvent.intent.idempotencyKey,
    });
    this.publish();
  }

  private async processOrderUpdate(whaleAddress: string, update: HyperliquidRealtimeOrderUpdate, receivedMonotonicMs: number): Promise<void> {
    if (this.state !== "RUNNING") return;
    const whale = this.whales.get(normaliseAddress(whaleAddress));
    if (!whale) return;
    if (update.sourceLeverage) this.sourceLeverageByAsset.set(`${whale.address}|${update.order.coin.toUpperCase()}`, update.sourceLeverage);
    const accountState = this.accountStates.get(whale.address);
    const pendingKey = `${whale.address}|${String(update.order.oid)}`;
    if ((this.config.entryPolicy ?? "INCLUDE_EXISTING") === "NEW_POSITIONS_ONLY") {
      if (!accountState || !this.accountStateIsUsable(accountState)) {
        this.pendingOrderUpdates.set(pendingKey, { whale: whale.address, update });
        return;
      }
      const coin = update.order.coin.toUpperCase();
      const sourcePosition = accountState.positions.find((position) => position.coin.toUpperCase() === coin)?.signedSize ?? 0;
      const followerPosition = this.ledger.getFollowerPosition(whale.address, coin);
      const followerIsFlat = Math.abs(followerPosition) <= 1e-9;
      const sameDirectionIncrease = sourcePosition > 1e-9
        ? update.order.side === "B"
        : sourcePosition < -1e-9
          ? update.order.side === "A"
          : false;
      const belongsToExcludedPosition = Math.abs(sourcePosition) > 1e-9 && followerIsFlat && !sameDirectionIncrease;
      const reduceOnlyWithoutFollowerPosition = update.order.reduceOnly === true && followerIsFlat;
      if (belongsToExcludedPosition || reduceOnlyWithoutFollowerPosition) {
        this.pendingOrderUpdates.delete(pendingKey);
        this.log("SOURCE_ORDER", "Source order ignored by new-position-only policy", {
          whale: whale.address,
          coin,
          symbol: coin,
          idempotencyKey: pendingKey,
          detail: {
            sourceOid: String(update.order.oid),
            startupSnapshot: update.isSnapshot === true,
            reduceOnly: update.order.reduceOnly === true,
            sourcePosition,
            followerPosition,
          },
        });
        this.publish();
        return;
      }
    }
    const followerAccountValueUsd = this.followerAccountValueUsd(whale.address);
    const sizing = this.config.sizing?.mode === "SOURCE_EQUITY_RATIO" && accountState && this.accountStateIsUsable(accountState) && followerAccountValueUsd > 0
      ? {
          sourceAccountValueUsd: accountState.accountValueUsd,
          followerAccountValueUsd,
          followerPositionQuantity: this.ledger.getFollowerPosition(whale.address, update.order.coin),
        }
      : undefined;
    const mirrorEvent = this.orderMirror.apply(whale.address, update, sizing);
    if (!sizing && update.status.toLowerCase() === "open") this.pendingOrderUpdates.set(pendingKey, { whale: whale.address, update });
    else this.pendingOrderUpdates.delete(pendingKey);
    this.auditSink?.onMirrorOrder?.(mirrorEvent);
    const order = mirrorEvent.order;
    this.log("SOURCE_ORDER", `Source order ${mirrorEvent.action.toLowerCase()}`, {
      whale: whale.address,
      coin: order.coin,
      symbol: order.symbol,
      idempotencyKey: order.id,
      latencyMs: Math.max(0, this.now() - update.statusTimestamp),
      detail: {
        action: mirrorEvent.action,
        sourceOid: order.sourceOid,
        sourceStatus: order.sourceStatus,
        orderType: order.orderType,
        tif: order.tif,
        reduceOnly: order.reduceOnly,
        side: order.side,
        price: order.price,
        sourceOriginalQuantity: order.sourceOriginalQuantity,
        sourceRemainingQuantity: order.sourceRemainingQuantity,
        followerOriginalQuantity: order.followerOriginalQuantity,
        followerRemainingQuantity: order.followerRemainingQuantity,
        followerFilledQuantity: order.followerFilledQuantity,
        sourceAccountValueUsd: order.sourceAccountValueUsd,
        followerAccountValueUsd: order.followerAccountValueUsd,
        balanceScale: order.balanceScale,
        metadataComplete: order.metadataComplete,
        leverageCapped: order.leverageCapped,
        sourceLeverage: update.sourceLeverage,
        startupSnapshot: update.isSnapshot === true,
      },
    });
    if (mirrorEvent.copied) {
      this.log("ORDER_MIRROR", this.mode === "SIMULATION"
        ? `Simulated follower order ${mirrorEvent.action.toLowerCase()}`
        : "Live Hyperliquid order lifecycle ready for same-venue dispatch", {
        whale: whale.address,
        coin: order.coin,
        symbol: order.symbol,
        idempotencyKey: order.id,
        detail: { action: mirrorEvent.action, status: order.status, side: order.side, price: order.price, quantity: order.followerOriginalQuantity, remainingQuantity: order.followerRemainingQuantity, sourceLeverage: update.sourceLeverage },
      });
    } else if (mirrorEvent.ignoredReason === "SIZING_DATA_UNAVAILABLE") {
      this.log("RISK_BLOCK", "Source or follower account value is unavailable; order mirror recorded but not sized", { whale: whale.address, coin: order.coin, symbol: order.symbol, idempotencyKey: order.id });
    }
    if (this.mode === "HYPERLIQUID" && mirrorEvent.copied) {
      const leverage = update.sourceLeverage ?? this.sourceLeverageFor(whale.address, order.coin);
      await this.executeMirroredOrder(mirrorEvent, leverage);
      if (order.status === "FILLED") this.scheduleFilledOrderSettlement(order, leverage, receivedMonotonicMs);
    }
    this.publish();
  }

  private enqueue(whaleAddress: string, work: () => Promise<void>): void {
    const whale = normaliseAddress(whaleAddress);
    const prior = this.processingByWhale.get(whale) ?? Promise.resolve();
    const next = prior.then(work).catch((error) => this.fail(error));
    this.processingByWhale.set(whale, next);
    void next.finally(() => {
      if (this.processingByWhale.get(whale) === next) this.processingByWhale.delete(whale);
    });
  }

  private sourceLeverageFor(whale: string, coin: string): HyperliquidCloneOrderRequest["leverage"] {
    const wanted = coin.toUpperCase();
    const address = normaliseAddress(whale);
    return this.sourceLeverageByAsset.get(`${address}|${wanted}`)
      ?? this.accountStates.get(address)?.positions.find((position) => position.coin.toUpperCase() === wanted)?.leverage;
  }

  private cloneRequest(order: MirroredOrder, action: HyperliquidCloneOrderRequest["action"], leverage?: HyperliquidCloneOrderRequest["leverage"], settlement = false): HyperliquidCloneOrderRequest {
    const useOriginalQuantity = settlement || action === "CANCEL" || order.status === "FILLED";
    return {
      action,
      sourceWhale: order.whale,
      sourceOid: order.sourceOid,
      clientOrderId: hyperliquidClientOrderId(order.whale, order.sourceOid),
      coin: order.coin,
      side: order.side,
      price: order.price,
      quantity: useOriginalQuantity ? order.followerOriginalQuantity : order.followerRemainingQuantity,
      reduceOnly: order.reduceOnly === true,
      ...(order.orderType ? { orderType: order.orderType } : {}),
      ...(order.tif ? { tif: order.tif } : {}),
      ...(order.isTrigger !== undefined ? { isTrigger: order.isTrigger } : {}),
      ...(order.closeAll ? { closeAll: true } : {}),
      ...(order.triggerPrice !== undefined ? { triggerPrice: order.triggerPrice } : {}),
      ...(leverage ? { leverage } : {}),
      ...(settlement ? { targetPositionAfter: this.ledger.getFollowerPosition(order.whale, order.coin) } : {}),
    };
  }

  private async executeMirroredOrder(event: MirroredOrderEvent, leverage?: HyperliquidCloneOrderRequest["leverage"]): Promise<void> {
    const order = event.order;
    let action: HyperliquidCloneOrderRequest["action"] | undefined;
    if (event.action === "PLACED" || (!this.dispatchedOrders.has(order.id) && ["PARTIALLY_FILLED", "FILLED", "TRIGGERED"].includes(event.action))) action = "ENSURE";
    else if (event.action === "MODIFIED") action = "MODIFY";
    else if (event.action === "CANCELED" || event.action === "REJECTED") action = "CANCEL";
    if (!action) return;
    if (!order.metadataComplete && action !== "CANCEL") {
      this.blockOrder(order, "Source order metadata is incomplete; exact live cloning was blocked");
      return;
    }
    if (order.followerOriginalQuantity <= 0 || (action !== "CANCEL" && (order.status === "FILLED" ? order.followerOriginalQuantity : order.followerRemainingQuantity) <= 0)) {
      this.blockOrder(order, "Scaled Hyperliquid order quantity is zero");
      return;
    }
    if (!order.reduceOnly && action !== "CANCEL" && !leverage) {
      this.blockOrder(order, "Exact source cross/isolated leverage was unavailable");
      return;
    }
    if (!this.execution.enabled) {
      this.blockOrder(order, "Hyperliquid execution adapter is disabled");
      return;
    }
    if (action !== "CANCEL") {
      const decision = this.risk.evaluate({
        idempotencyKey: order.id,
        whale: order.whale,
        coin: order.coin,
        symbol: order.symbol,
        referencePrice: order.price,
        sourceTime: order.updatedAt,
        segments: [],
        notionalUsd: (order.status === "FILLED" ? order.followerOriginalQuantity : order.followerRemainingQuantity) * order.price,
      });
      if (!decision.allowed) {
        this.blockOrder(order, decision.reason ?? "Risk gate rejected the Hyperliquid order clone");
        return;
      }
    }
    const request = this.cloneRequest(order, action, leverage);
    const started = globalThis.performance?.now() ?? this.now();
    const result = await this.execution.cloneOrder(request);
    const latencyMs = (globalThis.performance?.now() ?? this.now()) - started;
    if (!result.accepted) {
      this.performance.errors += 1;
      this.performanceFor(order.whale).errors += 1;
      this.risk.setKillSwitch(true);
      this.log("ERROR", result.error ?? "Hyperliquid rejected the cloned order; kill switch enabled", {
        whale: order.whale,
        coin: order.coin,
        symbol: order.symbol,
        idempotencyKey: request.clientOrderId,
        latencyMs,
        detail: { action, sourceOid: order.sourceOid, testnet: this.execution.testnet },
      });
      return;
    }
    if (action !== "CANCEL") this.dispatchedOrders.add(order.id);
    else this.dispatchedOrders.delete(order.id);
    this.performance.executions += 1;
    this.performanceFor(order.whale).executions += 1;
    this.log("EXECUTION", `Hyperliquid ${action.toLowerCase()} clone accepted`, {
      whale: order.whale,
      coin: order.coin,
      symbol: order.symbol,
      idempotencyKey: request.clientOrderId,
      latencyMs,
      detail: {
        action,
        sourceOid: order.sourceOid,
        targetOrderId: result.targetOrderId,
        status: result.status,
        quantity: result.quantity ?? request.quantity,
        price: request.price,
        leverage,
        testnet: this.execution.testnet,
      },
    });
  }

  private scheduleFilledOrderSettlement(order: MirroredOrder, leverage?: HyperliquidCloneOrderRequest["leverage"], completedAtMonotonicMs = globalThis.performance?.now() ?? this.now()): void {
    if (this.settlementTimers.has(order.id)) return;
    const scheduledAt = completedAtMonotonicMs;
    const delayMs = Math.max(0, 1_000 - ((globalThis.performance?.now() ?? this.now()) - completedAtMonotonicMs));
    const timer = setTimeout(() => {
      this.settlementTimers.delete(order.id);
      this.enqueue(order.whale, async () => {
        if (this.state !== "RUNNING" || this.mode !== "HYPERLIQUID") return;
        const waitedMs = (globalThis.performance?.now() ?? this.now()) - scheduledAt;
        const request = this.cloneRequest(order, "ENSURE", leverage, true);
        const started = globalThis.performance?.now() ?? this.now();
        const result = await this.execution.settleFilledOrder(request);
        const latencyMs = (globalThis.performance?.now() ?? this.now()) - started;
        if (!result.accepted) {
          this.performance.errors += 1;
          this.performanceFor(order.whale).errors += 1;
          this.risk.setKillSwitch(true);
          this.log("ERROR", result.error ?? "One-second Hyperliquid fill settlement failed; kill switch enabled", {
            whale: order.whale,
            coin: order.coin,
            symbol: order.symbol,
            idempotencyKey: `${request.clientOrderId}:settle`,
            latencyMs,
            detail: { waitedMs, remainingQuantity: result.remainingQuantity, status: result.status },
          });
          this.publish();
          return;
        }
        const catchUpQuantity = result.marketCatchUpQuantity ?? 0;
        if (catchUpQuantity > 0) {
          this.performance.executions += 1;
          this.performance.executedNotionalUsd += catchUpQuantity * (result.marketCatchUpAveragePrice ?? order.price);
          const whalePerformance = this.performanceFor(order.whale);
          whalePerformance.executions += 1;
          whalePerformance.executedNotionalUsd += catchUpQuantity * (result.marketCatchUpAveragePrice ?? order.price);
          this.log("EXECUTION", "Target limit remainder persisted for one second; canceled and filled by Hyperliquid market catch-up", {
            whale: order.whale,
            coin: order.coin,
            symbol: order.symbol,
            idempotencyKey: `${request.clientOrderId}:settle`,
            latencyMs,
            detail: {
              waitedMs,
              sourceOid: order.sourceOid,
              expectedQuantity: request.quantity,
              marketCatchUpQuantity: catchUpQuantity,
              marketCatchUpAveragePrice: result.marketCatchUpAveragePrice,
              marketCatchUpSlippageBps: result.marketCatchUpSlippageBps,
              remainingQuantity: result.remainingQuantity ?? 0,
              testnet: this.execution.testnet,
            },
          });
        } else {
          this.log("EXECUTION", "One-second fill check completed; target order was already fully filled", {
            whale: order.whale,
            coin: order.coin,
            symbol: order.symbol,
            idempotencyKey: `${request.clientOrderId}:settle`,
            latencyMs,
            detail: { waitedMs, sourceOid: order.sourceOid, marketCatchUpQuantity: 0 },
          });
        }
        this.publish();
      });
    }, delayMs);
    this.settlementTimers.set(order.id, timer);
  }

  private blockOrder(order: MirroredOrder, reason: string): void {
    this.performance.blockedExecutions += 1;
    this.performanceFor(order.whale).blockedExecutions += 1;
    this.log("RISK_BLOCK", reason, {
      whale: order.whale,
      coin: order.coin,
      symbol: order.symbol,
      idempotencyKey: order.id,
    });
  }

  private recordSimulation(event: SimulationLedgerEvent): void {
    const fees = event.fills.reduce((total, fill) => total + fill.fee, 0);
    const pnlAfterFees = event.realizedPnl - fees;
    this.performance.realizedPnl += pnlAfterFees;
    this.performance.fees += fees;
    this.performance.simulatedFills += event.fills.length;
    const whalePerformance = this.performanceFor(event.whale);
    whalePerformance.realizedPnl += pnlAfterFees;
    whalePerformance.fees += fees;
    whalePerformance.simulatedFills += event.fills.length;
    this.risk.recordRealizedPnl(pnlAfterFees, event.sourceFill.time);
    this.auditSink?.onSimulation?.(event);
  }

  /**
   * Reconstruct only source episodes which end at the first usable snapshot.
   * This path never touches the order mirror or execution adapter: it exists
   * solely to establish a paper ledger at the historic source fill prices.
   */
  private async bootstrapOpenEpisodeReplay(whaleAddress: string, cutoffAccountState: HyperliquidAccountState): Promise<void> {
    const whale = this.whales.get(whaleAddress);
    const sizing = this.config.sizing;
    if (!whale || !sizing || sizing.mode !== "SOURCE_EQUITY_RATIO" || this.mode !== "SIMULATION") return;
    const followerAllocationUsd = sizing.followerCapitalUsd / this.whales.size;
    const sourceAccountValueUsd = cutoffAccountState.accountValueUsd;
    const currentCoins = cutoffAccountState.positions
      .filter((position) => Math.abs(position.signedSize) > 1e-9)
      .map((position) => position.coin.toUpperCase());
    // A flat source has no open episode to reconstruct. Avoid consuming a
    // scarce historical API request (and avoid turning a transient 429 into a
    // misleading blocked state) simply to prove that there is no residual.
    if (currentCoins.length === 0) {
      this.positionSyncedWhales.add(whaleAddress);
      this.setEpisodeReplayStatus(whaleAddress, cutoffAccountState, "READY", {
        replayedFillCount: 0,
        blockedEpisodeCount: 0,
      });
      this.log("SIMULATION", "Source account is flat; open-episode replay completed without history", {
        whale: whale.address,
        detail: { entryPolicy: "REPLAY_OPEN_EPISODES", replayedFillCount: 0, blockedEpisodeCount: 0 },
      });
      this.publish();
      return;
    }
    try {
      if (!this.openEpisodeReplayProvider) throw new Error("Open-episode replay history provider is unavailable");
      const plan = await this.openEpisodeReplayProvider({
        whale,
        cutoffAccountState,
        followerAllocationUsd,
        sourceAccountValueUsd,
      });
      if (this.state !== "RUNNING") return;
      if (!Array.isArray(plan.replayFills) || !Array.isArray(plan.blocked)) {
        throw new Error("Open-episode replay provider returned an invalid reconciliation plan");
      }

      let replayedFillCount = 0;
      for (const step of plan.replayFills) {
        const ledgerEvent = this.ledger.apply(whale, step.fill, {
          // No followerAccountValueUsd here: the bootstrap is fixed to its
          // cutoff allocation/source-equity ratio, not rebalanced dynamically.
          sourceAccountValueUsd,
          allocatedFollowerCapitalUsd: followerAllocationUsd,
        });
        const position = this.ledger.getPositionSnapshot(whale.address, step.fill.coin);
        if (position) this.auditSink?.onSimulationPosition?.(position);
        this.recordSimulation(ledgerEvent);
        replayedFillCount += ledgerEvent.fills.length;
      }

      // A partial plan is safe: verified coins are reconstructed, while every
      // blocked source residual stays absent from the ledger. The existing
      // carry-in guard consequently ignores its non-flat follow-up fills until
      // the source is flat and opens a new episode.
      this.positionSyncedWhales.add(whaleAddress);
      for (const blocked of plan.blocked) {
        this.log("RISK_BLOCK", `Open-episode replay blocked residual ${blocked.coin}: ${blocked.reason}`, {
          whale: whale.address,
          coin: blocked.coin,
          detail: { entryPolicy: "REPLAY_OPEN_EPISODES", reason: blocked.reason, replayDetail: blocked.detail },
        });
      }
      const status = plan.blocked.length > 0
        ? replayedFillCount > 0 ? "PARTIAL" : "BLOCKED"
        : "READY";
      this.setEpisodeReplayStatus(whaleAddress, cutoffAccountState, status, {
        replayedFillCount,
        blockedEpisodeCount: plan.blocked.length,
      });
      this.log("SIMULATION", plan.blocked.length > 0
        ? `Replayed ${replayedFillCount} validated open-episode fill(s); ${plan.blocked.length} current residual(s) blocked`
        : `Replayed ${replayedFillCount} validated open-episode fill(s)`, {
        whale: whale.address,
        detail: {
          entryPolicy: "REPLAY_OPEN_EPISODES",
          replayedFillCount,
          blockedEpisodeCount: plan.blocked.length,
          reconciled: plan.reconciled,
          sourceAccountValueUsd,
          followerAllocationUsd,
          bootstrapScale: plan.bootstrapScale,
        },
      });
    } catch (error) {
      // A history/coverage/reconciliation failure is intentionally local to
      // this whale. Marking it initialized prevents the legacy carry-in path
      // from adopting the snapshot residual on a later account-state update.
      this.positionSyncedWhales.add(whaleAddress);
      const reason = error instanceof Error ? error.message : "Unknown open-episode replay failure";
      for (const coin of currentCoins) {
        this.log("RISK_BLOCK", `Open-episode replay blocked residual ${coin}: ${reason}`, {
          whale: whale.address,
          coin,
          detail: { entryPolicy: "REPLAY_OPEN_EPISODES", reason },
        });
      }
      this.setEpisodeReplayStatus(whaleAddress, cutoffAccountState, "BLOCKED", {
        replayedFillCount: 0,
        blockedEpisodeCount: currentCoins.length,
      });
    }
    this.publish();
  }

  private setEpisodeReplayStatus(
    whale: string,
    accountState: HyperliquidAccountState,
    episodeReplayStatus: NonNullable<CopyEngineSnapshot["sizingByWhale"][string]>["episodeReplayStatus"],
    counts: { replayedFillCount?: number; blockedEpisodeCount?: number } = {},
  ): void {
    this.sizingByWhale.set(whale, {
      ...(this.sizingByWhale.get(whale) ?? {}),
      accountValueUsd: accountState.accountValueUsd,
      accountStateAt: accountState.receivedAt,
      followerAccountValueUsd: this.followerAccountValueUsd(whale),
      stateFresh: this.accountStateIsFresh(accountState),
      sizingReady: this.accountStateIsUsable(accountState),
      episodeReplayStatus,
      ...counts,
      episodeReplayAt: this.now(),
      updatedAt: this.now(),
    });
  }

  private synchronizeSimulationPositions(whaleAddress: string, accountState: HyperliquidAccountState): boolean {
    const whale = this.whales.get(whaleAddress);
    const sizing = this.config.sizing;
    if (!whale || !sizing || sizing.mode !== "SOURCE_EQUITY_RATIO") return false;
    const followerAccountValueUsd = this.followerAccountValueUsd(whaleAddress);
    if (followerAccountValueUsd <= 0) return false;
    const synchronizedAt = this.now();
    const positions = this.ledger.synchronizeCarryInPositions(whale, accountState.positions, {
      sourceAccountValueUsd: accountState.accountValueUsd,
      allocatedFollowerCapitalUsd: sizing.followerCapitalUsd / this.whales.size,
      followerAccountValueUsd,
    }, synchronizedAt);
    this.positionSyncedWhales.add(whaleAddress);
    for (const position of positions) this.auditSink?.onSimulationPosition?.(position);

    const markByCoin = new Map(accountState.positions.flatMap((position) => {
      if (position.positionValueUsd === undefined || Math.abs(position.signedSize) <= 0) return [];
      return [[position.coin.toUpperCase(), position.positionValueUsd / Math.abs(position.signedSize)] as const];
    }));
    const active = positions.filter((position) => Math.abs(position.followerPosition) > 1e-9);
    const sourcePositionNotionalUsd = active.reduce((sum, position) => sum + Math.abs(position.sourcePosition) * (markByCoin.get(position.coin) ?? 0), 0);
    const targetFollowerNotionalUsd = active.reduce((sum, position) => sum + Math.abs(position.followerPosition) * (markByCoin.get(position.coin) ?? 0), 0);
    const requestedTargetFollowerNotionalUsd = sourcePositionNotionalUsd * followerAccountValueUsd / accountState.accountValueUsd;
    const followerLeverage = targetFollowerNotionalUsd / followerAccountValueUsd;
    this.sizingByWhale.set(whaleAddress, {
      accountValueUsd: accountState.accountValueUsd,
      accountStateAt: accountState.receivedAt,
      followerAccountValueUsd: this.followerAccountValueUsd(whaleAddress),
      sourcePositionNotionalUsd,
      sourceExposurePct: sourcePositionNotionalUsd / accountState.accountValueUsd * 100,
      targetFollowerNotionalUsd,
      requestedTargetFollowerNotionalUsd,
      followerLeverage,
      leverageCapped: targetFollowerNotionalUsd + 1e-9 < requestedTargetFollowerNotionalUsd,
      ...(active.length === 1 ? { lastCoin: active[0]!.coin, followerPositionAfter: active[0]!.followerPosition } : {}),
      syncedPositionCount: active.length,
      positionSyncAt: synchronizedAt,
      updatedAt: synchronizedAt,
      stateFresh: true,
      sizingReady: true,
    });
    const skippedMissingEntryPrice = accountState.positions.filter((position) => (
      Math.abs(position.signedSize) > 1e-9 &&
      (position.entryPriceUsd === undefined || !Number.isFinite(position.entryPriceUsd) || position.entryPriceUsd <= 0)
    )).length;
    this.log("SIMULATION", active.length > 0
      ? `Synchronized ${active.length} existing source position(s) at source entry prices`
      : "Paper account position synchronization completed with no existing source positions", {
      whale: whaleAddress,
      detail: {
        syncedPositionCount: active.length,
        sourceAccountValueUsd: accountState.accountValueUsd,
        followerAccountValueUsd: this.followerAccountValueUsd(whaleAddress),
        sourcePositionNotionalUsd,
        targetFollowerNotionalUsd,
        requestedTargetFollowerNotionalUsd,
        followerLeverage,
        leveragePolicy: "COPY_SOURCE_EXACTLY",
        baselineAtSourceEntryPrice: true,
        skippedMissingEntryPrice,
      },
    });
    return true;
  }

  private initializeNewPositionOnlyPolicy(whaleAddress: string, accountState: HyperliquidAccountState): boolean {
    const sizing = this.config.sizing;
    if (!sizing || sizing.mode !== "SOURCE_EQUITY_RATIO") return false;
    const followerAccountValueUsd = this.followerAccountValueUsd(whaleAddress);
    if (followerAccountValueUsd <= 0) return false;
    const initializedAt = this.now();
    const existing = accountState.positions.filter((position) => Math.abs(position.signedSize) > 1e-9);
    const sourcePositionNotionalUsd = existing.reduce((sum, position) => sum + (
      position.positionValueUsd !== undefined
        ? Math.abs(position.positionValueUsd)
        : Math.abs(position.signedSize) * (position.entryPriceUsd ?? 0)
    ), 0);
    this.positionSyncedWhales.add(whaleAddress);
    this.sizingByWhale.set(whaleAddress, {
      accountValueUsd: accountState.accountValueUsd,
      accountStateAt: accountState.receivedAt,
      followerAccountValueUsd,
      sourcePositionNotionalUsd,
      sourceExposurePct: sourcePositionNotionalUsd / accountState.accountValueUsd * 100,
      targetFollowerNotionalUsd: 0,
      requestedTargetFollowerNotionalUsd: 0,
      followerLeverage: 0,
      leverageCapped: false,
      ...(existing.length === 1 ? { lastCoin: existing[0]!.coin.toUpperCase(), followerPositionAfter: 0 } : {}),
      syncedPositionCount: 0,
      waitingForNewPosition: true,
      ignoredExistingPositionCount: existing.length,
      positionSyncAt: initializedAt,
      updatedAt: initializedAt,
      stateFresh: true,
      sizingReady: true,
    });
    this.log("SIMULATION", existing.length > 0
      ? `Ignored ${existing.length} existing source position(s); waiting for a new position episode`
      : "Source account is flat; waiting for a new position episode", {
      whale: whaleAddress,
      detail: {
        entryPolicy: "NEW_POSITIONS_ONLY",
        ignoredExistingPositionCount: existing.length,
        sourceAccountValueUsd: accountState.accountValueUsd,
        followerAccountValueUsd,
        sourcePositionNotionalUsd,
      },
    });
    return true;
  }

  private maxAccountStateAgeMs(): number {
    return this.config.sizing?.maxAccountStateAgeMs ?? 60_000;
  }

  private accountStateIsFresh(state: HyperliquidAccountState): boolean {
    return this.now() - state.receivedAt <= this.maxAccountStateAgeMs();
  }

  private minSourceAccountValueUsd(): number {
    return this.config.sizing?.minSourceAccountValueUsd ?? 10_000;
  }

  private accountStateIsUsable(state: HyperliquidAccountState): boolean {
    return this.accountStateIsFresh(state) && state.accountValueUsd >= this.minSourceAccountValueUsd();
  }

  private followerAccountValueUsd(whale: string): number {
    if (this.mode === "HYPERLIQUID") {
      const state = this.execution.followerAccountState(whale);
      return state && this.now() - state.receivedAt <= this.maxAccountStateAgeMs() && state.accountValueUsd > 0
        ? state.accountValueUsd
        : 0;
    }
    const allocation = this.config.sizing?.followerCapitalUsd
      ? this.config.sizing.followerCapitalUsd / this.whales.size
      : 0;
    if (allocation <= 0) return 0;
    const accountState = this.accountStates.get(whale);
    const markByCoin = new Map<string, number>();
    for (const position of accountState?.positions ?? []) {
      if (position.positionValueUsd !== undefined && Math.abs(position.signedSize) > 0) {
        markByCoin.set(position.coin.toUpperCase(), position.positionValueUsd / Math.abs(position.signedSize));
      }
    }
    const unrealized = this.ledger.getUnrealizedPnl(whale, (coin) => markByCoin.get(coin));
    return Math.max(0, allocation + this.performanceFor(whale).realizedPnl + unrealized);
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : "Unknown copy engine error";
    this.state = "ERROR";
    this.lastError = message;
    this.performance.errors += 1;
    this.risk.setKillSwitch(true);
    this.log("ERROR", `${message}; kill switch enabled`);
    this.publish();
  }

  private log(kind: EngineLogEntry["kind"], message: string, extra: Omit<EngineLogEntry, "id" | "time" | "kind" | "message"> = {}): void {
    const entry = { id: `${this.now()}-${this.logs.length}`, time: this.now(), kind, message, ...extra };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift();
    this.auditSink?.onLog?.(entry);
  }

  private performanceFor(whale: string): CopyPerformance {
    const address = whale.toLowerCase();
    const current = this.performanceByWhale.get(address);
    if (current) return current;
    const created = blankPerformance();
    this.performanceByWhale.set(address, created);
    return created;
  }

  private publish(): void {
    const snapshot = this.snapshot();
    this.auditSink?.onSnapshot?.(snapshot);
    for (const subscriber of this.subscribers) subscriber(snapshot);
  }
}
