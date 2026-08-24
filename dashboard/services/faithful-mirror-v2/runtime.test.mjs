import test from "node:test";
import assert from "node:assert/strict";
import {
  ActiveLeverageCache,
  BoundedFillDeduper,
  HyperliquidInfoClient,
  HyperliquidMirrorRuntime,
  UserSocket,
  normalizeAccountMode,
  parseAllDexsAccountSnapshot,
  parseOrderUpdate,
  parseUserFill,
} from "./runtime.mjs";
import { canonicalTargetCloid } from "./domain.mjs";
import { FiveWhaleFaithfulMirrorEngine } from "./engine.mjs";
import { HyperliquidLiveExecutionPort } from "./live-port.mjs";

class FakeSocket {
  static instances = [];
  constructor() {
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    FakeSocket.instances.push(this);
  }
  addEventListener(type, listener) {
    const values = this.listeners.get(type) ?? [];
    values.push(listener);
    this.listeners.set(type, values);
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.emit("close", {}); }
  emit(type, event) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  open() { this.readyState = 1; this.emit("open", {}); }
}

class AsyncFakeSocket extends FakeSocket {
  static instances = [];
  constructor(...args) {
    super(...args);
    AsyncFakeSocket.instances.push(this);
  }
  async emitAsync(type, event) {
    for (const listener of this.listeners.get(type) ?? []) await listener(event);
  }
  async openAsync() { this.readyState = 1; await this.emitAsync("open", {}); }
  close() { this.readyState = 3; void this.emitAsync("close", {}); }
}

test("account abstraction modes normalize and portfolio margin fails closed", () => {
  assert.equal(normalizeAccountMode("disabled"), "STANDARD");
  assert.equal(normalizeAccountMode(), "STANDARD");
  assert.equal(normalizeAccountMode({ accountMode: "standard_account" }), "STANDARD");
  assert.equal(normalizeAccountMode("unifiedAccount"), "UNIFIED");
  assert.equal(normalizeAccountMode("portfolioMargin"), "PORTFOLIO_MARGIN");
});

test("all-dex open-order bootstrap queries every discovered dex and deduplicates by dex and oid", async () => {
  const calls = [];
  const client = new HyperliquidInfoClient({ fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const orders = body.dex === "hip3"
      ? [{ oid: 9, coin: "XYZ", side: "A", limitPx: "11", sz: "2" }]
      : [{ oid: 9, coin: "BTC", side: "B", limitPx: "10", sz: "1" }];
    return { ok: true, status: 200, json: async () => orders };
  }, retries: 0 });
  const state = { clearinghouseStates: [["main", { marginSummary: { accountValue: "1" } }], ["hip3", { marginSummary: { accountValue: "1" } }]] };
  const orders = await client.openOrders("0x1111111111111111111111111111111111111111", { allDexsState: state });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.dex).sort(), ["", "hip3"]);
  assert.deepEqual(orders.map((order) => [order.dex, order.coin, order.side]).sort(), [["hip3", "hip3:XYZ", "SELL"], ["main", "BTC", "BUY"]]);

  const failing = new HyperliquidInfoClient({ fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    return body.dex === "hip3"
      ? { ok: false, status: 400, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => [] };
  }, retries: 0 });
  await assert.rejects(() => failing.openOrders("0x1111111111111111111111111111111111111111", { allDexsState: state }), /info request failed/);
});

