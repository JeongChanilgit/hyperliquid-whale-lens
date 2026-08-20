import type {
  CopyDirection,
  CopyIntent,
  CopySegment,
  HyperliquidAccountPosition,
  HyperliquidRealtimeFill,
  SimulatedFill,
  SimulationLedgerEvent,
  SimulationPositionSnapshot,
  WhaleConfig,
} from "../copy-types";

const EPSILON = 1e-9;

const finite = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const zero = (value: number): number => (Math.abs(value) <= EPSILON ? 0 : value);
const sideForDelta = (delta: number): "BUY" | "SELL" => (delta > 0 ? "BUY" : "SELL");
const directionFor = (position: number): CopyDirection => (position > 0 ? "LONG" : "SHORT");
const sign = (value: number): number => (value > EPSILON ? 1 : value < -EPSILON ? -1 : 0);

export const sourceFillId = (whale: string, fill: HyperliquidRealtimeFill): string =>
  `${whale.toLowerCase()}|${fill.hash ?? ""}|${fill.tid ?? ""}|${fill.oid ?? ""}|${fill.time}|${fill.coin}|${fill.side}|${fill.sz}|${fill.px}|${fill.startPosition}`;

interface LedgerPosition {
  sourcePosition: number;
  trackedSourcePosition: number;
  followerPosition: number;
  averageEntryPrice: number;
  copyingEpisode: boolean;
  desynced: boolean;
  updatedAt: number;
}

export interface SimulationLedgerOptions {
  symbolForCoin?: (coin: string) => string;
  initialPositions?: SimulationPositionSnapshot[];
}

export interface EquityRatioSizingInput {
  sourceAccountValueUsd: number;
  /** Current follower equity; defaults to the original allocation for compatibility. */
  followerAccountValueUsd?: number;
  /** Original per-whale collateral allocation, retained for reporting. */
  allocatedFollowerCapitalUsd: number;
  maxLeverage?: number;
  /** Remaining notional available to this coin after other paper positions. */
  maximumTargetNotionalUsd?: number;
}

export interface SimulationLedgerApplyOptions {
  /** Treat same-direction increases to a startup carry-in as new session exposure. */
  copyCarryInAdds?: boolean;
}

/**
 * A per-whale virtual execution ledger. Carry-in positions remain fail-closed unless
 * the engine explicitly synchronizes them from a fresh clearinghouse snapshot.
 */
export class CopySimulationLedger {
  private readonly positions = new Map<string, LedgerPosition>();
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly symbolForCoin: (coin: string) => string;

  constructor(options: SimulationLedgerOptions = {}) {
    this.symbolForCoin = options.symbolForCoin ?? ((coin) => coin.includes(":") ? coin.toUpperCase() : `${coin.toUpperCase()}USDT`);
    for (const position of options.initialPositions ?? []) {
      const whale = position.whale.toLowerCase();
      const coin = position.coin.toUpperCase();
      if (!/^0x[a-f0-9]{40}$/.test(whale) || !coin || ![
        position.sourcePosition,
        position.followerPosition,
        position.averageEntryPrice,
        position.updatedAt,
      ].every(Number.isFinite)) continue;
      this.positions.set(`${whale}|${coin}`, {
        sourcePosition: zero(position.sourcePosition),
        trackedSourcePosition: zero(finite(position.trackedSourcePosition) ?? (
          position.copyingEpisode ? position.sourcePosition : 0
        )),
        followerPosition: zero(position.followerPosition),
        averageEntryPrice: Math.max(0, position.averageEntryPrice),
        copyingEpisode: position.copyingEpisode,
        desynced: position.desynced,
        updatedAt: position.updatedAt,
      });
    }
  }

