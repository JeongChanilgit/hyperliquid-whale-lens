/** Shared contracts for the server-side realtime copy engine. No credential fields belong here. */

export type CopyMode = "SIMULATION" | "HYPERLIQUID";
export type CopySizingMode = "FIXED_SOURCE_RATIO" | "SOURCE_EQUITY_RATIO";
export type CopyEntryPolicy = "INCLUDE_EXISTING" | "NEW_POSITIONS_ONLY" | "REPLAY_OPEN_EPISODES";
export type CopyEngineState = "STOPPED" | "STARTING" | "RUNNING" | "STOPPING" | "ERROR";
export type CopySide = "BUY" | "SELL";
export type CopyDirection = "LONG" | "SHORT";

export interface HyperliquidRealtimeFill {
  coin: string;
  side: "B" | "A";
  px: string;
  sz: string;
  time: number;
  startPosition: string;
  closedPnl?: string;
  fee?: string;
  feeToken?: string;
  oid?: number | string;
  tid?: number | string;
  hash?: string;
  [key: string]: unknown;
}

export interface HyperliquidRealtimeOrder {
  coin: string;
  side: "B" | "A";
  limitPx: string;
  /** Remaining source quantity. */
  sz: string;
  /** Original source quantity. */
  origSz: string;
  oid: number | string;
  timestamp: number;
  cloid?: string | null;
  reduceOnly?: boolean;
  orderType?: string;
  tif?: string;
  isTrigger?: boolean;
  closeAll?: boolean;
  triggerPx?: string;
  triggerCondition?: string;
  isPositionTpsl?: boolean;
  [key: string]: unknown;
}

export interface HyperliquidRealtimeOrderUpdate {
  order: HyperliquidRealtimeOrder;
  status: string;
  statusTimestamp: number;
  /** True for the startup frontendOpenOrders snapshot. */
  isSnapshot?: boolean;
  /** False when the public order-status enrichment could not be loaded. */
  metadataComplete: boolean;
  /** Fresh public per-asset setting fetched in parallel with order enrichment. */
  sourceLeverage?: HyperliquidLeverage;
}

export interface HyperliquidAccountPosition {
  coin: string;
  /** Signed base-asset position size. */
  signedSize: number;
  /** Absolute position value reported by Hyperliquid, when present. */
  positionValueUsd?: number;
  /** Source average entry price used as the paper/backtest carry-in cost basis. */
  entryPriceUsd?: number;
  /** Per-asset account setting reported by Hyperliquid. */
  leverage?: HyperliquidLeverage;
  /** Desired signed follower position used by the one-second live reconciliation. */
  targetPositionAfter?: number;
}

export interface HyperliquidLeverage {
  type: "cross" | "isolated";
  value: number;
  rawUsd?: number;
}

export interface HyperliquidAccountState {
  accountValueUsd: number;
  positions: HyperliquidAccountPosition[];
  /** Local receipt time used to reject stale sizing data. */
  receivedAt: number;
}

export interface WhaleConfig {
  /** Public Hyperliquid address; no exchange credentials are accepted. */
  address: string;
  /** Stable operator-facing label for this monitored wallet. */
  label?: string;
  /** Fraction of the whale's filled size to mirror, constrained to (0, 1]. */
  copyRatio: number;
  /** Optional per-whale symbol allowlist. Hyperliquid coin names are upper-cased. */
  allowedCoins?: string[];
}

export interface CopyRiskConfig {
  /** Explicit public source-wallet allowlist. Defaults to the supplied monitored wallets. */
  allowedWhales?: string[];
  /** Explicit instrument allowlist. Empty denies all live orders. */
  allowedSymbols: string[];
  maxNotionalUsd: number;
  /** Retained for aggressive-order protection; resting Hyperliquid clones use the source price. */
  maxSlippageProxyBps: number;
  /** Execution is blocked once today's realized simulation PnL is at or below -limit. */
  maxDailyLossUsd: number;
  killSwitch?: boolean;
}

export interface CopyEngineConfig {
  whales: WhaleConfig[];
  risk: CopyRiskConfig;
  mode?: CopyMode;
  /** Whether a session adopts existing positions, waits for a new episode, or replays current open episodes in paper mode. */
  entryPolicy?: CopyEntryPolicy;
  sizing?: {
    /** Equity-ratio mode targets the whale's position-notional/account-value ratio. */
    mode: CopySizingMode;
    /** Total follower capital; divided equally across configured whales. */
    followerCapitalUsd: number;
    /** Fail closed when the latest public account state is older than this. */
    maxAccountStateAgeMs?: number;
    /** Prevent pathological scaling after a screened whale withdraws most capital. */
    minSourceAccountValueUsd?: number;
    /** Maximum follower notional divided by its per-whale margin. */
    maxLeverage?: number;
  };
  /** Display/risk symbol mapping. Hyperliquid execution continues to use the original coin. */
  binanceSymbolForCoin?: (coin: string) => string;
}

