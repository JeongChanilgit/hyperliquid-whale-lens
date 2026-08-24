/**
 * Browser-safe, read-only view of the isolated Faithful Mirror V2 service.
 * This deliberately has no control-token, signer, or action fields.
 */

export type FaithfulMirrorV2Mode = "PAPER" | "LIVE" | null;
export type FaithfulMirrorV2LiveGateState = "PAPER_NOT_APPLICABLE" | "NOT_CONFIGURED" | "LOCKED" | "UNARMED" | "ARMED" | "KILLED";

export interface FaithfulMirrorV2Position {
  coin: string;
  signedSize: number | null;
  entryPriceUsd: number | null;
  markPriceUsd: number | null;
  positionValueUsd: number | null;
  unrealizedPnlUsd: number | null;
  liquidationPriceUsd: number | null;
  marginUsedUsd: number | null;
  leverage: unknown | null;
  poolId: string | null;
}

export interface FaithfulMirrorV2Order {
  id: string | null;
  sourceOrderId: string | null;
  targetOrderId: string | null;
  coin: string | null;
  side: string | null;
  price: number | null;
  size: number | null;
  remainingSize: number | null;
  reduceOnly: boolean | null;
  status: string | null;
  orderType: string | null;
  tif: string | null;
  triggerPrice: number | null;
}

export interface FaithfulMirrorV2AccountView {
  equityUsd: number | null;
  receivedAt: number | null;
  snapshotAgeMs: number | null;
  accountMode: string | null;
  marginUsedUsd: number | null;
  maintenanceMarginUsd: number | null;
  withdrawableUsd: number | null;
  marginStatus: string | null;
  approximateLiquidationRisk: boolean | null;
  positions: FaithfulMirrorV2Position[];
  orders: FaithfulMirrorV2Order[];
}

export interface FaithfulMirrorV2DebtView {
  positions: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
}

export interface FaithfulMirrorV2PairView {
  pairId: string;
  startingCapitalUsd: number | null;
  sourceAddress: string | null;
  /** A non-sensitive local follower label; never a target account mapping. */
  targetAccountLabel: string;
  /** Optional masked display only, such as `0x1234…abcd`; never the full target address. */
  targetAddressDisplay: string | null;
  state: string | null;
  initialized: boolean;
  blocked: boolean;
  killed: boolean;
  killReason: string | null;
  lastError: string | null;
  snapshotAgeMs: number | null;
  snapshotFresh: boolean | null;
  source: FaithfulMirrorV2AccountView;
  target: FaithfulMirrorV2AccountView;
  trackingDebt: FaithfulMirrorV2DebtView;
  metrics: Record<string, number | null>;
  stats: Record<string, number | null>;
}

export interface FaithfulMirrorV2Event {
  at: number | null;
  type: string;
  pairId: string | null;
  coin: string | null;
  side: string | null;
  message: string | null;
  details: Record<string, string | number | boolean | string[]>;
}

export interface FaithfulMirrorV2LiveGate {
  state: FaithfulMirrorV2LiveGateState;
  configured: boolean;
  armed: boolean;
  armExpiresAt: number | null;
  /** Always false: this API intentionally has no browser control action. */
  canStart: false;
  reason: string;
}

export interface FaithfulMirrorV2PolicyView {
  verificationDelayMs: number | null;
  terminalVerificationDelayMs: number | null;
  targetToleranceBps: number | null;
  maxCatchUpSlippageBps: number | null;
  immediateResidualNotionalUsd: number | null;
  killOnTerminalResidual: boolean | null;
  paperMakerFeeRate: number | null;
  paperTakerFeeRate: number | null;
}

export interface FaithfulMirrorV2ServiceView {
  mode: FaithfulMirrorV2Mode;
  state: string;
  running: boolean;
  killed: boolean;
  sessionId: string | null;
  recoveryAvailable: boolean;
  liveGate: FaithfulMirrorV2LiveGate;
  policy: FaithfulMirrorV2PolicyView;
}

export interface FaithfulMirrorV2StatusResponse {
  ok: boolean;
  connected: boolean;
  observedAt: number;
  stale: boolean;
  staleReason: string | null;
  service: FaithfulMirrorV2ServiceView;
  pairs: FaithfulMirrorV2PairView[];
  events: FaithfulMirrorV2Event[];
}