  apply(
    whaleConfig: WhaleConfig,
    fill: HyperliquidRealtimeFill,
    equitySizing?: EquityRatioSizingInput,
    options: SimulationLedgerApplyOptions = {},
  ): SimulationLedgerEvent {
    const whale = whaleConfig.address.toLowerCase();
    const fillId = sourceFillId(whale, fill);
    const start = finite(fill.startPosition);
    const size = finite(fill.sz);
    const price = finite(fill.px);
    if (start === undefined || size === undefined || price === undefined || size < 0 || price <= 0 || (fill.side !== "B" && fill.side !== "A")) {
      return this.ignored(whale, fill, fillId, "INVALID_FILL");
    }
    if (this.remember(fillId)) return this.ignored(whale, fill, fillId, "DESYNC", "Duplicate source fill ignored");
    if (size <= EPSILON) return this.ignored(whale, fill, fillId, "ZERO_SIZE");

    const coin = fill.coin.toUpperCase();
    const key = `${whale}|${coin}`;
    const delta = fill.side === "B" ? size : -size;
    const sourceBefore = zero(start);
    const sourceAfter = zero(start + delta);
    const current = this.positions.get(key);
    const prior: LedgerPosition = current ?? {
      sourcePosition: sourceBefore,
      trackedSourcePosition: 0,
      followerPosition: 0,
      averageEntryPrice: 0,
      copyingEpisode: sourceBefore === 0,
      desynced: false,
      updatedAt: fill.time,
    };

    if (current && Math.abs(current.sourcePosition - sourceBefore) > EPSILON) {
      // Do not infer missed fills. Resume only after the whale is flat.
      prior.desynced = true;
      prior.copyingEpisode = false;
      prior.trackedSourcePosition = 0;
    }
    const allowedCoin = !whaleConfig.allowedCoins || whaleConfig.allowedCoins.map((item) => item.toUpperCase()).includes(coin);
    if (!allowedCoin) {
      prior.copyingEpisode = false;
      prior.trackedSourcePosition = 0;
    }
    if (sourceBefore === 0 && !prior.desynced && allowedCoin) prior.copyingEpisode = true;
    const carryInAdditionStartsTrackedEpisode = options.copyCarryInAdds === true &&
      sourceBefore !== 0 && sourceAfter !== 0 && sign(sourceBefore) === sign(sourceAfter) &&
      sign(delta) === sign(sourceBefore) && Math.abs(sourceAfter) > Math.abs(sourceBefore) + EPSILON &&
      !prior.copyingEpisode && !prior.desynced && allowedCoin;
    if (carryInAdditionStartsTrackedEpisode) prior.copyingEpisode = true;
    const carryInReversalStartsNewEpisode = sourceBefore !== 0 && sourceAfter !== 0 &&
      sign(sourceBefore) !== sign(sourceAfter) && !prior.copyingEpisode && !prior.desynced && allowedCoin;
    if (carryInReversalStartsNewEpisode) {
      // The close portion belongs to the pre-session position, but the amount
      // beyond flat is a genuinely new opposite-side episode and is eligible.
      prior.sourcePosition = 0;
      prior.trackedSourcePosition = 0;
      prior.followerPosition = 0;
      prior.averageEntryPrice = 0;
      prior.copyingEpisode = true;
    }
    if (sourceBefore !== 0 && !prior.copyingEpisode) {
      prior.sourcePosition = sourceAfter;
      prior.updatedAt = fill.time;
      if (sourceAfter === 0) prior.desynced = false;
      this.positions.set(key, prior);
      return this.ignored(whale, fill, fillId, current?.desynced ? "DESYNC" : "CARRY_IN");
    }
    if (prior.desynced) {
      prior.sourcePosition = sourceAfter;
      prior.updatedAt = fill.time;
      if (sourceAfter === 0) prior.desynced = false;
      this.positions.set(key, prior);
      return this.ignored(whale, fill, fillId, "DESYNC");
    }

    const trackedBefore = prior.trackedSourcePosition;
    let trackedAfter: number;
    if (carryInReversalStartsNewEpisode || sourceBefore === 0) {
      trackedAfter = sourceAfter;
    } else if (sourceAfter === 0) {
      trackedAfter = 0;
    } else if (sign(sourceBefore) !== sign(sourceAfter)) {
      trackedAfter = sourceAfter;
    } else if (sign(delta) === sign(sourceBefore)) {
      trackedAfter = zero(trackedBefore + delta);
    } else {
      trackedAfter = zero(sign(trackedBefore) * Math.max(0, Math.abs(trackedBefore) - Math.abs(delta)));
    }

    if (equitySizing && (
      !Number.isFinite(equitySizing.sourceAccountValueUsd) || equitySizing.sourceAccountValueUsd <= 0 ||
      !Number.isFinite(equitySizing.allocatedFollowerCapitalUsd) || equitySizing.allocatedFollowerCapitalUsd <= 0 ||
      (equitySizing.followerAccountValueUsd !== undefined && (!Number.isFinite(equitySizing.followerAccountValueUsd) || equitySizing.followerAccountValueUsd <= 0)) ||
      (equitySizing.maxLeverage !== undefined && (!Number.isFinite(equitySizing.maxLeverage) || equitySizing.maxLeverage <= 0)) ||
      (equitySizing.maximumTargetNotionalUsd !== undefined && (!Number.isFinite(equitySizing.maximumTargetNotionalUsd) || equitySizing.maximumTargetNotionalUsd < 0))
    )) {
      prior.sourcePosition = sourceAfter;
      prior.trackedSourcePosition = trackedAfter;
      prior.updatedAt = fill.time;
      this.positions.set(key, prior);
      return this.ignored(whale, fill, fillId, "SIZING_DATA_UNAVAILABLE", "Invalid source equity sizing data", prior.followerPosition);
    }

    const followerBefore = prior.followerPosition;
    const followerAccountValueUsd = equitySizing?.followerAccountValueUsd ?? equitySizing?.allocatedFollowerCapitalUsd;
    const quantityScale = equitySizing
      ? followerAccountValueUsd! / equitySizing.sourceAccountValueUsd
      : whaleConfig.copyRatio;
    const requestedTarget = zero(trackedAfter * quantityScale);
    const requestedTargetNotionalUsd = Math.abs(requestedTarget * price);
    const maximumTargetNotionalUsd = equitySizing?.maximumTargetNotionalUsd ?? (equitySizing?.maxLeverage
      ? followerAccountValueUsd! * equitySizing.maxLeverage
      : Number.POSITIVE_INFINITY);
    const leverageCapped = requestedTargetNotionalUsd > maximumTargetNotionalUsd;
    const target = leverageCapped
      ? zero(Math.sign(requestedTarget) * maximumTargetNotionalUsd / price)
      : requestedTarget;
    const executedQuantityScale = Math.abs(trackedAfter) > EPSILON ? Math.abs(target / trackedAfter) : quantityScale;
    const followerDelta = zero(target - followerBefore);
    const segments = this.segmentsFor(followerBefore, target);
    const simulated = this.executeSegments({
      whale,
      coin,
      fill,
      fillId,
      price,
      quantityScale: executedQuantityScale,
      position: prior,
      segments,
    });
    prior.sourcePosition = sourceAfter;
    prior.trackedSourcePosition = trackedAfter;
    prior.followerPosition = target;
    prior.updatedAt = fill.time;
    if (sourceAfter === 0 || Math.abs(trackedAfter) <= EPSILON) prior.copyingEpisode = false;
    this.positions.set(key, prior);

    const intent: CopyIntent | undefined = segments.length === 0 ? undefined : {
      idempotencyKey: fillId,
      whale,
      coin,
      symbol: this.symbolForCoin(coin),
      referencePrice: price,
      sourceTime: fill.time,
      segments,
      notionalUsd: segments.reduce((total, segment) => total + segment.quantity * price, 0),
    };
    return {
      whale,
      sourceFill: fill,
      sourceFillId: fillId,
      sourcePositionBefore: sourceBefore,
      sourcePositionAfter: sourceAfter,
      followerPositionBefore: followerBefore,
      followerPositionAfter: prior.followerPosition,
      copied: Math.abs(followerDelta) > EPSILON,
      ...(intent ? { intent } : {}),
      fills: simulated,
      realizedPnl: simulated.reduce((total, trade) => total + trade.realizedPnl, 0),
      sizingMode: equitySizing ? "SOURCE_EQUITY_RATIO" : "FIXED_SOURCE_RATIO",
      ...(equitySizing ? {
        sourceAccountValueUsd: equitySizing.sourceAccountValueUsd,
        allocatedFollowerCapitalUsd: equitySizing.allocatedFollowerCapitalUsd,
        followerAccountValueUsd,
        sourcePositionNotionalUsd: Math.abs(sourceAfter * price),
        sourceExposurePct: Math.abs(sourceAfter * price) / equitySizing.sourceAccountValueUsd * 100,
        requestedTargetFollowerNotionalUsd: requestedTargetNotionalUsd,
        targetFollowerNotionalUsd: Math.abs(target * price),
        followerLeverage: Math.abs(target * price) / followerAccountValueUsd!,
        leverageCapped,
      } : {}),
    };
  }

