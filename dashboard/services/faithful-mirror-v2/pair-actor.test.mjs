import test from "node:test";
import assert from "node:assert/strict";
import { FaithfulPairActor } from "./pair-actor.mjs";

const source = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";

const sourceSnapshot = (size = 1, leverage = { type: "cross", value: 10 }) => ({
  accountEquityUsd: 100_000,
  marginPools: { default: { equityUsd: 100_000 } },
  positions: size === 0 ? [] : [{
    coin: "BTC",
    signedSize: size,
    markPriceUsd: 100_000,
    positionValueUsd: Math.abs(size) * 100_000,
    leverage,
    poolId: "default",
    ...(leverage.type === "isolated" ? { marginUsedUsd: 20_000 } : {}),
  }],
});

const targetSnapshot = (positions = [], accountEquityUsd = 100) => ({
  accountEquityUsd,
  marginPools: { default: { equityUsd: accountEquityUsd } },
  positions,
});

class FakeExecutionPort {
  constructor({ holdFirstIoc = false, fillIoc = true } = {}) {
    this.holdFirstIoc = holdFirstIoc;
    this.fillIoc = fillIoc;
    this.calls = [];
    this.firstIocResolver = null;
    this.killCalls = [];
    this.failureCalls = [];
  }

  async registerPair(request) { this.calls.push({ type: "REGISTER", request }); return { accepted: true }; }
  async setLeverage(request) { this.calls.push({ type: "LEVERAGE", request }); return { accepted: true }; }
  async upsertOrder(request) { this.calls.push({ type: "UPSERT", request }); return { accepted: true, status: "OPEN" }; }
  async cancelOrder(request) { this.calls.push({ type: "CANCEL", request }); return { accepted: true }; }
  async adjustIsolatedMargin(request) { this.calls.push({ type: "ISOLATED_MARGIN", request }); return { accepted: true, marginUsedUsd: request.targetMarginUsd }; }
  async onPairFailure(request) { this.failureCalls.push(request); }
  async killPair(request) { this.killCalls.push(request); }
  protectedIoc(request) {
    this.calls.push({ type: "IOC", request });
    if (this.holdFirstIoc && !this.firstIocResolver) return new Promise((resolve) => { this.firstIocResolver = resolve; });
    return Promise.resolve({
      accepted: this.fillIoc,
      actualSignedSize: this.fillIoc ? request.desiredSignedSize : request.actualSignedSize,
      filledSize: this.fillIoc ? Math.abs(request.deltaSize) : 0,
      unfilledSize: this.fillIoc ? 0 : Math.abs(request.deltaSize),
    });
  }
  resolveFirstIoc() { this.firstIocResolver?.({ accepted: true, actualSignedSize: 0.001, filledSize: 0.001, unfilledSize: 0 }); }
  byType(type) { return this.calls.filter((call) => call.type === type); }
}

test("bootstrap copies current exposure at current book price", async () => {
  const venue = new FakeExecutionPort();
  const actor = new FaithfulPairActor({ pairId: "p1", sourceAddress: source, targetAddress: target, execution: venue });
  await actor.bootstrap({ sourceSnapshot: sourceSnapshot(1), targetSnapshot: targetSnapshot(), sourceOpenOrders: [], currentMarks: { BTC: 95_000 } });
  const position = actor.snapshot().targetSnapshot.positions[0];
  assert.equal(position.signedSize, 0.001);
  assert.equal(position.markPriceUsd, 95_000);
  assert.equal(venue.byType("IOC")[0].request.markPriceUsd, 95_000);
  actor.stop();
});

test("every source fill triggers immediate target reconciliation without fixed debounce", async () => {
  const venue = new FakeExecutionPort();
  const actor = new FaithfulPairActor({ pairId: "p1", sourceAddress: source, targetAddress: target, execution: venue });
  await actor.bootstrap({ sourceSnapshot: sourceSnapshot(1), targetSnapshot: targetSnapshot(), sourceOpenOrders: [] });
  const before = venue.byType("IOC").length;
  actor.onSourceFill({ coin: "BTC", startPosition: 1, side: "B", size: 0.2, price: 100_000, leverage: { type: "cross", value: 10 } });
  await actor.whenIdle();
  const afterEvents = venue.byType("IOC");
  assert.equal(afterEvents.length, before + 1);
  assert.ok(Math.abs(actor.snapshot().targetSnapshot.positions[0].signedSize - 0.0012) < 1e-10);
  actor.stop();
});

