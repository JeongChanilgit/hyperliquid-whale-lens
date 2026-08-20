import type {
  HyperliquidRealtimeFill,
  HyperliquidRealtimeOrderUpdate,
  MirroredOrder,
  MirroredOrderAction,
  MirroredOrderEvent,
  MirroredOrderStatus,
} from "../copy-types";

const EPSILON = 1e-9;

const finite = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normaliseStatus = (status: string): MirroredOrderStatus => {
  const value = status.trim().toLowerCase();
  if (value === "open") return "OPEN";
  if (value === "filled") return "FILLED";
  if (value === "triggered") return "TRIGGERED";
  if (value === "canceled" || value.endsWith("canceled")) return "CANCELED";
  if (value === "rejected" || value.endsWith("rejected")) return "REJECTED";
  return "UNKNOWN";
};

const actionForStatus = (status: MirroredOrderStatus): MirroredOrderAction => {
  if (status === "FILLED") return "FILLED";
  if (status === "CANCELED") return "CANCELED";
  if (status === "REJECTED") return "REJECTED";
  if (status === "TRIGGERED") return "TRIGGERED";
  return "IGNORED";
};

export interface OrderMirrorSizingInput {
  sourceAccountValueUsd: number;
  followerAccountValueUsd: number;
  followerPositionQuantity?: number;
  maxLeverage?: number;
  /** Portfolio room after positions and other resting entry orders are reserved. */
  maximumAdditionalNotionalUsd?: number;
}

export interface OrderMirrorLedgerOptions {
  symbolForCoin?: (coin: string) => string;
  historyLimit?: number;
}

/**
 * Mirrors the public source-order lifecycle without pretending that an order has
 * filled before the whale's fill arrives. Quantity is scaled by follower equity
 * divided by source equity; the fill ledger remains the position/PnL authority.
 */
export class CopyOrderMirrorLedger {
  private readonly orders = new Map<string, MirroredOrder>();
  private readonly signatures = new Map<string, string>();
  private readonly symbolForCoin: (coin: string) => string;
  private readonly historyLimit: number;

  constructor(options: OrderMirrorLedgerOptions = {}) {
    this.symbolForCoin = options.symbolForCoin ?? ((coin) => coin.includes(":") ? coin.toUpperCase() : `${coin.toUpperCase()}USDT`);
    this.historyLimit = options.historyLimit ?? 500;
  }

