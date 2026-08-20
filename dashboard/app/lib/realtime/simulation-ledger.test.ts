import assert from "node:assert/strict";
import test from "node:test";
import { CopySimulationLedger } from "./simulation-ledger";
import type { HyperliquidRealtimeFill, WhaleConfig } from "../copy-types";

const whale: WhaleConfig = { address: "0x1111111111111111111111111111111111111111", copyRatio: 1 };
const otherWhale: WhaleConfig = { address: "0x2222222222222222222222222222222222222222", copyRatio: 1 };
const fill = (time: number, startPosition: number, side: "B" | "A", sz: number, px: number): HyperliquidRealtimeFill => ({
  coin: "BTC",
  time,
  startPosition: String(startPosition),
  side,
  sz: String(sz),
  px: String(px),
  fee: "0",
});

test("ledger keeps one episode across partial entry and partial exits", () => {
  const ledger = new CopySimulationLedger();
  assert.equal(ledger.apply(whale, fill(1, 0, "B", 2, 100)).intent?.segments[0]?.kind, "ENTRY");
  assert.equal(ledger.apply(whale, fill(2, 2, "B", 1, 110)).intent?.segments[0]?.kind, "ADD");
  const partial = ledger.apply(whale, fill(3, 3, "A", 1, 120));
  assert.equal(partial.intent?.segments[0]?.kind, "REDUCE");
  assert.ok(Math.abs(partial.realizedPnl - (120 - (310 / 3))) < 1e-9);
  const close = ledger.apply(whale, fill(4, 2, "A", 2, 90));
  assert.equal(close.intent?.segments[0]?.kind, "CLOSE");
  assert.equal(close.followerPositionAfter, 0);
});

test("each whale owns an isolated paper wallet and position ledger", () => {
  const ledger = new CopySimulationLedger();
  ledger.apply(whale, fill(1, 0, "B", 1, 100));
  ledger.apply(otherWhale, fill(2, 0, "A", 2, 200));
  const firstClose = ledger.apply(whale, fill(3, 1, "A", 1, 120));
  assert.equal(firstClose.realizedPnl, 20);
  assert.equal(ledger.getFollowerPosition(whale.address, "BTC"), 0);
  assert.equal(ledger.getFollowerPosition(otherWhale.address, "BTC"), -2);
});

test("ledger splits a source reversal into close and new entry", () => {
  const ledger = new CopySimulationLedger();
  ledger.apply(whale, fill(1, 0, "B", 2, 100));
  const reversal = ledger.apply(whale, fill(2, 2, "A", 5, 110));
  assert.deepEqual(reversal.intent?.segments.map((segment) => segment.kind), ["CLOSE", "ENTRY"]);
  assert.equal(reversal.followerPositionAfter, -3);
  assert.equal(reversal.fills.length, 2);
  assert.equal(reversal.fills[0]?.realizedPnl, 20);
});

test("ledger never copies a startup carry-in episode but resumes from a new flat entry", () => {
  const ledger = new CopySimulationLedger();
  const carryClose = ledger.apply(whale, fill(1, 5, "A", 5, 100));
  assert.equal(carryClose.copied, false);
  assert.equal(carryClose.ignoredReason, "CARRY_IN");
  const nextEpisode = ledger.apply(whale, fill(2, 0, "A", 2, 100));
  assert.equal(nextEpisode.copied, true);
  assert.equal(nextEpisode.followerPositionAfter, -2);
});

test("a carry-in reversal ignores the old close and copies only the new opposite position", () => {
  const ledger = new CopySimulationLedger();
  const reversal = ledger.apply(whale, fill(1, 5, "A", 8, 100));
  assert.equal(reversal.copied, true);
  assert.equal(reversal.followerPositionBefore, 0);
  assert.equal(reversal.followerPositionAfter, -3);
  assert.deepEqual(reversal.intent?.segments.map((segment) => segment.kind), ["ENTRY"]);
});

