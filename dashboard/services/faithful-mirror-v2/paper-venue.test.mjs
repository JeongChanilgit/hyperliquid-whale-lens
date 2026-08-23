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
