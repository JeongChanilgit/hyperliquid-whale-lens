import test from "node:test";
import assert from "node:assert/strict";
import { FiveWhaleFaithfulMirrorEngine } from "./engine.mjs";

const address = (value) => `0x${Number(value).toString(16).padStart(40, "0")}`;
const execution = () => ({
  registerPair: async () => ({ accepted: true }),
  setLeverage: async () => ({ accepted: true }),
  upsertOrder: async () => ({ accepted: true, status: "OPEN" }),
  cancelOrder: async () => ({ accepted: true }),
  protectedIoc: async (request) => ({ accepted: true, actualSignedSize: request.desiredSignedSize }),
  adjustIsolatedMargin: async () => ({ accepted: true }),
});

test("engine rejects more than five whales and duplicate targets", () => {
  const six = Array.from({ length: 6 }, (_, index) => ({
    pairId: `p${index}`,
    sourceAddress: address(String(index + 1)),
    targetAddress: address(String(index + 2)),
  }));
  assert.throws(() => new FiveWhaleFaithfulMirrorEngine({
    pairs: six,
    executionFactory: execution,
  }), /1-5/);

  assert.throws(() => new FiveWhaleFaithfulMirrorEngine({
    pairs: [
      { pairId: "a", sourceAddress: address("1"), targetAddress: address("3") },
      { pairId: "b", sourceAddress: address("2"), targetAddress: address("3") },
    ],
    executionFactory: execution,
  }), /Duplicate target/);
});

test("engine permits one through five fully separated pairs and rejects duplicate sources or self-pairs", () => {
  const five = Array.from({ length: 5 }, (_, index) => ({
    pairId: `p${index + 1}`,
    sourceAddress: address(String(index + 1)),
    targetAddress: address(String(index + 6)),
  }));
  const engine = new FiveWhaleFaithfulMirrorEngine({ pairs: five, executionFactory: execution });
  assert.equal(Object.keys(engine.snapshot().pairs).length, 5);
  engine.stop();

  assert.throws(() => new FiveWhaleFaithfulMirrorEngine({
    pairs: [
      { pairId: "a", sourceAddress: address("1"), targetAddress: address("6") },
      { pairId: "b", sourceAddress: address("1"), targetAddress: address("7") },
    ],
    executionFactory: execution,
  }), /Duplicate source/);
  assert.throws(() => new FiveWhaleFaithfulMirrorEngine({
    pairs: [{ pairId: "self", sourceAddress: address("1"), targetAddress: address("1") }],
    executionFactory: execution,
  }), /must differ/);
});

test("terminal pair dispatch is a non-error no-op for queued source and mark events", async () => {
  const sourceAddress = address("41");
  const targetAddress = address("42");
  const engine = new FiveWhaleFaithfulMirrorEngine({
    pairs: [{ pairId: "terminal", sourceAddress, targetAddress }],
    executionFactory: execution,
  });
  const actor = engine.actorsByPair.get("terminal");
  let actorCalls = 0;
  for (const name of ["onSourceSnapshot", "onSourceFill", "onSourceOrder", "onTargetSnapshot", "onTargetFill", "onTargetOrder", "syncSourceOrders", "syncTargetOrders", "onCurrentMark"]) {
    actor[name] = async () => { actorCalls += 1; };
  }
  actor.stop();
  assert.equal(engine.isPairTerminal("terminal"), true);
  assert.deepEqual(engine.onSourceSnapshot(sourceAddress, {}), { ignored: true, reason: "PAIR_TERMINAL" });
  assert.deepEqual(engine.onSourceFill(sourceAddress, {}), { ignored: true, reason: "PAIR_TERMINAL" });
  assert.deepEqual(await engine.onSourceOrder(sourceAddress, {}), { ignored: true, reason: "PAIR_TERMINAL" });
  assert.deepEqual(engine.onCurrentMark(sourceAddress, "BTC", 100), { ignored: true, reason: "PAIR_TERMINAL" });
  assert.deepEqual(engine.onTargetSnapshot(targetAddress, {}), { ignored: true, reason: "PAIR_TERMINAL" });
  assert.deepEqual(engine.onTargetFill(targetAddress, {}), { ignored: true, reason: "PAIR_TERMINAL" });
  assert.deepEqual(engine.onTargetOrder(targetAddress, {}), { ignored: true, reason: "PAIR_TERMINAL" });
  assert.deepEqual(await engine.syncSourceOrders(sourceAddress, []), { ignored: true, reason: "PAIR_TERMINAL" });
  assert.deepEqual(engine.syncTargetOrders(targetAddress, []), { ignored: true, reason: "PAIR_TERMINAL" });
  assert.equal(actorCalls, 0);
  engine.stop();
});
