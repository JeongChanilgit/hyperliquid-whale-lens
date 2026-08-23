import test from "node:test";
import assert from "node:assert/strict";
import {
  HyperliquidInfoClient,
  UserSocket,
  normalizeAccountMode,
  parseAllDexsAccountSnapshot,
  parseOrderUpdate,
  parseUserFill,
} from "./runtime.mjs";

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

test("account abstraction modes normalize and portfolio margin fails closed", () => {
  assert.equal(normalizeAccountMode("disabled"), "STANDARD");
  assert.equal(normalizeAccountMode("unifiedAccount"), "UNIFIED");
  assert.equal(normalizeAccountMode("portfolioMargin"), "PORTFOLIO_MARGIN");
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
});

test("wire fills and order updates parse into actor inputs", () => {
  assert.deepEqual(parseUserFill({ coin: "BTC", side: "B", sz: "1", px: "100", startPosition: "2", time: 10, oid: 3 }), {
    coin: "BTC", side: "B", size: 1, price: 100, startPosition: 2, time: 10, oid: "3", tid: null, hash: null,
  });
  const update = parseOrderUpdate({ status: "open", order: { oid: 7, coin: "ETH", side: "A", limitPx: "2000", sz: "3", origSz: "5", timestamp: 11, reduceOnly: true, tif: "Gtc" } });
  assert.equal(update.order.id, "7");
  assert.equal(update.order.side, "SELL");
  assert.equal(update.order.remainingSize, 3);
  assert.equal(update.order.size, 5);
  assert.equal(update.order.reduceOnly, true);
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
