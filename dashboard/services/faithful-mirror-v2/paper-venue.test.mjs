import test from "node:test";
import assert from "node:assert/strict";
import { PaperExecutionPort, walkBook } from "./paper-venue.mjs";

const targetSnapshot = {
  accountEquityUsd: 100,
  marginPools: { default: { equityUsd: 100 } },
  positions: [],
};

test("book walking computes volume-weighted fill and residual", () => {
  const result = walkBook({
    side: "BUY",
    size: 3,
    asks: [[100, 1], [101, 1], [102, 1]],
    bids: [],
    limitPrice: 101,
  });
  assert.equal(result.filledSize, 2);
  assert.equal(result.averagePrice, 100.5);
  assert.equal(result.unfilledSize, 1);
});

test("paper resting order respects queue ahead before receiving fills", async () => {
  let now = 1_000;
  const venue = new PaperExecutionPort({ now: () => now });
  venue.registerPair("p1", targetSnapshot);
  venue.setBook("BTC", { bids: [[99, 2]], asks: [[101, 2]] });
  await venue.upsertOrder({
    pairId: "p1",
    order: {
      targetOrderId: "o1",
      coin: "BTC",
      side: "BUY",
      price: 99,
      quantity: 1,
      tif: "GTC",
      reduceOnly: false,
    },
  });
  venue.applyPublicTrade({ pairId: "p1", coin: "BTC", price: 99, size: 1.5, aggressorSide: "SELL" });
  assert.equal(venue.getSnapshot("p1").positions.length, 0);
  venue.applyPublicTrade({ pairId: "p1", coin: "BTC", price: 99, size: 2, aggressorSide: "SELL" });
  assert.equal(venue.getSnapshot("p1").positions[0].signedSize, 1);
});

test("paper equity reflects realized, unrealized and fees", async () => {
  const venue = new PaperExecutionPort({ takerFeeRate: 0 });
  venue.registerPair("p2", targetSnapshot);
  venue.setBook("ETH", { bids: [[99, 10]], asks: [[100, 10]] });
  await venue.protectedIoc({ pairId: "p2", coin: "ETH", deltaSize: 1, markPriceUsd: 100, poolId: "default", leverage: { type: "cross", value: 2 } });
  venue.setBook("ETH", { bids: [[109, 10]], asks: [[111, 10]] });
  assert.equal(venue.getPerformance("p2").unrealizedPnlUsd, 10);
  assert.equal(venue.getSnapshot("p2").accountEquityUsd, 110);
  await venue.protectedIoc({ pairId: "p2", coin: "ETH", deltaSize: -1, markPriceUsd: 110, maxSlippageBps: 100, poolId: "default", leverage: { type: "cross", value: 2 } });
  assert.equal(venue.getPerformance("p2").realizedPnlUsd, 9);
  assert.equal(venue.getSnapshot("p2").accountEquityUsd, 109);
});

test("paper resting fills return target fill events and funding updates equity", async () => {
  const venue = new PaperExecutionPort({ makerFeeRate: 0, takerFeeRate: 0 });
  venue.registerPair("p3", targetSnapshot);
  venue.setBook("BTC", { bids: [[99, 2]], asks: [[101, 2]] });
  await venue.upsertOrder({ pairId: "p3", order: {
    targetOrderId: "rest-1",
    coin: "BTC",
    side: "BUY",
    price: 99,
    quantity: 1,
    tif: "GTC",
    reduceOnly: false,
    poolId: "default",
    leverage: { type: "cross", value: 2 },
  } });
  const fills = venue.applyPublicTrade({ pairId: "p3", coin: "BTC", price: 99, size: 3, aggressorSide: "SELL" });
  assert.equal(fills.length, 1);
  assert.equal(fills[0].positionAfter, 1);
  venue.applyFunding({ pairId: "p3", coin: "BTC", amountUsd: 2 });
  assert.equal(venue.getPerformance("p3").fundingUsd, 2);
  assert.equal(venue.getSnapshot("p3").accountEquityUsd, 102);
});