test("session-time additions to a carry-in are copied without adopting the startup balance", () => {
  const ledger = new CopySimulationLedger();
  const options = { copyCarryInAdds: true };
  const added = ledger.apply(whale, fill(1, 5, "B", 2, 100), undefined, options);
  assert.equal(added.copied, true);
  assert.equal(added.sourcePositionAfter, 7);
  assert.equal(added.followerPositionAfter, 2);
  assert.equal(added.intent?.segments[0]?.kind, "ENTRY");
  assert.equal(ledger.getPositionSnapshot(whale.address, "BTC")?.trackedSourcePosition, 2);

  const partial = ledger.apply(whale, fill(2, 7, "A", 1, 110), undefined, options);
  assert.equal(partial.intent?.segments[0]?.kind, "REDUCE");
  assert.equal(partial.followerPositionAfter, 1);
  assert.equal(ledger.getPositionSnapshot(whale.address, "BTC")?.trackedSourcePosition, 1);

  const closesOnlyTrackedAmount = ledger.apply(whale, fill(3, 6, "A", 4, 120), undefined, options);
  assert.equal(closesOnlyTrackedAmount.intent?.segments[0]?.kind, "CLOSE");
  assert.equal(closesOnlyTrackedAmount.sourcePositionAfter, 2);
  assert.equal(closesOnlyTrackedAmount.followerPositionAfter, 0);
  assert.equal(ledger.getPositionSnapshot(whale.address, "BTC")?.trackedSourcePosition, 0);

  const laterAdd = ledger.apply(whale, fill(4, 2, "B", 3, 130), undefined, options);
  assert.equal(laterAdd.intent?.segments[0]?.kind, "ENTRY");
  assert.equal(laterAdd.followerPositionAfter, 3);
  assert.equal(ledger.getPositionSnapshot(whale.address, "BTC")?.trackedSourcePosition, 3);
});

test("paper startup synchronizes carry-in positions at the source entry price and copies later reductions", () => {
  const ledger = new CopySimulationLedger();
  const sizing = {
    sourceAccountValueUsd: 10_000,
    allocatedFollowerCapitalUsd: 1_000,
    followerAccountValueUsd: 1_000,
    maxLeverage: 20,
  };
  const synchronized = ledger.synchronizeCarryInPositions(whale, [{
    coin: "BTC",
    signedSize: 5,
    positionValueUsd: 500,
    entryPriceUsd: 80,
  }], sizing, 10);
  assert.equal(synchronized[0]?.followerPosition, 0.5);
  assert.equal(synchronized[0]?.averageEntryPrice, 80);
  assert.equal(synchronized[0]?.copyingEpisode, true);

  const reduction = ledger.apply(whale, fill(11, 5, "A", 2, 120), sizing);
  assert.equal(reduction.copied, true);
  assert.equal(reduction.intent?.segments[0]?.kind, "REDUCE");
  assert.ok(Math.abs(reduction.followerPositionAfter - 0.3) < 1e-9);
  assert.ok(Math.abs(reduction.realizedPnl - 8) < 1e-9);
});

test("paper startup skips a carry-in whose source entry price is unavailable", () => {
  const ledger = new CopySimulationLedger();
  const synchronized = ledger.synchronizeCarryInPositions(whale, [{
    coin: "BTC",
    signedSize: 5,
    positionValueUsd: 500,
  }], {
    sourceAccountValueUsd: 10_000,
    allocatedFollowerCapitalUsd: 1_000,
  }, 10);
  assert.equal(synchronized[0]?.followerPosition, 0);
  assert.equal(synchronized[0]?.copyingEpisode, false);
});

