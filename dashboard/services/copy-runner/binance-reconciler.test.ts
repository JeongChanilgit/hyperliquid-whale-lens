import assert from "node:assert/strict";
import test from "node:test";
import type { CopyIntent, CopySegment } from "../../app/lib/copy-types";
import type { BinanceUsdMAdapter } from "../../app/lib/realtime/binance-usdm";
import { BinanceReconciler } from "./binance-reconciler";
import { CopyRunnerStore } from "./database";

const intent = (whale: string, idempotencyKey: string): CopyIntent => ({
  idempotencyKey,
  whale,
  coin: "BTC",
  symbol: "BTCUSDT",
  referencePrice: 100_000,
  sourceTime: 1,
  segments: [],
  notionalUsd: 0,
});

test("reconciliation tracks the aggregate Binance position across whales", async () => {
  const store = new CopyRunnerStore(":memory:");
  const positions = [0.1, 0.3];
  const adapter = {
    isHedgeMode: async () => false,
    getOrderByClientOrderId: async (_symbol: string, clientOrderId: string) => ({
      clientOrderId,
      status: "FILLED",
      executedQty: clientOrderId === "copy-one" ? 0.1 : 0.2,
    }),
    getPositionAmount: async () => positions.shift() ?? 0.3,
  } as unknown as BinanceUsdMAdapter;
  const reconciler = new BinanceReconciler(adapter, store, false);
  const first: CopySegment = { kind: "ENTRY", side: "BUY", quantity: 0.1, reduceOnly: false };
  const second: CopySegment = { kind: "ENTRY", side: "BUY", quantity: 0.2, reduceOnly: false };

  const afterOrder = (tradeIntent: CopyIntent, segment: CopySegment, clientOrderId: string) => reconciler.afterOrder({
    intent: tradeIntent,
    segmentIndex: 0,
    segment,
    result: { clientOrderId, status: "FILLED" },
    expectedPositionAfter: 999,
  });

  assert.deepEqual(await afterOrder(intent("0x1111111111111111111111111111111111111111", "source-one"), first, "copy-one"), { ok: true });
  assert.deepEqual(await afterOrder(intent("0x2222222222222222222222222222222222222222", "source-two"), second, "copy-two"), { ok: true });
  assert.equal(store.expectedPosition("BTCUSDT"), 0.3);
  assert.equal(store.unresolvedOrders().length, 0);
  store.close();
});

test("preflight rejects Binance Hedge Mode", async () => {
  const store = new CopyRunnerStore(":memory:");
  const adapter = { isHedgeMode: async () => true } as unknown as BinanceUsdMAdapter;
  const result = await new BinanceReconciler(adapter, store, false).preflight(["BTCUSDT"]);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /One-way Mode/);
  store.close();
});