test("paper model rejects sub-minimum or undercollateralized fills and exposes approximate liquidation metadata", async () => {
  const venue = new PaperExecutionPort({ minNotionalUsd: 10, maintenanceMarginRatio: 0.05 });
  venue.registerPair("risk", targetSnapshot);
  venue.setBook("BTC", { bids: [[99, 10]], asks: [[100, 10]] });
  const small = await venue.protectedIoc({ pairId: "risk", coin: "BTC", deltaSize: 0.05, markPriceUsd: 100, leverage: { type: "cross", value: 2 } });
  assert.equal(small.accepted, false);
  assert.equal(small.reason, "MIN_NOTIONAL");

  const initial = await venue.protectedIoc({ pairId: "risk", coin: "BTC", deltaSize: 1, markPriceUsd: 100, leverage: { type: "cross", value: 2 } });
  assert.equal(initial.filledSize, 1);
  const insufficient = await venue.protectedIoc({ pairId: "risk", coin: "BTC", deltaSize: 2, markPriceUsd: 100, leverage: { type: "cross", value: 2 } });
  assert.equal(insufficient.accepted, false);
  assert.equal(insufficient.filledSize, 0);
  const snapshot = venue.getSnapshot("risk");
  assert.equal(snapshot.simulationModelVersion, "FMV2_PAPER_APPROX_MARGIN_V1");
  assert.equal(snapshot.liquidationModel, "APPROXIMATE");
  assert.equal(snapshot.marginState.status, "LIQUIDATION_RISK_BLOCKED");
  const reducing = await venue.protectedIoc({ pairId: "risk", coin: "BTC", deltaSize: -0.5, markPriceUsd: 99, reduceOnly: true, leverage: { type: "cross", value: 2 } });
  assert.equal(reducing.filledSize, 0.5);
  assert.equal(reducing.actualSignedSize, 0.5);
  venue.applyFunding({ pairId: "risk", coin: "BTC", amountUsd: -200 });
  assert.equal(venue.getSnapshot("risk").marginState.status, "NEGATIVE_EQUITY");
});

test("paper tracks isolated leverage and accepts an explicit isolated-margin allocation after the position exists", async () => {
  const venue = new PaperExecutionPort({ takerFeeRate: 0 });
  venue.registerPair("isolated", targetSnapshot);
  venue.setBook("ETH", { bids: [[99, 10]], asks: [[100, 10]] });
  assert.equal((await venue.setLeverage({ pairId: "isolated", coin: "ETH", leverage: { type: "isolated", value: 5 } })).accepted, true);
  assert.equal((await venue.protectedIoc({ pairId: "isolated", coin: "ETH", deltaSize: 1, markPriceUsd: 100, leverage: { type: "isolated", value: 5 } })).filledSize, 1);
  assert.equal((await venue.adjustIsolatedMargin({ pairId: "isolated", coin: "ETH", targetMarginUsd: 40 })).accepted, true);
  const position = venue.getSnapshot("isolated").positions[0];
  assert.deepEqual(position.leverage, { type: "isolated", value: 5 });
  assert.equal(position.marginUsedUsd, 40);
});

test("paper ALO rejects a crossing order and IOC obeys the slippage cap with partial depth", async () => {
  const venue = new PaperExecutionPort({ takerFeeRate: 0 });
  venue.registerPair("book", targetSnapshot);
  venue.setBook("SOL", { bids: [[99, 10]], asks: [[100, 1], [102, 10]] });
  const alo = await venue.upsertOrder({ pairId: "book", order: { targetOrderId: "alo", coin: "SOL", side: "BUY", price: 100, quantity: 1, tif: "ALO" } });
  assert.equal(alo.reason, "ALO_WOULD_CROSS");
  const ioc = await venue.protectedIoc({ pairId: "book", coin: "SOL", deltaSize: 3, markPriceUsd: 100, maxSlippageBps: 50, leverage: { type: "cross", value: 10 } });
  assert.equal(ioc.filledSize, 1);
  assert.equal(ioc.unfilledSize, 2);
});