export interface CopySegment {
  kind: "ENTRY" | "ADD" | "REDUCE" | "CLOSE";
  side: CopySide;
  quantity: number;
  reduceOnly: boolean;
}

export interface CopyIntent {
  idempotencyKey: string;
  whale: string;
  coin: string;
  symbol: string;
  referencePrice: number;
  sourceTime: number;
  segments: CopySegment[];
  /** Absolute notional across all planned segments. */
  notionalUsd: number;
}

export interface SimulatedFill {
  id: string;
  whale: string;
  coin: string;
  time: number;
  side: CopySide;
  quantity: number;
  price: number;
  realizedPnl: number;
  fee: number;
  positionAfter: number;
  sourceFillId: string;
  segment: CopySegment["kind"];
}

/** Durable virtual position owned by one whale's independent paper account. */
export interface SimulationPositionSnapshot {
  whale: string;
  coin: string;
  sourcePosition: number;
  /** Source quantity opened during the session and therefore eligible to copy. */
  trackedSourcePosition?: number;
  followerPosition: number;
  averageEntryPrice: number;
  copyingEpisode: boolean;
  desynced: boolean;
  updatedAt: number;
}

export interface SimulationLedgerEvent {
  whale: string;
  sourceFill: HyperliquidRealtimeFill;
  sourceFillId: string;
  sourcePositionBefore: number;
  sourcePositionAfter: number;
  followerPositionBefore: number;
  followerPositionAfter: number;
  copied: boolean;
  ignoredReason?: "CARRY_IN" | "DESYNC" | "ZERO_SIZE" | "INVALID_FILL" | "SIZING_DATA_UNAVAILABLE";
  intent?: CopyIntent;
  fills: SimulatedFill[];
  realizedPnl: number;
  sizingMode?: CopySizingMode;
  sourceAccountValueUsd?: number;
  allocatedFollowerCapitalUsd?: number;
  followerAccountValueUsd?: number;
  sourcePositionNotionalUsd?: number;
  sourceExposurePct?: number;
  targetFollowerNotionalUsd?: number;
  requestedTargetFollowerNotionalUsd?: number;
  followerLeverage?: number;
  leverageCapped?: boolean;
  warning?: string;
}

export type MirroredOrderStatus = "OPEN" | "FILLED" | "CANCELED" | "REJECTED" | "TRIGGERED" | "UNKNOWN";
export type MirroredOrderAction = "PLACED" | "MODIFIED" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "REJECTED" | "TRIGGERED" | "IGNORED";

export interface MirroredOrder {
  id: string;
  whale: string;
  sourceOid: string;
  coin: string;
  symbol: string;
  side: CopySide;
  price: number;
  sourceStatus: string;
  status: MirroredOrderStatus;
  sourceOriginalQuantity: number;
  sourceRemainingQuantity: number;
  followerOriginalQuantity: number;
  followerRemainingQuantity: number;
  followerFilledQuantity: number;
  sourceAccountValueUsd?: number;
  followerAccountValueUsd?: number;
  balanceScale?: number;
  reduceOnly?: boolean;
  orderType?: string;
  tif?: string;
  isTrigger?: boolean;
  closeAll?: boolean;
  /** True when the order already existed before this runner process connected. */
  startupSnapshot?: boolean;
  triggerPrice?: number;
  metadataComplete: boolean;
  leverageCapped: boolean;
  lastAction: MirroredOrderAction;
  createdAt: number;
  updatedAt: number;
  warning?: string;
}

export interface MirroredOrderEvent {
  action: MirroredOrderAction;
  copied: boolean;
  order: MirroredOrder;
  ignoredReason?: "SIZING_DATA_UNAVAILABLE" | "INVALID_ORDER" | "DUPLICATE";
}

export interface BinanceMarketOrderRequest {
  symbol: string;
  side: CopySide;
  quantity: number;
  reduceOnly: boolean;
  idempotencyKey: string;
}

export interface BinanceExecutionResult {
  accepted: boolean;
  orderId?: string;
  clientOrderId: string;
  status?: string;
  error?: string;
}

export interface BinanceUsdMExecutionPort {
  readonly enabled: boolean;
  readonly testnet: boolean;
  getPrice(symbol: string): Promise<number>;
  marketOrder(request: BinanceMarketOrderRequest): Promise<BinanceExecutionResult>;
}

export type HyperliquidCloneAction = "ENSURE" | "MODIFY" | "CANCEL";

export interface HyperliquidCloneOrderRequest {
  action: HyperliquidCloneAction;
  sourceWhale: string;
  sourceOid: string;
  clientOrderId: string;
  coin: string;
  side: CopySide;
  price: number;
  quantity: number;
  reduceOnly: boolean;
  orderType?: string;
  tif?: string;
  isTrigger?: boolean;
  closeAll?: boolean;
  triggerPrice?: number;
  leverage?: HyperliquidLeverage;
  /** Desired post-fill follower position used only by the server-side settlement check. */
  targetPositionAfter?: number;
}

