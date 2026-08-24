import test from "node:test";
import assert from "node:assert/strict";
import { createPaperMirrorSystem, PaperSourceRuntime } from "./paper-runtime.mjs";
import { canonicalTargetCloid } from "./domain.mjs";

const source = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";

class AsyncSocket {
  static instances = [];
  constructor() {
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    AsyncSocket.instances.push(this);
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  async emitAsync(type, event) { for (const listener of this.listeners.get(type) ?? []) await listener(event); }
  async openAsync() { this.readyState = 1; await this.emitAsync("open", {}); }
  close() { this.readyState = 3; void this.emitAsync("close", {}); }
}

test("paper system creates independent virtual targets and enforces five-whale cap", () => {
  const infoClient = {};
  const system = createPaperMirrorSystem({ pairs: [{ pairId: "a", sourceAddress: source, capitalUsd: 100 }], infoClient, WebSocketImpl: class {} });
  assert.equal(system.pairs.length, 1);
  assert.match(system.pairs[0].targetAddress, /^0x[a-f0-9]{40}$/);
  assert.equal(system.venues.size, 1);
  assert.throws(() => createPaperMirrorSystem({
    pairs: Array.from({ length: 6 }, (_, index) => ({ sourceAddress: `0x${String(index + 1).repeat(40)}`, capitalUsd: 100 })),
    infoClient,
    WebSocketImpl: class {},
  }), /1-5/);
});

test("paper runtime exports nonzero source and simulated-target cursors/IDs for audit recovery", async () => {
  AsyncSocket.instances = [];
  const fillTime = Date.now();
  const calls = [];
  const engine = {
    bootstrapPair: async () => {},
    whenIdle: async () => {},
    onSourceSnapshot: () => {},
    onSourceFill: () => {},
    onSourceOrder: async () => {},
    onTargetFill: () => {},
    onTargetSnapshot: () => {},
    onCurrentMark: () => {},
    syncSourceOrders: async () => {},
    stop: () => {},
    snapshot: () => ({ pairs: { paper: { targetOrderState: [{ sourceOrderId: "source-order", targetOrderId: canonicalTargetCloid("paper", "source-order") }], targetSnapshot: { receivedAt: 77 }, killed: false, blocked: false } } }),
  };
  const venue = {
    hasPair: () => true,
    setBook: () => {},
    getSnapshot: () => ({ positions: [] }),
    applyPublicTrade: () => [{ coin: "BTC", side: "B", size: 0.2, price: 100, positionAfter: 0.2, targetOrderId: "fmv2-paper-order" }],
  };
  const info = {
    accountMode: async () => "STANDARD",
    allDexsState: async () => ({ clearinghouseStates: [["main", { marginSummary: { accountValue: "100" }, assetPositions: [] }]] }),
    openOrders: async () => [],
    l2Book: async () => ({ bids: [[99, 1]], asks: [[100, 1]] }),
    activeLeverage: async () => ({ type: "cross", value: 2 }),
  };
  const runtime = new PaperSourceRuntime({
    engine,
    pairs: [{ pairId: "paper", sourceAddress: source, targetAddress: target, capitalUsd: 100 }],
    venues: new Map([["paper", venue]]),
    testnet: true,
    infoClient: info,
    WebSocketImpl: AsyncSocket,
    heartbeatMs: 60_000,
    staleConnectionMs: 120_000,
    reconnectMaxMs: 1,
    allowApproxUnified: false,
    log: (event) => calls.push(event),
  });
  await runtime.start();
  const [marketSocket, sourceSocket] = AsyncSocket.instances;
  await sourceSocket.openAsync();
  await sourceSocket.emitAsync("message", { data: JSON.stringify({ channel: "userFills", data: { fills: [{ coin: "BTC", side: "B", sz: "0.2", px: "100", startPosition: "0", time: fillTime, tid: "paper-source-42" }] } }) });
  await marketSocket.emitAsync("message", { data: JSON.stringify({ channel: "trades", data: [{ coin: "BTC", side: "B", px: "100", sz: "0.2" }] }) });
  const checkpoint = runtime.recoveryCheckpoint();
  assert.equal(checkpoint.pairs[0].lastSourceFillTime, fillTime);
  assert.ok(checkpoint.pairs[0].lastTargetFillTime > 0);
  assert.equal(checkpoint.pairs[0].recentSourceFillIds.length, 1);
  assert.equal(checkpoint.pairs[0].recentTargetFillIds.length, 1);
  assert.equal(checkpoint.pairs[0].sourceOrderToTargetCloid["source-order"], canonicalTargetCloid("paper", "source-order"));
  assert.equal(checkpoint.pairs[0].lastTargetSnapshotAt, 77);
  assert.ok(calls.some((event) => event.type === "PAPER_SOURCE_FILL"));
  runtime.stop();
});

test("paper recovery restores bounded source identities and suppresses inclusive backfill overlap", async () => {
  const recoverySource = "0x3333333333333333333333333333333333333333";
  const recoveryTarget = "0x4444444444444444444444444444444444444444";
  const fillTime = Date.now();
  const originalFill = { coin: "BTC", side: "B", sz: "0.2", px: "100", startPosition: "0", time: fillTime, tid: "paper-recovery-original" };
  const accountSnapshot = () => ({ clearinghouseStates: [["main", { marginSummary: { accountValue: "100" }, assetPositions: [] }]] });
  const makeEngine = (delivered) => ({
    bootstrapPair: async () => {},
    whenIdle: async () => {},
    onSourceSnapshot: () => {},
    onSourceFill: (_address, fill) => delivered.push(fill.tid),
    onSourceOrder: async () => {},
    onTargetFill: () => {},
    onTargetSnapshot: () => {},
    onCurrentMark: () => {},
    syncSourceOrders: async () => {},
    stop: () => {},
    snapshot: () => ({ pairs: { "paper-recovered": { targetOrderState: [], killed: false, blocked: false } } }),
  });
  const venue = {
    hasPair: () => true,
    setBook: () => {},
    getSnapshot: () => ({ positions: [] }),
    applyPublicTrade: () => [],
  };
  const baseInfo = {
    accountMode: async () => "STANDARD",
    allDexsState: async () => accountSnapshot(),
    openOrders: async () => [],
    l2Book: async () => ({ bids: [[99, 1]], asks: [[100, 1]] }),
    activeLeverage: async () => ({ type: "cross", value: 2 }),
  };
  const makeRuntime = ({ engine, infoClient }) => new PaperSourceRuntime({
    engine,
    pairs: [{ pairId: "paper-recovered", sourceAddress: recoverySource, targetAddress: recoveryTarget, capitalUsd: 100 }],
    venues: new Map([["paper-recovered", venue]]),
    testnet: true,
    infoClient,
    WebSocketImpl: AsyncSocket,
    heartbeatMs: 60_000,
    staleConnectionMs: 120_000,
    reconnectMaxMs: 1,
  });

  AsyncSocket.instances = [];
  const initialDelivered = [];
  const initial = makeRuntime({ engine: makeEngine(initialDelivered), infoClient: { ...baseInfo, fillsSince: async () => [] } });
  await initial.start();
  const initialSourceSocket = AsyncSocket.instances[1];
  await initialSourceSocket.openAsync();
  await initialSourceSocket.emitAsync("message", { data: JSON.stringify({ channel: "userFills", data: { fills: [originalFill] } }) });
  assert.deepEqual(initialDelivered, ["paper-recovery-original"]);
  const checkpoint = initial.recoveryCheckpoint();
  initial.stop();

  AsyncSocket.instances = [];
  const recoveredDelivered = [];
  const backfillCursors = [];
  const recovered = makeRuntime({
    engine: makeEngine(recoveredDelivered),
    infoClient: {
      ...baseInfo,
      fillsSince: async (_address, startTime) => {
        backfillCursors.push(startTime);
        return [
          { coin: "BTC", side: "BUY", size: 0.2, price: 100, startPosition: 0, time: fillTime, tid: "paper-recovery-original", oid: null, hash: null },
          { coin: "BTC", side: "SELL", size: 0.1, price: 100, startPosition: 0.2, time: fillTime + 2, tid: "paper-recovery-new", oid: null, hash: null },
        ];
      },
    },
  });
  assert.deepEqual(recovered.restoreRecoveryCheckpoint(checkpoint), { accepted: true, restoredPairs: 1 });
  await recovered.start();
  await AsyncSocket.instances[1].openAsync();
  assert.deepEqual(backfillCursors, [fillTime - 1_000]);
  assert.deepEqual(recoveredDelivered, ["paper-recovery-new"]);
  assert.equal(recovered.recoveryCheckpoint().pairs[0].lastSourceFillTime, fillTime + 2);
  recovered.stop();
});

test("paper recovery consumes canonical ownership before bootstrap and rejects a mismatched Cloid", async () => {
  const pairId = "paper-owned";
  const sourceOrderId = "paper-source-order";
  const targetCloid = canonicalTargetCloid(pairId, sourceOrderId);
  const ownershipRequests = [];
  const engine = {
    restoreOrderOwnership: (receivedPairId, payload) => { ownershipRequests.push({ receivedPairId, payload }); return { accepted: true }; },
    bootstrapPair: async () => {},
    whenIdle: async () => {},
    onSourceSnapshot: () => {},
    onSourceFill: () => {},
    onSourceOrder: async () => {},
    onTargetFill: () => {},
    onTargetSnapshot: () => {},
    onCurrentMark: () => {},
    syncSourceOrders: async () => {},
    stop: () => {},
    snapshot: () => ({ pairs: { [pairId]: { targetOrderState: [] } } }),
  };
  const sourceOrder = { id: sourceOrderId, coin: "BTC", poolId: "main", side: "BUY", price: 100, size: 1, remainingSize: 1, status: "OPEN" };
  const runtime = new PaperSourceRuntime({
    engine,
    pairs: [{ pairId, sourceAddress: source, targetAddress: target, capitalUsd: 100 }],
    venues: new Map([[pairId, { hasPair: () => true, setBook: () => {}, getSnapshot: () => ({ positions: [] }), applyPublicTrade: () => [] }]]),
    testnet: true,
    infoClient: {
      accountMode: async () => "STANDARD",
      allDexsState: async () => ({ clearinghouseStates: [["main", { marginSummary: { accountValue: "100" }, assetPositions: [] }]] }),
      openOrders: async () => [sourceOrder],
      l2Book: async () => ({ bids: [[99, 1]], asks: [[100, 1]] }),
      activeLeverage: async () => ({ type: "cross", value: 2 }),
    },
    WebSocketImpl: AsyncSocket,
    heartbeatMs: 60_000,
    staleConnectionMs: 120_000,
    reconnectMaxMs: 1,
  });
  assert.deepEqual(runtime.restoreRecoveryCheckpoint({
    pairs: [{ pairId, sourceAddress: source, targetAddress: target, accountMode: "STANDARD", sourceOrderToTargetCloid: { [sourceOrderId]: targetCloid } }],
  }), { accepted: true, restoredPairs: 1 });
  AsyncSocket.instances = [];
  await runtime.start();
  await AsyncSocket.instances[1].openAsync();
  assert.equal(ownershipRequests.length, 1);
  assert.equal(ownershipRequests[0].receivedPairId, pairId);
  assert.equal(ownershipRequests[0].payload.sourceOrderToTargetCloid[sourceOrderId], targetCloid);
  assert.equal(ownershipRequests[0].payload.requireTargetOpen, false);
  assert.throws(() => runtime.restoreRecoveryCheckpoint({
    pairs: [{ pairId, sourceAddress: source, targetAddress: target, sourceOrderToTargetCloid: { [sourceOrderId]: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }],
  }), /non-canonical/);
  runtime.stop();
});

test("terminal paper pair ignores repeated source and market events while an active pair continues", async () => {
  const deadSource = "0x3333333333333333333333333333333333333333";
  const deadTarget = "0x4444444444444444444444444444444444444444";
  const activeSource = "0x5555555555555555555555555555555555555555";
  const activeTarget = "0x6666666666666666666666666666666666666666";
  const calls = [];
  const logs = [];
  const engine = {
    isPairTerminal: (pairId) => pairId === "dead",
    bootstrapPair: async (pairId) => calls.push(["bootstrap", pairId]),
    whenIdle: async () => {},
    onSourceSnapshot: (address) => calls.push(["sourceSnapshot", address]),
    onSourceFill: (address) => calls.push(["sourceFill", address]),
    onSourceOrder: async (address) => calls.push(["sourceOrder", address]),
    onTargetFill: (address) => calls.push(["targetFill", address]),
    onTargetSnapshot: (address) => calls.push(["targetSnapshot", address]),
    onCurrentMark: (address) => calls.push(["mark", address]),
    syncSourceOrders: async (address) => calls.push(["sync", address]),
    stop: () => {},
    snapshot: () => ({ pairs: { dead: { killed: true }, active: { killed: false } } }),
  };
  const venue = () => ({ hasPair: () => true, setBook: () => {}, getSnapshot: () => ({ positions: [] }), applyPublicTrade: () => [] });
  const sourceSnapshot = () => ({ clearinghouseStates: [["main", { marginSummary: { accountValue: "100" }, assetPositions: [] }]] });
  const runtime = new PaperSourceRuntime({
    engine,
    pairs: [
      { pairId: "dead", sourceAddress: deadSource, targetAddress: deadTarget, capitalUsd: 100 },
      { pairId: "active", sourceAddress: activeSource, targetAddress: activeTarget, capitalUsd: 100 },
    ],
    venues: new Map([["dead", venue()], ["active", venue()]]),
    testnet: true,
    infoClient: {
      accountMode: async () => "STANDARD",
      allDexsState: async () => sourceSnapshot(),
      openOrders: async (address) => address === activeSource ? [{ id: "active-order", coin: "BTC", side: "BUY", price: 100, size: 1, remainingSize: 1, status: "OPEN" }] : [],
      l2Book: async () => ({ bids: [[99, 1]], asks: [[101, 1]] }),
      activeLeverage: async () => ({ type: "cross", value: 2 }),
    },
    WebSocketImpl: AsyncSocket,
    heartbeatMs: 60_000,
    staleConnectionMs: 120_000,
    reconnectMaxMs: 1,
    log: (event) => logs.push(event),
  });
  AsyncSocket.instances = [];
  await runtime.start();
  const [marketSocket, deadSocket, activeSocket] = AsyncSocket.instances;
  await deadSocket.openAsync();
  await activeSocket.openAsync();
  await deadSocket.emitAsync("message", { data: JSON.stringify({ channel: "allDexsClearinghouseState", data: sourceSnapshot() }) });
  await deadSocket.emitAsync("message", { data: JSON.stringify({ channel: "userFills", data: { fills: [{ coin: "BTC", side: "B", sz: "1", px: "100", startPosition: "0", time: Date.now(), tid: "dead-fill" }] } }) });
  await deadSocket.emitAsync("message", { data: JSON.stringify({ channel: "orderUpdates", data: [{ status: "open", order: { oid: "dead-order", coin: "BTC", side: "B", limitPx: "100", sz: "1" } }] }) });
  await deadSocket.emitAsync("message", { data: "{" });
  await marketSocket.openAsync();
  await marketSocket.emitAsync("message", { data: JSON.stringify({ channel: "l2Book", data: { coin: "BTC", levels: [[{ px: "99", sz: "1" }], [{ px: "101", sz: "1" }]] } }) });
  await activeSocket.emitAsync("message", { data: JSON.stringify({ channel: "userFills", data: { fills: [{ coin: "BTC", side: "B", sz: "0.1", px: "100", startPosition: "0", time: Date.now(), tid: "active-fill" }] } }) });
  assert.equal(calls.some(([, address]) => address === deadSource || address === deadTarget), false);
  assert.ok(calls.some(([type, address]) => type === "sourceFill" && address === activeSource));
  assert.ok(calls.some(([type, address]) => type === "mark" && address === activeSource));
  assert.equal(logs.some((event) => event.type === "PAPER_SOURCE_WS_ERROR" || event.type === "MARKET_WS_ERROR"), false);
  runtime.stop();
});
