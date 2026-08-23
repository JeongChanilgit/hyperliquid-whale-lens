import test from "node:test";
import assert from "node:assert/strict";
import { FaithfulPairActor } from "./pair-actor.mjs";
import { PaperExecutionPort } from "./paper-venue.mjs";
import { FiveWhaleFaithfulMirrorEngine } from "./engine.mjs";

const source = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";

const sourceSnapshot = (size = 1) => ({
  accountEquityUsd: 100_000,
  marginPools: { default: { equityUsd: 100_000 } },
  positions: size === 0 ? [] : [{
    coin: "BTC",
    signedSize: size,
    markPriceUsd: 100_000,
    positionValueUsd: Math.abs(size) * 100_000,
    leverage: { type: "cross", value: 10 },
    poolId: "default",
  }],
});

const targetSnapshot = () => ({
  accountEquityUsd: 100,
  marginPools: { default: { equityUsd: 100 } },
  positions: [],
});

test("bootstrap copies current exposure at current book price", async () => {
  const venue = new PaperExecutionPort();
  venue.registerPair("p1", targetSnapshot());
  venue.setBook("BTC", { asks: [[100_000, 1]], bids: [[99_999, 1]] });
  const actor = new FaithfulPairActor({ pairId: "p1", sourceAddress: source, targetAddress: target, execution: venue });
  await actor.bootstrap({ sourceSnapshot: sourceSnapshot(1), targetSnapshot: targetSnapshot(), sourceOpenOrders: [] });
  const position = venue.getSnapshot("p1").positions[0];
  assert.equal(position.signedSize, 0.001);
  assert.equal(position.markPriceUsd, 100_000);
  actor.stop();
});

test("every source fill triggers immediate target reconciliation without fixed debounce", async () => {
  const venue = new PaperExecutionPort();
  venue.registerPair("p1", targetSnapshot());
  venue.setBook("BTC", { asks: [[100_000, 10]], bids: [[99_999, 10]] });
  const actor = new FaithfulPairActor({ pairId: "p1", sourceAddress: source, targetAddress: target, execution: venue });
  await actor.bootstrap({ sourceSnapshot: sourceSnapshot(1), targetSnapshot: targetSnapshot(), sourceOpenOrders: [] });
  const before = venue.getEvents().filter((event) => event.type === "PROTECTED_IOC").length;
  actor.onSourceFill({ coin: "BTC", startPosition: 1, side: "B", size: 0.2, price: 100_000, leverage: { type: "cross", value: 10 } });
  await actor.whenIdle();
  const afterEvents = venue.getEvents().filter((event) => event.type === "PROTECTED_IOC");
  assert.equal(afterEvents.length, before + 1);
  assert.ok(Math.abs(venue.getSnapshot("p1").positions[0].signedSize - 0.00119946) < 1e-10);
  actor.stop();
});

test("existing and new source orders are shadowed with scaled quantities", async () => {
  const venue = new PaperExecutionPort();
  venue.registerPair("p1", targetSnapshot());
  venue.setBook("BTC", { asks: [[101_000, 10]], bids: [[99_000, 10]] });
  const actor = new FaithfulPairActor({ pairId: "p1", sourceAddress: source, targetAddress: target, execution: venue });
  await actor.bootstrap({
    sourceSnapshot: sourceSnapshot(1),
    targetSnapshot: targetSnapshot(),
    sourceOpenOrders: [{
      id: "source-order-1",
      coin: "BTC",
      side: "B",
      price: 99_000,
      remainingSize: 0.1,
      tif: "GTC",
      reduceOnly: false,
      leverage: { type: "cross", value: 10 },
    }],
  });
  const shadow = venue.getEvents().find((event) => event.type === "PLACE_ORDER");
  assert.ok(shadow);
  assert.equal(shadow.order.remainingSize, 0.0001);
  actor.stop();
});