  apply(whaleAddress: string, update: HyperliquidRealtimeOrderUpdate, sizing?: OrderMirrorSizingInput): MirroredOrderEvent {
    const whale = whaleAddress.toLowerCase();
    const raw = update.order;
    const coin = raw.coin?.toUpperCase();
    const sourceOid = String(raw.oid ?? "");
    const price = finite(raw.limitPx);
    const sourceRemaining = finite(raw.sz);
    const sourceOriginal = finite(raw.origSz);
    const valid = Boolean(
      coin && sourceOid && (raw.side === "B" || raw.side === "A") &&
      price !== undefined && price > 0 && sourceRemaining !== undefined && sourceRemaining >= 0 &&
      sourceOriginal !== undefined && sourceOriginal >= sourceRemaining,
    );
    const id = `${whale}|${sourceOid || "invalid"}`;
    const prior = this.orders.get(id);
    const status = normaliseStatus(update.status);
    const closeAll = raw.reduceOnly === true && raw.isPositionTpsl === true && (sourceOriginal ?? 0) <= EPSILON;
    const signature = `${update.status}|${raw.limitPx}|${raw.sz}|${raw.origSz}|${update.statusTimestamp}`;
    const sizingUsable = Boolean(
      sizing && Number.isFinite(sizing.sourceAccountValueUsd) && sizing.sourceAccountValueUsd > 0 &&
      Number.isFinite(sizing.followerAccountValueUsd) && sizing.followerAccountValueUsd > 0 &&
      (sizing.maxLeverage === undefined || (Number.isFinite(sizing.maxLeverage) && sizing.maxLeverage > 0)),
    );
    if (valid && this.signatures.get(id) === signature && prior && (!sizingUsable || prior.balanceScale !== undefined)) {
      return { action: "IGNORED", copied: false, order: prior, ignoredReason: "DUPLICATE" };
    }
    const scale = sizingUsable ? sizing!.followerAccountValueUsd / sizing!.sourceAccountValueUsd : undefined;
    const requestedFollowerOriginal = valid && scale !== undefined
      ? closeAll ? Math.abs(sizing?.followerPositionQuantity ?? 0) : sourceOriginal! * scale
      : 0;
    const leverageMaximumQuantity = valid && sizingUsable && sizing?.maxLeverage
      ? sizing.followerAccountValueUsd * sizing.maxLeverage / price!
      : Number.POSITIVE_INFINITY;
    const portfolioMaximumQuantity = valid && sizingUsable && sizing?.maximumAdditionalNotionalUsd !== undefined && raw.reduceOnly !== true
      ? Math.max(0, sizing.maximumAdditionalNotionalUsd) / price!
      : Number.POSITIVE_INFINITY;
    const maximumQuantity = Math.min(leverageMaximumQuantity, portfolioMaximumQuantity);
    const leverageCapped = requestedFollowerOriginal > maximumQuantity;
    const followerOriginal = Math.min(requestedFollowerOriginal, maximumQuantity);
    const effectiveScale = valid && sourceOriginal! > EPSILON ? followerOriginal / sourceOriginal! : (scale ?? 0);
    const openRemaining = valid ? closeAll ? followerOriginal : sourceRemaining! * effectiveScale : 0;
    const followerRemaining = status === "OPEN" || status === "TRIGGERED" ? openRemaining : 0;
    const followerFilled = valid
      ? Math.max(0, Math.min(followerOriginal, (sourceOriginal! - sourceRemaining!) * effectiveScale))
      : 0;

    let action: MirroredOrderAction;
    if (!valid || !sizingUsable) action = "IGNORED";
    else if ((!prior || prior.balanceScale === undefined) && status === "OPEN") action = "PLACED";
    else if (status !== "OPEN") action = actionForStatus(status);
    else if (sourceRemaining! < prior!.sourceRemainingQuantity - EPSILON && price === prior!.price && sourceOriginal === prior!.sourceOriginalQuantity) action = "PARTIALLY_FILLED";
    else if (
      Math.abs(price! - prior!.price) > EPSILON ||
      Math.abs(sourceRemaining! - prior!.sourceRemainingQuantity) > EPSILON ||
      Math.abs(sourceOriginal! - prior!.sourceOriginalQuantity) > EPSILON
    ) action = "MODIFIED";
    else action = "IGNORED";

    const createdAt = prior?.createdAt ?? raw.timestamp ?? update.statusTimestamp;
    const order: MirroredOrder = {
      id,
      whale,
      sourceOid,
      coin: coin || "UNKNOWN",
      symbol: this.symbolForCoin(coin || "UNKNOWN"),
      side: raw.side === "B" ? "BUY" : "SELL",
      price: price ?? 0,
      sourceStatus: update.status,
      status,
      sourceOriginalQuantity: sourceOriginal ?? 0,
      sourceRemainingQuantity: sourceRemaining ?? 0,
      followerOriginalQuantity: followerOriginal,
      followerRemainingQuantity: followerRemaining,
      followerFilledQuantity: status === "FILLED" ? followerOriginal : followerFilled,
      ...(sizingUsable ? {
        sourceAccountValueUsd: sizing!.sourceAccountValueUsd,
        followerAccountValueUsd: sizing!.followerAccountValueUsd,
        balanceScale: effectiveScale,
      } : {}),
      ...(raw.reduceOnly !== undefined ? { reduceOnly: raw.reduceOnly } : {}),
      ...(raw.orderType ? { orderType: raw.orderType } : {}),
      ...(raw.tif ? { tif: raw.tif } : {}),
      ...(raw.isTrigger !== undefined ? { isTrigger: raw.isTrigger } : {}),
      ...(closeAll ? { closeAll: true } : {}),
      ...(update.isSnapshot !== undefined ? { startupSnapshot: update.isSnapshot } : {}),
      ...(finite(raw.triggerPx) !== undefined ? { triggerPrice: finite(raw.triggerPx) } : {}),
      metadataComplete: update.metadataComplete,
      leverageCapped,
      lastAction: action,
      createdAt,
      updatedAt: update.statusTimestamp,
      ...(!valid ? { warning: "Invalid source order data" } : !sizingUsable ? { warning: "Source or follower account value is unavailable" } : !update.metadataComplete ? { warning: "Order type metadata is incomplete; live mirroring must fail closed" } : {}),
    };

    this.orders.set(id, order);
    this.signatures.set(id, signature);
    this.trim();
    return {
      action,
      copied: valid && sizingUsable && action !== "IGNORED",
      order,
      ...(!valid ? { ignoredReason: "INVALID_ORDER" as const } : !sizingUsable ? { ignoredReason: "SIZING_DATA_UNAVAILABLE" as const } : {}),
    };
  }

  /** Update the visible pending quantity immediately when the fill stream wins the race. */
  applySourceFill(whaleAddress: string, fill: HyperliquidRealtimeFill): MirroredOrder | undefined {
    if (fill.oid === undefined) return undefined;
    const id = `${whaleAddress.toLowerCase()}|${String(fill.oid)}`;
    const prior = this.orders.get(id);
    const sourceFillQuantity = finite(fill.sz);
    if (!prior || sourceFillQuantity === undefined || sourceFillQuantity <= 0) return prior;
    const sourceRemaining = Math.max(0, prior.sourceRemainingQuantity - sourceFillQuantity);
    const scale = prior.balanceScale ?? 0;
    const followerFilled = Math.min(prior.followerOriginalQuantity, prior.followerFilledQuantity + sourceFillQuantity * scale);
    const next: MirroredOrder = {
      ...prior,
      sourceRemainingQuantity: sourceRemaining,
      followerRemainingQuantity: Math.max(0, prior.followerOriginalQuantity - followerFilled),
      followerFilledQuantity: followerFilled,
      status: sourceRemaining <= EPSILON ? "FILLED" : "OPEN",
      sourceStatus: sourceRemaining <= EPSILON ? "filled" : "open",
      lastAction: sourceRemaining <= EPSILON ? "FILLED" : "PARTIALLY_FILLED",
      updatedAt: fill.time,
    };
    this.orders.set(id, next);
    return next;
  }

  snapshot(): MirroredOrder[] {
    return [...this.orders.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, this.historyLimit);
  }

  private trim(): void {
    if (this.orders.size <= this.historyLimit) return;
    const oldest = [...this.orders.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!oldest) return;
    this.orders.delete(oldest.id);
    this.signatures.delete(oldest.id);
  }
}
