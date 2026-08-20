import assert from "node:assert/strict";
import test from "node:test";
import { buildHistoricalCarryInPositions } from "./backtest-carry-in";
import type { TradingEvent } from "./types";

const event = (
  time: number,
  startPosition: number,
  endPosition: number,
  side: "B" | "A",
  size: number,
  price: number,
  closedPnl: number,
): TradingEvent => ({
  id: String(time),
  coin: "BTC",
  time,
  fill: { coin: "BTC", side, sz: String(size), px: String(price), time, startPosition: String(startPosition), closedPnl: String(closedPnl), fee: "0" },
  startPosition,
  endPosition,
  actions: [],
  segments: [],
  labels: [],
  displayLabel: "",
  closedPnl,
  fee: 0,
  isLossClose: false,
  isTriggerStop: false,
});

test("infers the original carry-in entry after an add and a reduction", () => {
  const result = buildHistoricalCarryInPositions([
    event(2, 5, 10, "B", 5, 100, 0),
    event(3, 10, 8, "A", 2, 120, 80),
  ], 1);
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].signedSize, 5);
  assert.equal(result.positions[0].entryPriceUsd, 60);
});

test("does not invent an entry price when the carry-in never reduces", () => {
  const result = buildHistoricalCarryInPositions([
    event(2, -5, -7, "A", 2, 100, 0),
  ], 1);
  assert.equal(result.positions.length, 0);
  assert.deepEqual(result.skippedMissingEntryPrice, [{ coin: "BTC", signedSize: -5 }]);
});
