import type { HyperliquidAccountPosition } from "./copy-types";
import type { TradingEvent } from "./types";

const EPSILON = 1e-9;

export interface HistoricalCarryInResult {
  positions: HyperliquidAccountPosition[];
  skippedMissingEntryPrice: Array<{ coin: string; signedSize: number }>;
}

function finite(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Reconstruct the average entry of a position already open at the backtest
 * baseline. Hyperliquid reports realized PnL on the first later reduction, so:
 *   long entry = exit - closedPnl / closedQty
 *   short entry = exit + closedPnl / closedQty
 * Adds before that reduction are algebraically removed to recover the baseline
 * position's own average entry. No reduction means no trustworthy entry.
 */
function inferBaselineEntryPrice(
  signedSize: number,
  events: TradingEvent[],
): number | undefined {
  const direction = Math.sign(signedSize);
  const initialQuantity = Math.abs(signedSize);
  let addedQuantity = 0;
  let addedCost = 0;

  for (const event of events) {
    const start = finite(event.fill.startPosition);
    const end = finite(event.endPosition);
    const price = finite(event.fill.px);
    const fillSize = finite(event.fill.sz);
    if (start === undefined || end === undefined || price === undefined || fillSize === undefined || price <= 0) continue;
    if (Math.abs(start) <= EPSILON || Math.sign(start) !== direction) break;

    const positionDelta = Math.abs(end) - Math.abs(start);
    if (positionDelta > EPSILON && Math.sign(end) === direction) {
      addedQuantity += positionDelta;
      addedCost += positionDelta * price;
      continue;
    }
    if (positionDelta >= -EPSILON) continue;

    const closedQuantity = Math.min(Math.abs(start), fillSize);
    const closedPnl = finite(event.closedPnl);
    if (closedQuantity <= EPSILON || closedPnl === undefined) continue;
    const averageAtReduction = direction > 0
      ? price - closedPnl / closedQuantity
      : price + closedPnl / closedQuantity;
    const baselineEntry = (
      averageAtReduction * (initialQuantity + addedQuantity) - addedCost
    ) / initialQuantity;
    return Number.isFinite(baselineEntry) && baselineEntry > 0 ? baselineEntry : undefined;
  }
  return undefined;
}

export function buildHistoricalCarryInPositions(
  allEvents: TradingEvent[],
  baselineTime: number,
): HistoricalCarryInResult {
  const byCoin = new Map<string, TradingEvent[]>();
  for (const event of [...allEvents].sort((left, right) => left.time - right.time)) {
    const coin = event.coin.toUpperCase();
    const existing = byCoin.get(coin) ?? [];
    existing.push(event);
    byCoin.set(coin, existing);
  }

  const positions: HyperliquidAccountPosition[] = [];
  const skippedMissingEntryPrice: Array<{ coin: string; signedSize: number }> = [];
  for (const [coin, events] of byCoin) {
    const before = events.filter((event) => event.time < baselineTime).at(-1);
    const after = events.find((event) => event.time >= baselineTime);
    const signedSize = finite(before?.endPosition ?? after?.fill.startPosition) ?? 0;
    if (Math.abs(signedSize) <= EPSILON) continue;
    const remainingEvents = events.filter((event) => event.time >= baselineTime);
    const entryPriceUsd = inferBaselineEntryPrice(signedSize, remainingEvents);
    if (entryPriceUsd === undefined) {
      skippedMissingEntryPrice.push({ coin, signedSize });
      continue;
    }
    positions.push({
      coin,
      signedSize,
      entryPriceUsd,
      // Historical public data has no mark snapshot at an arbitrary baseline.
      // Entry notional is therefore the only non-fabricated sizing reference.
      positionValueUsd: Math.abs(signedSize) * entryPriceUsd,
    });
  }
  return { positions, skippedMissingEntryPrice };
}
