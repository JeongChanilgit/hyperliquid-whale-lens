import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CopySimulationLedger } from "../app/lib/realtime/simulation-ledger";
import { buildHistoricalCarryInPositions } from "../app/lib/backtest-carry-in";
import { SEED_WALLETS } from "../app/seed-wallets";
import type { AccountValuePoint, WalletBundle } from "../app/lib/types";

const allocationUsd = Number(process.env.BACKTEST_WHALE_ALLOCATION_USD ?? 100);
const minSourceEquityUsd = Number(process.env.BACKTEST_MIN_SOURCE_EQUITY_USD ?? 10_000);
const maxLeverage = process.env.BACKTEST_MAX_LEVERAGE === undefined
  ? Number.POSITIVE_INFINITY
  : Number(process.env.BACKTEST_MAX_LEVERAGE);

if (!Number.isFinite(allocationUsd) || allocationUsd <= 0) throw new Error("BACKTEST_WHALE_ALLOCATION_USD must be greater than zero");
if (!Number.isFinite(minSourceEquityUsd) || minSourceEquityUsd < 0) throw new Error("BACKTEST_MIN_SOURCE_EQUITY_USD must not be negative");
if (!(maxLeverage > 0)) throw new Error("BACKTEST_MAX_LEVERAGE must be greater than zero");

type BacktestResult = {
  rank: number;
  label: string;
  address: string;
  events: number;
  copiedEvents: number;
  simulatedFills: number;
  sizingBlocks: number;
  leverageCapEvents: number;
  grossPnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  returnPct: number;
  realizedMaxDrawdownPct: number;
  minimumRealizedEquityUsd: number;
  firstInsolvencyAt?: number;
  maxSourceExposurePct: number;
  averageSourceExposurePct: number;
  maxFollowerLeverageUsed: number;
  carryInPositionsSynced: number;
  carryInPositionsSkippedMissingEntry: number;
};

const equityAt = (points: AccountValuePoint[], time: number, cursor: { index: number; value: number }): number => {
  while (cursor.index + 1 < points.length && points[cursor.index + 1].time <= time) {
    cursor.index += 1;
    const next = points[cursor.index].value;
    if (Number.isFinite(next) && next >= 0) cursor.value = next;
  }
  return cursor.value;
};

