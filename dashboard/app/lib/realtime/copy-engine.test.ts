import assert from "node:assert/strict";
import test from "node:test";
import type {
  HyperliquidCloneOrderRequest,
  HyperliquidCloneResult,
  HyperliquidExecutionPort,
  RealtimeMonitorEvent,
} from "../copy-types";
import { RealtimeCopyEngine } from "./copy-engine";
import type { HyperliquidUserFillsMonitor } from "./hyperliquid-ws";
import { buildOpenEpisodeReplay } from "./open-episode-replay";

const whale = "0x1111111111111111111111111111111111111111";

class FakeMonitor {
  private listener: ((event: RealtimeMonitorEvent) => void) | undefined;
  subscribe(listener: (event: RealtimeMonitorEvent) => void): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
  start(): void {}
  stop(): void {}
  emit(event: RealtimeMonitorEvent): void { this.listener?.(event); }
}

class FakeExecution implements HyperliquidExecutionPort {
  readonly enabled = true;
  readonly testnet = true;
  readonly clones: Array<{ at: number; request: HyperliquidCloneOrderRequest }> = [];
  readonly settlements: Array<{ at: number; request: HyperliquidCloneOrderRequest }> = [];
  async preflight(): Promise<{ ok: boolean }> { return { ok: true }; }
  followerAccountState(): { accountValueUsd: number; receivedAt: number } { return { accountValueUsd: 100, receivedAt: Date.now() }; }
  async cloneOrder(request: HyperliquidCloneOrderRequest): Promise<HyperliquidCloneResult> {
    this.clones.push({ at: performance.now(), request });
    return { accepted: true, clientOrderId: request.clientOrderId, status: "resting", quantity: request.quantity };
  }
  async settleFilledOrder(request: HyperliquidCloneOrderRequest): Promise<HyperliquidCloneResult> {
    this.settlements.push({ at: performance.now(), request });
    return {
      accepted: true,
      clientOrderId: request.clientOrderId,
      status: "filled",
      marketCatchUpQuantity: request.quantity,
      marketCatchUpAveragePrice: 101,
      marketCatchUpSlippageBps: 100,
      remainingQuantity: 0,
    };
  }
}