test("REST all-dex bootstrap enumerates perpDexs and requests clearinghouseState for main and every HIP-3 DEX", async () => {
  const calls = [];
  const client = new HyperliquidInfoClient({ fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const payload = body.type === "perpDexs"
      ? [null, { name: "hip3" }, { name: "markets" }]
      : { marginSummary: { accountValue: body.dex === "" ? "1" : "2" }, assetPositions: [] };
    return { ok: true, status: 200, json: async () => payload };
  }, retries: 0 });

  const first = await client.allDexsState("0x1111111111111111111111111111111111111111");
  const second = await client.allDexsState("0x2222222222222222222222222222222222222222");

  assert.equal(calls.filter((call) => call.type === "perpDexs").length, 1);
  assert.deepEqual(calls.filter((call) => call.type === "clearinghouseState").map((call) => call.dex).sort(), ["", "", "hip3", "hip3", "markets", "markets"]);
  assert.deepEqual(first.clearinghouseStates.map(([dex]) => dex), ["main", "hip3", "markets"]);
  assert.deepEqual(second.clearinghouseStates.map(([dex]) => dex), ["main", "hip3", "markets"]);
});

test("bounded fill dedup evicts only the oldest identity and leverage cache coalesces a miss", async () => {
  let now = 0;
  const seen = new BoundedFillDeduper({ maxEntries: 2, maxAgeMs: 100, now: () => now });
  seen.add("one", now);
  seen.add("two", now);
  assert.equal(seen.has("one", now), true);
  seen.add("three", now);
  assert.equal(seen.has("one", now), false);
  assert.equal(seen.has("two", now), true);
  assert.deepEqual(seen.snapshot({ at: now }).map((entry) => entry.id), ["two", "three"]);
  now = 101;
  assert.equal(seen.has("two", now), false);

  let calls = 0;
  const cache = new ActiveLeverageCache({ now: () => now, ttlMs: 1_000 });
  const loader = async () => { calls += 1; return { type: "cross", value: 5 }; };
  const [first, second] = await Promise.all([cache.resolve("BTC", loader), cache.resolve("BTC", loader)]);
  assert.deepEqual(first, { type: "cross", value: 5 });
  assert.deepEqual(second, { type: "cross", value: 5 });
  assert.equal(calls, 1);
  await cache.resolve("BTC", loader);
  assert.equal(calls, 1);
});

test("all-dex account state preserves pool equity and isolated margin", () => {
  const snapshot = parseAllDexsAccountSnapshot({
    accountMode: "STANDARD",
    payload: {
      clearinghouseStates: [["xyz", {
        marginSummary: { accountValue: "1000" },
        assetPositions: [{ position: {
          coin: "SKHX",
          szi: "2",
          positionValue: "200",
          entryPx: "90",
          marginUsed: "40",
          liquidationPx: "50",
          leverage: { type: "isolated", value: 5 },
        } }],
      }]],
    },
  });
  assert.equal(snapshot.marginPools.xyz.equityUsd, 1000);
  assert.equal(snapshot.positions[0].coin, "xyz:SKHX");
  assert.equal(snapshot.positions[0].markPriceUsd, 100);
  assert.equal(snapshot.positions[0].marginUsedUsd, 40);
  assert.deepEqual(snapshot.positions[0].leverage, { type: "isolated", value: 5 });

  const main = parseAllDexsAccountSnapshot({
    accountMode: "STANDARD",
    payload: { clearinghouseStates: [["main", {
      marginSummary: { accountValue: "100" },
      assetPositions: [{ position: { coin: "BTC", szi: "1", positionValue: "10", leverage: { type: "cross", value: 2 } } }],
    }]] },
  });
  assert.equal(main.positions[0].coin, "BTC");
  assert.equal(main.positions[0].poolId, "main");
});

test("wire fills and order updates parse into actor inputs", () => {
  assert.deepEqual(parseUserFill({ coin: "BTC", side: "B", sz: "1", px: "100", startPosition: "2", time: 10, oid: 3 }), {
    coin: "BTC", side: "BUY", size: 1, price: 100, startPosition: 2, time: 10, oid: "3", tid: null, hash: null,
  });
  const update = parseOrderUpdate({ status: "open", order: { oid: 7, coin: "ETH", side: "A", limitPx: "2000", sz: "3", origSz: "5", timestamp: 11, reduceOnly: true, tif: "Gtc" } });
  assert.equal(update.order.id, "7");
  assert.equal(update.order.side, "SELL");
  assert.equal(update.order.remainingSize, 3);
  assert.equal(update.order.size, 5);
  assert.equal(update.order.reduceOnly, true);
  assert.equal(update.order.triggerPrice, null);
  const trigger = parseOrderUpdate({ status: "open", order: { oid: 8, coin: "ETH", side: "A", limitPx: "2000", triggerPx: "1900", sz: "1" } });
  assert.equal(trigger.order.triggerPrice, 1900);
});

