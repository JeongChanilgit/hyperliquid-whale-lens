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
  assert.ok(Math.abs(shadow.order.remainingSize - 0.000099955) < 1e-12);
  actor.stop();
});

test("engine enforces at most five independent source-target pairs", () => {
  const address = (prefix) => `0x${prefix.repeat(40)}`;
  assert.throws(() => new FiveWhaleFaithfulMirrorEngine({
    pairs: Array.from({ length: 6 }, (_, index) => ({ pairId: `p${index}`, sourceAddress: address(String(index + 1)), targetAddress: address(String(index + 7)) })),
    executionFactory: () => new PaperExecutionPort(),
  }), /1-5/);
});

test("an in-flight catch-up coalesces later fills into the latest desired state", async () => {
  let resolveFirst;
  const calls = [];
  const execution = {
    async registerPair() { return { accepted: true }; },
    async setLeverage() { return { accepted: true }; },
    async upsertOrder() { return { accepted: true, status: "OPEN" }; },
    async cancelOrder() { return { accepted: true }; },
    async adjustIsolatedMargin() { return { accepted: true }; },
    protectedIoc(request) {
      calls.push({ ...request });
      if (calls.length === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return Promise.resolve({ accepted: true, actualSignedSize: request.desiredSignedSize, filledSize: Math.abs(request.deltaSize), unfilledSize: 0 });
    },
  };
  const actor = new FaithfulPairActor({ pairId: "p1", sourceAddress: source, targetAddress: target, execution });
  const bootstrap = actor.bootstrap({ sourceSnapshot: sourceSnapshot(1), targetSnapshot: targetSnapshot(), sourceOpenOrders: [] });
  while (!resolveFirst) await new Promise((resolve) => setImmediate(resolve));
  actor.onSourceFill({ coin: "BTC", startPosition: 1, side: "B", size: 0.2, price: 100_000, leverage: { type: "cross", value: 10 } });
  resolveFirst({ accepted: true, actualSignedSize: 0.001, filledSize: 0.001, unfilledSize: 0 });
  await bootstrap;
  await actor.whenIdle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].desiredSignedSize, 0.0012);
  actor.stop();
});

test("target order updates are retained and wake reconciliation", async () => {
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
  const targetOrder = actor.snapshot().targetOrderState[0];
  actor.onTargetOrder({
    sourceOrderId: "source-order-1",
    targetOrderId: targetOrder.targetOrderId,
    coin: "BTC",
    status: "PARTIAL",
    remainingSize: targetOrder.quantity / 2,
  });
  await actor.whenIdle();
  assert.equal(actor.snapshot().targetOrderState[0].status, "PARTIAL");
  assert.equal(actor.snapshot().stats.targetOrderUpdates, 1);
  actor.stop();
});