const replayWallet = (label: string, address: string): BacktestResult => {
  const bundle = JSON.parse(readFileSync(join("public", "preloaded", "wallets", `${address}.json`), "utf8")) as WalletBundle;
  const points = [...(bundle.portfolio.month?.accountValueHistory ?? [])].sort((left, right) => left.time - right.time);
  const events = [...bundle.events].sort((left, right) => left.time - right.time);
  const ledger = new CopySimulationLedger();
  const cursor = { index: -1, value: 0 };
  let copiedEvents = 0;
  let simulatedFills = 0;
  let sizingBlocks = 0;
  let grossPnlUsd = 0;
  let feesUsd = 0;
  let exposureTotal = 0;
  let exposureSamples = 0;
  let maxSourceExposurePct = 0;
  let maxFollowerLeverageUsed = 0;
  let leverageCapEvents = 0;
  let runningNetPnlUsd = 0;
  let peakRealizedEquityUsd = allocationUsd;
  let minimumRealizedEquityUsd = allocationUsd;
  let realizedMaxDrawdownPct = 0;
  let firstInsolvencyAt: number | undefined;

  const baselinePoint = points.find((point) => Number.isFinite(point.value) && point.value >= minSourceEquityUsd);
  const baselineTime = baselinePoint?.time ?? bundle.range.startTime;
  const carryIn = buildHistoricalCarryInPositions(events, baselineTime);
  if (baselinePoint && carryIn.positions.length > 0) {
    ledger.synchronizeCarryInPositions(
      { address, copyRatio: 0.01 },
      carryIn.positions,
      {
        sourceAccountValueUsd: baselinePoint.value,
        allocatedFollowerCapitalUsd: allocationUsd,
        ...(Number.isFinite(maxLeverage) ? { maxLeverage } : {}),
      },
      baselineTime,
    );
  }

  for (const event of events) {
    if (event.time < baselineTime) continue;
    const sourceEquityUsd = equityAt(points, event.time, cursor);
    const price = Number(event.fill.px);
    const sourceExposureMultiple = sourceEquityUsd > 0 && Number.isFinite(price)
      ? Math.abs(event.endPosition * price) / sourceEquityUsd
      : 0;
    if (sourceEquityUsd >= minSourceEquityUsd && sourceExposureMultiple > maxLeverage) leverageCapEvents += 1;
    if (sourceEquityUsd >= minSourceEquityUsd) {
      maxFollowerLeverageUsed = Math.max(maxFollowerLeverageUsed, Math.min(sourceExposureMultiple, maxLeverage));
    }
    const result = ledger.apply(
      { address, copyRatio: 0.01 },
      event.fill,
      sourceEquityUsd >= minSourceEquityUsd
        ? {
            sourceAccountValueUsd: sourceEquityUsd,
            allocatedFollowerCapitalUsd: allocationUsd,
            ...(Number.isFinite(maxLeverage) ? { maxLeverage } : {}),
          }
        : { sourceAccountValueUsd: 0, allocatedFollowerCapitalUsd: allocationUsd },
    );
    if (result.ignoredReason === "SIZING_DATA_UNAVAILABLE") sizingBlocks += 1;
    if (result.copied) copiedEvents += 1;
    simulatedFills += result.fills.length;
    grossPnlUsd += result.realizedPnl;
    const eventFeesUsd = result.fills.reduce((total, fill) => total + fill.fee, 0);
    feesUsd += eventFeesUsd;
    runningNetPnlUsd += result.realizedPnl - eventFeesUsd;
    const realizedEquityUsd = allocationUsd + runningNetPnlUsd;
    minimumRealizedEquityUsd = Math.min(minimumRealizedEquityUsd, realizedEquityUsd);
    peakRealizedEquityUsd = Math.max(peakRealizedEquityUsd, realizedEquityUsd);
    realizedMaxDrawdownPct = Math.max(realizedMaxDrawdownPct, (peakRealizedEquityUsd - realizedEquityUsd) / peakRealizedEquityUsd * 100);
    if (firstInsolvencyAt === undefined && realizedEquityUsd <= 0) firstInsolvencyAt = event.time;
    if (result.sourceExposurePct !== undefined) {
      exposureTotal += result.sourceExposurePct;
      exposureSamples += 1;
      maxSourceExposurePct = Math.max(maxSourceExposurePct, result.sourceExposurePct);
    }
  }

  const netPnlUsd = grossPnlUsd - feesUsd;
  return {
    rank: Number(label.split(" ")[1]),
    label,
    address,
    events: events.length,
    copiedEvents,
    simulatedFills,
    sizingBlocks,
    leverageCapEvents,
    grossPnlUsd,
    feesUsd,
    netPnlUsd,
    returnPct: netPnlUsd / allocationUsd * 100,
    realizedMaxDrawdownPct,
    minimumRealizedEquityUsd,
    ...(firstInsolvencyAt !== undefined ? { firstInsolvencyAt } : {}),
    maxSourceExposurePct,
    averageSourceExposurePct: exposureSamples > 0 ? exposureTotal / exposureSamples : 0,
    maxFollowerLeverageUsed,
    carryInPositionsSynced: baselinePoint ? carryIn.positions.length : 0,
    carryInPositionsSkippedMissingEntry: carryIn.skippedMissingEntryPrice.length,
  };
};

const results = SEED_WALLETS
  .filter((wallet) => wallet.status === "ACTIVE")
  .map((wallet) => replayWallet(wallet.label, wallet.address));
const portfolioNetPnlUsd = results.reduce((total, result) => total + result.netPnlUsd, 0);
const output = {
  assumptions: {
    allocationUsdPerWhale: allocationUsd,
    totalCapitalUsd: allocationUsd * results.length,
    minimumSourceEquityUsd: minSourceEquityUsd,
    maxLeverage: Number.isFinite(maxLeverage) ? maxLeverage : null,
    openPositionUnrealizedPnlIncluded: false,
    carryInPositionCostBasis: "SOURCE_ENTRY_PRICE_INFERRED_FROM_FIRST_REDUCTION",
    carryInEntryFeesIncluded: false,
    carryInWithoutTrustworthyEntryPrice: "SKIPPED_UNTIL_FLAT",
    slippageIncluded: false,
  },
  portfolio: {
    netPnlUsd: portfolioNetPnlUsd,
    returnPct: portfolioNetPnlUsd / (allocationUsd * results.length) * 100,
    profitableWhales: results.filter((result) => result.netPnlUsd > 0).length,
  },
  results,
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
