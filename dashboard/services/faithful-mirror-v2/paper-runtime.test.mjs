import test from "node:test";
import assert from "node:assert/strict";
import { createPaperMirrorSystem } from "./paper-runtime.mjs";

const source = "0x1111111111111111111111111111111111111111";

test("paper system creates independent virtual targets and enforces five-whale cap", () => {
  const infoClient = {};
  const system = createPaperMirrorSystem({ pairs: [{ pairId: "a", sourceAddress: source, capitalUsd: 100 }], infoClient, WebSocketImpl: class {} });
  assert.equal(system.pairs.length, 1);
  assert.match(system.pairs[0].targetAddress, /^0x[a-f0-9]{40}$/);
  assert.equal(system.venues.size, 1);
  assert.throws(() => createPaperMirrorSystem({
    pairs: Array.from({ length: 6 }, (_, index) => ({ sourceAddress: `0x${String(index + 1).repeat(40)}`, capitalUsd: 100 })),
    infoClient,
    WebSocketImpl: class {},
  }), /1-5/);
});
