import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonlAuditStore } from "./audit-store.mjs";
import { parseServiceConfig } from "./config.mjs";
import { createServiceLifecycle } from "./index.mjs";

const source = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
const privateKey = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const controlToken = "control-token-at-least-16";

const configFor = (root) => parseServiceConfig({
  rawConfig: {
    mode: "LIVE", testnet: true, autoStart: false,
    pairs: [{ pairId: "p1", sourceAddress: source, targetAddress: target }],
    actorConfig: { immediateResidualNotionalUsd: 10, targetPositionToleranceBps: 5, verificationDelayMs: 250, terminalVerificationDelayMs: 1000, maxCatchUpSlippageBps: 50, killOnTerminalResidual: true },
    runtime: { heartbeatMs: 20_000, staleConnectionMs: 50_000, reconnectMaxMs: 30_000, allowApproxUnified: false },
    paper: {},
    audit: { eventsPath: "data/events.jsonl", snapshotPath: "data/latest.json", recoveryPath: "data/recovery.json", snapshotIntervalMs: 5000 },
    control: { host: "127.0.0.1", port: 8790 },
    live: { exclusiveTargetAccount: true, adoptExistingTargetState: false },
  },
  env: { FMV2_CONTROL_TOKEN: controlToken, FMV2_TESTNET: "true", FMV2_MASTER_ACCOUNT_ADDRESS: source, FMV2_AGENT_PRIVATE_KEY_1: privateKey },
  serviceRoot: root,
});

test("audit records and atomic recovery checkpoints are redacted, bounded, and restored through a runtime hook", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fmv2-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = configFor(root);
  const store = new JsonlAuditStore({ ...config.audit, secretValues: [controlToken, privateKey] });
  await store.record({ type: "SIGN_ATTEMPT", privateKey, controlToken, signature: { r: "sensitive" }, detail: { note: "safe" } });
  await store.writeRecoveryCheckpoint({
    sessionId: "prior-session", mode: "LIVE", state: "RUNNING", pairs: config.pairs,
    recoveryPairs: [{
      pairId: "p1", sourceAddress: source, targetAddress: target,
      lastSourceFillTime: 100, lastTargetFillTime: 99,
      recentSourceFillIds: Array.from({ length: 2_005 }, (_, index) => `source-${index}`),
      recentTargetFillIds: ["target-1"],
      sourceOrderToTargetCloid: { sourceOrder: "0x11111111111111111111111111111111" },
      accountMode: "STANDARD", lastSourceSnapshotAt: 101, lastTargetSnapshotAt: 102, killSwitch: false,
    }],
  });
  await store.flush();
  const events = await readFile(config.audit.eventsPath, "utf8");
  assert.doesNotMatch(events, /bbbbbbbb/);
  assert.doesNotMatch(events, /control-token-at-least-16/);
  assert.doesNotMatch(events, /sensitive/);
  const recovered = await store.loadRecoveryCheckpoint();
  assert.equal(recovered.sessionId, "prior-session");
  assert.equal(recovered.pairs[0].recentSourceFillIds.length, 2_000);
  assert.equal(recovered.pairs[0].sourceOrderToTargetCloid.sourceOrder, "0x11111111111111111111111111111111");

  const calls = [];
  const lifecycle = createServiceLifecycle({
    config,
    auditStore: store,
    buildSystem: async () => ({
      engine: { executionByPair: new Map(), snapshot: () => ({ pairs: { p1: { targetOrderState: [] } } }) },
      runtime: {
        async restoreRecoveryCheckpoint(checkpoint) { calls.push(["restore", checkpoint.sessionId]); return { accepted: true, restoredPairs: 1 }; },
        async start() { calls.push(["start"]); },
        async stop() { calls.push(["stop"]); },
      },
    }),
  });
  await lifecycle.initialize();
  await lifecycle.arm({ confirmation: "I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS" });
  await lifecycle.start();
  assert.deepEqual(calls, [["restore", "prior-session"], ["start"]]);
  await lifecycle.stop();
  const nextCheckpoint = JSON.parse(await readFile(config.audit.recoveryPath, "utf8"));
  assert.equal(nextCheckpoint.schemaVersion, 1);
  assert.equal(nextCheckpoint.pairs[0].sourceAddress, source);
  assert.doesNotMatch(JSON.stringify(nextCheckpoint), /bbbbbbbb|control-token/);
});
