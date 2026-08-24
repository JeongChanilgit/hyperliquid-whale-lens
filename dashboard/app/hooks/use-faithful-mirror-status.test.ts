import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFaithfulMirrorSnapshot } from "./use-faithful-mirror-status";

test("Faithful Mirror status normalization keeps the UI read-only and tolerant of partial payloads", () => {
  const snapshot = normalizeFaithfulMirrorSnapshot({
    ok: true,
    connected: true,
    observedAt: "2026-08-24T10:00:00.000Z",
    stale: false,
    service: {
      mode: "LIVE",
      state: "RUNNING",
      liveGate: { state: "ARMED", configured: true, armed: true, canStart: true },
    },
    pairs: [{
      pairId: "whale-1",
      sourceAddress: "0xsource",
      targetAccountLabel: "Follower 01",
      targetAddressDisplay: "0x1234…abcd",
      source: { equityUsd: "1000", positions: [{ coin: "BTC" }] },
      target: { equityUsd: 995, orders: [{ coin: "BTC" }] },
      trackingDebt: null,
    }],
    events: [{ at: "not-a-time", type: "terminal_residual", details: null }],
  });

  assert.equal(snapshot.service.mode, "LIVE");
  assert.equal(snapshot.service.liveGate.canStart, false);
  assert.equal(snapshot.observedAt, Date.parse("2026-08-24T10:00:00.000Z"));
  assert.equal(snapshot.pairs[0].source.equityUsd, 1000);
  assert.equal(snapshot.pairs[0].target.orders.length, 1);
  assert.deepEqual(snapshot.pairs[0].trackingDebt, {});
  assert.equal(snapshot.events[0].at, null);
});

test("Faithful Mirror status normalization surfaces missing service data as unknown instead of inventing readiness", () => {
  const snapshot = normalizeFaithfulMirrorSnapshot({ connected: false, stale: true, staleReason: "loopback unavailable" });
  assert.equal(snapshot.connected, false);
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.service.mode, "UNKNOWN");
  assert.equal(snapshot.service.running, false);
  assert.equal(snapshot.service.liveGate.canStart, false);
  assert.equal(snapshot.pairs.length, 0);
});