test("fill backfill paginates full pages with inclusive cursor and stable dedup", async () => {
  const calls = [];
  const pageOne = Array.from({ length: 2_000 }, (_, index) => ({
    coin: "BTC",
    side: "B",
    sz: "1",
    px: "100",
    startPosition: String(index),
    time: index < 1_999 ? 1_000 + index : 3_000,
    oid: index + 1,
    tid: index + 1,
  }));
  const pageTwo = [
    pageOne.at(-1),
    { coin: "BTC", side: "B", sz: "1", px: "101", startPosition: "2000", time: 3_001, oid: 2001, tid: 2001 },
  ];
  const client = new HyperliquidInfoClient({ fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return { ok: true, json: async () => calls.length === 1 ? pageOne : pageTwo };
  }, retries: 0 });
  const fills = await client.fillsSince("0x1111111111111111111111111111111111111111", 1_000, 4_000);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].startTime, 3_000);
  assert.equal(fills.length, 2_001);
  assert.equal(fills.at(-1).time, 3_001);
});

test("one target user socket carries signed action post and correlates response", async () => {
  FakeSocket.instances = [];
  const socket = new UserSocket({
    address: "0x1111111111111111111111111111111111111111",
    role: "target",
    testnet: true,
    WebSocketImpl: FakeSocket,
    subscriptions: [],
    onMessage: async () => {},
  });
  socket.start();
  const transport = FakeSocket.instances[0];
  transport.open();
  const pending = socket.postAction({ action: { type: "noop" }, nonce: 1, signature: { r: "0x1", s: "0x2", v: 27 } });
  const post = transport.sent.find((item) => item.method === "post");
  assert.ok(post);
  transport.emit("message", { data: JSON.stringify({ channel: "post", data: { id: post.id, response: { type: "action", payload: { status: "ok" } } } }) });
  assert.equal((await pending).payload.status, "ok");
  socket.stop();
});

test("target signed action post fails closed on a missing correlated response", async () => {
  FakeSocket.instances = [];
  const socket = new UserSocket({
    address: "0x1111111111111111111111111111111111111111",
    role: "target",
    testnet: true,
    WebSocketImpl: FakeSocket,
    subscriptions: [],
    onMessage: async () => {},
  });
  socket.start();
  FakeSocket.instances[0].open();
  await assert.rejects(() => socket.postAction({ action: { type: "noop" }, nonce: 1, signature: { r: "0x1", s: "0x2", v: 27 } }, 2), /timed out/);
  socket.stop();
});

