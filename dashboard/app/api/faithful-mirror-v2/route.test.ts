import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "./route";

const savedBaseUrl = process.env.FMV2_BASE_URL;
const savedToken = process.env.FMV2_CONTROL_TOKEN;

const restoreEnvironment = () => {
  if (savedBaseUrl === undefined) delete process.env.FMV2_BASE_URL;
  else process.env.FMV2_BASE_URL = savedBaseUrl;
  if (savedToken === undefined) delete process.env.FMV2_CONTROL_TOKEN;
  else process.env.FMV2_CONTROL_TOKEN = savedToken;
};

test("faithful mirror route fails closed when its server-only bridge is absent", async (t) => {
  t.after(restoreEnvironment);
  delete process.env.FMV2_BASE_URL;
  delete process.env.FMV2_CONTROL_TOKEN;
  const response = await GET(new Request("http://localhost/api/faithful-mirror-v2"));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.connected, false);
  assert.equal(typeof body.observedAt, "number");
  assert.deepEqual({ ...body, observedAt: undefined }, {
    ok: false,
    connected: false,
    observedAt: undefined,
    stale: true,
    staleReason: "Faithful Mirror V2 loopback observability is not configured.",
    service: {
      mode: null,
      state: "DISCONNECTED",
      running: false,
      killed: false,
      sessionId: null,
      recoveryAvailable: false,
      liveGate: {
        state: "NOT_CONFIGURED",
        configured: false,
        armed: false,
        armExpiresAt: null,
        canStart: false,
        reason: "Faithful Mirror V2 loopback observability is not configured.",
      },
      policy: {
        verificationDelayMs: null,
        terminalVerificationDelayMs: null,
        targetToleranceBps: null,
        maxCatchUpSlippageBps: null,
        immediateResidualNotionalUsd: null,
        killOnTerminalResidual: null,
        paperMakerFeeRate: null,
        paperTakerFeeRate: null,
      },
    },
    pairs: [],
    events: [],
  });
});

