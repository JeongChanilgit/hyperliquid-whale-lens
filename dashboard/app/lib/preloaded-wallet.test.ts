import assert from "node:assert/strict";
import test from "node:test";
import { isUsablePreloadedWalletBundle } from "./index";

const address = "0x1111111111111111111111111111111111111111";

const bundle = (events: unknown[], fillCount: number) => ({
  address,
  fills: [],
  events,
  episodes: [],
  coverage: { complete: true, fillCount },
});

test("accepts a complete preload whose display events cover every fill", () => {
  assert.equal(isUsablePreloadedWalletBundle(bundle([{}], 1), address), true);
});

test("rejects a stale complete preload that would render an empty or partial log", () => {
  assert.equal(isUsablePreloadedWalletBundle(bundle([], 1), address), false);
  assert.equal(isUsablePreloadedWalletBundle(bundle([{}], 2), address), false);
});

test("rejects a preload for another wallet", () => {
  assert.equal(isUsablePreloadedWalletBundle(bundle([], 0), "0x2222222222222222222222222222222222222222"), false);
});