  getFollowerPosition(whale: string, coin: string): number {
    return this.positions.get(`${whale.toLowerCase()}|${coin.toUpperCase()}`)?.followerPosition ?? 0;
  }

  /**
   * Adopt positions that already exist when a paper session starts. New positions
   * use the source's reported average entry price. Positions without a trustworthy
   * source entry are not adopted; fabricating one would corrupt carry-in PnL.
   */
  synchronizeCarryInPositions(
    whaleConfig: WhaleConfig,
    sourcePositions: HyperliquidAccountPosition[],
    equitySizing: EquityRatioSizingInput,
    synchronizedAt: number,
  ): SimulationPositionSnapshot[] {
    const whale = whaleConfig.address.toLowerCase();
    const allowedCoins = whaleConfig.allowedCoins?.map((coin) => coin.toUpperCase());
    const currentCoins = new Set<string>();
    const followerEquity = equitySizing.followerAccountValueUsd ?? equitySizing.allocatedFollowerCapitalUsd;
    const scale = followerEquity / equitySizing.sourceAccountValueUsd;
    const maximumNotionalUsd = equitySizing.maxLeverage
      ? followerEquity * equitySizing.maxLeverage
      : Number.POSITIVE_INFINITY;
    const candidates = sourcePositions.flatMap((source) => {
      const coin = source.coin.toUpperCase();
      const sourcePosition = zero(source.signedSize);
      if (!coin || !Number.isFinite(sourcePosition) || Math.abs(sourcePosition) <= EPSILON) return [];
      const allowed = !allowedCoins || allowedCoins.includes(coin);
      const markPrice = source.positionValueUsd !== undefined && source.positionValueUsd > 0
        ? source.positionValueUsd / Math.abs(sourcePosition)
        : source.entryPriceUsd;
      const validMark = markPrice !== undefined && Number.isFinite(markPrice) && markPrice > 0;
      const entryPrice = source.entryPriceUsd;
      const validEntry = entryPrice !== undefined && Number.isFinite(entryPrice) && entryPrice > 0;
      const requestedTarget = allowed ? zero(sourcePosition * scale) : 0;
      return [{
        coin,
        sourcePosition,
        allowed,
        markPrice: validMark ? markPrice : undefined,
        entryPrice: validEntry ? entryPrice : undefined,
        requestedTarget,
      }];
    });
    const requestedGrossNotionalUsd = candidates.reduce((total, candidate) => total + (
      candidate.markPrice ? Math.abs(candidate.requestedTarget * candidate.markPrice) : 0
    ), 0);
    const portfolioScale = requestedGrossNotionalUsd > maximumNotionalUsd
      ? maximumNotionalUsd / requestedGrossNotionalUsd
      : 1;

    for (const candidate of candidates) {
      const { coin, sourcePosition, allowed, markPrice, entryPrice, requestedTarget } = candidate;
      currentCoins.add(coin);
      const validMark = markPrice !== undefined;
      const validEntry = entryPrice !== undefined;
      const target = allowed && validMark && validEntry ? zero(requestedTarget * portfolioScale) : 0;
      const key = `${whale}|${coin}`;
      this.positions.set(key, {
        sourcePosition,
        trackedSourcePosition: sourcePosition,
        followerPosition: target,
        averageEntryPrice: Math.abs(target) > EPSILON ? entryPrice! : 0,
        copyingEpisode: allowed && validMark && validEntry,
        desynced: false,
        updatedAt: synchronizedAt,
      });
    }

    for (const [key, position] of this.positions) {
      if (!key.startsWith(`${whale}|`)) continue;
      const coin = key.slice(whale.length + 1);
      if (currentCoins.has(coin)) continue;
      this.positions.set(key, {
        ...position,
        sourcePosition: 0,
        trackedSourcePosition: 0,
        followerPosition: 0,
        averageEntryPrice: 0,
        copyingEpisode: false,
        desynced: false,
        updatedAt: synchronizedAt,
      });
    }
    return this.snapshot(whale);
  }