test("engine enforces at most five independent source-target pairs", () => {
  const address = (prefix) => `0x${prefix.repeat(40)}`;
  assert.throws(() => new FiveWhaleFaithfulMirrorEngine({
    pairs: Array.from({ length: 6 }, (_, index) => ({ pairId: `p${index}`, sourceAddress: address(String(index + 1)), targetAddress: address(String(index + 7)) })),
    executionFactory: () => new PaperExecutionPort(),
  }), /1-5/);
});

test("flat-coin source order is mirrored without an existing position and unchanged reconciles preserve queue", async () => {
  const venue = new PaperExecutionPort();
  venue.setBook("ETH", { asks: [[2_100, 10]], bids: [[2_000, 10]] });
  const actor = new FaithfulPairActor({ pairId: "p-flat", sourceAddress: source, targetAddress: target, execution: venue });
  await actor.bootstrap({
    sourceSnapshot: sourceSnapshot(0),
    targetSnapshot: targetSnapshot(),
    sourceOpenOrders: [{
      id: "flat-order",
      coin: "ETH",
      side: "B",
      price: 2_000,
      remainingSize: 5,
      tif: "GTC",
      reduceOnly: false,
      leverage: { type: "cross", value: 5 },
    }],
  });
  const firstCount = venue.getEvents().filter((event) => event.type === "PLACE_ORDER" || event.type === "MODIFY_ORDER").length;
  actor.onSourceSnapshot(sourceSnapshot(0));
  await actor.whenIdle();
  const secondCount = venue.getEvents().filter((event) => event.type === "PLACE_ORDER" || event.type === "MODIFY_ORDER").length;
  assert.equal(firstCount, 1);
  assert.equal(secondCount, 1);
  actor.stop();
});

test("source partial fill resizes the shadow remainder before immediate IOC catch-up", async () => {
  const venue = new PaperExecutionPort();
  venue.setBook("BTC", { asks: [[100_000, 10]], bids: [[99_000, 10]] });
  const actor = new FaithfulPairActor({ pairId: "p-order-fill", sourceAddress: source, targetAddress: target, execution: venue });
  await actor.bootstrap({
    sourceSnapshot: sourceSnapshot(1),
    targetSnapshot: targetSnapshot(),
    sourceOpenOrders: [{
      id: "source-partial",
      coin: "BTC",
      side: "B",
      price: 99_000,
      remainingSize: 0.2,
      tif: "GTC",
      reduceOnly: false,
      leverage: { type: "cross", value: 10 },
    }],
  });
  const baseline = venue.getEvents().length;
  actor.onSourceFill({
    coin: "BTC",
    startPosition: 1,
    side: "B",
    size: 0.1,
    price: 100_000,
    sourceOrderId: "source-partial",
    leverage: { type: "cross", value: 10 },
  });
  await actor.whenIdle();
  const actions = venue.getEvents().slice(baseline).map((event) => event.type);
  const modifyIndex = actions.indexOf("MODIFY_ORDER");
  const iocIndex = actions.indexOf("PROTECTED_IOC");
  assert.ok(modifyIndex >= 0);
  assert.ok(iocIndex > modifyIndex);
  actor.stop();
});

test("target fill startPosition makes committed-response optimism idempotent", async () => {
  const venue = new PaperExecutionPort();
  venue.registerPair("p1", targetSnapshot());
  venue.setBook("BTC", { asks: [[100_000, 10]], bids: [[99_999, 10]] });
  const actor = new FaithfulPairActor({ pairId: "p1", sourceAddress: source, targetAddress: target, execution: venue });
  await actor.bootstrap({ sourceSnapshot: sourceSnapshot(1), targetSnapshot: targetSnapshot(), sourceOpenOrders: [] });
  const before = actor.snapshot().targetSnapshot.positions[0].signedSize;
  actor.onTargetFill({ coin: "BTC", startPosition: before, side: "B", size: 0.0002, price: 100_000 });
  actor.onTargetFill({ coin: "BTC", startPosition: before, side: "B", size: 0.0002, price: 100_000 });
  assert.equal(actor.snapshot().targetSnapshot.positions[0].signedSize, before + 0.0002);
  actor.stop();
});
