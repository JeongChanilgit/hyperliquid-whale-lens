import assert from "node:assert/strict";
import test from "node:test";
import { loadCopyRunnerConfig } from "./config";

const whale = "0x1111111111111111111111111111111111111111";

const baseEnvironment = (): NodeJS.ProcessEnv => ({
  COPY_RUNNER_CONTROL_TOKEN: "test-control-token",
  COPY_RUNNER_WHALES: JSON.stringify([{ address: whale, label: "Growth Rank 01", copyRatio: 0.01 }]),
  COPY_RUNNER_DATABASE: ":memory:",
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
