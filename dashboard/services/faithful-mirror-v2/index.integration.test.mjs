import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JsonlAuditStore } from "./audit-store.mjs";
import { parseServiceConfig } from "./config.mjs";
import { createServiceLifecycle, isDirectInvocation } from "./index.mjs";

const source = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
const key = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("direct entrypoint detection works with native absolute paths", () => {
  const moduleUrl = new URL("./index.mjs", import.meta.url).href;
  assert.equal(isDirectInvocation({ argv1: fileURLToPath(moduleUrl), moduleUrl }), true);
  assert.equal(isDirectInvocation({ argv1: fileURLToPath(new URL("./config.mjs", import.meta.url)), moduleUrl }), false);
});

const rawConfig = (mode = "PAPER") => ({
  mode,
  testnet: true,
  autoStart: false,
  pairs: [{ pairId: "p1", sourceAddress: source, targetAddress: target, capitalUsd: mode === "PAPER" ? 100 : null }],
  actorConfig: { immediateResidualNotionalUsd: 10, targetPositionToleranceBps: 5, verificationDelayMs: 250, terminalVerificationDelayMs: 1000, maxCatchUpSlippageBps: 50, killOnTerminalResidual: true },
  runtime: { heartbeatMs: 20_000, staleConnectionMs: 50_000, reconnectMaxMs: 30_000, allowApproxUnified: false },
  paper: { takerFeeRate: 0.00045, makerFeeRate: 0.00015, defaultSlippageBps: 50 },
  audit: { eventsPath: "data/events.jsonl", snapshotPath: "data/latest.json", recoveryPath: "data/recovery.json", snapshotIntervalMs: 5000 },
  control: { host: "127.0.0.1", port: 8790 },
  live: { exclusiveTargetAccount: true, adoptExistingTargetState: false },
});

const temporaryConfig = (root, mode = "PAPER") => parseServiceConfig({
  rawConfig: rawConfig(mode),
  serviceRoot: root,
  env: mode === "LIVE"
    ? { FMV2_CONTROL_TOKEN: "control-token-at-least-16", FMV2_TESTNET: "true", FMV2_MASTER_ACCOUNT_ADDRESS: source, FMV2_AGENT_PRIVATE_KEY_1: key }
    : { FMV2_CONTROL_TOKEN: "control-token-at-least-16" },
});

const fakeSystem = (calls) => ({
  engine: {
    executionByPair: new Map(),
    snapshot: () => ({ pairs: { p1: { accountMode: "STANDARD", sourceSnapshot: { receivedAt: 1 }, targetSnapshot: { receivedAt: 2 }, targetOrderState: [] } } }),
  },
  runtime: {
    async start() { calls.push("start"); },
    async stop() { calls.push("stop"); },
    async reconcile() { calls.push("reconcile"); return { accepted: true, pairCount: 1 }; },
    async restoreRecoveryCheckpoint(checkpoint) { calls.push(["restore", checkpoint.sessionId]); return { accepted: true, restoredPairs: 1 }; },
  },
});

test("PAPER lifecycle is explicit, uses fake runtime only, persists a redacted safe state, and stops cleanly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fmv2-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = temporaryConfig(root);
  const store = new JsonlAuditStore({ ...config.audit, secretValues: [config.control.token] });
  const calls = [];
  const lifecycle = createServiceLifecycle({ config, auditStore: store, buildSystem: async () => fakeSystem(calls) });
  await lifecycle.initialize();
  await lifecycle.start();
  assert.deepEqual(calls, ["start"]);
  assert.equal((await lifecycle.status()).state, "RUNNING");
  assert.deepEqual(await lifecycle.reconcile(), { accepted: true, pairCount: 1 });
  await lifecycle.stop();
  assert.deepEqual(calls, ["start", "reconcile", "stop"]);
  const saved = await readFile(config.audit.snapshotPath, "utf8");
  assert.doesNotMatch(saved, /control-token-at-least-16/);
  assert.match(saved, /STOPPED/);
});

test("LIVE is never auto-started, requires arm, consumes it on start, and kill remains position-preserving", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fmv2-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = temporaryConfig(root, "LIVE");
  const store = new JsonlAuditStore({ ...config.audit, secretValues: [config.control.token, key] });
  const calls = [];
  const lifecycle = createServiceLifecycle({ config, auditStore: store, buildSystem: async () => fakeSystem(calls) });
  await lifecycle.initialize();
  assert.equal((await lifecycle.status()).state, "STOPPED_UNARMED");
  await assert.rejects(lifecycle.start(), /requires an unexpired arm/);
  await lifecycle.arm({ confirmation: "I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS" });
  await lifecycle.start();
  assert.equal((await lifecycle.status()).armed, false);
  await lifecycle.kill();
  assert.equal((await lifecycle.status()).state, "KILLED");
  assert.deepEqual(calls, ["start", "stop"]);
});
