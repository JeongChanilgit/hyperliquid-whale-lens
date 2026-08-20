import assert from "node:assert/strict";
import test from "node:test";
import { HyperliquidUserFillsMonitor, type WebSocketLike } from "./hyperliquid-ws";
import type { RealtimeMonitorEvent } from "../copy-types";

const whale = "0x1111111111111111111111111111111111111111";

class FakeSocket implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: Event | { data: unknown }) => void>>();

  send(data: string): void { this.sent.push(data); }
  close(): void {}
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: Event | { data: unknown }) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }
  dispatch(type: "open" | "message", data?: unknown): void {
    const event = type === "message" ? { data } : new Event(type);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

test("monitor subscribes to all DEX clearinghouse states and emits aggregate account equity", async () => {
  const socket = new FakeSocket();
  const events: RealtimeMonitorEvent[] = [];
  const fetchedDexes: string[] = [];
  const monitor = new HyperliquidUserFillsMonitor({
    whales: [whale],
    socketFactory: () => socket,
    includePortfolioAccountValue: false,
    fetchOpenOrders: async (_owner, dex = "") => { fetchedDexes.push(dex); return []; },
  });
  monitor.subscribe((event) => events.push(event));
  monitor.start();
  socket.dispatch("open");
  assert.ok(socket.sent.some((message) => message.includes('"type":"allDexsClearinghouseState"')));
  assert.ok(socket.sent.findIndex((message) => message.includes('"type":"allDexsClearinghouseState"')) < socket.sent.findIndex((message) => message.includes('"type":"userFills"')));

  socket.dispatch("message", JSON.stringify({
    channel: "allDexsClearinghouseState",
    data: {
      user: whale,
      clearinghouseStates: [["", {
          marginSummary: { accountValue: "25000" },
          assetPositions: [{ position: { coin: "BTC", szi: "0.25", positionValue: "15000", entryPx: "59000", leverage: { type: "cross", value: 25 } } }],
        }], ["xyz", {
          marginSummary: { accountValue: "5000" },
          assetPositions: [{ position: { coin: "GOOGL", szi: "2", positionValue: "600" } }],
        }]],
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const state = events.find((event) => event.type === "accountState")?.accountState;
  assert.equal(state?.accountValueUsd, 30_000);
  assert.deepEqual(state?.positions[0], { coin: "BTC", signedSize: 0.25, positionValueUsd: 15_000, entryPriceUsd: 59_000, leverage: { type: "cross", value: 25 } });
  assert.deepEqual(state?.positions[1], { coin: "XYZ:GOOGL", signedSize: 2, positionValueUsd: 600 });
  assert.deepEqual(fetchedDexes.sort(), ["", "xyz"]);
  monitor.stop();
});

test("uses one socket per whale so user-less order updates cannot be misattributed", async () => {
  const other = "0x2222222222222222222222222222222222222222";
  const sockets = new Map([[whale, new FakeSocket()], [other, new FakeSocket()]]);
  const events: RealtimeMonitorEvent[] = [];
  const monitor = new HyperliquidUserFillsMonitor({
    whales: [whale, other],
    socketFactory: (_url, owner) => sockets.get(owner ?? "")!,
    includePortfolioAccountValue: false,
    fetchOpenOrders: async () => [],
    fetchActiveAssetLeverage: async () => ({ type: "isolated", value: 17 }),
    fetchOrderDetails: async () => ({
      coin: "BTC",
      side: "B",
      limitPx: "100",
      sz: "2",
      origSz: "2",
      oid: 7,
      timestamp: 1,
      reduceOnly: false,
      orderType: "Limit",
      tif: "Gtc",
    }),
  });
  monitor.subscribe((event) => events.push(event));
  monitor.start();
  for (const socket of sockets.values()) socket.dispatch("open");
  assert.ok([...sockets.values()].every((socket) => socket.sent.some((message) => message.includes('"type":"orderUpdates"'))));

  sockets.get(other)!.dispatch("message", JSON.stringify({
    channel: "orderUpdates",
    data: [{
      order: { coin: "BTC", side: "B", limitPx: "100", sz: "2", origSz: "2", oid: 7, timestamp: 1 },
      status: "open",
      statusTimestamp: 2,
    }],
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const orderEvent = events.find((event) => event.type === "order");
  assert.equal(orderEvent?.whale, other);
  assert.equal(orderEvent?.orderUpdate?.order.reduceOnly, false);
  assert.equal(orderEvent?.orderUpdate?.metadataComplete, true);
  assert.deepEqual(orderEvent?.orderUpdate?.sourceLeverage, { type: "isolated", value: 17 });
  monitor.stop();
});

test("uses current total portfolio value for source-equity sizing", async () => {
  const socket = new FakeSocket();
  const events: RealtimeMonitorEvent[] = [];
  const monitor = new HyperliquidUserFillsMonitor({
    whales: [whale],
    socketFactory: () => socket,
    fetchOpenOrders: async () => [],
    fetchPortfolioAccountValue: async () => 867_581.45,
  });
  monitor.subscribe((event) => events.push(event));
  monitor.start();
  socket.dispatch("open");
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.dispatch("message", JSON.stringify({
    channel: "allDexsClearinghouseState",
    data: {
      user: whale,
      clearinghouseStates: [["", { marginSummary: { accountValue: "0" }, assetPositions: [] }]],
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const states = events.filter((event) => event.type === "accountState");
  assert.equal(states.at(-1)?.accountState?.accountValueUsd, 867_581.45);
  monitor.stop();
});

test("withholds startup account state until the total portfolio value is fresh", async (t) => {
  const socket = new FakeSocket();
  const events: RealtimeMonitorEvent[] = [];
  let resolvePortfolio: ((value: number) => void) | undefined;
  const monitor = new HyperliquidUserFillsMonitor({
    whales: [whale],
    socketFactory: () => socket,
    fetchOpenOrders: async () => [],
    fetchPortfolioAccountValue: async () => new Promise<number>((resolve) => { resolvePortfolio = resolve; }),
  });
  t.after(() => monitor.stop());
  monitor.subscribe((event) => events.push(event));
  monitor.start();
  socket.dispatch("open");
  assert.ok(resolvePortfolio, "opening the socket should start the total-portfolio fetch");

  socket.dispatch("message", JSON.stringify({
    channel: "allDexsClearinghouseState",
    data: {
      user: whale,
      clearinghouseStates: [["", {
        marginSummary: { accountValue: "12463" },
        assetPositions: [{ position: { coin: "BTC", szi: "1", positionValue: "50000", entryPx: "50000" } }],
      }]],
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.filter((event) => event.type === "accountState").length, 0);

  resolvePortfolio!(126_943);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const states = events.filter((event) => event.type === "accountState");
  assert.equal(states.length, 1);
  assert.equal(states[0]?.accountState?.accountValueUsd, 126_943);
});

test("does not publish the perpetual subtotal after startup portfolio fetch failure and recovers on heartbeat", async (t) => {
  const socket = new FakeSocket();
  const events: RealtimeMonitorEvent[] = [];
  let attempts = 0;
  let rejectFirst: ((reason?: unknown) => void) | undefined;
  const monitor = new HyperliquidUserFillsMonitor({
    whales: [whale],
    socketFactory: () => socket,
    heartbeatMs: 5,
    staleConnectionMs: 1_000,
    portfolioRefreshMs: 20,
    fetchOpenOrders: async () => [],
    fetchPortfolioAccountValue: async () => {
      attempts += 1;
      if (attempts === 1) return new Promise<number>((_resolve, reject) => { rejectFirst = reject; });
      return 126_943;
    },
  });
  t.after(() => monitor.stop());
  monitor.subscribe((event) => events.push(event));
  monitor.start();
  socket.dispatch("open");
  socket.dispatch("message", JSON.stringify({
    channel: "allDexsClearinghouseState",
    data: {
      user: whale,
      clearinghouseStates: [["", { marginSummary: { accountValue: "12463" }, assetPositions: [] }]],
    },
  }));
  rejectFirst!(new Error("portfolio temporarily unavailable"));
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(events.filter((event) => event.type === "accountState").every((event) => event.accountState?.accountValueUsd !== 12_463));

  await new Promise((resolve) => setTimeout(resolve, 35));
  const states = events.filter((event) => event.type === "accountState");
  assert.ok(attempts >= 2, "a heartbeat should retry the failed portfolio fetch");
  assert.ok(states.length >= 1);
  assert.ok(states.every((event) => event.accountState?.accountValueUsd === 126_943));
});
