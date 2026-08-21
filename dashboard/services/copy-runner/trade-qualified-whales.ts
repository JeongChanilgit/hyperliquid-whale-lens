import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CanonicalTop10, CanonicalWhale } from "./canonical-whales";

const ADDRESS = /^0x[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXACT_QUALITIES = new Set([
  "VERIFIED_EXACT",
  "VERIFIED_INTERVAL",
  "VERIFIED_INTERVAL_WITH_GUARD",
  "VERIFIED_BLOCK_RECONCILED",
  "VERIFIED_DERIVED_VALUE",
]);

export interface TradeQualifiedTop10Options {
  statePath: string;
  reportPath: string;
  rescueSummaryPath: string;
  activityCensusPath: string;
  nowMs?: number;
  maxAgeMs: number;
}

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
};

const readJson = (path: string, label: string): Record<string, unknown> => {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch (error) {
    throw new Error(`${label} is unavailable at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try { return object(JSON.parse(raw), label); } catch (error) {
    throw new Error(`${label} is invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
};

const integer = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer`);
  return Number(value);
};

const decimal = (value: unknown, label: string): number => {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label} must be numeric`);
  return result;
};

type ExactDecimal = { sign: -1 | 0 | 1; coefficient: bigint; scale: number };
const exactDecimal = (value: unknown, label: string): ExactDecimal => {
  const raw = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) throw new Error(`${label} must be an exact decimal`);
  const integerPart = match[2] ?? "";
  const fractionPart = match[3] ?? match[4] ?? "";
  const exponent = Number(match[5] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000) throw new Error(`${label} exponent is out of range`);
  const digits = `${integerPart}${fractionPart}`.replace(/^0+/, "") || "0";
  if (digits === "0") return { sign: 0, coefficient: BigInt(0), scale: 0 };
  return {
    sign: match[1] === "-" ? -1 : 1,
    coefficient: BigInt(digits),
    scale: exponent - fractionPart.length,
  };
};
const compareExactDecimals = (left: unknown, right: unknown, label = "decimal"): number => {
  const a = exactDecimal(left, label);
  const b = exactDecimal(right, label);
  if (a.sign !== b.sign) return a.sign < b.sign ? -1 : 1;
  if (a.sign === 0) return 0;
  const commonScale = Math.min(a.scale, b.scale);
  const alignedA = a.coefficient * (BigInt(10) ** BigInt(a.scale - commonScale));
  const alignedB = b.coefficient * (BigInt(10) ** BigInt(b.scale - commonScale));
  const magnitude = alignedA === alignedB ? 0 : alignedA < alignedB ? -1 : 1;
  return a.sign === 1 ? magnitude : -magnitude;
};
const validExactDecimal = (value: unknown): string | null => {
  try { exactDecimal(value, "TWR"); return String(value).trim(); } catch { return null; }
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const hashValue = (value: unknown): string => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

/**
 * Load the deliberately weaker "one or more raw fills" research cohort.
 * This contract is separate from the canonical/10-completed-episode loader so
 * the weaker activity threshold can never silently leak into live trading.
 */
export const loadTradeQualifiedTop10 = (options: TradeQualifiedTop10Options): CanonicalTop10 => {
  const state = readJson(options.statePath, "trade-qualified TOP 10 state");
  const report = readJson(options.reportPath, "trade-qualified TOP 10 report");
  if (hashValue(state) !== hashValue(report)) throw new Error("trade-qualified state and report differ");
  if (state.selection_type !== "TRADE_QUALIFIED_TWR_RESEARCH" || state.simulation_only !== true) {
    throw new Error("trade-qualified cohort must be explicitly simulation-only");
  }
  if (Number(state.minimum_raw_fills_30d) !== 1 || Number(state.minimum_proven_fills_30d) !== 1
      || state.activity_evidence_scope !== "OFFICIAL_PERP_MONTH_VOLUME_OR_UNAGGREGATED_DEFAULT_DEX_FILLS"
      || state.minimum_completed_episodes !== null) {
    throw new Error("trade-qualified cohort must require one proven 30D fill and no completed-episode threshold");
  }
  if (state.selection_basis !== "FULL_PRESERVED_ACCOUNT_ACTIVITY_CENSUS_EXACT_TWR" || state.activity_census_complete !== true) {
    throw new Error("trade-qualified cohort must come from a complete preserved-account activity census");
  }

  const cohortHash = text(state.cohort_sha256, "trade-qualified cohort_sha256").toLowerCase();
  const cohortBody = { ...state };
  delete cohortBody.cohort_sha256;
  if (!SHA256.test(cohortHash) || hashValue(cohortBody) !== cohortHash) {
    throw new Error("trade-qualified cohort_sha256 does not match its payload");
  }

  const rescueSummary = readJson(options.rescueSummaryPath, "account-preservation rescue summary");
  const summaryHash = text(state.source_rescue_summary_sha256, "trade-qualified source_rescue_summary_sha256").toLowerCase();
  if (!SHA256.test(summaryHash) || hashValue(rescueSummary) !== summaryHash) {
    throw new Error("trade-qualified cohort does not match the rescue summary");
  }
  const rescueReportHash = text(state.source_rescue_report_sha256, "trade-qualified source_rescue_report_sha256").toLowerCase();
  if (text(rescueSummary.full_report_canonical_sha256, "rescue full_report_canonical_sha256").toLowerCase() !== rescueReportHash) {
    throw new Error("trade-qualified cohort does not match the full rescue report digest");
  }
  const census = readJson(options.activityCensusPath, "preserved-account activity census");
  const censusHash = text(state.activity_census_report_sha256, "trade-qualified activity_census_report_sha256").toLowerCase();
  if (!SHA256.test(censusHash) || hashValue(census) !== censusHash) {
    throw new Error("trade-qualified cohort does not match the activity census");
  }
  if (census.run_status !== "COMPLETE" || census.coverage_complete !== true) {
    throw new Error("activity census is not complete");
  }
  const preservedCount = integer(census.preserved_account_count, "activity census preserved_account_count");
  const scannedCount = integer(census.scanned_account_count, "activity census scanned_account_count");
  if (preservedCount !== scannedCount || Number(state.activity_census_preserved_account_count) !== preservedCount || Number(state.activity_census_scanned_account_count) !== scannedCount) {
    throw new Error("activity census does not cover every preserved account");
  }
  if (text(state.activity_census_account_set_hash, "trade-qualified activity_census_account_set_hash").toLowerCase()
      !== text(census.account_set_hash, "activity census account_set_hash").toLowerCase()) {
    throw new Error("trade-qualified cohort and activity census account sets differ");
  }
  if (text(census.source_rescue_summary_sha256, "activity census source_rescue_summary_sha256").toLowerCase() !== summaryHash) {
    throw new Error("activity census does not match the rescue summary");
  }

  const runId = text(state.source_run_id, "trade-qualified source_run_id");
  if (text(rescueSummary.source_run_id, "rescue source_run_id") !== runId) {
    throw new Error("trade-qualified cohort and rescue summary run_id differ");
  }
  const asOfMs = integer(state.source_as_of_ms, "trade-qualified source_as_of_ms");
  const nowMs = options.nowMs ?? Date.now();
  if (asOfMs > nowMs + 300_000) throw new Error("trade-qualified source_as_of_ms is in the future");
  if (nowMs - asOfMs > options.maxAgeMs) throw new Error("trade-qualified TOP 10 is stale; refresh the screening evidence");

  if (!Array.isArray(state.wallets) || state.wallets.length !== 10) {
    throw new Error("trade-qualified cohort must contain exactly 10 wallets");
  }
  let previousTwr: string | null = null;
  const walletTwrTexts: string[] = [];
  const wallets: CanonicalWhale[] = state.wallets.map((value, index) => {
    const row = object(value, `trade-qualified wallets[${index}]`);
    const address = text(row.address ?? row.wallet, `trade-qualified wallets[${index}].address`).toLowerCase();
    if (!ADDRESS.test(address)) throw new Error(`trade-qualified wallets[${index}].address is invalid`);
    const rank = integer(row.rank, `trade-qualified wallets[${index}].rank`);
    if (rank !== index + 1) throw new Error("trade-qualified wallets must have contiguous ordered ranks 1-10");
    if (text(row.status, `trade-qualified wallets[${index}].status`).toUpperCase() !== "ACTIVE") {
      throw new Error("trade-qualified TOP 10 may contain only ACTIVE wallets");
    }
    if (!EXACT_QUALITIES.has(String(row.data_quality_status))) {
      throw new Error("trade-qualified TOP 10 may use only exact verified TWR accounts");
    }
    if (integer(row.raw_fill_count_30d, `trade-qualified wallets[${index}].raw_fill_count_30d`) < 1) {
      throw new Error("trade-qualified TOP 10 requires at least one raw 30D fill");
    }
    const twrText = validExactDecimal(row.perp_cashflow_neutral_twr_30d);
    if (twrText === null) throw new Error(`trade-qualified wallets[${index}].twr must be an exact decimal`);
    const twr30d = decimal(twrText, `trade-qualified wallets[${index}].twr`);
    if (previousTwr !== null && compareExactDecimals(twrText, previousTwr, "trade-qualified TWR") > 0) {
      throw new Error("trade-qualified wallets are not sorted by descending TWR");
    }
    previousTwr = twrText;
    walletTwrTexts.push(twrText);
    return {
      address,
      rank,
      label: typeof row.label === "string" && row.label.trim() ? row.label.trim() : `Trade-qualified TWR ${String(rank).padStart(2, "0")}`,
      twr30d,
    };
  });
  if (new Set(wallets.map((wallet) => wallet.address)).size !== 10) throw new Error("trade-qualified wallets must be unique");
  const walletHash = text(state.wallet_order_hash, "trade-qualified wallet_order_hash").toLowerCase();
  if (!SHA256.test(walletHash) || hashValue(wallets.map((wallet) => wallet.address)) !== walletHash) {
    throw new Error("trade-qualified wallet_order_hash does not match the ordered cohort");
  }

  if (!Array.isArray(rescueSummary.accounts) || !Array.isArray(census.accounts)) {
    throw new Error("rescue summary and activity census must include account rows");
  }
  const censusByWallet = new Map<string, Record<string, unknown>>();
  for (const value of census.accounts) {
    const row = object(value, "activity census account");
    const wallet = text(row.wallet, "activity census wallet").toLowerCase();
    if (!ADDRESS.test(wallet) || censusByWallet.has(wallet)) throw new Error("activity census contains an invalid or duplicate wallet");
    if (row.status !== "HAS_FILL" && row.status !== "ZERO_FILLS") throw new Error("complete activity census contains a non-terminal account");
    censusByWallet.set(wallet, row);
  }
  if (censusByWallet.size !== preservedCount) throw new Error("activity census row count does not match preserved_account_count");
  const expectedTop10 = (rescueSummary.accounts as unknown[])
    .map((value) => object(value, "rescue account"))
    .map((row) => {
      const wallet = text(row.wallet, "rescue account wallet").toLowerCase();
      const scores = row.latest_scores && typeof row.latest_scores === "object" && !Array.isArray(row.latest_scores)
        ? row.latest_scores as Record<string, unknown>
        : {};
      return { wallet, quality: String(row.data_quality_status), twr: validExactDecimal(scores.exact_twr) };
    })
    .filter((row) => ADDRESS.test(row.wallet) && EXACT_QUALITIES.has(row.quality)
      && row.twr !== null && censusByWallet.get(row.wallet)?.status === "HAS_FILL")
    .sort((left, right) => {
      const scoreOrder = compareExactDecimals(left.twr, right.twr, "rescue exact TWR");
      return scoreOrder === 0 ? left.wallet.localeCompare(right.wallet) : -scoreOrder;
    })
    .slice(0, 10);
  if (expectedTop10.length !== 10
      || JSON.stringify(expectedTop10.map((row) => row.wallet)) !== JSON.stringify(wallets.map((row) => row.address))) {
    throw new Error("trade-qualified wallets are not the global exact-TWR TOP 10 among fill-positive preserved accounts");
  }
  if (expectedTop10.some((row, index) => compareExactDecimals(row.twr, walletTwrTexts[index], "TOP10 TWR") !== 0)) {
    throw new Error("trade-qualified TOP 10 scores differ from the rescue registry");
  }
  for (let index = 0; index < wallets.length; index += 1) {
    const evidence = censusByWallet.get(wallets[index]!.address);
    if (!evidence || evidence.status !== "HAS_FILL" || integer(evidence.minimum_proven_fill_count_30d, `activity census TOP10[${index}].minimum proven fills`) < 1) {
      throw new Error("trade-qualified TOP 10 is missing positive fill evidence");
    }
  }

  const configHash = text(state.source_config_hash, "trade-qualified source_config_hash").toLowerCase();
  const candidatePoolHash = text(state.source_candidate_pool_hash, "trade-qualified source_candidate_pool_hash").toLowerCase();
  if (!SHA256.test(configHash) || !SHA256.test(candidatePoolHash)) throw new Error("trade-qualified source hashes are invalid");
  return {
    runId,
    asOfMs,
    coverageMode: text(state.source_coverage_mode, "trade-qualified source_coverage_mode"),
    rankingScope: text(state.source_ranking_scope, "trade-qualified source_ranking_scope"),
    configHash,
    candidatePoolHash,
    reportSha256: cohortHash,
    selectionMode: "TRADE_QUALIFIED_TWR_RESEARCH",
    researchOverride: true,
    wallets,
  };
};
