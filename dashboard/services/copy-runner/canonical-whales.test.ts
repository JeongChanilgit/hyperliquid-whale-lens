import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadCanonicalTop10 } from "./canonical-whales";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "whale-lens-canonical-"));
  const statePath = join(directory, "state.json");
  const reportPath = join(directory, "report.json");
  const candidatePath = join(directory, "candidates.json");
  const runId = "run-20260821";
  const configHash = sha256("config");
  const candidatePoolHash = sha256("candidates");
  const report = JSON.stringify({ candidate_pool_hash: candidatePoolHash, config_hash: configHash, run_id: runId });
  const candidate = JSON.stringify({ run_id: runId, candidate_pool_hash: candidatePoolHash });
  const finalists = Array.from({ length: 10 }, (_, index) => ({
    wallet: `0x${String(index + 1).padStart(40, "0")}`,
    rank: index + 1,
    status: "ACTIVE",
    perp_cashflow_neutral_twr_30d: String(1 - index / 100),
  }));
  const state = {
    run_id: runId,
    as_of_ms: 1_800_000_000_000,
    metric_name: "perp_cashflow_neutral_twr_30d",
    metric_version: "1",
    coverage_mode: "FAST_INCREMENTAL",
    ranking_scope: "DISCOVERY_POOL_EXACT",
    window_start_ms: 1_797_408_000_000,
    window_end_ms: 1_800_000_000_000,
    wallets: finalists.map((wallet) => wallet.wallet),
    finalists,
    config_hash: configHash,
    candidate_pool_hash: candidatePoolHash,
    report_sha256: sha256(report),
  };
  writeFileSync(reportPath, report);
  writeFileSync(candidatePath, candidate);
  writeFileSync(statePath, JSON.stringify(state));
  return { directory, statePath, reportPath, candidatePath, state };
};

test("loads a fresh, fully cross-checked canonical TOP 10", () => {
  const value = fixture();
  try {
    const canonical = loadCanonicalTop10({
      statePath: value.statePath,
      reportPath: value.reportPath,
      candidatePath: value.candidatePath,
      nowMs: 1_800_000_100_000,
      maxAgeMs: 200_000,
    });
    assert.equal(canonical.wallets.length, 10);
    assert.equal(canonical.wallets[0]?.rank, 1);
    assert.equal(canonical.wallets[9]?.address, `0x${String(10).padStart(40, "0")}`);
  } finally { rmSync(value.directory, { recursive: true, force: true }); }
});

test("rejects stale, partial, or tampered canonical state", () => {
  const value = fixture();
  try {
    assert.throws(() => loadCanonicalTop10({
      statePath: value.statePath,
      reportPath: value.reportPath,
      candidatePath: value.candidatePath,
      nowMs: 1_800_001_000_000,
      maxAgeMs: 10,
    }), /stale/);

    writeFileSync(value.reportPath, "{}\n");
    assert.throws(() => loadCanonicalTop10({
      statePath: value.statePath,
      reportPath: value.reportPath,
      candidatePath: value.candidatePath,
      nowMs: 1_800_000_100_000,
      maxAgeMs: 200_000,
    }), /report_sha256/);

    const partial = { ...value.state, run_status: "PARTIAL", canonical_state_updated: false };
    writeFileSync(value.statePath, JSON.stringify(partial));
    assert.throws(() => loadCanonicalTop10({
      statePath: value.statePath,
      reportPath: value.reportPath,
      candidatePath: value.candidatePath,
      nowMs: 1_800_000_100_000,
      maxAgeMs: 200_000,
    }), /incomplete run/);
  } finally { rmSync(value.directory, { recursive: true, force: true }); }
});