test("faithful mirror route projects loopback status/events without sending the token to the browser", async (t) => {
  t.after(restoreEnvironment);
  process.env.FMV2_BASE_URL = "http://127.0.0.1:8790";
  process.env.FMV2_CONTROL_TOKEN = "server-only-control-token";
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    if (String(input).endsWith("/status")) {
      return Response.json({ ok: true, status: {
        mode: "LIVE",
        state: "STOPPED_UNARMED",
        running: false,
        killed: false,
        armed: false,
        armExpiresAt: null,
        sessionId: "session-safe-id",
        recoveryAvailable: true,
        config: {
          pairs: [{ pairId: "p1", sourceAddress: "0x1111111111111111111111111111111111111111", targetAddress: "0x2222222222222222222222222222222222222222", capitalUsd: 100 }],
          actorConfig: {
            verificationDelayMs: 250,
            terminalVerificationDelayMs: 1000,
            targetPositionToleranceBps: 5,
            maxCatchUpSlippageBps: 50,
            immediateResidualNotionalUsd: 10,
            killOnTerminalResidual: true,
          },
          paper: { makerFeeRate: 0.00015, takerFeeRate: 0.00045 },
        },
        snapshot: { pairs: { p1: {
          pairId: "p1",
          initialized: true,
          state: "RUNNING",
          sourceSnapshot: {
            accountMode: "STANDARD", accountEquityUsd: 200, receivedAt: Date.now(),
            marginPools: { main: { marginUsedUsd: 40, maintenanceMarginUsedUsd: 8, withdrawableUsd: 160 } },
            positions: [{ coin: "BTC", signedSize: 1, markPriceUsd: 100, marginUsedUsd: 40 }],
          },
          targetSnapshot: {
            accountMode: "STANDARD", accountEquityUsd: 100, receivedAt: Date.now(),
            marginState: { status: "HEALTHY", maintenanceMarginUsd: 4, approximateLiquidationRisk: false },
            positions: [{ coin: "BTC", signedSize: 0.5, markPriceUsd: 100, marginUsedUsd: 20 }],
          },
          sourceOrders: [{ id: "source-1", coin: "BTC", side: "BUY", price: 99, remainingSize: 1, secret: "remove" }],
          targetOrderState: [{ sourceOrderId: "source-1", targetOrderId: "target-1", coin: "BTC", side: "BUY", price: 99 }],
          trackingDebt: { positions: [{ coin: "BTC", reason: "below minimum", rawSecret: "remove" }], orders: [] },
          metrics: { source_fill_count: 3 },
          stats: { sourceFills: 3 },
        } } },
      } });
    }
    return Response.json({ ok: true, events: [{
      at: Date.now(), type: "TRACKING_DEBT", pairId: "p1", coin: "BTC", message: "below minimum", details: { reason: "below minimum", secret: "remove" },
    }] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await GET(new Request("http://localhost/api/faithful-mirror-v2?eventLimit=999"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.get("x-fmv2-control-token"), "server-only-control-token");
  assert.match(calls[1].url, /\/events\?limit=200$/);
  assert.equal(body.connected, true);
  assert.equal(body.stale, false);
  assert.deepEqual(body.service.liveGate, {
    state: "UNARMED",
    configured: true,
    armed: false,
    armExpiresAt: null,
    canStart: false,
    reason: "LIVE stays locked until a server-side operator performs the explicit arm/start flow.",
  });
  assert.deepEqual(body.pairs[0].source.positions, [{
    coin: "BTC", signedSize: 1, entryPriceUsd: null, markPriceUsd: 100, positionValueUsd: null,
    unrealizedPnlUsd: null, liquidationPriceUsd: null, marginUsedUsd: 40, leverage: null, poolId: null,
  }]);
  assert.deepEqual(body.pairs[0].source, {
    equityUsd: 200,
    receivedAt: body.pairs[0].source.receivedAt,
    snapshotAgeMs: body.pairs[0].source.snapshotAgeMs,
    accountMode: "STANDARD",
    marginUsedUsd: 40,
    maintenanceMarginUsd: 8,
    withdrawableUsd: 160,
    marginStatus: null,
    approximateLiquidationRisk: null,
    positions: body.pairs[0].source.positions,
    orders: body.pairs[0].source.orders,
  });
  assert.equal(body.pairs[0].startingCapitalUsd, 100);
  assert.equal(body.pairs[0].target.marginStatus, "HEALTHY");
  assert.equal(body.pairs[0].target.approximateLiquidationRisk, false);
  assert.deepEqual(body.service.policy, {
    verificationDelayMs: 250,
    terminalVerificationDelayMs: 1000,
    targetToleranceBps: 5,
    maxCatchUpSlippageBps: 50,
    immediateResidualNotionalUsd: 10,
    killOnTerminalResidual: true,
    paperMakerFeeRate: 0.00015,
    paperTakerFeeRate: 0.00045,
  });
  assert.equal(body.pairs[0].sourceAddress, "0x1111111111111111111111111111111111111111");
  assert.equal(body.pairs[0].targetAccountLabel, "Follower p1");
  assert.equal(body.pairs[0].targetAddressDisplay, null);
  assert.doesNotMatch(JSON.stringify(body), /0x2222222222222222222222222222222222222222/);
  assert.deepEqual(body.events[0].details, { reason: "below minimum" });
  assert.doesNotMatch(JSON.stringify(body), /server-only-control-token|remove/);
});

test("faithful mirror route denies non-local browser requests", async () => {
  const response = await GET(new Request("https://dashboard.example/api/faithful-mirror-v2"));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.connected, false);
  assert.equal(body.service.liveGate.canStart, false);
});

test("terminal pairs carry local snapshot age but do not make a running active pair globally stale", async (t) => {
  t.after(restoreEnvironment);
  process.env.FMV2_BASE_URL = "http://127.0.0.1:8790";
  process.env.FMV2_CONTROL_TOKEN = "server-only-control-token";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).endsWith("/status")
    ? Response.json({ ok: true, status: {
      mode: "PAPER", state: "RUNNING", running: true, killed: false, armed: true, sessionId: "safe", recoveryAvailable: false,
      config: { pairs: [{ pairId: "dead", capitalUsd: 100 }, { pairId: "active", capitalUsd: 100, targetAddress: "0x3333333333333333333333333333333333333333" }] },
      snapshot: { pairs: {
        dead: { pairId: "dead", state: "KILLED", killed: true, sourceSnapshot: { receivedAt: Date.now() - 120_000, positions: [] }, targetSnapshot: { receivedAt: Date.now() - 120_000, positions: [] } },
        active: { pairId: "active", state: "RUNNING", sourceSnapshot: { receivedAt: Date.now(), positions: [] }, targetSnapshot: { receivedAt: Date.now(), positions: [] } },
      } },
    } })
    : Response.json({ ok: true, events: [] });
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await GET(new Request("http://localhost/api/faithful-mirror-v2"));
  const body = await response.json();
  assert.equal(body.stale, false);
  assert.equal(body.pairs.find((pair: { pairId: string }) => pair.pairId === "dead").snapshotFresh, false);
  assert.equal(body.pairs.find((pair: { pairId: string }) => pair.pairId === "active").snapshotFresh, true);
  assert.equal(body.pairs.find((pair: { pairId: string }) => pair.pairId === "active").targetAddressDisplay, "0x3333…3333");
});
