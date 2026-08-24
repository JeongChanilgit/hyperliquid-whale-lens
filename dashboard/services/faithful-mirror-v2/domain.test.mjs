import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalTargetCloid,
  MIRROR_FAILURE_CODES,
  marginPoolEquityUsd,
  normalizeCoin,
  reconciliationDelta,
  scaleSourceOrder,
  sourcePositionAfterFill,
  targetPositionFromSource,
} from "./domain.mjs";

const snapshot = (equity, positions = []) => ({
  accountEquityUsd: equity,
  marginPools: { default: { equityUsd: equity } },
  positions,
});

test("cross position copies economic exposure and leverage without multiplying leverage twice", () => {
  const sourcePosition = {
    coin: "BTC",
    signedSize: 5,
    markPriceUsd: 100_000,
    positionValueUsd: 500_000,
    leverage: { type: "cross", value: 10 },
    poolId: "default",
  };
  const desired = targetPositionFromSource({
    sourcePosition,
    sourceSnapshot: snapshot(100_000, [sourcePosition]),
    targetSnapshot: snapshot(100),
  });
  assert.equal(desired.exposureRatio, 5);
  assert.equal(desired.targetSignedNotionalUsd, 500);
  assert.equal(desired.targetSignedSize, 0.005);
  assert.deepEqual(desired.leverage, { type: "cross", value: 10 });
});

test("short cross exposure remains negative and does not apply leverage twice", () => {
  const sourcePosition = {
    coin: "ETH",
    signedSize: -4,
    markPriceUsd: 2_500,
    positionValueUsd: 10_000,
    leverage: { type: "cross", value: 20 },
  };
  const desired = targetPositionFromSource({
    sourcePosition,
    sourceSnapshot: snapshot(2_000),
    targetSnapshot: snapshot(100),
  });
  assert.equal(desired.targetSignedNotionalUsd, -500);
  assert.equal(desired.targetSignedSize, -0.2);
  assert.equal(desired.leverage.value, 20);
});

test("isolated position copies notional and actual margin ratio", () => {
  const sourcePosition = {
    coin: "SOL",
    signedSize: 2_000,
    markPriceUsd: 100,
    positionValueUsd: 200_000,
    leverage: { type: "isolated", value: 10 },
    marginUsedUsd: 40_000,
    poolId: "default",
  };
  const desired = targetPositionFromSource({
    sourcePosition,
    sourceSnapshot: snapshot(100_000, [sourcePosition]),
    targetSnapshot: snapshot(100),
  });
  assert.equal(desired.targetSignedNotionalUsd, 200);
  assert.equal(desired.targetSignedSize, 2);
  assert.equal(desired.isolatedMarginRatio, 0.2);
  assert.equal(desired.targetIsolatedMarginUsd, 40);
});

test("isolated position without observed margin fails closed", () => {
  const sourcePosition = {
    coin: "SOL",
    signedSize: 2,
    markPriceUsd: 100,
    positionValueUsd: 200,
    leverage: { type: "isolated", value: 5 },
  };
  assert.throws(
    () => targetPositionFromSource({ sourcePosition, sourceSnapshot: snapshot(1_000), targetSnapshot: snapshot(100) }),
    (error) => error.code === MIRROR_FAILURE_CODES.ISOLATED_MARGIN_DATA_UNAVAILABLE,
  );
});

test("a missing non-default margin pool fails closed instead of falling back to account equity", () => {
  assert.throws(
    () => marginPoolEquityUsd(snapshot(100), "cross-main"),
    (error) => error.code === MIRROR_FAILURE_CODES.MARGIN_POOL_DATA_UNAVAILABLE,
  );
});

test("source fill immediately determines post-fill signed position", () => {
  assert.equal(sourcePositionAfterFill({ startPosition: 10, side: "A", size: 3 }), 7);
  assert.equal(sourcePositionAfterFill({ startPosition: -2, side: "B", size: 5 }), 3);
});

test("reduce-only source order is capped by target position", () => {
  const order = scaleSourceOrder({
    sourceOrder: {
      id: "1",
      coin: "ETH",
      side: "A",
      price: 2_000,
      remainingSize: 10,
      reduceOnly: true,
      leverage: { type: "cross", value: 5 },
    },
    sourceSnapshot: snapshot(1_000),
    targetSnapshot: snapshot(100),
    targetPositionSize: 0.25,
  });
  assert.equal(order.targetRemainingSize, 0.25);
  assert.deepEqual(order.leverage, { type: "cross", value: 5 });
});

test("reduce-only order cannot increase or reverse the target position", () => {
  const order = scaleSourceOrder({
    sourceOrder: {
      id: "bad-reduce",
      coin: "ETH",
      side: "B",
      price: 2_000,
      remainingSize: 10,
      reduceOnly: true,
      leverage: { type: "cross", value: 5 },
    },
    sourceSnapshot: snapshot(1_000),
    targetSnapshot: snapshot(100),
    targetPositionSize: 0.25,
  });
  assert.equal(order.targetRemainingSize, 0);
});

test("sub-minimum shadow order carries its scaled amount as tracking debt input", () => {
  const order = scaleSourceOrder({
    sourceOrder: {
      id: "small",
      coin: "ETH",
      side: "B",
      price: 2_000,
      remainingSize: 0.1,
      reduceOnly: false,
      leverage: { type: "cross", value: 5 },
    },
    sourceSnapshot: snapshot(10_000),
    targetSnapshot: snapshot(10),
    minNotionalUsd: 1,
  });
  assert.equal(order.targetUnroundedRemainingSize, 0.0001);
  assert.equal(order.targetRemainingSize, 0);
  assert.equal(order.belowMinimum, true);
});

test("HIP-3 coin normalization is stable", () => {
  assert.equal(normalizeCoin("xyz:eth"), "xyz:ETH");
  assert.equal(normalizeCoin("ETH"), "ETH");
});

test("canonical Cloid is deterministic, pair-isolated, and exactly 128-bit lowercase hex", () => {
  const first = canonicalTargetCloid("pair-a", "source-order-42");
  assert.match(first, /^0x[a-f0-9]{32}$/);
  assert.equal(first, canonicalTargetCloid("pair-a", "source-order-42"));
  assert.notEqual(first, canonicalTargetCloid("pair-b", "source-order-42"));
  assert.notEqual(first, canonicalTargetCloid("pair-a", "source-order-43"));
});

test("reconciliation uses target minus actual and respects minimum notional", () => {
  assert.deepEqual(
    reconciliationDelta({ desiredSize: 2, actualSize: 1.5, markPriceUsd: 100, minNotionalUsd: 10 }),
    {
      targetSize: 2,
      actualSize: 1.5,
      deltaSize: 0.5,
      rawDeltaSize: 0.5,
      notionalUsd: 50,
      tradeable: true,
    },
  );
  assert.equal(reconciliationDelta({ desiredSize: 1.01, actualSize: 1, markPriceUsd: 100, minNotionalUsd: 10 }).tradeable, false);
});