export interface HyperliquidCloneResult {
  accepted: boolean;
  clientOrderId: string;
  targetOrderId?: string;
  status?: string;
  error?: string;
  quantity?: number;
  marketCatchUpQuantity?: number;
  marketCatchUpAveragePrice?: number;
  marketCatchUpSlippageBps?: number;
  remainingQuantity?: number;
}

/** Server-only port. Credentials and target-account mapping never cross this boundary. */
export interface HyperliquidExecutionPort {
  readonly enabled: boolean;
  readonly testnet: boolean;
  preflight(sourceWhales: string[]): Promise<{ ok: boolean; reason?: string; targets?: Record<string, { accountValueUsd: number }> }>;
  followerAccountState(sourceWhale: string): { accountValueUsd: number; receivedAt: number } | undefined;
  cloneOrder(request: HyperliquidCloneOrderRequest): Promise<HyperliquidCloneResult>;
  /** Called one second after the source order fully fills; cancels target remainder and markets only the deficit. */
  settleFilledOrder(request: HyperliquidCloneOrderRequest): Promise<HyperliquidCloneResult>;
  close?(): Promise<void> | void;
}

export type EngineLogKind = "LIFECYCLE" | "SOURCE_ORDER" | "ORDER_MIRROR" | "SOURCE_FILL" | "SIMULATION" | "EXECUTION" | "RISK_BLOCK" | "ERROR" | "HEARTBEAT";

export interface EngineLogEntry {
  id: string;
  time: number;
  kind: EngineLogKind;
  message: string;
  whale?: string;
  coin?: string;
  symbol?: string;
  idempotencyKey?: string;
  latencyMs?: number;
  detail?: Record<string, unknown>;
}

export interface CopyPerformance {
  realizedPnl: number;
  fees: number;
  executedNotionalUsd: number;
  simulatedFills: number;
  executions: number;
  blockedExecutions: number;
  errors: number;
}

export interface CopyAccountEquityPoint {
  whale: string;
  time: number;
  accountValueUsd: number;
  realizedPnl: number;
}

export interface CopyEngineSnapshot {
  state: CopyEngineState;
  mode: CopyMode;
  entryPolicy: CopyEntryPolicy;
  startedAt?: number;
  watchedWhales: string[];
  /** Runtime labels keyed by normalized whale address. */
  whaleLabels?: Record<string, string>;
  performance: CopyPerformance;
  performanceByWhale: Record<string, CopyPerformance>;
  sizing: {
    mode: CopySizingMode;
    followerCapitalUsd?: number;
    allocationPerWhaleUsd?: number;
    maxLeverage?: number;
  };
  sizingByWhale: Record<string, WhaleSizingSnapshot>;
  /** Added by the durable local runner from its SQLite account-equity ledger. */
  equityHistory?: CopyAccountEquityPoint[];
  simulationPositions: SimulationPositionSnapshot[];
  mirroredOrders: MirroredOrder[];
  logs: EngineLogEntry[];
  killSwitch: boolean;
  lastError?: string;
}

export interface WhaleSizingSnapshot {
  accountValueUsd?: number;
  followerAccountValueUsd?: number;
  accountStateAt?: number;
  lastCoin?: string;
  sourcePositionNotionalUsd?: number;
  sourceExposurePct?: number;
  targetFollowerNotionalUsd?: number;
  requestedTargetFollowerNotionalUsd?: number;
  followerLeverage?: number;
  leverageCapped?: boolean;
  followerPositionAfter?: number;
  syncedPositionCount?: number;
  /** Existing source positions are intentionally excluded until the next new episode. */
  waitingForNewPosition?: boolean;
  ignoredExistingPositionCount?: number;
  /** Open-episode replay bootstrap status, when that paper-mode policy is active. */
  episodeReplayStatus?: "PENDING" | "READY" | "PARTIAL" | "BLOCKED";
  /** Number of verified historical fills replayed into this whale's paper ledger. */
  replayedFillCount?: number;
  /** Open source episodes withheld because their history/equity coverage was incomplete. */
  blockedEpisodeCount?: number;
  /** Local completion/checkpoint time for the latest episode-replay bootstrap. */
  episodeReplayAt?: number;
  positionSyncAt?: number;
  updatedAt?: number;
  stateFresh: boolean;
  sizingReady: boolean;
}

export interface RealtimeMonitorEvent {
  type: "fill" | "order" | "accountState" | "status" | "error" | "heartbeat";
  whale?: string;
  fill?: HyperliquidRealtimeFill;
  orderUpdate?: HyperliquidRealtimeOrderUpdate;
  accountState?: HyperliquidAccountState;
  message?: string;
  time: number;
}
