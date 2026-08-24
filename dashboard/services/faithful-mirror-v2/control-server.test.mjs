import assert from "node:assert/strict";
import test from "node:test";
import { createControlServer, isControlTokenMatch } from "./control-server.mjs";

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