test("carry-in synchronization applies the leverage cap to the whole whale portfolio", () => {
  const ledger = new CopySimulationLedger();
  const synchronized = ledger.synchronizeCarryInPositions(whale, [
    { coin: "BTC", signedSize: 15, positionValueUsd: 15_000, entryPriceUsd: 900 },
    { coin: "ETH", signedSize: -15, positionValueUsd: 15_000, entryPriceUsd: 1_100 },
  ], {
    sourceAccountValueUsd: 1_000,
    allocatedFollowerCapitalUsd: 1_000,
    followerAccountValueUsd: 1_000,
    maxLeverage: 20,
  }, 10);
  const grossNotional = synchronized.reduce((sum, position) => sum + Math.abs(position.followerPosition) * position.averageEntryPrice, 0);
  assert.ok(Math.abs(grossNotional - 20_000) < 1e-9);
  assert.ok(synchronized.every((position) => Math.abs(position.followerPosition) - 10 < 1e-9));
});

test("equity-ratio sizing matches source exposure within the whale capital allocation", () => {
  const ledger = new CopySimulationLedger();
  const entry = ledger.apply(whale, fill(1, 0, "B", 2, 100), {
    sourceAccountValueUsd: 10_000,
    allocatedFollowerCapitalUsd: 1_000,
  });
  assert.equal(entry.sourceExposurePct, 2);
  assert.equal(entry.sourcePositionNotionalUsd, 200);
  assert.equal(entry.targetFollowerNotionalUsd, 20);
  assert.equal(entry.followerPositionAfter, 0.2);

  const partialExit = ledger.apply(whale, fill(2, 2, "A", 1, 120), {
    sourceAccountValueUsd: 10_000,
    allocatedFollowerCapitalUsd: 1_000,
  });
  assert.equal(partialExit.intent?.segments[0]?.kind, "REDUCE");
  assert.equal(partialExit.followerPositionAfter, 0.1);
});

test("equity-ratio sizing fails closed without account value and catches up on the next fill", () => {
  const ledger = new CopySimulationLedger();
  const skipped = ledger.apply(whale, fill(1, 0, "B", 2, 100), {
    sourceAccountValueUsd: 0,
    allocatedFollowerCapitalUsd: 1_000,
  });
  assert.equal(skipped.copied, false);
  assert.equal(skipped.ignoredReason, "SIZING_DATA_UNAVAILABLE");

  const caughtUp = ledger.apply(whale, fill(2, 2, "B", 1, 100), {
    sourceAccountValueUsd: 10_000,
    allocatedFollowerCapitalUsd: 1_000,
  });
  assert.equal(caughtUp.intent?.segments[0]?.kind, "ENTRY");
  assert.ok(Math.abs(caughtUp.followerPositionAfter - 0.3) < 1e-9);
});

test("equity-ratio sizing limits target notional to configured follower leverage", () => {
  const ledger = new CopySimulationLedger();
  const leveraged = ledger.apply(whale, fill(1, 0, "B", 30, 1_000), {
    sourceAccountValueUsd: 1_000,
    allocatedFollowerCapitalUsd: 1_000,
    maxLeverage: 20,
  });
  assert.equal(leveraged.requestedTargetFollowerNotionalUsd, 30_000);
  assert.equal(leveraged.targetFollowerNotionalUsd, 20_000);
  assert.equal(leveraged.followerLeverage, 20);
  assert.equal(leveraged.leverageCapped, true);
  assert.equal(leveraged.followerPositionAfter, 20);
});

test("equity-ratio sizing uses current follower equity and exposes unrealized PnL", () => {
  const ledger = new CopySimulationLedger();
  const entry = ledger.apply(whale, fill(1, 0, "B", 2, 100), {
    sourceAccountValueUsd: 10_000,
    allocatedFollowerCapitalUsd: 1_000,
    followerAccountValueUsd: 1_200,
  });
  assert.equal(entry.followerAccountValueUsd, 1_200);
  assert.equal(entry.followerPositionAfter, 0.24);
  assert.ok(Math.abs(ledger.getUnrealizedPnl(whale.address, () => 110) - 2.4) < 1e-9);
});