test("copies exact source leverage and markets only after the source-full one-second grace", async () => {
  const monitor = new FakeMonitor();
  const execution = new FakeExecution();
  const engine = new RealtimeCopyEngine({
    monitor: monitor as unknown as HyperliquidUserFillsMonitor,
    execution,
    config: {
      mode: "HYPERLIQUID",
      whales: [{ address: whale, copyRatio: 0.01 }],
      sizing: {
        mode: "SOURCE_EQUITY_RATIO",
        followerCapitalUsd: 100,
        minSourceAccountValueUsd: 0,
        maxAccountStateAgeMs: 60_000,
      },
      risk: {
        allowedWhales: [whale],
        allowedSymbols: ["*"],
        maxNotionalUsd: 1_000_000_000,
        maxSlippageProxyBps: 500,
        maxDailyLossUsd: 100,
      },
    },
  });
  engine.start();
  monitor.emit({
    type: "accountState",
    whale,
    time: Date.now(),
    accountState: { accountValueUsd: 1_000, positions: [], receivedAt: Date.now() },
  });
  const baseOrder = {
    coin: "BTC",
    side: "B" as const,
    limitPx: "100",
    origSz: "10",
    oid: 77,
    timestamp: Date.now(),
    reduceOnly: false,
    orderType: "Limit",
    tif: "Gtc",
  };
  monitor.emit({
    type: "order",
    whale,
    time: Date.now(),
    orderUpdate: {
      order: { ...baseOrder, sz: "10" },
      status: "open",
      statusTimestamp: Date.now(),
      metadataComplete: true,
      sourceLeverage: { type: "isolated", value: 37 },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(execution.clones.length, 1);
  assert.deepEqual(execution.clones[0]?.request.leverage, { type: "isolated", value: 37 });
  assert.equal(execution.clones[0]?.request.quantity, 1);

  const fullReceivedAt = performance.now();
  monitor.emit({
    type: "fill",
    whale,
    time: Date.now(),
    fill: {
      coin: "BTC",
      side: "B",
      px: "100",
      sz: "10",
      time: Date.now(),
      startPosition: "0",
      oid: 77,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 1_080));
  assert.equal(execution.settlements.length, 1);
  assert.equal(execution.settlements[0]!.request.targetPositionAfter, 1);
  const elapsed = execution.settlements[0]!.at - fullReceivedAt;
  assert.ok(elapsed >= 950 && elapsed < 1_500, `settlement should run around 1000ms, got ${elapsed}ms`);
  assert.ok(engine.snapshot().logs.some((entry) => entry.message.includes("market catch-up") && entry.detail?.marketCatchUpQuantity === 1));
  engine.stop();
});

test("a paper runner restart preserves its durable position instead of creating a phantom rebalance", () => {
  const monitor = new FakeMonitor();
  const engine = new RealtimeCopyEngine({
    monitor: monitor as unknown as HyperliquidUserFillsMonitor,
    now: () => 2_000,
    config: {
      mode: "SIMULATION",
      whales: [{ address: whale, copyRatio: 0.01 }],
      sizing: {
        mode: "SOURCE_EQUITY_RATIO",
        followerCapitalUsd: 100,
        minSourceAccountValueUsd: 0,
        maxAccountStateAgeMs: 60_000,
      },
      risk: {
        allowedWhales: [whale],
        allowedSymbols: ["*"],
        maxNotionalUsd: 1_000_000,
        maxSlippageProxyBps: 500,
        maxDailyLossUsd: 100,
      },
    },
    initialState: {
      simulationPositions: [{
        whale,
        coin: "BTC",
        sourcePosition: 100,
        followerPosition: 2,
        averageEntryPrice: 10,
        copyingEpisode: true,
        desynced: false,
        updatedAt: 1_000,
      }],
    },
  });
  engine.start();
  monitor.emit({
    type: "accountState",
    whale,
    time: 2_000,
    accountState: {
      accountValueUsd: 1_000,
      receivedAt: 2_000,
      positions: [{ coin: "BTC", signedSize: 100, positionValueUsd: 2_000 }],
    },
  });

  const position = engine.snapshot().simulationPositions[0];
  assert.equal(position?.sourcePosition, 100);
  assert.equal(position?.followerPosition, 2);
  assert.equal(position?.averageEntryPrice, 10);
  assert.equal(engine.snapshot().logs.some((entry) => entry.message.startsWith("Synchronized")), false);
  engine.stop();
});

test("new-position-only paper mode ignores startup exposure but copies later additions and new positions", async () => {
  const monitor = new FakeMonitor();
  const now = Date.now();
  const engine = new RealtimeCopyEngine({
    monitor: monitor as unknown as HyperliquidUserFillsMonitor,
    config: {
      mode: "SIMULATION",
      entryPolicy: "NEW_POSITIONS_ONLY",
      whales: [{ address: whale, copyRatio: 0.01 }],
      sizing: {
        mode: "SOURCE_EQUITY_RATIO",
        followerCapitalUsd: 100,
        minSourceAccountValueUsd: 0,
        maxAccountStateAgeMs: 60_000,
      },
      risk: {
        allowedWhales: [whale],
        allowedSymbols: ["*"],
        maxNotionalUsd: 1_000_000,
        maxSlippageProxyBps: 500,
        maxDailyLossUsd: 100,
      },
    },
  });
  engine.start();
  monitor.emit({
    type: "accountState",
    whale,
    time: now,
    accountState: {
      accountValueUsd: 1_000,
      receivedAt: now,
      positions: [{ coin: "BTC", signedSize: 5, positionValueUsd: 500, entryPriceUsd: 80 }],
    },
  });
  assert.equal(engine.snapshot().simulationPositions.length, 0);
  assert.equal(engine.snapshot().sizingByWhale[whale]?.waitingForNewPosition, true);
  assert.equal(engine.snapshot().sizingByWhale[whale]?.ignoredExistingPositionCount, 1);
  monitor.emit({
    type: "accountState",
    whale,
    time: now + 1,
    accountState: {
      accountValueUsd: 2_000,
      receivedAt: now + 1,
      positions: [{ coin: "BTC", signedSize: 5, positionValueUsd: 600, entryPriceUsd: 80 }],
    },
  });
  assert.equal(engine.snapshot().sizingByWhale[whale]?.sourcePositionNotionalUsd, 600);
  assert.equal(engine.snapshot().sizingByWhale[whale]?.sourceExposurePct, 30);
  monitor.emit({
    type: "accountState",
    whale,
    time: now + 2,
    accountState: {
      accountValueUsd: 1_000,
      receivedAt: now + 2,
      positions: [{ coin: "BTC", signedSize: 5, positionValueUsd: 500, entryPriceUsd: 80 }],
    },
  });

  monitor.emit({
    type: "order",
    whale,
    time: now + 1,
    orderUpdate: {
      order: {
        coin: "BTC", side: "A", limitPx: "90", sz: "5", origSz: "5", oid: 99,
        timestamp: now + 1, reduceOnly: true, orderType: "Stop Market", isTrigger: true,
      },
      status: "open",
      statusTimestamp: now + 1,
      isSnapshot: true,
      metadataComplete: true,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(engine.snapshot().mirroredOrders.length, 0);
  assert.ok(engine.snapshot().logs.some((entry) => entry.message.includes("new-position-only policy")));

  monitor.emit({
    type: "order",
    whale,
    time: now + 2,
    orderUpdate: {
      order: {
        coin: "BTC", side: "B", limitPx: "100", sz: "2", origSz: "2", oid: 100,
        timestamp: now + 2, reduceOnly: false, orderType: "Limit", tif: "Gtc",
      },
      status: "open",
      statusTimestamp: now + 2,
      isSnapshot: false,
      metadataComplete: true,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(engine.snapshot().mirroredOrders.length, 1);

  monitor.emit({ type: "fill", whale, time: now + 3, fill: { coin: "BTC", side: "B", px: "100", sz: "2", time: now + 3, startPosition: "5" } });
  monitor.emit({ type: "fill", whale, time: now + 4, fill: { coin: "BTC", side: "A", px: "100", sz: "1", time: now + 4, startPosition: "7" } });
  monitor.emit({ type: "fill", whale, time: now + 5, fill: { coin: "BTC", side: "A", px: "100", sz: "6", time: now + 5, startPosition: "6" } });
  monitor.emit({ type: "fill", whale, time: now + 6, fill: { coin: "BTC", side: "B", px: "100", sz: "2", time: now + 6, startPosition: "0" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const snapshot = engine.snapshot();
  assert.equal(snapshot.performance.simulatedFills, 4);
  assert.equal(snapshot.simulationPositions[0]?.sourcePosition, 2);
  assert.equal(snapshot.simulationPositions[0]?.trackedSourcePosition, 2);
  assert.equal(snapshot.simulationPositions[0]?.followerPosition, 0.2);
  assert.equal(snapshot.sizingByWhale[whale]?.waitingForNewPosition, false);
  engine.stop();
});

test("replays a validated open episode at the fixed bootstrap scale without execution, and ignores queued overlap", async () => {
  const monitor = new FakeMonitor();
  const execution = new FakeExecution();
  const now = Date.now();
  const historicalFills = [
    { coin: "BTC", startPosition: "0", side: "B" as const, px: "100", sz: "2", time: now - 2, hash: "history-open", oid: 1, tid: 1, fee: "2" },
    { coin: "BTC", startPosition: "2", side: "A" as const, px: "110", sz: "1", time: now - 1, hash: "history-trim", oid: 2, tid: 2, fee: "1" },
  ];
  const engine = new RealtimeCopyEngine({
    monitor: monitor as unknown as HyperliquidUserFillsMonitor,
    execution,
    config: {
      mode: "SIMULATION",
      entryPolicy: "REPLAY_OPEN_EPISODES",
      whales: [{ address: whale, copyRatio: 0.01 }],
      sizing: { mode: "SOURCE_EQUITY_RATIO", followerCapitalUsd: 100, minSourceAccountValueUsd: 0, maxAccountStateAgeMs: 60_000 },
      risk: { allowedWhales: [whale], allowedSymbols: ["*"], maxNotionalUsd: 1_000_000, maxSlippageProxyBps: 500, maxDailyLossUsd: 100 },
    },
    openEpisodeReplayProvider: async ({ cutoffAccountState, followerAllocationUsd, sourceAccountValueUsd }) => buildOpenEpisodeReplay({
      sourcePositions: cutoffAccountState.positions.map((position) => ({ coin: position.coin, szi: position.signedSize, entryPriceUsd: position.entryPriceUsd })),
      fills: historicalFills,
      followerAllocationUsd,
      sourceTotalEquityUsd: sourceAccountValueUsd,
    }),
  });
  engine.start();
  monitor.emit({
    type: "accountState",
    whale,
    time: now,
    accountState: { accountValueUsd: 1_000, receivedAt: now, positions: [{ coin: "BTC", signedSize: 1, positionValueUsd: 100, entryPriceUsd: 100 }] },
  });
  // This source fill was already returned by the history provider. It queues
  // behind bootstrap and must be suppressed by the ledger source-fill ID.
  monitor.emit({ type: "fill", whale, time: now + 1, fill: historicalFills[1]! });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const snapshot = engine.snapshot();
  const position = snapshot.simulationPositions.find((item) => item.coin === "BTC");
  assert.equal(position?.sourcePosition, 1);
  assert.equal(position?.followerPosition, 0.1);
  assert.equal(position?.averageEntryPrice, 100);
  assert.equal(snapshot.performance.simulatedFills, 2);
  assert.ok(Math.abs(snapshot.performance.fees - 0.3) < 1e-9);
  assert.ok(Math.abs(snapshot.performance.realizedPnl - 0.7) < 1e-9);
  assert.equal(snapshot.sizingByWhale[whale]?.episodeReplayStatus, "READY");
  assert.equal(snapshot.sizingByWhale[whale]?.replayedFillCount, 2);
  assert.equal(execution.clones.length, 0);
  assert.equal(execution.settlements.length, 0);
  engine.stop();
});

test("a flat source completes replay bootstrap without calling history", async () => {
  const monitor = new FakeMonitor();
  const now = Date.now();
  let providerCalls = 0;
  const engine = new RealtimeCopyEngine({
    monitor: monitor as unknown as HyperliquidUserFillsMonitor,
    config: {
      mode: "SIMULATION",
      entryPolicy: "REPLAY_OPEN_EPISODES",
      whales: [{ address: whale, copyRatio: 0.01 }],
      sizing: { mode: "SOURCE_EQUITY_RATIO", followerCapitalUsd: 100, minSourceAccountValueUsd: 0, maxAccountStateAgeMs: 60_000 },
      risk: { allowedWhales: [whale], allowedSymbols: ["*"], maxNotionalUsd: 1_000_000, maxSlippageProxyBps: 500, maxDailyLossUsd: 100 },
    },
    openEpisodeReplayProvider: async () => {
      providerCalls += 1;
      throw new Error("history must not be requested for a flat source");
    },
  });
  engine.start();
  monitor.emit({ type: "accountState", whale, time: now, accountState: { accountValueUsd: 1_000, receivedAt: now, positions: [] } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(providerCalls, 0);
  assert.equal(engine.snapshot().sizingByWhale[whale]?.episodeReplayStatus, "READY");
  assert.equal(engine.snapshot().sizingByWhale[whale]?.replayedFillCount, 0);
  assert.equal(engine.snapshot().sizingByWhale[whale]?.blockedEpisodeCount, 0);
  assert.equal(engine.snapshot().simulationPositions.length, 0);
  assert.equal(engine.snapshot().logs.some((entry) => entry.kind === "RISK_BLOCK"), false);
  engine.stop();
});

test("a failed open-episode provider leaves current residuals unadopted but permits a later flat-to-open episode", async () => {
  const monitor = new FakeMonitor();
  const now = Date.now();
  const engine = new RealtimeCopyEngine({
    monitor: monitor as unknown as HyperliquidUserFillsMonitor,
    config: {
      mode: "SIMULATION",
      entryPolicy: "REPLAY_OPEN_EPISODES",
      whales: [{ address: whale, copyRatio: 0.01 }],
      sizing: { mode: "SOURCE_EQUITY_RATIO", followerCapitalUsd: 100, minSourceAccountValueUsd: 0, maxAccountStateAgeMs: 60_000 },
      risk: { allowedWhales: [whale], allowedSymbols: ["*"], maxNotionalUsd: 1_000_000, maxSlippageProxyBps: 500, maxDailyLossUsd: 100 },
    },
    openEpisodeReplayProvider: async () => { throw new Error("history coverage is incomplete"); },
  });
  engine.start();
  monitor.emit({
    type: "accountState",
    whale,
    time: now,
    accountState: { accountValueUsd: 1_000, receivedAt: now, positions: [{ coin: "BTC", signedSize: 5, positionValueUsd: 500, entryPriceUsd: 100 }] },
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(engine.snapshot().simulationPositions.length, 0);
  assert.equal(engine.snapshot().sizingByWhale[whale]?.episodeReplayStatus, "BLOCKED");
  assert.ok(engine.snapshot().logs.some((entry) => entry.kind === "RISK_BLOCK" && entry.message.includes("history coverage is incomplete")));

  // Closing the unknown residual remains fail-closed; a fresh fill from flat
  // is a later episode and must still be eligible for normal dynamic sizing.
  monitor.emit({ type: "fill", whale, time: now + 1, fill: { coin: "BTC", side: "A", px: "100", sz: "5", time: now + 1, startPosition: "5", hash: "unknown-close", oid: 3, tid: 3 } });
  monitor.emit({ type: "fill", whale, time: now + 2, fill: { coin: "BTC", side: "B", px: "100", sz: "2", time: now + 2, startPosition: "0", hash: "new-episode", oid: 4, tid: 4 } });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const position = engine.snapshot().simulationPositions.find((item) => item.coin === "BTC");
  assert.equal(position?.sourcePosition, 2);
  assert.equal(position?.followerPosition, 0.2);
  engine.stop();
});

test("restored paper state skips open-episode bootstrap after a process restart", async () => {
  const monitor = new FakeMonitor();
  let providerCalls = 0;
  const engine = new RealtimeCopyEngine({
    monitor: monitor as unknown as HyperliquidUserFillsMonitor,
    now: () => 2_000,
    config: {
      mode: "SIMULATION",
      entryPolicy: "REPLAY_OPEN_EPISODES",
      whales: [{ address: whale, copyRatio: 0.01 }],
      sizing: { mode: "SOURCE_EQUITY_RATIO", followerCapitalUsd: 100, minSourceAccountValueUsd: 0, maxAccountStateAgeMs: 60_000 },
      risk: { allowedWhales: [whale], allowedSymbols: ["*"], maxNotionalUsd: 1_000_000, maxSlippageProxyBps: 500, maxDailyLossUsd: 100 },
    },
    initialState: { simulationPositions: [{ whale, coin: "BTC", sourcePosition: 1, followerPosition: 0.1, averageEntryPrice: 100, copyingEpisode: true, desynced: false, updatedAt: 1_000 }] },
    openEpisodeReplayProvider: async () => {
      providerCalls += 1;
      throw new Error("must not run");
    },
  });
  engine.start();
  monitor.emit({
    type: "accountState",
    whale,
    time: 2_000,
    accountState: { accountValueUsd: 1_000, receivedAt: 2_000, positions: [{ coin: "BTC", signedSize: 1, positionValueUsd: 100, entryPriceUsd: 100 }] },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(providerCalls, 0);
  assert.equal(engine.snapshot().simulationPositions[0]?.followerPosition, 0.1);
  engine.stop();
});
