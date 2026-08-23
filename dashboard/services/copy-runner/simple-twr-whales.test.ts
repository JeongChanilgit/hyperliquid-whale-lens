import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSimpleTwrRunnerState, loadSimpleTwrTop10 } from "./simple-twr-whales";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "simple-twr-top10-"));
  const reportPath = join(directory, "report.json");
  const statePath = join(directory, "state.json");
  const wallets = Array.from({ length: 12 }, (_, index) => ({
    wallet: `0x${String(index + 1).padStart(40, "0")}`,
    status: "ELIGIBLE",
    reason_code: "VALID",
    selection_type: "PORTFOLIO_PERP_MONTH_SIMPLE_TWR_RESEARCH",
    data_quality: "PORTFOLIO_ONLY_ESTIMATE",
    latest_account_value_usd: 20_000 + index,
    perp_month_vlm: 1_000 + index,
    perp_month_simple_twr_30d: String(12 - index),
  }));
  const report: Record<string, unknown> = {
    run_id: "simple-twr-test",
    run_status: "COMPLETE",
    research_only: true,
    canonical_state_updated: false,
    selection_type: "PORTFOLIO_PERP_MONTH_SIMPLE_TWR_RESEARCH",
    metric_name: "perp_month_simple_twr_30d",
    data_quality: "PORTFOLIO_ONLY_ESTIMATE",
    cashflow_neutral_verified: false,
    report_sha256: sha("internal-report"),
    ranking_input_sha256: sha("ranking-input"),
    source_universe: { window_start_ms: 1_797_408_000_000, window_end_ms: 1_800_000_000_000 },
    coverage: {
      coverage_complete: true,
      preserved_account_count: wallets.length,
      raw_payload_count: wallets.length,
      missing_raw_payload_count: 0,
    },
    top10: wallets.slice(0, 10),
    wallets,
  };
  const raw = Buffer.from(JSON.stringify(report));
  writeFileSync(reportPath, raw);
  const state = buildSimpleTwrRunnerState(report, createHash("sha256").update(raw).digest("hex"));
  writeFileSync(statePath, JSON.stringify(state));
  return { directory, reportPath, statePath, report, state };
};

test("loads the exact full-report simple TWR TOP10 as simulation-only research", () => {
  const value = fixture();
  try {
    const loaded = loadSimpleTwrTop10({
      statePath: value.statePath,
      reportPath: value.reportPath,
      nowMs: 1_800_000_100_000,
      maxAgeMs: 200_000,
    });
    assert.equal(loaded.selectionMode, "SIMPLE_PERP_MONTH_TWR_RESEARCH");
    assert.equal(loaded.researchOverride, true);
    assert.equal(loaded.wallets.length, 10);
    assert.equal(loaded.wallets[0]?.address, "0x0000000000000000000000000000000000000001");
    assert.equal(loaded.wallets[0]?.twr30d, 12);
  } finally { rmSync(value.directory, { recursive: true, force: true }); }
});
test("fails closed on state drift, incomplete coverage, or a reordered saved TOP10", () => {
  const stateDrift = fixture();
  try {
    (stateDrift.state.wallets as Array<Record<string, unknown>>)[0]!.address = "0x9999999999999999999999999999999999999999";
    writeFileSync(stateDrift.statePath, JSON.stringify(stateDrift.state));
    assert.throws(() => loadSimpleTwrTop10({
      statePath: stateDrift.statePath,
      reportPath: stateDrift.reportPath,
      nowMs: 1_800_000_100_000,
      maxAgeMs: 200_000,
    }), /does not exactly match/);
  } finally { rmSync(stateDrift.directory, { recursive: true, force: true }); }

  for (const mutate of [
    (report: Record<string, unknown>) => { (report.coverage as Record<string, unknown>).coverage_complete = false; },
    (report: Record<string, unknown>) => { (report.top10 as unknown[]).reverse(); },
  ]) {
    const value = fixture();
    try {
      mutate(value.report);
      assert.throws(() => buildSimpleTwrRunnerState(value.report, sha("report-file")));
    } finally { rmSync(value.directory, { recursive: true, force: true }); }
  }
});
