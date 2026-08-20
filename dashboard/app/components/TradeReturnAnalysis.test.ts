import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFlowNeutralPortfolioPerformance,
  buildTradeReturnSummary,
} from "./TradeReturnAnalysis";
import type { TradingEpisode } from "../lib/types";

test("flow-neutral portfolio return excludes a deposit from performance", () => {
  const performance = buildFlowNeutralPortfolioPerformance(
    [
      { time: 1, value: 100 },
      { time: 2, value: 200 },
      { time: 3, value: 220 },
    ],
    [
      { time: 1, value: 0 },
      { time: 2, value: 0 },
      { time: 3, value: 20 },
    ],
  );

  assert.equal(performance.inferredNetFlowUsd, 100);
  assert.ok(Math.abs(performance.returnPct - 10) < 1e-9);
  assert.deepEqual(performance.points.map((point) => point.value), [100, 100, 110.00000000000001]);
});

test("flow-neutral portfolio return compounds interval returns", () => {
  const performance = buildFlowNeutralPortfolioPerformance(
    [
      { time: 1, value: 100 },
      { time: 2, value: 110 },
      { time: 3, value: 121 },
    ],
    [
      { time: 1, value: 0 },
      { time: 2, value: 10 },
      { time: 3, value: 21 },
    ],
  );

  assert.ok(Math.abs(performance.returnPct - 21) < 1e-9);
  assert.deepEqual(performance.points.map((point) => Math.round(point.value)), [100, 110, 121]);
});

test("same-sample deposit and pnl cannot turn a dust balance into an astronomical return", () => {
  const performance = buildFlowNeutralPortfolioPerformance(
    [
      { time: 1, value: 0.02 },
      { time: 2, value: 26_383.02 },
    ],
    [
      { time: 1, value: 0 },
      { time: 2, value: 1_383 },
    ],
  );

  assert.ok(performance.returnPct > 5 && performance.returnPct < 6);
});

test("withdrawal larger than the sampled starting capital is not compounded from dust", () => {
  const performance = buildFlowNeutralPortfolioPerformance(
    [
      { time: 1, value: 0.005 },
      { time: 2, value: 0.005 },
    ],
    [
      { time: 1, value: 0 },
      { time: 2, value: 1_815 },
    ],
  );

  assert.deepEqual(performance.points, []);
  assert.equal(performance.returnPct, 0);
});

test("trade return uses one completed episode and entry account value", () => {
  const episode: TradingEpisode = {
    id: "BTC-1",
    coin: "BTC",
    direction: "LONG",
    status: "COMPLETED",
    entryTime: 2,
    exitTime: 3,
    openedWithinWindow: true,
    entrySize: 2,
    exitSize: 2,
    closedPnl: 21,
    fee: 1,
    netPnl: 20,
    fillIds: ["entry-a", "entry-b", "exit-a", "exit-b"],
  };
  const summary = buildTradeReturnSummary(
    [episode],
    [
      { time: 1, value: 100 },
      { time: 2, value: 200 },
      { time: 3, value: 220 },
    ],
  );

  assert.equal(summary.rows.length, 1);
  assert.equal(summary.rows[0].capitalBeforeUsd, 200);
  assert.equal(summary.rows[0].returnPct, 10);
  assert.equal(summary.cumulativeContributionPct, 10);
});

test("trade return uses inferred deposited capital instead of a dust balance", () => {
  const episode: TradingEpisode = {
    id: "SOL-1",
    coin: "SOL",
    direction: "LONG",
    status: "COMPLETED",
    entryTime: 2,
    exitTime: 3,
    openedWithinWindow: true,
    entrySize: 1,
    exitSize: 1,
    closedPnl: 7_347.243302,
    fee: 738.893168,
    netPnl: 6_608.350134,
    fillIds: [],
  };
  const summary = buildTradeReturnSummary(
    [episode],
    [
      { time: 1, value: 0.008341 },
      { time: 3, value: 24_304.302539 },
    ],
    [
      { time: 1, value: 0 },
      { time: 3, value: 1_976.894198 },
    ],
  );

  assert.ok(summary.rows[0].capitalBeforeUsd > 22_000);
  assert.ok(summary.rows[0].returnPct > 29 && summary.rows[0].returnPct < 30);
});
