import test from "node:test";
import assert from "node:assert/strict";
import { HyperliquidLiveExecutionPort } from "./live-port.mjs";

const source = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";

class FakeBridge {
  constructor() { this.calls = []; }
  async request(operation, payload = {}) {
    this.calls.push({ operation, payload });
    if (operation === "preflight") return { ok: true, accountValueUsd: 100, openOrders: [{ oid: "9", cloid: "0x99999999999999999999999999999999", coin: "BTC" }] };
    return { signedPayload: { action: { type: operation }, nonce: this.calls.length, signature: { r: "0x1", s: "0x2", v: 27 } } };
  }
  close() {}
}

class FakeTransport {
  constructor() { this.posts = []; }
  async postAction(payload) {
    this.posts.push(payload);
    const type = payload.action.type;
    if (type === "signProtectedIoc" || type === "signUpsertOrder") {
      return { type: "action", payload: { status: "ok", response: { data: { statuses: [{ filled: { oid: 1, totalSz: "0.2", avgPx: "100" } }] } } } };
    }
    return { type: "action", payload: { status: "ok", response: { data: { statuses: [] } } };
  }
}

test("live port signs through sidecar and posts on attached target socket", async () => {
  const bridge = new FakeBridge();
  const transport = new FakeTransport();
  const port = new HyperliquidLiveExecutionPort({
    pairId: "p1",
    sourceAddress: source,
    targetAddress: target,
    bridge,
  });
  port.attachActionTransport(transport);
  await port.registerPair();
  assert.equal(bridge.calls[0].operation, "preflight");
  assert.equal(bridge.calls[1].operation, "signCancelOrder");
  assert.equal(transport.posts.length, 1);

  const result = await port.protectedIoc({
    coin: "BTC",
    deltaSize: 0.2,
    markPriceUsd: 100,
    maxSlippageBps: 50,
    desiredSignedSize: 1.2,
    actualSignedSize: 1,
    reduceOnly: false,
    leverage: { type: "cross", value: 10 },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.actualSignedSize, 1.2);
  assert.equal(bridge.calls.at(-1).operation, "signProtectedIoc");
  assert.equal(transport.posts.length, 2);
});
