import assert from "node:assert/strict";
import test from "node:test";
import { CopyRunnerStore } from "./database";
import type { CopyEngineSnapshot, CopyPerformance, MirroredOrder } from "../../app/lib/copy-types";

const performance: CopyPerformance = {
  realizedPnl: 12.5,
  fees: 0.5,
  executedNotionalUsd: 100,
  simulatedFills: 2,
  executions: 1,
  blockedExecutions: 0,
  errors: 0,
};

test("SQLite store persists idempotency, state, performance, and expected positions", () => {
  const store = new CopyRunnerStore(":memory:");
  assert.equal(store.acquire("source-fill:0"), true);
  assert.equal(store.acquire("source-fill:0"), false);
  const snapshot = {
    state: "RUNNING",
    mode: "SIMULATION",
    watchedWhales: ["0x1111111111111111111111111111111111111111"],
    performance,
    performanceByWhale: { "0x1111111111111111111111111111111111111111": performance },
    sizing: { mode: "SOURCE_EQUITY_RATIO", followerCapitalUsd: 100, allocationPerWhaleUsd: 100 },
    sizingByWhale: {
      "0x1111111111111111111111111111111111111111": {
        followerAccountValueUsd: 112,
        stateFresh: true,
        sizingReady: true,
      },
    },
    simulationPositions: [],
    mirroredOrders: [],
    logs: [],
    killSwitch: true,
  } as CopyEngineSnapshot;
  store.onSnapshot(snapshot);
  store.setExpectedPosition("BTCUSDT", 0.25);
  store.recordBinanceOrder({ clientOrderId: "copy-test", symbol: "BTCUSDT", sourceKey: "source-fill:0", expectedPosition: 0.25, status: "PENDING_RECONCILIATION", payload: { safe: true } });
  const mirroredOrder: MirroredOrder = {
    id: "whale|7", whale: "whale", sourceOid: "7", coin: "BTC", symbol: "BTCUSDT", side: "BUY", price: 100,
    sourceStatus: "open", status: "OPEN", sourceOriginalQuantity: 2, sourceRemainingQuantity: 2,
    followerOriginalQuantity: 0.2, followerRemainingQuantity: 0.2, followerFilledQuantity: 0,
    metadataComplete: true, leverageCapped: false, lastAction: "PLACED", createdAt: 1, updatedAt: 2,
  };
  store.onMirrorOrder({ action: "PLACED", copied: true, order: mirroredOrder });
  store.onSimulationPosition({
    whale: "0x1111111111111111111111111111111111111111",
    coin: "BTC",
    sourcePosition: 2,
    followerPosition: 0.2,
    averageEntryPrice: 100,
    copyingEpisode: true,
    desynced: false,
    updatedAt: 3,
  });
  const restored = store.restoreEngineState();
  assert.equal(restored.performance.realizedPnl, 12.5);
  assert.equal(restored.risk.killSwitch, true);
  assert.deepEqual(store.expectedPositions(), [{ symbol: "BTCUSDT", position: 0.25 }]);
  assert.equal(store.unresolvedOrders()[0]?.clientOrderId, "copy-test");
  assert.deepEqual(store.recentMirroredOrders(), [mirroredOrder]);
  assert.equal(restored.simulationPositions[0]?.followerPosition, 0.2);
  assert.deepEqual(store.accountEquityHistory().map(({ whale, accountValueUsd, realizedPnl }) => ({ whale, accountValueUsd, realizedPnl })), [{
    whale: "0x1111111111111111111111111111111111111111",
    accountValueUsd: 112,
    realizedPnl: 12.5,
  }]);
  store.close();
});
