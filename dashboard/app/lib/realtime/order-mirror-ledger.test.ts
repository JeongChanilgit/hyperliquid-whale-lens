import assert from "node:assert/strict";
import test from "node:test";
import { CopyOrderMirrorLedger } from "./order-mirror-ledger";
import type { HyperliquidRealtimeOrderUpdate } from "../copy-types";

const whale = "0x1111111111111111111111111111111111111111";
const update = (status: string, remaining: number, price = 100, original = 10): HyperliquidRealtimeOrderUpdate => ({
  status,
  statusTimestamp: Date.now() + remaining,
  metadataComplete: true,
  order: {
    coin: "BTC",
    side: "B",
    limitPx: String(price),
    sz: String(remaining),
    origSz: String(original),
    oid: 7,
    timestamp: 1,
    reduceOnly: false,
    orderType: "Limit",
    tif: "Gtc",
  },
});

test("mirrors place, partial fill, modify, and cancel at the account-balance ratio", () => {
  const ledger = new CopyOrderMirrorLedger();
  const sizing = { sourceAccountValueUsd: 10_000, followerAccountValueUsd: 1_000, maxLeverage: 20 };
  const placed = ledger.apply(whale, update("open", 10), sizing);
  assert.equal(placed.action, "PLACED");
  assert.equal(placed.order.followerOriginalQuantity, 1);
  assert.equal(placed.order.followerRemainingQuantity, 1);

  const partial = ledger.apply(whale, update("open", 6), sizing);
  assert.equal(partial.action, "PARTIALLY_FILLED");
  assert.equal(partial.order.followerFilledQuantity, 0.4);

  const modified = ledger.apply(whale, update("open", 6, 101), sizing);
  assert.equal(modified.action, "MODIFIED");
  const canceled = ledger.apply(whale, update("canceled", 6, 101), sizing);
  assert.equal(canceled.action, "CANCELED");
  assert.equal(canceled.order.followerRemainingQuantity, 0);
});

test("caps a mirrored resting order at follower max leverage", () => {
  const ledger = new CopyOrderMirrorLedger();
  const placed = ledger.apply(whale, update("open", 100, 1_000, 100), {
    sourceAccountValueUsd: 1_000,
    followerAccountValueUsd: 1_000,
    maxLeverage: 20,
  });
  assert.equal(placed.order.leverageCapped, true);
  assert.equal(placed.order.followerOriginalQuantity, 20);
});

test("mirrors zero-size position TP/SL as a close-all order", () => {
  const ledger = new CopyOrderMirrorLedger();
  const stop = update("open", 0, 74, 0);
  stop.order.reduceOnly = true;
  stop.order.isPositionTpsl = true;
  stop.order.isTrigger = true;
  stop.order.orderType = "Stop Market";
  const mirrored = ledger.apply(whale, stop, {
    sourceAccountValueUsd: 10_000,
    followerAccountValueUsd: 1_000,
    followerPositionQuantity: 0.25,
  });
  assert.equal(mirrored.order.closeAll, true);
  assert.equal(mirrored.order.followerOriginalQuantity, 0.25);
  assert.equal(mirrored.order.followerRemainingQuantity, 0.25);
});

test("records the source lifecycle but fails closed when equity sizing is unavailable", () => {
  const ledger = new CopyOrderMirrorLedger();
  const sourceUpdate = update("open", 10);
  const ignored = ledger.apply(whale, sourceUpdate);
  assert.equal(ignored.copied, false);
  assert.equal(ignored.ignoredReason, "SIZING_DATA_UNAVAILABLE");
  assert.equal(ignored.order.status, "OPEN");
  const retried = ledger.apply(whale, sourceUpdate, { sourceAccountValueUsd: 10_000, followerAccountValueUsd: 1_000 });
  assert.equal(retried.copied, true);
  assert.equal(retried.order.followerOriginalQuantity, 1);
});

test("keeps a startup snapshot idempotent by source OID and tracks its later lifecycle", () => {
  const ledger = new CopyOrderMirrorLedger();
  const sizing = { sourceAccountValueUsd: 10_000, followerAccountValueUsd: 1_000 };
  const startup = { ...update("open", 10), statusTimestamp: 1, isSnapshot: true };

  const placed = ledger.apply(whale, startup, sizing);
  const replayed = ledger.apply(whale, startup, sizing);
  assert.equal(placed.action, "PLACED");
  assert.equal(placed.order.startupSnapshot, true);
  assert.equal(replayed.action, "IGNORED");
  assert.equal(replayed.ignoredReason, "DUPLICATE");
  assert.equal(replayed.order.id, placed.order.id);

  const modified = ledger.apply(whale, {
    ...startup,
    statusTimestamp: 2,
    order: { ...startup.order, limitPx: "101" },
  }, sizing);
  const canceled = ledger.apply(whale, {
    ...startup,
    status: "canceled",
    statusTimestamp: 3,
    isSnapshot: false,
    order: { ...startup.order, limitPx: "101" },
  }, sizing);
  assert.equal(modified.action, "MODIFIED");
  assert.equal(modified.order.id, placed.order.id);
  assert.equal(canceled.action, "CANCELED");
  assert.equal(canceled.order.id, placed.order.id);
  assert.equal(canceled.order.followerRemainingQuantity, 0);
});
