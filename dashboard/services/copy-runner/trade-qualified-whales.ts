import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CanonicalTop10, CanonicalWhale } from "./canonical-whales";

const ADDRESS = /^0x[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface TradeQualifiedTop10Options {
  statePath: string;
  reportPath: string;
  rescueSummaryPath: string;
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
  if (Number(state.minimum_raw_fills_30d) !== 1 || state.minimum_completed_episodes !== null) {
    throw new Error("trade-qualified cohort must require one raw 30D fill and no completed-episode threshold");
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
  let previousTwr = Number.POSITIVE_INFINITY;
  const wallets: CanonicalWhale[] = state.wallets.map((value, index) => {
    const row = object(value, `trade-qualified wallets[${index}]`);
    const address = text(row.address ?? row.wallet, `trade-qualified wallets[${index}].address`).toLowerCase();
    if (!ADDRESS.test(address)) throw new Error(`trade-qualified wallets[${index}].address is invalid`);
    const rank = integer(row.rank, `trade-qualified wallets[${index}].rank`);
    if (rank !== index + 1) throw new Error("trade-qualified wallets must have contiguous ordered ranks 1-10");
    if (text(row.status, `trade-qualified wallets[${index}].status`).toUpperCase() !== "ACTIVE") {
      throw new Error("trade-qualified TOP 10 may contain only ACTIVE wallets");
    }
    if (row.data_quality_status !== "VERIFIED_EXACT") {
      throw new Error("trade-qualified TOP 10 may use only exact verified TWR accounts");
    }
    if (integer(row.raw_fill_count_30d, `trade-qualified wallets[${index}].raw_fill_count_30d`) < 1) {
      throw new Error("trade-qualified TOP 10 requires at least one raw 30D fill");
    }
    const twr30d = decimal(row.perp_cashflow_neutral_twr_30d, `trade-qualified wallets[${index}].twr`);
    if (twr30d > previousTwr) throw new Error("trade-qualified wallets are not sorted by descending TWR");
    previousTwr = twr30d;
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
