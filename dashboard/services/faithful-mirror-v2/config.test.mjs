import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FMV2_MAINNET_CONFIRMATION, loadConfig, parseServiceConfig, publicConfig } from "./config.mjs";

const SERVICE_ROOT = dirname(fileURLToPath(import.meta.url));
const source = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
const key = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const baseConfig = (overrides = {}) => ({
  mode: "PAPER",
  testnet: false,
  autoStart: false,
  pairs: [{ pairId: "p1", sourceAddress: source, targetAddress: target, capitalUsd: 100 }],
  actorConfig: { immediateResidualNotionalUsd: 10, targetPositionToleranceBps: 5, verificationDelayMs: 250, terminalVerificationDelayMs: 1000, maxCatchUpSlippageBps: 50, killOnTerminalResidual: true },
  runtime: { heartbeatMs: 20_000, staleConnectionMs: 50_000, reconnectMaxMs: 30_000, allowApproxUnified: false },
  paper: { takerFeeRate: 0.00045, makerFeeRate: 0.00015, defaultSlippageBps: 50 },
  audit: { eventsPath: "data/events.jsonl", snapshotPath: "data/latest-state.json", recoveryPath: "data/recovery.json", snapshotIntervalMs: 5000 },
  control: { host: "127.0.0.1", port: 8790 },
  live: { exclusiveTargetAccount: true, adoptExistingTargetState: false },
  ...overrides,
});
const baseEnv = { FMV2_CONTROL_TOKEN: "safe-control-token-with-16-chars" };

test("PAPER config accepts 1-5 distinct pairs and strips secrets from public config", () => {
  const config = parseServiceConfig({ rawConfig: baseConfig({ autoStart: true }), env: baseEnv, serviceRoot: SERVICE_ROOT });
  assert.equal(config.mode, "PAPER");
  assert.equal(config.autoStart, true);
  assert.equal(config.pairs.length, 1);
  assert.doesNotMatch(JSON.stringify(publicConfig(config)), /safe-control-token/);
  assert.throws(() => parseServiceConfig({ rawConfig: baseConfig({ pairs: Array.from({ length: 6 }, (_, index) => ({ pairId: `p${index}`, sourceAddress: `0x${String(index + 1).padStart(40, "0")}`, targetAddress: `0x${String(index + 11).padStart(40, "0")}`, capitalUsd: 1 })) }), env: baseEnv, serviceRoot: SERVICE_ROOT }), /1-5/);
  assert.throws(() => parseServiceConfig({ rawConfig: baseConfig({ pairs: [{ pairId: "one", sourceAddress: source, targetAddress: target, capitalUsd: 1 }, { pairId: "two", sourceAddress: source, targetAddress: "0x3333333333333333333333333333333333333333", capitalUsd: 1 }] }), env: baseEnv, serviceRoot: SERVICE_ROOT }), /unique/);
  assert.throws(() => parseServiceConfig({ rawConfig: baseConfig({ pairs: [{ pairId: "same-account", sourceAddress: source, targetAddress: source, capitalUsd: 1 }] }), env: baseEnv, serviceRoot: SERVICE_ROOT }), /must differ/);
});

test("LIVE config requires explicit testnet, distinct agent keys, and disables autoStart", () => {
  const live = baseConfig({ mode: "LIVE", testnet: true, pairs: [{ pairId: "p1", sourceAddress: source, targetAddress: target, capitalUsd: null }] });
  const env = { ...baseEnv, FMV2_TESTNET: "true", FMV2_MASTER_ACCOUNT_ADDRESS: source, FMV2_AGENT_PRIVATE_KEY_1: key };
  const config = parseServiceConfig({ rawConfig: live, env, serviceRoot: SERVICE_ROOT });
  assert.equal(config.mode, "LIVE");
  assert.equal(config.live.agentPrivateKeys.length, 1);
  assert.doesNotMatch(JSON.stringify(publicConfig(config)), /aaaaaaaa/);
  assert.throws(() => parseServiceConfig({ rawConfig: { ...live, autoStart: true }, env, serviceRoot: SERVICE_ROOT }), /never set autoStart/);
  assert.throws(() => parseServiceConfig({ rawConfig: live, env: { ...env, FMV2_TESTNET: undefined }, serviceRoot: SERVICE_ROOT }), /explicit FMV2_TESTNET/);
});

test("mainnet confirmation and JSON secret rejection are fail-closed", () => {
  const live = baseConfig({ mode: "LIVE", testnet: false, pairs: [{ pairId: "p1", sourceAddress: source, targetAddress: target }] });
  const env = { ...baseEnv, FMV2_TESTNET: "false", FMV2_MASTER_ACCOUNT_ADDRESS: source, FMV2_AGENT_PRIVATE_KEY_1: key };
  assert.throws(() => parseServiceConfig({ rawConfig: live, env, serviceRoot: SERVICE_ROOT }), /PRODUCTION_CONFIRMED/);
  assert.doesNotThrow(() => parseServiceConfig({ rawConfig: live, env: { ...env, FMV2_PRODUCTION_CONFIRMED: FMV2_MAINNET_CONFIRMATION }, serviceRoot: SERVICE_ROOT }));
  assert.throws(() => parseServiceConfig({ rawConfig: { ...baseConfig(), privateKey: "not-allowed" }, env: baseEnv, serviceRoot: SERVICE_ROOT }), /environment/);
});

test("committed five-whale PAPER config loads as mainnet public-data paper only", async () => {
  const config = await loadConfig({
    env: { ...baseEnv, FMV2_CONFIG: "config/five-whale-paper.json" },
    serviceRoot: SERVICE_ROOT,
    configPath: resolve(SERVICE_ROOT, "config/five-whale-paper.json"),
  });
  assert.equal(config.mode, "PAPER");
  assert.equal(config.testnet, false);
  assert.equal(config.autoStart, true);
  assert.equal(config.pairs.length, 5);
  assert.deepEqual(config.pairs.map((pair) => pair.capitalUsd), [100, 100, 100, 100, 100]);
  assert.equal(new Set(config.pairs.map((pair) => pair.targetAddress)).size, 5);
});
