import assert from "node:assert/strict";
import test from "node:test";
import { classifyTradingEvents } from "./trading-events";
import { tradingEventLabel } from "./trading-labels";

test("labels entries, adds, and partial closes with long or short direction", () => {
  const plain = { isLossClose: false, isTriggerStop: false };
  assert.equal(tradingEventLabel({ ...plain, actions: ["LONG_ENTRY"] }), "롱 진입");
  assert.equal(tradingEventLabel({ ...plain, actions: ["SHORT_ENTRY"] }), "숏 진입");
  assert.equal(tradingEventLabel({ ...plain, actions: ["LONG_ADD"] }), "롱 추가진입");
  assert.equal(tradingEventLabel({ ...plain, actions: ["SHORT_ADD"] }), "숏 추가진입");
  assert.equal(tradingEventLabel({ ...plain, actions: ["LONG_REDUCE"] }), "롱 부분청산");
  assert.equal(tradingEventLabel({ ...plain, actions: ["SHORT_REDUCE"] }), "숏 부분청산");
});

test("labels closes, stop losses, and reversals with their direction", () => {
  assert.equal(
    tradingEventLabel({ actions: ["LONG_CLOSE"], isLossClose: false, isTriggerStop: false }, "$12"),
    "롱 청산 $12",
  );
  assert.equal(
    tradingEventLabel({ actions: ["SHORT_CLOSE"], isLossClose: true, isTriggerStop: false }, "-$7"),
    "숏 손실청산 -$7",
  );
  assert.equal(
    tradingEventLabel({ actions: ["LONG_CLOSE"], isLossClose: true, isTriggerStop: true }, "-$5"),
    "롱 손절 -$5",
  );
  assert.equal(
    tradingEventLabel({ actions: ["LONG_CLOSE", "SHORT_ENTRY"], isLossClose: false, isTriggerStop: false }, "$3"),
    "롱 청산 $3 → 숏 진입",
  );
});

test("uses a unique event id when multiple fills share a transaction hash", () => {
  const shared = {
    coin: "BTC",
    px: "100",
    sz: "1",
    time: 1_786_880_000_000,
    closedPnl: "0",
    fee: "0",
    hash: `0x${"0".repeat(64)}`,
  };
  const result = classifyTradingEvents([
    { ...shared, side: "B", startPosition: "0", tid: 1 },
    { ...shared, side: "A", startPosition: "1", tid: 2 },
  ]);
  assert.equal(result.events.length, 2);
  assert.notEqual(result.events[0]?.id, result.events[1]?.id);
});
