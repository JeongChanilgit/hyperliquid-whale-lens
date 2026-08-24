import assert from "node:assert/strict";
import test from "node:test";
import { createControlServer, isControlTokenMatch, normalizeControlEvent } from "./control-server.mjs";

const token = "control-token-at-least-16";

test("control server exposes public health and authenticates all lifecycle controls", async (t) => {
  const calls = [];
  const lifecycle = {
    async status() { return { state: "STOPPED" }; },
    async arm(body) { calls.push(["arm", body]); return { state: "ARMED" }; },
    async start(body) { calls.push(["start", body]); return { state: "RUNNING" }; },
    async stop(body) { calls.push(["stop", body]); return { state: "STOPPED" }; },
    async kill(body) { calls.push(["kill", body]); return { state: "KILLED" }; },
    async reconcile(body) { calls.push(["reconcile", body]); return { accepted: true }; },
  };
  const control = createControlServer({ lifecycle, host: "127.0.0.1", port: 0, controlToken: token });
  t.after(() => control.close());
  const address = await control.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "faithful-mirror-v2" });
  assert.equal((await fetch(`${base}/status`)).status, 401);
  const status = await fetch(`${base}/status`, { headers: { "x-fmv2-control-token": token } });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).status.state, "STOPPED");
  const arm = await fetch(`${base}/arm`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fmv2-control-token": token },
    body: JSON.stringify({ confirmation: "I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS" }),
  });
  assert.equal(arm.status, 200);
  assert.deepEqual(calls, [["arm", { confirmation: "I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS" }]]);
  assert.equal((await fetch(`${base}/kill`, { method: "POST", headers: { "x-fmv2-control-token": "wrong-token" } })).status, 401);
});

test("token check requires exact value and control server remains loopback-only", () => {
  assert.equal(isControlTokenMatch(token, token), true);
  assert.equal(isControlTokenMatch(`${token}x`, token), false);
  assert.equal(isControlTokenMatch("x".repeat(token.length), token), false);
  assert.throws(() => createControlServer({ lifecycle: { status() {} }, host: "0.0.0.0", controlToken: token }), /loopback/);
});

test("control server returns a bounded, normalized authenticated event feed", async (t) => {
  const requests = [];
  const auditStore = {
    async readRecentEvents({ limit }) {
      requests.push(limit);
      return [{
        at: 1_725_000_000_000,
        type: "TRACKING_DEBT",
        pairId: "pair-1",
        coin: "BTC",
        reason: "below minimum notional",
        desiredSize: 1.5,
        leakedToken: "must-not-cross-the-control-plane",
      }];
    },
  };
  const control = createControlServer({
    lifecycle: { async status() { return { state: "STOPPED" }; } },
    auditStore,
    host: "127.0.0.1",
    port: 0,
    controlToken: token,
  });
  t.after(() => control.close());
  const address = await control.listen();
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/events?limit=1000`)).status, 401);
  const response = await fetch(`${base}/events?limit=1000`, { headers: { "x-fmv2-control-token": token } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(requests, [200]);
  assert.deepEqual(body.events, [{
    at: 1_725_000_000_000,
    type: "TRACKING_DEBT",
    pairId: "pair-1",
    coin: "BTC",
    side: null,
    message: "below minimum notional",
    details: { reason: "below minimum notional", desiredSize: 1.5 },
  }]);
  assert.doesNotMatch(JSON.stringify(body), /must-not-cross-the-control-plane/);
});

test("event normalization only retains the display-safe allowlist", () => {
  assert.deepEqual(normalizeControlEvent({
    type: "SERVICE_START_FAILED",
    error: { message: "bridge rejected request" },
    privateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    nested: { token: "not-safe" },
  }), {
    at: null,
    type: "SERVICE_START_FAILED",
    pairId: null,
    coin: null,
    side: null,
    message: "bridge rejected request",
    details: {},
  });
  assert.deepEqual(normalizeControlEvent({
    type: "SERVICE_EVENT",
    accepted: true,
    message: "authorization=server-token-value 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }), {
    at: null,
    type: "SERVICE_EVENT",
    pairId: null,
    coin: null,
    side: null,
    message: "authorization=[REDACTED] [REDACTED]",
    details: { accepted: true },
  });
  assert.equal(
    normalizeControlEvent({ type: "PAIR_READY", message: "target 0x1111111111111111111111111111111111111111" }).message,
    "target [ADDRESS_REDACTED]",
  );
  assert.deepEqual(normalizeControlEvent({
    type: "TRACKING_DEBT",
    at: 42,
    pairId: "whale-1",
    detail: {
      coin: "BTC",
      side: "SELL",
      reason: "below minimum notional",
      residualBps: 13.5,
      targetAddress: "0x2222222222222222222222222222222222222222",
    },
  }), {
    at: 42,
    type: "TRACKING_DEBT",
    pairId: "whale-1",
    coin: "BTC",
    side: "SELL",
    message: "below minimum notional",
    details: { reason: "below minimum notional", residualBps: 13.5 },
  });
});
