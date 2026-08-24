import assert from "node:assert/strict";
import test from "node:test";
import { summarizeFaithfulMirrorPair } from "./FaithfulMirrorDashboard";
import { normalizeFaithfulMirrorSnapshot } from "../hooks/use-faithful-mirror-status";

test("Faithful Mirror pair summary signs absolute short notional, reports gross/effective leverage, and excludes terminal order history", () => {
  const snapshot = normalizeFaithfulMirrorSnapshot({
    connected: true,
    service: {},
    pairs: [{
      pairId: "short-pair",
      source: {
        equityUsd: 20,
        positions: [{ coin: "BTC", signedSize: -2, positionValueUsd: 100 }],
        orders: [{ status: "OPEN" }, { status: "CANCELED" }],
      },
      target: {
        equityUsd: 10,
        positions: [{ coin: "BTC", signedSize: -1, positionValueUsd: 50 }],
        orders: [{ status: "FILLED" }, { status: "OPEN" }, { status: "TERMINAL_OR_MISSING" }],
      },
      trackingDebt: {
        positions: [{ coin: "ETH", signedSize: 1, markPriceUsd: 7 }, { coin: "SOL", signedSize: -2, markPriceUsd: 3 }],
        orders: [{ id: "debt-order" }],
      },
    }],
  });
  const summary = summarizeFaithfulMirrorPair(snapshot.pairs[0]);

  assert.equal(summary.sourceGross, 100);
  assert.equal(summary.sourceNet, -100);
  assert.equal(summary.sourceEffectiveLeverage, 5);
  assert.equal(summary.followerToSourceGrossPct, 50);
  assert.equal(summary.sourceOpenOrderCount, 1);
  assert.equal(summary.followerOpenOrderCount, 1);
  assert.equal(summary.positionDebtCount, 2);
  assert.equal(summary.orderDebtCount, 1);
  assert.equal(summary.positionDebtNotional, 13);
});
