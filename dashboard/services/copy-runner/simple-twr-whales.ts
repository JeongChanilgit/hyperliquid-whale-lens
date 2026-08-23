import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CanonicalTop10, CanonicalWhale } from "./canonical-whales";

const ADDRESS = /^0x[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const METRIC = "perp_month_simple_twr_30d";
const SOURCE_SELECTION = "PORTFOLIO_PERP_MONTH_SIMPLE_TWR_RESEARCH";
const RUNNER_SELECTION = "SIMPLE_PERP_MONTH_TWR_RESEARCH";
const DATA_QUALITY = "PORTFOLIO_ONLY_ESTIMATE";

export interface SimpleTwrTop10Options {
  statePath: string;
  reportPath: string;
  nowMs?: number;
  maxAgeMs: number;
}

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
};

const integer = (value: unknown, label: string, minimum = 1): number => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
  return Number(value);
};

const decimalText = (value: unknown, label: string): string => {
  const raw = text(value, label);
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) throw new Error(`${label} must be an exact decimal string`);
  return raw;
};

const normalizedDecimal = (value: string): { sign: number; whole: string; fraction: string } => {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [wholeRaw, fractionRaw = ""] = unsigned.split(".");
  const whole = wholeRaw!.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionRaw.replace(/0+$/, "");
  const zero = whole === "0" && fraction.length === 0;
  return { sign: zero ? 0 : negative ? -1 : 1, whole, fraction };
};