test("one-pair live runtime opens two sockets, buffers source fills, accepts target-authoritative snapshots, and exposes recovery hooks", async () => {
  const source = "0x1111111111111111111111111111111111111111";
  const target = "0x2222222222222222222222222222222222222222";
  const fillBaseTime = Date.now();
  const states = [];
  const engine = {
    attachActionTransport: () => {},
    bootstrapPair: async () => { states.push("bootstrap"); },
    syncTargetOrders: () => {},
    syncSourceOrders: async () => {},
    onSourceSnapshot: () => {},
    onTargetSnapshot: (_address, snapshot) => { states.push(["target", snapshot.accountEquityUsd]); },
    onSourceFill: (_address, fill) => { states.push(["sourceFill", fill.time]); },
    onTargetFill: () => {},
    onSourceOrder: async () => {},
    onTargetOrder: () => {},
    whenIdle: async () => {},
    stop: () => {},
    snapshot: () => ({ pairs: { one: {
      targetOrderState: [{ sourceOrderId: "source-oid", targetOrderId: canonicalTargetCloid("one", "source-oid") }],
      killed: false,
      blocked: false,
    } } }),
  };
  const snapshot = (equity) => ({ clearinghouseStates: [["main", { marginSummary: { accountValue: String(equity) }, assetPositions: [] }]] });
  const info = {
    accountMode: async () => "STANDARD",
    allDexsState: async (address) => snapshot(address === target ? 100 : 200),
    openOrders: async () => [],
    fillsSince: async () => [],
    activeLeverage: async () => ({ type: "cross", value: 2 }),
  };
  AsyncFakeSocket.instances = [];
  const runtime = new HyperliquidMirrorRuntime({ engine, pairs: [{ pairId: "one", sourceAddress: source, targetAddress: target }], infoClient: info, WebSocketImpl: AsyncFakeSocket });
  assert.deepEqual(runtime.restoreRecoveryCheckpoint({ pairs: [{ pairId: "one", sourceAddress: source, targetAddress: target, accountMode: "UNKNOWN", lastSourceFillTime: 1 }] }), { accepted: true, restoredPairs: 1 });
  await runtime.start();
  assert.equal(runtime.sockets.length, 2);
  const [targetSocket, sourceSocket] = AsyncFakeSocket.instances;
  await sourceSocket.openAsync();
  await sourceSocket.emitAsync("message", { data: JSON.stringify({ channel: "userFills", data: { fills: [{ coin: "BTC", side: "B", sz: "1", px: "100", startPosition: "0", time: fillBaseTime, tid: "fill-2" }] } }) });
  await targetSocket.openAsync();
  assert.ok(states.some((event) => Array.isArray(event) && event[0] === "sourceFill"));
  await targetSocket.emitAsync("message", { data: JSON.stringify({ channel: "userFills", data: { fills: [{ coin: "BTC", side: "A", sz: "0.5", px: "100", startPosition: "1", time: fillBaseTime + 1, tid: "target-fill-3" }] } }) });
  await targetSocket.emitAsync("message", { data: JSON.stringify({ channel: "allDexsClearinghouseState", data: snapshot(150) }) });
  assert.ok(states.some((event) => Array.isArray(event) && event[0] === "target" && event[1] === 150));
  const checkpoint = runtime.recoveryCheckpoint();
  assert.equal(checkpoint.pairs[0].lastSourceFillTime, fillBaseTime);
  assert.equal(checkpoint.pairs[0].lastTargetFillTime, fillBaseTime + 1);
  assert.equal(checkpoint.pairs[0].recentSourceFillIds.length, 1);
  assert.equal(checkpoint.pairs[0].recentTargetFillIds.length, 1);
  assert.equal(checkpoint.pairs[0].sourceOrderToTargetCloid["source-oid"], canonicalTargetCloid("one", "source-oid"));
  assert.equal(checkpoint.pairs[0].accountMode, "STANDARD");
  assert.ok(checkpoint.pairs[0].lastSourceSnapshotAt > 0);
  assert.ok(checkpoint.pairs[0].lastTargetSnapshotAt > 0);
  assert.deepEqual(await runtime.reconcile(), { accepted: true, pairCount: 1 });
  runtime.stop();
});

