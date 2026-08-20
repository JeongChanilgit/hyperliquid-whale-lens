import assert from "node:assert/strict";
import test from "node:test";
import { planOpenEpisodeReplay, type OpenEpisodeReplayInput, type OpenEpisodeSourceFill } from "./open-episode-replay";

const fill = (input: Partial<OpenEpisodeSourceFill> & Pick<OpenEpisodeSourceFill, "coin" | "startPosition" | "side" | "sz" | "px" | "time">): OpenEpisodeSourceFill => ({
  hash: `0x${String(input.tid ?? input.time)}`,
  oid: input.oid ?? Number(input.tid ?? input.time),
  tid: input.tid ?? input.time,
  fee: input.fee ?? "1",
  ...input,
});

const request = (overrides: Partial<OpenEpisodeReplayInput> = {}): OpenEpisodeReplayInput => ({
  sourcePositions: [{ coin: "BTC", szi: "2", entryPx: "103.33333333333333" }],
  fills: [
    fill({ coin: "BTC", startPosition: "0", side: "B", sz: "2", px: "100", time: 1, tid: 1 }),
    fill({ coin: "BTC", startPosition: "2", side: "B", sz: "1", px: "110", time: 2, tid: 2 }),
    fill({ coin: "BTC", startPosition: "3", side: "A", sz: "1", px: "120", time: 3, tid: 3 }),
  ],
  followerAllocationUsd: 1_000,
  sourceTotalEquityUsd: 10_000,
  ...overrides,
});

test("replays a flat-origin open episode with partial entries and exits at one fixed bootstrap scale", () => {
  const plan = planOpenEpisodeReplay(request());
  assert.equal(plan.bootstrapScale, 0.1);
  assert.equal(plan.reconciliation.allCurrentOpenPositionsVerified, true);
  assert.equal(plan.episodes.length, 1);
  assert.deepEqual(plan.episodes[0]?.fills.map((step) => step.kind), ["ENTRY", "ADD", "PARTIAL_EXIT"]);
  assert.deepEqual(plan.episodes[0]?.fills.map((step) => step.replayedFollowerDelta), [0.2, 0.1, -0.1]);
  assert.equal(plan.episodes[0]?.sourcePosition, 2);
  assert.equal(plan.episodes[0]?.followerPosition, 0.2);
});

test("starts a new open episode from only the residual side of a zero-crossing reversal", () => {
  const plan = planOpenEpisodeReplay(request({
    sourcePositions: [{ coin: "ETH", szi: "-2", entryPx: "100" }],
    fills: [fill({ coin: "ETH", startPosition: "3", side: "A", sz: "5", px: "100", time: 1, tid: 11, fee: "5" })],
  }));
  const step = plan.episodes[0]?.fills[0];
  assert.equal(plan.episodes[0]?.boundary, "REVERSAL");
  assert.equal(step?.kind, "ENTRY");
  assert.equal(step?.fillStartPosition, 3);
  assert.equal(step?.sourcePositionBefore, 0);
  assert.equal(step?.sourcePositionAfter, -2);
  assert.equal(step?.replayedSourceDelta, -2);
  assert.equal(step?.sourceFee, 2);
});

test("orders same-millisecond fills only when startPosition continuity makes the order unique", () => {
  const plan = planOpenEpisodeReplay(request({
    sourcePositions: [{ coin: "BTC", szi: "3", entryPx: "100.66666666666667" }],
    fills: [
      fill({ coin: "BTC", startPosition: "1", side: "B", sz: "2", px: "101", time: 10, tid: 22 }),
      fill({ coin: "BTC", startPosition: "0", side: "B", sz: "1", px: "100", time: 10, tid: 21 }),
    ],
  }));
  assert.equal(plan.reconciliation.allCurrentOpenPositionsVerified, true);
  assert.deepEqual(plan.episodes[0]?.fills.map((step) => step.tid), [21, 22]);
});

test("synthesizes a financially commutative same-side atomic batch while preserving prices, fees, and source identities", () => {
  const plan = planOpenEpisodeReplay(request({
    sourcePositions: [{ coin: "BTC", szi: "3", entryPx: "106.66666666666667" }],
    fills: [
      fill({ coin: "BTC", startPosition: "0", side: "B", sz: "1", px: "100", fee: "1", time: 10, tid: 201 }),
      fill({ coin: "BTC", startPosition: "0", side: "B", sz: "2", px: "110", fee: "2", time: 10, tid: 202 }),
    ],
  }));
  const steps = plan.episodes[0]?.fills ?? [];
  assert.equal(plan.reconciled, true);
  assert.equal(plan.episodes[0]?.replayedAverageEntryPrice, 106.66666666666667);
  assert.deepEqual(steps.map((step) => step.fillStartPosition), [0, 0]);
  assert.deepEqual(steps.map((step) => step.fill.startPosition), ["0", "1"]);
  assert.deepEqual(steps.map((step) => step.sourceFee), [1, 2]);
  assert.deepEqual(steps.map((step) => step.synthesizedWithinMillisecond), [true, true]);
  assert.deepEqual(steps.map((step) => step.tid), [201, 202]);
});