const compareDecimal = (left: string, right: string): number => {
  const a = normalizedDecimal(left);
  const b = normalizedDecimal(right);
  if (a.sign !== b.sign) return a.sign < b.sign ? -1 : 1;
  if (a.sign === 0) return 0;
  const magnitude = a.whole.length !== b.whole.length
    ? a.whole.length < b.whole.length ? -1 : 1
    : a.whole !== b.whole
      ? a.whole < b.whole ? -1 : 1
      : (a.fraction.padEnd(Math.max(a.fraction.length, b.fraction.length), "0")
        .localeCompare(b.fraction.padEnd(Math.max(a.fraction.length, b.fraction.length), "0")));
  return a.sign < 0 ? -magnitude : magnitude;
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const hashValue = (value: unknown): string => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
const rawHash = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

const readJson = (path: string, label: string): { raw: Buffer; value: Record<string, unknown> } => {
  let raw: Buffer;
  try { raw = readFileSync(path); } catch (error) {
    throw new Error(`${label} is unavailable at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try { return { raw, value: object(JSON.parse(raw.toString("utf8")), label) }; } catch (error) {
    throw new Error(`${label} is invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const buildSimpleTwrRunnerState = (
  report: Record<string, unknown>,
  sourceReportFileSha256: string,
): Record<string, unknown> => {
  if (!SHA256.test(sourceReportFileSha256)) throw new Error("simple TWR source report file hash is invalid");
  if (report.research_only !== true || report.canonical_state_updated !== false || report.run_status !== "COMPLETE") {
    throw new Error("simple TWR runner source must be a complete, research-only, non-canonical report");
  }
  if (report.selection_type !== SOURCE_SELECTION || report.metric_name !== METRIC || report.data_quality !== DATA_QUALITY) {
    throw new Error("simple TWR runner source uses an unsupported metric or data-quality contract");
  }
  if (report.cashflow_neutral_verified !== false) throw new Error("simple TWR source must not claim cash-flow-neutral verification");
  const runId = text(report.run_id, "simple TWR run_id");
  const internalReportHash = text(report.report_sha256, "simple TWR report_sha256").toLowerCase();
  const rankingInputHash = text(report.ranking_input_sha256, "simple TWR ranking_input_sha256").toLowerCase();
  if (!SHA256.test(internalReportHash) || !SHA256.test(rankingInputHash)) throw new Error("simple TWR source hashes are invalid");
  const source = object(report.source_universe, "simple TWR source_universe");
  const coverage = object(report.coverage, "simple TWR coverage");
  const asOfMs = integer(source.window_end_ms, "simple TWR window_end_ms");
  const windowStartMs = integer(source.window_start_ms, "simple TWR window_start_ms");
  if (windowStartMs >= asOfMs) throw new Error("simple TWR source window is inverted");
  const preservedCount = integer(coverage.preserved_account_count, "simple TWR preserved_account_count", 10);
  if (coverage.coverage_complete !== true
      || integer(coverage.raw_payload_count, "simple TWR raw_payload_count", 0) !== preservedCount
      || integer(coverage.missing_raw_payload_count, "simple TWR missing_raw_payload_count", 0) !== 0) {
    throw new Error("simple TWR source portfolio coverage is incomplete");
  }
  if (!Array.isArray(report.wallets) || report.wallets.length !== preservedCount || !Array.isArray(report.top10) || report.top10.length !== 10) {
    throw new Error("simple TWR source wallet or TOP10 count is inconsistent");
  }
  const ranked = report.wallets
    .map((value, index) => object(value, `simple TWR wallets[${index}]`))
    .filter((row) => row.status === "ELIGIBLE")
    .map((row) => {
      const address = text(row.wallet, "simple TWR wallet").toLowerCase();
      if (!ADDRESS.test(address)) throw new Error("simple TWR source contains an invalid wallet");
      const score = decimalText(row[METRIC], `simple TWR score for ${address}`);
      if (row.reason_code !== "VALID" || row.selection_type !== SOURCE_SELECTION || row.data_quality !== DATA_QUALITY) {
        throw new Error("simple TWR eligible row violates its source contract");
      }
      if (!(Number(row.latest_account_value_usd) >= 10_000) || !(Number(row.perp_month_vlm) > 0)) {
        throw new Error("simple TWR eligible row violates account-value or activity filters");
      }
      return { address, score };
    })
    .sort((left, right) => {
      const scoreOrder = compareDecimal(left.score, right.score);
      return scoreOrder === 0 ? left.address.localeCompare(right.address) : -scoreOrder;
    });
  if (ranked.length < 10 || new Set(ranked.map((row) => row.address)).size !== ranked.length) {
    throw new Error("simple TWR source has too few or duplicate eligible wallets");
  }
  const expected = ranked.slice(0, 10);
  for (let index = 0; index < 10; index += 1) {
    const row = object(report.top10[index], `simple TWR top10[${index}]`);
    const address = text(row.wallet, `simple TWR top10[${index}].wallet`).toLowerCase();
    const score = decimalText(row[METRIC], `simple TWR top10[${index}].score`);
    if (address !== expected[index]!.address || compareDecimal(score, expected[index]!.score) !== 0) {
      throw new Error("simple TWR saved TOP10 does not match the full eligible ranking");
    }
  }
  const wallets = expected.map((row, index) => ({
    address: row.address,
    rank: index + 1,
    status: "ACTIVE",
    label: `Simple TWR ${String(index + 1).padStart(2, "0")}`,
    perp_month_simple_twr_30d: row.score,
  }));
  const body: Record<string, unknown> = {
    schema_version: "1",
    selection_type: RUNNER_SELECTION,
    simulation_only: true,
    research_only: true,
    source_run_id: runId,
    source_as_of_ms: asOfMs,
    source_window_start_ms: windowStartMs,
    source_window_end_ms: asOfMs,
    source_metric_name: METRIC,
    source_data_quality: DATA_QUALITY,
    source_cashflow_neutral_verified: false,
    source_report_internal_sha256: internalReportHash,
    source_report_file_sha256: sourceReportFileSha256,
    source_ranking_input_sha256: rankingInputHash,
    source_preserved_account_count: preservedCount,
    source_coverage_complete: true,
    startup_position_policy: "NEW_POSITIONS_ONLY",
    startup_fill_policy: "IGNORE_SNAPSHOT_FILLS",
    startup_order_policy: "COPY_ENTRY_CAPABLE_OPEN_ORDERS",
    wallet_order_hash: hashValue(wallets.map((row) => row.address)),
    wallets,
  };
  return { ...body, cohort_sha256: hashValue(body) };
};

export const loadSimpleTwrTop10 = (options: SimpleTwrTop10Options): CanonicalTop10 => {
  const reportDocument = readJson(options.reportPath, "simple TWR source report");
  const expectedState = buildSimpleTwrRunnerState(reportDocument.value, rawHash(reportDocument.raw));
  const state = readJson(options.statePath, "simple TWR runner state").value;
  if (canonicalJson(state) !== canonicalJson(expectedState)) {
    throw new Error("simple TWR runner state does not exactly match the fixed source report");
  }
  const asOfMs = integer(state.source_as_of_ms, "simple TWR source_as_of_ms");
  const nowMs = options.nowMs ?? Date.now();
  if (asOfMs > nowMs + 300_000) throw new Error("simple TWR source as-of is in the future");
  if (nowMs - asOfMs > options.maxAgeMs) throw new Error("simple TWR TOP10 is stale; refresh the research report before starting");
  const rows = state.wallets as Array<Record<string, unknown>>;
  const wallets: CanonicalWhale[] = rows.map((row, index) => ({
    address: text(row.address, `simple TWR state wallets[${index}].address`).toLowerCase(),
    rank: integer(row.rank, `simple TWR state wallets[${index}].rank`),
    label: text(row.label, `simple TWR state wallets[${index}].label`),
    twr30d: Number(decimalText(row[METRIC], `simple TWR state wallets[${index}].score`)),
  }));
  return {
    runId: text(state.source_run_id, "simple TWR source_run_id"),
    asOfMs,
    coverageMode: "FIXED_CACHE_COMPLETE",
    rankingScope: `PRESERVED_${integer(state.source_preserved_account_count, "simple TWR source_preserved_account_count", 10)}_PORTFOLIO_ONLY_ESTIMATE`,
    configHash: text(state.source_report_internal_sha256, "simple TWR source report hash"),
    candidatePoolHash: text(state.source_ranking_input_sha256, "simple TWR ranking input hash"),
    reportSha256: text(state.source_report_file_sha256, "simple TWR source file hash"),
    selectionMode: RUNNER_SELECTION,
    researchOverride: true,
    wallets,
  };
};