test("live runtime forwards target snapshots, fills, and orders to the execution port", async () => {
  const source = "0x7777777777777777777777777777777777777777";
  const target = "0x8888888888888888888888888888888888888888";
  const pairId = "target-forwarding";
  const forwarded = [];
  const execution = {
    attachActionTransport: () => {},
    registerPair: async () => ({ accepted: true }),
    setLeverage: async () => ({ accepted: true }),
    upsertOrder: async () => ({ accepted: true, status: "OPEN" }),
    cancelOrder: async () => ({ accepted: true }),
    protectedIoc: async ({ desiredSignedSize }) => ({ accepted: true, actualSignedSize: desiredSignedSize }),
    adjustIsolatedMargin: async () => ({ accepted: true }),
    onTargetSnapshot: (snapshot) => forwarded.push(["snapshot", snapshot]),
    onTargetFill: ({ fill }) => forwarded.push(["fill", fill]),
    onTargetOrder: ({ update }) => forwarded.push(["order", update]),
    close: () => {},
  };
  const engine = new FiveWhaleFaithfulMirrorEngine({
    pairs: [{ pairId, sourceAddress: source, targetAddress: target }],
    executionFactory: () => execution,
  });
  const emptyState = () => ({ clearinghouseStates: [["main", { marginSummary: { accountValue: "100" }, assetPositions: [] }]] });
  const targetState = () => ({ clearinghouseStates: [["main", {
    marginSummary: { accountValue: "100" },
    assetPositions: [{ position: { coin: "BTC", szi: "-1", positionValue: "-100", entryPx: "100", marginUsed: "50", leverage: { type: "isolated", value: 2 } } }],
  }]] });
  AsyncFakeSocket.instances = [];
  const runtime = new HyperliquidMirrorRuntime({
    engine,
    pairs: [{ pairId, sourceAddress: source, targetAddress: target }],
    infoClient: {
      accountMode: async () => "STANDARD",
      allDexsState: async () => emptyState(),
      openOrders: async () => [],
      fillsSince: async () => [],
      activeLeverage: async () => ({ type: "cross", value: 2 }),
    },
    WebSocketImpl: AsyncFakeSocket,
  });
  await runtime.start();
  const [targetSocket, sourceSocket] = AsyncFakeSocket.instances;
  await targetSocket.openAsync();
  await sourceSocket.openAsync();
  forwarded.length = 0;
  const now = Date.now();
  await targetSocket.emitAsync("message", { data: JSON.stringify({ channel: "allDexsClearinghouseState", data: targetState() }) });
  await targetSocket.emitAsync("message", { data: JSON.stringify({ channel: "userFills", data: { fills: [{ coin: "BTC", side: "A", sz: "0.1", px: "100", startPosition: "-1", time: now, tid: "target-forward-fill" }] } }) });
  await targetSocket.emitAsync("message", { data: JSON.stringify({ channel: "orderUpdates", data: [{ status: "open", order: { oid: "target-forward-order", cloid: canonicalTargetCloid(pairId, "source-order"), coin: "BTC", side: "A", limitPx: "101", sz: "0.2" } }] }) });
  await engine.whenIdle();
  assert.equal(forwarded.some(([type, payload]) => type === "snapshot" && payload.positions[0]?.signedSize === -1), true);
  assert.equal(forwarded.some(([type, payload]) => type === "fill" && payload.tid === "target-forward-fill"), true);
  assert.equal(forwarded.some(([type, payload]) => type === "order" && payload.exchangeOrderId === "target-forward-order"), true);
  runtime.stop();
});

