import test from "node:test";
import assert from "node:assert/strict";
import { loadFaithfulMirrorConfig } from "./config.mjs";

const pairJson = JSON.stringify([{
  pairId: "p1",
  sourceAddress: "0x1111111111111111111111111111111111111111",
  targetCapitalUsd: 100,
}]);

test("configuration requires a nonempty private control token", () => {
  assert.throws(() => loadFaithfulMirrorConfig({ FMV2_PAIRS_JSON: pairJson }), /at least 16/);
  const config = loadFaithfulMirrorConfig({
    FMV2_PAIRS_JSON: pairJson,
    FMV2_CONTROL_TOKEN: "0123456789abcdef",
  });
  assert.equal(config.mode, "SIMULATION");
  assert.equal(config.pairs.length, 1);
});

test("configuration enforces at most five whales", () => {
  const pairs = Array.from({ length: 6 }, (_, index) => ({
    sourceAddress: `0x${String(index + 1).repeat(40)}`,
    targetCapitalUsd: 100,
  }));
  assert.throws(() => loadFaithfulMirrorConfig({
    FMV2_PAIRS_JSON: JSON.stringify(pairs),
    FMV2_CONTROL_TOKEN: "0123456789abcdef",
  }), /1-5/);
});