test("existing and new source orders are shadowed with scaled quantities", async () => {
  const venue = new FakeExecutionPort();
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
  const shadow = venue.byType("UPSERT")[0].request;
  assert.ok(shadow);
  assert.ok(Math.abs(shadow.order.quantity - 0.0001) < 1e-12);
  actor.stop();
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
  const venue = new FakeExecutionPort();
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

test("source partial and full fills alter shadow lifecycle before their IOC catch-up", async () => {
  const venue = new FakeExecutionPort();
  const actor = new FaithfulPairActor({ pairId: "p1", sourceAddress: source, targetAddress: target, execution: venue });
  await actor.bootstrap({
    sourceSnapshot: sourceSnapshot(1),
    targetSnapshot: targetSnapshot(),
    sourceOpenOrders: [{ id: "o1", coin: "BTC", side: "B", price: 100_000, remainingSize: 0.1, tif: "GTC", leverage: { type: "cross", value: 10 } }],
  });
  venue.calls.length = 0;
  actor.onSourceFill({ coin: "BTC", startPosition: 1, side: "B", size: 0.05, price: 100_000, sourceOrderId: "o1", leverage: { type: "cross", value: 10 } });
  await actor.whenIdle();
  const partialUpsert = venue.calls.findIndex((call) => call.type === "UPSERT");
  const partialIoc = venue.calls.findIndex((call) => call.type === "IOC");
  assert.ok(partialUpsert >= 0 && partialUpsert < partialIoc);
  assert.equal(venue.calls[partialUpsert].request.order.quantity, 0.00005);

  venue.calls.length = 0;
  actor.onSourceFill({ coin: "BTC", startPosition: 1.05, side: "B", size: 0.05, price: 100_000, sourceOrderId: "o1", leverage: { type: "cross", value: 10 } });
  await actor.whenIdle();
  const fullCancel = venue.calls.findIndex((call) => call.type === "CANCEL");
  const fullIoc = venue.calls.findIndex((call) => call.type === "IOC");
  assert.ok(fullCancel >= 0 && fullCancel < fullIoc);
  actor.stop();
});

test("target fills and snapshots are authoritative and reversal then flat is reduce-only", async () => {
  const venue = new FakeExecutionPort();
  const actor = new FaithfulPairActor({ pairId: "p1", sourceAddress: source, targetAddress: target, execution: venue });
  await actor.bootstrap({ sourceSnapshot: sourceSnapshot(1), targetSnapshot: targetSnapshot(), sourceOpenOrders: [] });
  venue.calls.length = 0;
  actor.onTargetFill({ coin: "BTC", startPosition: 0.001, side: "A", size: 0.0006, price: 100_000, leverage: { type: "cross", value: 10 } });
  await actor.whenIdle();
  assert.equal(venue.byType("IOC")[0].request.deltaSize, 0.0006);

  venue.calls.length = 0;
  actor.onTargetSnapshot(targetSnapshot([{ coin: "BTC", signedSize: 0.0002, markPriceUsd: 100_000, positionValueUsd: 20, leverage: { type: "cross", value: 10 } }]));
  await actor.whenIdle();
  assert.equal(venue.byType("IOC")[0].request.deltaSize, 0.0008);

  venue.calls.length = 0;
  actor.onSourceFill({ coin: "BTC", startPosition: 1, side: "A", size: 2, price: 100_000, leverage: { type: "cross", value: 10 } });
  await actor.whenIdle();
  assert.equal(venue.byType("IOC")[0].request.deltaSize, -0.002);
  assert.equal(venue.byType("IOC")[0].request.reduceOnly, false);

  venue.calls.length = 0;
  actor.onSourceFill({ coin: "BTC", startPosition: -1, side: "B", size: 1, price: 100_000, leverage: { type: "cross", value: 10 } });
  await actor.whenIdle();
  assert.equal(venue.byType("IOC")[0].request.deltaSize, 0.001);
  assert.equal(venue.byType("IOC")[0].request.reduceOnly, true);
  actor.stop();
});

test("minimum-size gaps remain as tracking debt until a later state can reconcile them", async () => {
  const venue = new FakeExecutionPort();
  const actor = new FaithfulPairActor({
    pairId: "p1",
    sourceAddress: source,
    targetAddress: target,
    execution: venue,
    config: { minimumOrderNotionalUsd: 10, immediateResidualNotionalUsd: 10 },
  });
  await actor.bootstrap({
    sourceSnapshot: sourceSnapshot(0),
    targetSnapshot: targetSnapshot(),
    sourceOpenOrders: [{ id: "small", coin: "BTC", side: "B", price: 100_000, remainingSize: 0.05, tif: "GTC", leverage: { type: "cross", value: 10 } }],
  });
  assert.equal(actor.snapshot().trackingDebt.orders.length, 1);
  actor.onSourceSnapshot(sourceSnapshot(0.0005));
  await actor.whenIdle();
  assert.equal(actor.snapshot().trackingDebt.positions.length, 1);
  actor.stop();
});

test("tracking-debt audit records only material transitions while keeping the current debt snapshot fresh", async () => {
  const venue = new FakeExecutionPort();
  const events = [];
  let clock = 0;
  const actor = new FaithfulPairActor({
    pairId: "p1",
    sourceAddress: source,
    targetAddress: target,
    execution: venue,
    now: () => ++clock,
    log: (event) => events.push(event),
    config: { minimumOrderNotionalUsd: 10 },
  });
  const order = (remainingSize) => ({ id: "small", coin: "BTC", side: "B", price: 100_000, remainingSize, tif: "GTC", leverage: { type: "cross", value: 10 } });
  await actor.bootstrap({ sourceSnapshot: sourceSnapshot(0), targetSnapshot: targetSnapshot(), sourceOpenOrders: [order(0.05)] });
  const debtEvents = () => events.filter((event) => event.type === "TRACKING_DEBT" || event.type === "TRACKING_DEBT_CLEARED");
  assert.deepEqual(debtEvents().map((event) => event.type), ["TRACKING_DEBT"]);
  const firstAt = actor.snapshot().trackingDebt.orders[0].at;

  for (let index = 0; index < 105; index += 1) {
    actor.onCurrentMark("BTC", 100_000);
    await actor.whenIdle();
  }
  assert.deepEqual(debtEvents().map((event) => event.type), ["TRACKING_DEBT"]);
  assert.ok(actor.snapshot().trackingDebt.orders[0].at > firstAt);

  // A follower-equity change re-scales the stored target remainder, but the
  // source order itself did not change so it must not create audit churn.
  actor.onTargetSnapshot(targetSnapshot([], 101));
  await actor.whenIdle();
  assert.deepEqual(debtEvents().map((event) => event.type), ["TRACKING_DEBT"]);
  assert.ok(actor.snapshot().trackingDebt.orders[0].targetUnroundedRemainingSize > 0.00005);

  await actor.onSourceOrder({ status: "OPEN", order: order(0.06) });
  assert.deepEqual(debtEvents().map((event) => event.type), ["TRACKING_DEBT", "TRACKING_DEBT"]);
  assert.ok(actor.snapshot().trackingDebt.orders[0].targetUnroundedRemainingSize > 0.00005);

  await actor.onSourceOrder({ status: "OPEN", order: order(0.2) });
  assert.deepEqual(debtEvents().map((event) => event.type), ["TRACKING_DEBT", "TRACKING_DEBT", "TRACKING_DEBT_CLEARED"]);
  assert.equal(actor.snapshot().trackingDebt.orders.length, 0);

  await actor.onSourceOrder({ status: "OPEN", order: order(0.05) });
  assert.deepEqual(debtEvents().map((event) => event.type), ["TRACKING_DEBT", "TRACKING_DEBT", "TRACKING_DEBT_CLEARED", "TRACKING_DEBT"]);
  assert.equal(events.filter((event) => event.type === "SOURCE_ORDER").length, 3);
  actor.stop();
});

test("position tracking debt records only lifecycle despite residual size and sign oscillation", async () => {
  const venue = new FakeExecutionPort();
  const events = [];
  const actor = new FaithfulPairActor({
    pairId: "p1",
    sourceAddress: source,
    targetAddress: target,
    execution: venue,
    log: (event) => events.push(event),
    config: { immediateResidualNotionalUsd: 10 },
  });
  const debtEvents = () => events.filter((event) => event.type === "TRACKING_DEBT" || event.type === "TRACKING_DEBT_CLEARED");
  // At a 1:1000 follower-equity ratio and 100,000 mark, source .001 is a
  // $0.10 target residual and .099 is $9.90. Both remain below the $10
  // catch-up threshold, but their sign and size can legitimately oscillate.
  await actor.bootstrap({ sourceSnapshot: sourceSnapshot(0.001), targetSnapshot: targetSnapshot(), sourceOpenOrders: [] });
  assert.deepEqual(debtEvents().map((event) => event.type), ["TRACKING_DEBT"]);
  for (let index = 0; index < 100; index += 1) {
    const sourceSize = index % 2 === 0 ? -0.099 : 0.001;
    actor.onSourceSnapshot(sourceSnapshot(sourceSize));
    await actor.whenIdle();
  }
  assert.deepEqual(debtEvents().map((event) => event.type), ["TRACKING_DEBT"]);
  assert.ok(actor.snapshot().trackingDebt.positions[0].notionalUsd <= 9.9);

  // A residual over the threshold follows catch-up and resolves the debt.
  actor.onSourceSnapshot(sourceSnapshot(0.2));
  await actor.whenIdle();
  assert.deepEqual(debtEvents().map((event) => event.type), ["TRACKING_DEBT", "TRACKING_DEBT_CLEARED"]);
  assert.equal(actor.snapshot().trackingDebt.positions.length, 0);

  // First mirror the source flat state so the fake IOC's local target is
  // neutralized. An authoritative flat target plus a later sub-threshold
  // residual then recreates the lifecycle debt exactly once.
  actor.onSourceSnapshot(sourceSnapshot(0));
  await actor.whenIdle();
  actor.onTargetSnapshot(targetSnapshot());
  await actor.whenIdle();
  actor.onSourceSnapshot(sourceSnapshot(0.001));
  await actor.whenIdle();
  assert.deepEqual(debtEvents().map((event) => event.type), ["TRACKING_DEBT", "TRACKING_DEBT_CLEARED", "TRACKING_DEBT"]);
  actor.stop();
});

test("isolated-data failure blocks only its pair while an independent pair stays runnable", async () => {
  const badVenue = new FakeExecutionPort();
  const goodVenue = new FakeExecutionPort();
  const bad = new FaithfulPairActor({ pairId: "bad", sourceAddress: source, targetAddress: target, execution: badVenue });
  const good = new FaithfulPairActor({ pairId: "good", sourceAddress: "0x3333333333333333333333333333333333333333", targetAddress: "0x4444444444444444444444444444444444444444", execution: goodVenue });
  const badSource = sourceSnapshot(1, { type: "isolated", value: 5 });
  delete badSource.positions[0].marginUsedUsd;
  await bad.bootstrap({ sourceSnapshot: badSource, targetSnapshot: targetSnapshot(), sourceOpenOrders: [] });
  await good.bootstrap({ sourceSnapshot: sourceSnapshot(1), targetSnapshot: targetSnapshot(), sourceOpenOrders: [] });
  assert.equal(bad.snapshot().state, "PAIR_RECOVERY_BLOCKED");
  assert.equal(badVenue.failureCalls.length, 1);
  assert.equal(good.snapshot().state, "RUNNING");
  good.stop();
});

test("the 250ms and terminal checks run once and kill an unresolved pair without timer recursion", async () => {
  const venue = new FakeExecutionPort({ fillIoc: false });
  const actor = new FaithfulPairActor({
    pairId: "p1",
    sourceAddress: source,
    targetAddress: target,
    execution: venue,
    config: { verificationDelayMs: 2, terminalVerificationDelayMs: 8, targetPositionToleranceBps: 1 },
  });
  await actor.bootstrap({ sourceSnapshot: sourceSnapshot(1), targetSnapshot: targetSnapshot(), sourceOpenOrders: [] });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const state = actor.snapshot();
  assert.equal(state.state, "KILLED");
  assert.equal(state.stats.verification250ms, 1);
  assert.equal(state.stats.verification1000ms, 1);
  assert.equal(venue.killCalls.length, 1);
});