  getPositionSnapshot(whale: string, coin: string): SimulationPositionSnapshot | undefined {
    const address = whale.toLowerCase();
    const normalizedCoin = coin.toUpperCase();
    const position = this.positions.get(`${address}|${normalizedCoin}`);
    return position ? this.toSnapshot(address, normalizedCoin, position) : undefined;
  }

  snapshot(whale?: string): SimulationPositionSnapshot[] {
    const address = whale?.toLowerCase();
    const prefix = address ? `${address}|` : undefined;
    return [...this.positions.entries()]
      .filter(([key]) => !prefix || key.startsWith(prefix))
      .map(([key, position]) => {
        const separator = key.indexOf("|");
        return this.toSnapshot(key.slice(0, separator), key.slice(separator + 1), position);
      })
      .sort((a, b) => a.whale.localeCompare(b.whale) || a.coin.localeCompare(b.coin));
  }

  getUnrealizedPnl(whale: string, markPriceForCoin: (coin: string) => number | undefined): number {
    const prefix = `${whale.toLowerCase()}|`;
    let total = 0;
    for (const [key, position] of this.positions) {
      if (!key.startsWith(prefix) || Math.abs(position.followerPosition) <= EPSILON || position.averageEntryPrice <= 0) continue;
      const coin = key.slice(prefix.length);
      const mark = markPriceForCoin(coin) ?? position.averageEntryPrice;
      if (mark === undefined || !Number.isFinite(mark) || mark <= 0) continue;
      total += position.followerPosition > 0
        ? (mark - position.averageEntryPrice) * position.followerPosition
        : (position.averageEntryPrice - mark) * Math.abs(position.followerPosition);
    }
    return total;
  }

