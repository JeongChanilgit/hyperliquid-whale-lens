import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTradeQualifiedTop10 } from "./trade-qualified-whales";

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const hash = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
type MutableCohort = Record<string, unknown> & {
  cohort_sha256: string;
  wallets: Array<Record<string, unknown>>;
};

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "trade-qualified-top10-"));
  const statePath = join(directory, "state.json");
  const reportPath = join(directory, "report.json");
  const rescueSummaryPath = join(directory, "rescue-summary.json");
  const activityCensusPath = join(directory, "activity-census.json");
  const fullReportHash = hash({ full: "rescue" });
  const wallets = Array.from({ length: 10 }, (_, index) => ({
    address: `0x${String(index + 1).padStart(40, "0")}`,
    wallet: `0x${String(index + 1).padStart(40, "0")}`,
    rank: index + 1,
    status: "ACTIVE",
    label: `Trade-qualified TWR ${String(index + 1).padStart(2, "0")}`,
    data_quality_status: "VERIFIED_EXACT",
    raw_fill_count_30d: index + 1,
    perp_cashflow_neutral_twr_30d: String(2 - index / 10),
  }));
  const rescue = {
    source_run_id: "source-run",
    full_report_canonical_sha256: fullReportHash,
    accounts: wallets.map((row) => ({
      wallet: row.wallet,
      data_quality_status: row.data_quality_status,
      latest_scores: { exact_twr: row.perp_cashflow_neutral_twr_30d },
    })),
  };
  const accountSetHash = hash(wallets.map((row) => row.wallet));
  const census = {
    run_status: "COMPLETE",
    coverage_complete: true,
    source_rescue_summary_sha256: hash(rescue),
    account_set_hash: accountSetHash,
    preserved_account_count: 10,
    scanned_account_count: 10,
    accounts: wallets.map((row) => ({
      wallet: row.wallet,
      status: "HAS_FILL",
      minimum_proven_fill_count_30d: 1,
      observed_unique_fill_count_30d: row.raw_fill_count_30d,
    })),
  };
  const body: Record<string, unknown> = {
    schema_version: "2",
    selection_type: "TRADE_QUALIFIED_TWR_RESEARCH",
    selection_basis: "FULL_PRESERVED_ACCOUNT_ACTIVITY_CENSUS_EXACT_TWR",
    simulation_only: true,
    minimum_raw_fills_30d: 1,
    minimum_proven_fills_30d: 1,
    activity_evidence_scope: "OFFICIAL_PERP_MONTH_VOLUME_OR_UNAGGREGATED_DEFAULT_DEX_FILLS",
    minimum_completed_episodes: null,
    activity_census_complete: true,
    activity_census_report_sha256: hash(census),
    activity_census_account_set_hash: accountSetHash,
    activity_census_scanned_account_count: 10,
    activity_census_preserved_account_count: 10,
    source_run_id: "source-run",
    source_as_of_ms: 1_800_000_000_000,
    source_window_start_ms: 1_797_408_000_000,
    source_window_end_ms: 1_800_000_000_000,
    source_coverage_mode: "FAST_INCREMENTAL",
    source_ranking_scope: "DISCOVERY_POOL_EXACT",
    source_config_hash: hash("config"),
    source_candidate_pool_hash: hash("candidates"),
    source_rescue_report_sha256: fullReportHash,
    source_rescue_summary_sha256: hash(rescue),
    wallet_order_hash: hash(wallets.map((row) => row.address)),
    wallets,
  };
  const state = { ...body, cohort_sha256: hash(body) };
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(reportPath, JSON.stringify(state));
  writeFileSync(rescueSummaryPath, JSON.stringify(rescue));
  writeFileSync(activityCensusPath, JSON.stringify(census));
  return { directory, statePath, reportPath, rescueSummaryPath, activityCensusPath, state };
};

test("loads a hash-linked simulation-only 30D fill-qualified exact TWR TOP10", () => {
  const value = fixture();
  try {
    const loaded = loadTradeQualifiedTop10({
      statePath: value.statePath,
      reportPath: value.reportPath,
      rescueSummaryPath: value.rescueSummaryPath,
      activityCensusPath: value.activityCensusPath,
      nowMs: 1_800_000_100_000,
      maxAgeMs: 200_000,
    });
    assert.equal(loaded.selectionMode, "TRADE_QUALIFIED_TWR_RESEARCH");
    assert.equal(loaded.wallets.length, 10);
    assert.equal(loaded.wallets[0]?.twr30d, 2);
  } finally { rmSync(value.directory, { recursive: true, force: true }); }
});

test("fails closed on non-exact, inactive, zero-fill, reordered, or tampered cohorts", () => {
  for (const mutate of [
    (state: MutableCohort) => { state.wallets[0]!.data_quality_status = "BOUNDED"; },
    (state: MutableCohort) => { state.wallets[0]!.status = "PASS"; },
    (state: MutableCohort) => { state.wallets[0]!.raw_fill_count_30d = 0; },
    (state: MutableCohort) => { state.wallets[1]!.perp_cashflow_neutral_twr_30d = "999"; },
  ]) {
    const value = fixture();
    try {
      mutate(value.state as MutableCohort);
      const body: Record<string, unknown> = { ...value.state };
      delete body.cohort_sha256;
      value.state.cohort_sha256 = hash(body);
      writeFileSync(value.statePath, JSON.stringify(value.state));
      writeFileSync(value.reportPath, JSON.stringify(value.state));
      assert.throws(() => loadTradeQualifiedTop10({
        statePath: value.statePath,
        reportPath: value.reportPath,
        rescueSummaryPath: value.rescueSummaryPath,
        activityCensusPath: value.activityCensusPath,
        nowMs: 1_800_000_100_000,
        maxAgeMs: 200_000,
      }));
    } finally { rmSync(value.directory, { recursive: true, force: true }); }
  }
});
