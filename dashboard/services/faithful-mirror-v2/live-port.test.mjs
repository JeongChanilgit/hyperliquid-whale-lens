import test from "node:test";
import assert from "node:assert/strict";
import { HyperliquidLiveExecutionPort } from "./live-port.mjs";
import { canonicalTargetCloid } from "./domain.mjs";

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
    return { type: "action", payload: { status: "ok", response: { data: { statuses: [] } } } };
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

  const margin = await port.adjustIsolatedMargin({ coin: "BTC", marginDeltaUsd: 1, targetMarginUsd: 2 });
  assert.equal(margin.accepted, true);
  const request = bridge.calls.at(-1);
  assert.equal(request.operation, "signAdjustIsolatedMargin");
  assert.equal(request.payload.isBuy, true);
  assert.equal(request.payload.positionSide, "LONG");

  port.onTargetFill({ fill: { coin: "ETH", side: "A", size: 0.3, startPosition: "0" } });
  const shortMargin = await port.adjustIsolatedMargin({ coin: "ETH", marginDeltaUsd: 1, targetMarginUsd: 2 });
  assert.equal(shortMargin.accepted, true);
  assert.equal(bridge.calls.at(-1).payload.isBuy, false);
  assert.equal(bridge.calls.at(-1).payload.positionSide, "SHORT");

  port.onTargetOrder({ update: { targetOrderId: "shadow-fill", status: "FILLED", positionAfter: 0.4, order: { coin: "SOL" } } });
  await port.adjustIsolatedMargin({ coin: "SOL", marginDeltaUsd: 1, targetMarginUsd: 2 });
  assert.equal(bridge.calls.at(-1).payload.isBuy, true);
  await assert.rejects(() => port.adjustIsolatedMargin({ coin: "AVAX", marginDeltaUsd: 1, targetMarginUsd: 2 }), /Cannot determine isolated position side/);
});

test("live preflight retains a validated recovered Cloid and only cleans unknown target orders", async () => {
  const knownCloid = canonicalTargetCloid("recovery-live", "source-open-1");
  const bridge = {
    calls: [],
    async request(operation, payload = {}) {
      this.calls.push({ operation, payload });
      if (operation === "preflight") {
        return {
          ok: true,
          openOrders: [
            { oid: "known-oid", cloid: knownCloid, coin: "BTC", status: "open" },
            { oid: "unknown-oid", cloid: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", coin: "ETH", status: "open" },
          ],
        };
      }
      return { signedPayload: { action: { type: operation }, nonce: this.calls.length, signature: { r: "0x1", s: "0x2", v: 27 } } };
    },
    close() {},
  };
  const port = new HyperliquidLiveExecutionPort({ pairId: "recovery-live", sourceAddress: source, targetAddress: target, bridge });
  const transport = new FakeTransport();
  port.attachActionTransport(transport);
  assert.deepEqual(port.restoreOrderOwnership({ sourceOrderToTargetCloid: { "source-open-1": knownCloid } }), { accepted: true, recoveredOrders: 1 });
  await port.registerPair();
  const cancellations = bridge.calls.filter((call) => call.operation === "signCancelOrder");
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].payload.cloid, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(transport.posts.length, 1);
  assert.throws(() => port.restoreOrderOwnership({ sourceOrderToTargetCloid: { "source-open-1": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }), /non-canonical/);
});

test("target-authoritative LONG and SHORT state reaches isolated-margin signer inputs", async () => {
  const bridge = new FakeBridge();
  const transport = new FakeTransport();
  const port = new HyperliquidLiveExecutionPort({ pairId: "side-e2e", sourceAddress: source, targetAddress: target, bridge });
  port.attachActionTransport(transport);
  port.onTargetSnapshot({ positions: [{ coin: "BTC", signedSize: 0.4 }, { coin: "ETH", signedSize: -0.3 }] });
  await port.adjustIsolatedMargin({ coin: "BTC", marginDeltaUsd: 1, targetMarginUsd: 2 });
  assert.equal(bridge.calls.at(-1).payload.isBuy, true);
  assert.equal(bridge.calls.at(-1).payload.positionSide, "LONG");
  await port.adjustIsolatedMargin({ coin: "ETH", marginDeltaUsd: 1, targetMarginUsd: 2 });
  assert.equal(bridge.calls.at(-1).payload.isBuy, false);
  assert.equal(bridge.calls.at(-1).payload.positionSide, "SHORT");
  port.onTargetFill({ fill: { coin: "SOL", side: "A", size: 0.2, startPosition: "0" } });
  await port.adjustIsolatedMargin({ coin: "SOL", marginDeltaUsd: 1, targetMarginUsd: 2 });
  assert.equal(bridge.calls.at(-1).payload.isBuy, false);
  assert.equal(bridge.calls.at(-1).payload.positionSide, "SHORT");
});