  getFollowerGrossNotional(
    whale: string,
    markPriceForCoin: (coin: string) => number | undefined,
    excludeCoin?: string,
  ): number {
    const prefix = `${whale.toLowerCase()}|`;
    const excluded = excludeCoin?.toUpperCase();
    let total = 0;
    for (const [key, position] of this.positions) {
      if (!key.startsWith(prefix) || Math.abs(position.followerPosition) <= EPSILON) continue;
      const coin = key.slice(prefix.length);
      if (coin === excluded) continue;
      const mark = markPriceForCoin(coin) ?? position.averageEntryPrice;
      if (mark === undefined || !Number.isFinite(mark) || mark <= 0) continue;
      total += Math.abs(position.followerPosition * mark);
    }
    return total;
  }

  private ignored(
    whale: string,
    fill: HyperliquidRealtimeFill,
    fillId: string,
    reason: SimulationLedgerEvent["ignoredReason"],
    warning?: string,
    followerPosition = 0,
  ): SimulationLedgerEvent {
    const sourceBefore = finite(fill.startPosition) ?? 0;
    const size = finite(fill.sz) ?? 0;
    const sourceAfter = zero(sourceBefore + (fill.side === "B" ? size : -size));
    return {
      whale,
      sourceFill: fill,
      sourceFillId: fillId,
      sourcePositionBefore: sourceBefore,
      sourcePositionAfter: sourceAfter,
      followerPositionBefore: followerPosition,
      followerPositionAfter: followerPosition,
      copied: false,
      ignoredReason: reason,
      fills: [],
      realizedPnl: 0,
      ...(warning ? { warning } : {}),
    };
  }