test("live recovery restores bounded identities and suppresses the inclusive backfill overlap", async () => {
  const source = "0x3333333333333333333333333333333333333333";
  const target = "0x4444444444444444444444444444444444444444";
  const fillTime = Date.now();
  const originalFill = { coin: "BTC", side: "B", sz: "1", px: "100", startPosition: "0", time: fillTime, tid: "recovery-original" };
  const newerFill = { coin: "BTC", side: "A", sz: "0.25", px: "100", startPosition: "1", time: fillTime + 2, tid: "recovery-new" };
  const accountSnapshot = () => ({ clearinghouseStates: [["main", { marginSummary: { accountValue: "100" }, assetPositions: [] }]] });
  const makeEngine = (delivered) => ({
    attachActionTransport: () => {},
    bootstrapPair: async () => {},
    syncTargetOrders: () => {},
    syncSourceOrders: async () => {},
    onSourceSnapshot: () => {},
    onTargetSnapshot: () => {},
    onSourceFill: (_address, fill) => delivered.push(fill.tid),
    onTargetFill: () => {},
    onSourceOrder: async () => {},
    onTargetOrder: () => {},
    whenIdle: async () => {},
    stop: () => {},
    snapshot: () => ({ pairs: { recovered: { targetOrderState: [], killed: false, blocked: false } } }),
  });
  const baseInfo = {
    accountMode: async () => "STANDARD",
    allDexsState: async () => accountSnapshot(),
    openOrders: async () => [],
    activeLeverage: async () => ({ type: "cross", value: 2 }),
  };

  AsyncFakeSocket.instances = [];
  const initialDelivered = [];
  const initial = new HyperliquidMirrorRuntime({
    engine: makeEngine(initialDelivered),
    pairs: [{ pairId: "recovered", sourceAddress: source, targetAddress: target }],
    infoClient: { ...baseInfo, fillsSince: async () => [] },
    WebSocketImpl: AsyncFakeSocket,
  });
  await initial.start();
  const [initialTargetSocket, initialSourceSocket] = AsyncFakeSocket.instances;
  await initialSourceSocket.openAsync();
  await initialSourceSocket.emitAsync("message", { data: JSON.stringify({ channel: "userFills", data: { fills: [originalFill] } }) });
  await initialTargetSocket.openAsync();
  assert.deepEqual(initialDelivered, ["recovery-original"]);
  const checkpoint = initial.recoveryCheckpoint();
  initial.stop();

  AsyncFakeSocket.instances = [];
  const recoveredDelivered = [];
  const backfillCursors = [];
  const recovered = new HyperliquidMirrorRuntime({
    engine: makeEngine(recoveredDelivered),
    pairs: [{ pairId: "recovered", sourceAddress: source, targetAddress: target }],
    infoClient: {
      ...baseInfo,
      fillsSince: async (address, startTime) => {
        if (address !== source) return [];
        backfillCursors.push(startTime);
        // HyperliquidInfoClient.fillsSince returns parsed domain fills, not
        // websocket wire payloads; preserve the same stable identity here.
        return [
          { coin: "BTC", side: "BUY", size: 1, price: 100, startPosition: 0, time: fillTime, tid: "recovery-original", oid: null, hash: null },
          { coin: "BTC", side: "SELL", size: 0.25, price: 100, startPosition: 1, time: fillTime + 2, tid: "recovery-new", oid: null, hash: null },
        ];
      },
    },
    WebSocketImpl: AsyncFakeSocket,
  });
  assert.deepEqual(recovered.restoreRecoveryCheckpoint(checkpoint), { accepted: true, restoredPairs: 1 });
  await recovered.start();
  const [recoveredTargetSocket, recoveredSourceSocket] = AsyncFakeSocket.instances;
  await recoveredTargetSocket.openAsync();
  await recoveredSourceSocket.openAsync();
  assert.deepEqual(backfillCursors, [fillTime - 1_000]);
  assert.deepEqual(recoveredDelivered, ["recovery-new"]);
  assert.equal(recovered.recoveryCheckpoint().pairs[0].lastSourceFillTime, fillTime + 2);
  recovered.stop();
});

