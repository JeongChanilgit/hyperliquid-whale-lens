import assert from "node:assert/strict";
import test from "node:test";
import type { CopyRunnerConfig } from "./config";
import { LIVE_ARM_CONFIRMATION, StandaloneCopyRunner } from "./runner";

const whale = "0x1111111111111111111111111111111111111111";

const config = (mode: "SIMULATION" | "HYPERLIQUID"): CopyRunnerConfig => ({
  engine: {
    mode,
    whales: [{ address: whale, copyRatio: 0.01 }],
    sizing: { mode: "SOURCE_EQUITY_RATIO", followerCapitalUsd: 100 },
    risk: {
      allowedWhales: [whale],
      allowedSymbols: ["*"],
      maxNotionalUsd: 1_000,
      maxSlippageProxyBps: 50,
      maxDailyLossUsd: 10,
    },
  },
  databasePath: ":memory:",
  host: "127.0.0.1",
  port: 0,
  controlToken: "private-test-token",
  autoStart: false,
  requireFlatStart: false,
  canonical: {
    runId: "run-test",
    asOfMs: Date.now(),
    coverageMode: "FAST_INCREMENTAL",
    rankingScope: "DISCOVERY_POOL_EXACT",
    configHash: "a".repeat(64),
    candidatePoolHash: "b".repeat(64),
  },
});

test("live runner cannot start or arm through a browser-only confirmation", async () => {
  const paper = new StandaloneCopyRunner(config("SIMULATION"));
  assert.throws(() => paper.armLive(LIVE_ARM_CONFIRMATION), /not a Hyperliquid live runner/);
  await paper.close();

  const live = new StandaloneCopyRunner(config("HYPERLIQUID"));
  await assert.rejects(live.startEngine(), /fresh server-side arm/);
  assert.throws(() => live.armLive("browser-state-only"), /confirmation is invalid/);
  assert.equal(live.status().liveArmed, false);
  await live.close();
});