  private remember(id: string): boolean {
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 25_000) {
      const expired = this.seenOrder.shift();
      if (expired) this.seen.delete(expired);
    }
    return false;
  }

  private toSnapshot(whale: string, coin: string, position: LedgerPosition): SimulationPositionSnapshot {
    return {
      whale,
      coin,
      sourcePosition: position.sourcePosition,
      trackedSourcePosition: position.trackedSourcePosition,
      followerPosition: position.followerPosition,
      averageEntryPrice: position.averageEntryPrice,
      copyingEpisode: position.copyingEpisode,
      desynced: position.desynced,
      updatedAt: position.updatedAt,
    };
  }

  private segmentsFor(before: number, target: number): CopySegment[] {
    if (Math.abs(target - before) <= EPSILON) return [];
    const beforeSign = sign(before);
    const targetSign = sign(target);
    if (beforeSign !== 0 && targetSign !== 0 && beforeSign !== targetSign) {
      return [
        { kind: "CLOSE", side: sideForDelta(-before), quantity: Math.abs(before), reduceOnly: true },
        { kind: "ENTRY", side: sideForDelta(target), quantity: Math.abs(target), reduceOnly: false },
      ];
    }
    const delta = target - before;
    if (beforeSign === 0) return [{ kind: "ENTRY", side: sideForDelta(delta), quantity: Math.abs(delta), reduceOnly: false }];
    if (targetSign === 0) return [{ kind: "CLOSE", side: sideForDelta(delta), quantity: Math.abs(delta), reduceOnly: true }];
    if (Math.abs(target) > Math.abs(before)) return [{ kind: "ADD", side: sideForDelta(delta), quantity: Math.abs(delta), reduceOnly: false }];
    return [{ kind: "REDUCE", side: sideForDelta(delta), quantity: Math.abs(delta), reduceOnly: true }];
  }

  private executeSegments(input: {
    whale: string;
    coin: string;
    fill: HyperliquidRealtimeFill;
    fillId: string;
    price: number;
    quantityScale: number;
    position: LedgerPosition;
    segments: CopySegment[];
  }): SimulatedFill[] {
    const sourceSize = Math.abs(finite(input.fill.sz) ?? 0);
    const copiedQuantity = input.segments.reduce((total, segment) => total + segment.quantity, 0);
    const feeScale = sourceSize > EPSILON ? copiedQuantity / sourceSize : input.quantityScale;
    const sourceFee = Math.abs(finite(input.fill.fee) ?? 0) * feeScale;
    const output: SimulatedFill[] = [];
    for (const [index, segment] of input.segments.entries()) {
      const signedDelta = segment.side === "BUY" ? segment.quantity : -segment.quantity;
      const before = input.position.followerPosition;
      const next = zero(before + signedDelta);
      let realizedPnl = 0;
      if (sign(before) !== 0 && sign(signedDelta) !== sign(before)) {
        const closed = Math.min(Math.abs(before), Math.abs(signedDelta));
        realizedPnl = directionFor(before) === "LONG" ? (input.price - input.position.averageEntryPrice) * closed : (input.position.averageEntryPrice - input.price) * closed;
      }
      if (sign(next) === 0) input.position.averageEntryPrice = 0;
      else if (sign(before) === 0 || sign(next) !== sign(before)) input.position.averageEntryPrice = input.price;
      else if (Math.abs(next) > Math.abs(before)) input.position.averageEntryPrice = (input.position.averageEntryPrice * Math.abs(before) + input.price * Math.abs(signedDelta)) / Math.abs(next);
      input.position.followerPosition = next;
      const fee = input.segments.length > 0 ? Math.abs(sourceFee) / input.segments.length : 0;
      output.push({
        id: `${input.fillId}:${index}`,
        whale: input.whale,
        coin: input.coin,
        time: input.fill.time,
        side: segment.side,
        quantity: segment.quantity,
        price: input.price,
        realizedPnl,
        fee,
        positionAfter: next,
        sourceFillId: input.fillId,
        segment: segment.kind,
      });
    }
    return output;
  }
}