test("live recovery rehydrates observed canonical Cloid ownership before bootstrap without a cancel or upsert", async () => {
  const source = "0x5555555555555555555555555555555555555555";
  const target = "0x6666666666666666666666666666666666666666";
  const pairId = "ownership-live";
  const sourceOrderId = "source-open-7";
  const targetCloid = canonicalTargetCloid(pairId, sourceOrderId);
  const bridge = {
    calls: [],
    async request(operation, payload = {}) {
      this.calls.push({ operation, payload });
      if (operation === "preflight") return { ok: true, openOrders: [{ oid: "target-exchange-7", cloid: targetCloid, coin: "BTC", status: "open" }] };
      throw new Error(`Unexpected signer operation ${operation}`);
    },
    close() {},
  };
  const port = new HyperliquidLiveExecutionPort({ pairId, sourceAddress: source, targetAddress: target, bridge });
  const engine = new FiveWhaleFaithfulMirrorEngine({
    pairs: [{ pairId, sourceAddress: source, targetAddress: target }],
    executionFactory: () => port,
  });
  const sourceOrder = {
    id: sourceOrderId,
    coin: "BTC",
    poolId: "main",
    side: "BUY",
    price: 100,
    size: 1,
    remainingSize: 1,
    status: "OPEN",
    leverage: { type: "cross", value: 2 },
  };
  const targetOrder = {
    id: "target-exchange-7",
    clientOrderId: targetCloid,
    coin: "BTC",
    poolId: "main",
    side: "BUY",
    price: 100,
    size: 1,
    remainingSize: 1,
    status: "OPEN",
  };
  const snapshot = () => ({ clearinghouseStates: [["main", { marginSummary: { accountValue: "100" }, assetPositions: [] }]] });
  const runtime = new HyperliquidMirrorRuntime({
    engine,
    pairs: [{ pairId, sourceAddress: source, targetAddress: target }],
    infoClient: {
      accountMode: async () => "STANDARD",
      allDexsState: async () => snapshot(),
      openOrders: async (address) => address === source ? [sourceOrder] : [targetOrder],
      fillsSince: async () => [],
      activeLeverage: async () => ({ type: "cross", value: 2 }),
    },
    WebSocketImpl: AsyncFakeSocket,
  });
  assert.deepEqual(runtime.restoreRecoveryCheckpoint({
    pairs: [{ pairId, sourceAddress: source, targetAddress: target, accountMode: "STANDARD", sourceOrderToTargetCloid: { [sourceOrderId]: targetCloid } }],
  }), { accepted: true, restoredPairs: 1 });
  AsyncFakeSocket.instances = [];
  await runtime.start();
  const [targetSocket, sourceSocket] = AsyncFakeSocket.instances;
  await targetSocket.openAsync();
  await sourceSocket.openAsync();
  assert.deepEqual(bridge.calls.map((call) => call.operation), ["preflight"]);
  assert.equal(targetSocket.sent.filter((message) => message.method === "post").length, 0);
  const actor = engine.snapshot().pairs[pairId];
  assert.equal(actor.targetOrderState[0].targetOrderId, targetCloid);
  assert.equal(actor.targetOrderState[0].sourceOrderId, sourceOrderId);
  assert.throws(() => runtime.restoreRecoveryCheckpoint({
    pairs: [{ pairId, sourceAddress: source, targetAddress: target, sourceOrderToTargetCloid: { [sourceOrderId]: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }],
  }), /non-canonical/);
  runtime.stop();
});

test("live runtime permits one through five pairs and requires explicit Unified opt-in", async () => {
  const sourceChars = "12345";
  const targetChars = "abcde";
  const pairs = [...sourceChars].map((sourceChar, index) => ({
    pairId: `pair-${index + 1}`,
    sourceAddress: `0x${sourceChar.repeat(40)}`,
    targetAddress: `0x${targetChars[index].repeat(40)}`,
  }));
  assert.doesNotThrow(() => new HyperliquidMirrorRuntime({ engine: {}, pairs, infoClient: {} }));
  assert.throws(() => new HyperliquidMirrorRuntime({ engine: {}, pairs: [...pairs, { pairId: "six", sourceAddress: `0x${"f".repeat(40)}`, targetAddress: `0x${"9".repeat(40)}` }], infoClient: {} }), /1-5/);

  const unifiedInfo = { accountMode: async () => "UNIFIED" };
  const configuration = { engine: { attachActionTransport: () => {}, stop: () => {} }, pairs: [pairs[0]], infoClient: unifiedInfo, WebSocketImpl: AsyncFakeSocket };
  await assert.rejects(() => new HyperliquidMirrorRuntime(configuration).start(), /Unified account support is approximate and disabled/);
  const allowed = new HyperliquidMirrorRuntime({ ...configuration, allowApproxUnified: true });
  await allowed.start();
  assert.equal(allowed.sockets.length, 2);
  allowed.stop();
});
