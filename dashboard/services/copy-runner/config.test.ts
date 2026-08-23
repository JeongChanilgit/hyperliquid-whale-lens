import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { loadCopyRunnerConfig } from "./config";

const whale = "0x1111111111111111111111111111111111111111";
const fixtureRoot = mkdtempSync(join(tmpdir(), "whale-lens-config-"));
const statePath = join(fixtureRoot, "state.json");
const reportPath = join(fixtureRoot, "report.json");
const candidatePath = join(fixtureRoot, "candidates.json");
const configHash = createHash("sha256").update("config").digest("hex");
const candidatePoolHash = createHash("sha256").update("candidates").digest("hex");
const runId = "run-config-test";
const report = JSON.stringify({ candidate_pool_hash: candidatePoolHash, config_hash: configHash, run_id: runId });
writeFileSync(reportPath, report);
writeFileSync(candidatePath, JSON.stringify({ run_id: runId, candidate_pool_hash: candidatePoolHash }));
writeFileSync(statePath, JSON.stringify({
  run_id: runId,
  as_of_ms: Date.now(),
  metric_name: "perp_cashflow_neutral_twr_30d",
  metric_version: "1",
  coverage_mode: "FAST_INCREMENTAL",
  ranking_scope: "DISCOVERY_POOL_EXACT",
  window_start_ms: Date.now() - 30 * 86_400_000,
  window_end_ms: Date.now(),
  config_hash: configHash,
  candidate_pool_hash: candidatePoolHash,
  report_sha256: createHash("sha256").update(report).digest("hex"),
  wallets: Array.from({ length: 10 }, (_, index) => ({
    address: index === 0 ? whale : `0x${String(index + 1).padStart(40, "0")}`,
    rank: index + 1,
    status: "ACTIVE",
    label: index === 0 ? "Growth Rank 01" : `Growth Rank ${String(index + 1).padStart(2, "0")}`,
    perp_cashflow_neutral_twr_30d: String(1 - index / 100),
  })),
}));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

const baseEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  COPY_RUNNER_CONTROL_TOKEN: "test-control-token",
  COPY_RUNNER_DATABASE: ":memory:",
  COPY_RUNNER_CANONICAL_STATE: statePath,
  COPY_RUNNER_CANONICAL_REPORT: reportPath,
  COPY_RUNNER_CANONICAL_CANDIDATES: candidatePath,
  COPY_RUNNER_REQUIRE_SEED_MATCH: "false",
});

test("runner config preserves an exact bounded simulation session", () => {
  const config = loadCopyRunnerConfig({
    ...baseEnvironment(),
    COPY_RUNNER_ENTRY_POLICY: "NEW_POSITIONS_ONLY",
    COPY_RUNNER_SESSION_STARTED_AT_MS: "1786752000000",
    COPY_RUNNER_SESSION_ENDS_AT_MS: "1787011200000",
  });
  assert.deepEqual(config.session, {
    startedAtMs: 1_786_752_000_000,
    endsAtMs: 1_787_011_200_000,
  });
  assert.equal(config.engine.whales[0]?.label, "Growth Rank 01");
  assert.equal(config.engine.entryPolicy, "NEW_POSITIONS_ONLY");
});

test("runner config rejects incomplete or inverted session bounds", () => {
  assert.throws(() => loadCopyRunnerConfig({
    ...baseEnvironment(),
    COPY_RUNNER_SESSION_ENDS_AT_MS: "1787011200000",
  }), /must be provided together/);
  assert.throws(() => loadCopyRunnerConfig({
    ...baseEnvironment(),
    COPY_RUNNER_SESSION_STARTED_AT_MS: "1787011200000",
    COPY_RUNNER_SESSION_ENDS_AT_MS: "1786752000000",
  }), /must be later/);
});

test("runner config rejects an unknown entry policy", () => {
  assert.throws(() => loadCopyRunnerConfig({
    ...baseEnvironment(),
    COPY_RUNNER_ENTRY_POLICY: "COPY_SOMETHING",
  }), /COPY_RUNNER_ENTRY_POLICY/);
});

test("runner rejects a whale override that differs from canonical TOP 10", () => {
  assert.throws(() => loadCopyRunnerConfig({
    ...baseEnvironment(),
    COPY_RUNNER_WHALES: JSON.stringify([{ address: whale, copyRatio: 0.01 }]),
  }), /exactly match/);
});

test("runner rejects a dashboard ACTIVE seed set that differs from canonical", () => {
  const environment = baseEnvironment();
  delete environment.COPY_RUNNER_REQUIRE_SEED_MATCH;
  assert.throws(() => loadCopyRunnerConfig(environment), /ACTIVE seed wallets/);
});

test("runner config accepts replaying open episodes in simulation mode", () => {
  const config = loadCopyRunnerConfig({
    ...baseEnvironment(),
    COPY_RUNNER_ENTRY_POLICY: "REPLAY_OPEN_EPISODES",
    COPY_RUNNER_MODE: "SIMULATION",
  });
  assert.equal(config.engine.entryPolicy, "REPLAY_OPEN_EPISODES");
});

test("runner config rejects replaying open episodes in live Hyperliquid mode", () => {
  assert.throws(() => loadCopyRunnerConfig({
    ...baseEnvironment(),
    COPY_RUNNER_ENTRY_POLICY: "REPLAY_OPEN_EPISODES",
    COPY_RUNNER_MODE: "HYPERLIQUID",
  }), /SIMULATION mode/);
});

test("runner config never permits the partial research gate in live mode", () => {
  assert.throws(() => loadCopyRunnerConfig({
    ...baseEnvironment(),
    COPY_RUNNER_ENTRY_POLICY: "NEW_POSITIONS_ONLY",
    COPY_RUNNER_MODE: "HYPERLIQUID",
    COPY_RUNNER_ALLOW_PARTIAL_RESEARCH: "true",
  }), /supported only in SIMULATION mode/);
});

test("runner config never permits the trade-qualified research gate in live mode", () => {
  assert.throws(() => loadCopyRunnerConfig({
    ...baseEnvironment(),
    COPY_RUNNER_ENTRY_POLICY: "NEW_POSITIONS_ONLY",
    COPY_RUNNER_MODE: "HYPERLIQUID",
    COPY_RUNNER_ALLOW_TRADE_QUALIFIED_RESEARCH: "true",
  }), /supported only in SIMULATION mode/);
});

test("runner config never permits the simple TWR research gate in live mode", () => {
  assert.throws(() => loadCopyRunnerConfig({
    ...baseEnvironment(),
    COPY_RUNNER_ENTRY_POLICY: "NEW_POSITIONS_ONLY",
    COPY_RUNNER_MODE: "HYPERLIQUID",
    COPY_RUNNER_ALLOW_SIMPLE_TWR_RESEARCH: "true",
  }), /supported only in SIMULATION mode/);
});

test("runner config rejects simultaneous research cohort gates", () => {
  assert.throws(() => loadCopyRunnerConfig({
    ...baseEnvironment(),
    COPY_RUNNER_ALLOW_PARTIAL_RESEARCH: "true",
    COPY_RUNNER_ALLOW_TRADE_QUALIFIED_RESEARCH: "true",
  }), /only one research cohort/);
});
