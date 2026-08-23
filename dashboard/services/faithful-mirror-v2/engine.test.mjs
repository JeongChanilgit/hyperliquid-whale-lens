import test from "node:test";
import assert from "node:assert/strict";
import { FiveWhaleFaithfulMirrorEngine } from "./engine.mjs";
import { PaperExecutionPort } from "./paper-venue.mjs";

const address = (digit) => `0x${digit.repeat(40)}`;

test("engine rejects more than five whales and duplicate targets", () => {
  const six = Array.from({ length: 6 }, (_, index) => ({
    pairId: `p${index}`,
    sourceAddress: address(String(index + 1)),
    targetAddress: address(String(index + 2)),
  }));
  assert.throws(() => new FiveWhaleFaithfulMirrorEngine({
    pairs: six,
    executionFactory: () => new PaperExecutionPort(),
  }), /1-5/);

  assert.throws(() => new FiveWhaleFaithfulMirrorEngine({
    pairs: [
      { pairId: "a", sourceAddress: address("1"), targetAddress: address("3") },
      { pairId: "b", sourceAddress: address("2"), targetAddress: address("3") },
    ],
    executionFactory: () => new PaperExecutionPort(),
  }), /Duplicate target/);
});
