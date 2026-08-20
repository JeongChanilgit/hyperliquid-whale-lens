export type Milliseconds = number;

export type FillSide = "B" | "A";
export type PositionDirection = "LONG" | "SHORT";
export type CandleInterval = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "8h" | "12h" | "1d" | "3d" | "1w" | "1M";

/** The public fields returned by Hyperliquid's `userFillsByTime` endpoint. */
export interface HyperliquidFill {
  coin: string;
  side: FillSide;
  px: string;
  sz: string;
  time: Milliseconds;
  startPosition: string;
  closedPnl: string;
  fee: string;
  feeToken?: string;
  oid?: number | string;
  tid?: number | string;
  hash?: string;
  dir?: string;
  crossed?: boolean;
  [field: string]: unknown;
}

/** The order fields vary slightly by Hyperliquid order type, so unknown fields are retained. */
export interface HistoricalOrder {
  order?: {
    oid?: number | string;
    coin?: string;
    side?: FillSide;
    orderType?: string;
    origSz?: string;
    reduceOnly?: boolean;
    triggerPx?: string;
    triggerCondition?: string;
    isTrigger?: boolean;
    [field: string]: unknown;
  };
  oid?: number | string;
  status?: string;
  statusTimestamp?: Milliseconds;
  orderType?: string;
  origSz?: string;
  reduceOnly?: boolean;
  triggerPx?: string;
  triggerCondition?: string;
  isTrigger?: boolean;
  [field: string]: unknown;
}

export interface AccountValuePoint {
  time: Milliseconds;
  value: number;
}

export interface PortfolioPeriodHistory {
  accountValueHistory: AccountValuePoint[];
  pnlHistory: AccountValuePoint[];
  vlmHistory: AccountValuePoint[];
}

export interface PortfolioHistory {
  periods: Record<string, PortfolioPeriodHistory>;
  month?: PortfolioPeriodHistory;
}

export interface FillCoverage {
  startTime: Milliseconds;
  endTime: Milliseconds;
  complete: boolean;
  pagesFetched: number;
  fillCount: number;
  incompleteReason?: string;
}

export type PositionAction =
  | "LONG_ENTRY"
  | "LONG_ADD"
  | "LONG_REDUCE"
  | "LONG_CLOSE"
  | "SHORT_ENTRY"
  | "SHORT_ADD"
  | "SHORT_REDUCE"
  | "SHORT_CLOSE";

export interface EventSegment {
  action: PositionAction;
  direction: PositionDirection;
  size: number;
  episodeId?: string;
}

export interface TradingEvent {
  id: string;
  coin: string;
  time: Milliseconds;
  fill: HyperliquidFill;
  startPosition: number;
  endPosition: number;
  /** Base position-state actions. A reversal contains a close then a new entry. */
  actions: PositionAction[];
  segments: EventSegment[];
  /** Human-readable labels, including LOSS CLOSE or TRIGGER STOP where supported by evidence. */
  labels: string[];
  displayLabel: string;
  closedPnl: number;
  fee: number;
  isLossClose: boolean;
  isTriggerStop: boolean;
  order?: HistoricalOrder;
  integrityIssue?: string;
}

export type EpisodeStatus = "OPEN" | "COMPLETED" | "CARRY_IN";

export interface TradingEpisode {
  id: string;
  coin: string;
  direction: PositionDirection;
  status: EpisodeStatus;
  /** Undefined for an episode that was already open at the requested window start. */
  entryTime?: Milliseconds;
  exitTime?: Milliseconds;
  openedWithinWindow: boolean;
  entrySize: number;
  exitSize: number;
  closedPnl: number;
  fee: number;
  netPnl: number;
  fillIds: string[];
}

export interface CacheMeta {
  cacheHit: boolean;
  fetchedAt: Milliseconds;
  cachedAt?: Milliseconds;
  coverageStart: Milliseconds;
  coverageEnd: Milliseconds;
}

export interface WalletBundle {
  address: string;
  range: { startTime: Milliseconds; endTime: Milliseconds };
  fills: HyperliquidFill[];
  events: TradingEvent[];
  episodes: TradingEpisode[];
  orders: HistoricalOrder[];
  portfolio: PortfolioHistory;
  coverage: FillCoverage;
  warnings: string[];
  /** Kept at the top level for simple React callers. */
  cacheHit: boolean;
  fetchedAt: Milliseconds;
  cache: CacheMeta;
}

export interface CandlePoint {
  time: Milliseconds;
  endTime: Milliseconds;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades?: number;
}

export interface CandleData {
  coin: string;
  interval: CandleInterval;
  range: { startTime: Milliseconds; endTime: Milliseconds };
  candles: CandlePoint[];
  cacheHit: boolean;
  fetchedAt: Milliseconds;
  cache: CacheMeta;
}

export interface WalletLoadOptions {
  force?: boolean;
  startTime?: Milliseconds;
  endTime?: Milliseconds;
}

export interface CandleLoadOptions {
  force?: boolean;
  interval?: CandleInterval;
  startTime?: Milliseconds;
  endTime?: Milliseconds;
}

export interface SimulationTradeRequest {
  coin: string;
  direction: PositionDirection;
  notionalUsd: number;
  referenceEventId?: string;
}

export interface SimulationTradeResult {
  accepted: boolean;
  simulatedAt: Milliseconds;
  reason?: string;
}

/** A future server-backed simulator can implement this without changing React consumers. */
export interface SimulationAdapter {
  readonly mode: "simulation";
  simulate(request: SimulationTradeRequest): Promise<SimulationTradeResult>;
}

/**
 * Execution remains deliberately unavailable in browser code. A future server-side
 * adapter may implement this contract after it owns signing and confirmation.
 */
export interface BinanceExecutionAdapter {
  readonly venue: "binance";
  readonly enabled: false;
  execute(): Promise<never>;
}