test("orders a shuffled 43-fill same-millisecond chain without a factorial search", () => {
  const chained = Array.from({ length: 43 }, (_, index) => fill({
    coin: "SPCX",
    startPosition: String(index),
    side: "B",
    sz: "1",
    px: "100",
    time: 100,
    tid: 1_000 + index,
  }));
  const shuffled = [...chained].sort((left, right) => (
    (Number(left.tid) * 17 % 43) - (Number(right.tid) * 17 % 43)
  ));
  const plan = planOpenEpisodeReplay(request({
    sourcePositions: [{ coin: "SPCX", szi: "43", entryPx: "100" }],
    fills: shuffled,
  }));
  assert.equal(plan.reconciled, true);
  assert.deepEqual(plan.episodes[0]?.fills.map((step) => step.tid), chained.map((source) => source.tid));
});

test("blocks an ambiguous same-millisecond order rather than using response order", () => {
  const plan = planOpenEpisodeReplay(request({
    sourcePositions: [{ coin: "BTC", szi: "-1", entryPx: "100" }],
    fills: [
      fill({ coin: "BTC", startPosition: "0", side: "B", sz: "1", px: "100", time: 10, tid: 31 }),
      fill({ coin: "BTC", startPosition: "0", side: "A", sz: "2", px: "100", time: 10, tid: 32 }),
    ],
  }));
  assert.equal(plan.episodes.length, 0);
  assert.equal(plan.blocked[0]?.reason, "SAME_MILLISECOND_ORDER_AMBIGUOUS");
});

test("keeps mixed-side and unequal-price reversal batches fail-closed", () => {
  const unequalPriceReversal = planOpenEpisodeReplay(request({
    sourcePositions: [{ coin: "BTC", szi: "-1", entryPx: "100" }],
    fills: [
      fill({ coin: "BTC", startPosition: "1", side: "A", sz: "1", px: "100", time: 10, tid: 41 }),
      fill({ coin: "BTC", startPosition: "1", side: "A", sz: "1", px: "110", time: 10, tid: 42 }),
    ],
  }));
  assert.equal(unequalPriceReversal.blocked[0]?.reason, "SAME_MILLISECOND_ORDER_AMBIGUOUS");

  const mixedSide = planOpenEpisodeReplay(request({
    sourcePositions: [{ coin: "BTC", szi: "-1", entryPx: "110" }],
    fills: [
      fill({ coin: "BTC", startPosition: "0", side: "B", sz: "1", px: "100", time: 10, tid: 43 }),
      fill({ coin: "BTC", startPosition: "0", side: "A", sz: "2", px: "110", time: 10, tid: 44 }),
    ],
  }));
  assert.equal(mixedSide.blocked[0]?.reason, "SAME_MILLISECOND_ORDER_AMBIGUOUS");
});

test("blocks an open position whose retained fills do not contain a flat or reversal boundary", () => {
  const plan = planOpenEpisodeReplay(request({
    sourcePositions: [{ coin: "BTC", szi: "5", entryPx: "100" }],
    fills: [fill({ coin: "BTC", startPosition: "3", side: "B", sz: "2", px: "100", time: 1, tid: 41 })],
  }));
  assert.equal(plan.blocked[0]?.reason, "MISSING_FLAT_BOUNDARY");
});

test("blocks a replay whose final inventory does not reconcile with the current source snapshot", () => {
  const plan = planOpenEpisodeReplay(request({
    sourcePositions: [{ coin: "BTC", szi: "2", entryPx: "100" }],
    fills: [fill({ coin: "BTC", startPosition: "0", side: "B", sz: "1", px: "100", time: 1, tid: 51 })],
  }));
  assert.equal(plan.blocked[0]?.reason, "FINAL_POSITION_MISMATCH");
});

test("blocks a matching inventory when its fill-derived average entry differs from the source snapshot", () => {
  const plan = planOpenEpisodeReplay(request({
    sourcePositions: [{ coin: "BTC", szi: "2", entryPriceUsd: "101" }],
    fills: [fill({ coin: "BTC", startPosition: "0", side: "B", sz: "2", px: "100", time: 1, tid: 55 })],
  }));
  assert.equal(plan.blocked[0]?.reason, "AVERAGE_ENTRY_PRICE_MISMATCH");
});

test("keeps qualified HIP-3 coins isolated and returns a globally time-ordered replay", () => {
  const plan = planOpenEpisodeReplay(request({
    sourcePositions: [
      { coin: "dexA:BTC", szi: "1", entryPx: "100" },
      { coin: "dexB:BTC", szi: "-2", entryPx: "101" },
    ],
    fills: [
      fill({ coin: "dexB:BTC", startPosition: "0", side: "A", sz: "2", px: "101", time: 5, tid: 61 }),
      fill({ coin: "dexA:BTC", startPosition: "0", side: "B", sz: "1", px: "100", time: 4, tid: 62 }),
    ],
  }));
  assert.equal(plan.episodes.length, 2);
  assert.deepEqual(plan.replay.map((step) => step.coin), ["DEXA:BTC", "DEXB:BTC"]);
  assert.deepEqual(plan.replay.map((step) => step.time), [4, 5]);
});

test("fails closed for invalid numbers and an invalid fixed bootstrap scale", () => {
  const invalidFill = planOpenEpisodeReplay(request({
    fills: [fill({ coin: "BTC", startPosition: "0", side: "B", sz: "2", px: "NaN", time: 1, tid: 71 })],
  }));
  assert.equal(invalidFill.blocked[0]?.reason, "INVALID_FILL");

  const invalidScale = planOpenEpisodeReplay(request({ sourceTotalEquityUsd: 0 }));
  assert.equal(invalidScale.blocked[0]?.reason, "INVALID_BOOTSTRAP_SCALE");
});
