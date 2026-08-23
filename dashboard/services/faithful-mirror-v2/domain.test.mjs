import test from "node:test";
import assert from "node:assert/strict";
import {
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

test("standard margin pools fail closed when the target DEX pool is unfunded or missing", () => {
  const sourcePosition = {
    coin: "xyz:SKHX",
    signedSize: 1,
    markPriceUsd: 100,
    positionValueUsd: 100,
    leverage: { type: "cross", value: 5 },
    poolId: "xyz",
  };
  assert.throws(() => targetPositionFromSource({
    sourcePosition,
    sourceSnapshot: { accountEquityUsd: 1000, marginPools: { xyz: { equityUsd: 1000 } }, positions: [sourcePosition] },
    targetSnapshot: { accountEquityUsd: 100, marginPools: { main: { equityUsd: 100 } }, positions: [] },
  }), /margin pool xyz is missing/);
});
