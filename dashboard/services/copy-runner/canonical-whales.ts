import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ADDRESS = /^0x[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface CanonicalWhale {
  address: string;
  label: string;
  rank: number;
  twr30d: number;
}

export interface CanonicalTop10 {
  runId: string;
  asOfMs: number;
  coverageMode: string;
  rankingScope: string;
  configHash: string;
  candidatePoolHash: string;
  reportSha256: string;
  wallets: CanonicalWhale[];
}

export interface CanonicalTop10Options {
  statePath: string;
  reportPath: string;
  candidatePath: string;
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

const integer = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer`);
  return Number(value);
};

const decimal = (value: unknown, label: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be numeric`);
  return parsed;
};

const json = (path: string, label: string): { raw: Buffer; value: Record<string, unknown> } => {
  let raw: Buffer;
  try { raw = readFileSync(path); } catch (error) {
    throw new Error(`${label} is unavailable at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try { return { raw, value: object(JSON.parse(raw.toString("utf8")), label) }; } catch (error) {
    throw new Error(`${label} is invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
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

const canonicalWallet = (value: unknown, index: number, finalists: unknown[]): CanonicalWhale => {
  const addressValue = typeof value === "string" ? value : object(value, `canonical wallets[${index}]`).address ?? object(value, `canonical wallets[${index}]`).wallet;
  const address = text(addressValue, `canonical wallets[${index}].address`).toLowerCase();
  const finalist = finalists.find((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const candidate = item as Record<string, unknown>;
    return String(candidate.address ?? candidate.wallet ?? "").toLowerCase() === address;
  });
  const row = typeof value === "string"
    ? object(finalist, `canonical finalists entry for ${address}`)
    : object(value, `canonical wallets[${index}]`);
  if (!ADDRESS.test(address)) throw new Error(`canonical wallets[${index}].address is invalid`);
  const rank = integer(row.rank ?? row.active_rank ?? index + 1, `canonical wallets[${index}].rank`);
  if (rank !== index + 1) throw new Error("canonical wallets must be ordered with contiguous ranks 1-10");
  const status = text(row.status ?? "ACTIVE", `canonical wallets[${index}].status`).toUpperCase();
  if (status !== "ACTIVE") throw new Error("canonical TOP 10 may contain only ACTIVE wallets");
  return {
    address,
    rank,
    label: typeof row.label === "string" && row.label.trim() ? row.label.trim() : `Perp TWR ${String(rank).padStart(2, "0")}`,
    twr30d: decimal(
      row.perp_cashflow_neutral_twr_30d ?? row.twr_30d ?? row.twr30d,
      `canonical wallets[${index}].perp_cashflow_neutral_twr_30d`,
    ),
  };
};

export const loadCanonicalTop10 = (options: CanonicalTop10Options): CanonicalTop10 => {
  const state = json(options.statePath, "canonical TOP 10 state").value;
  if (text(state.metric_name, "canonical metric_name") !== "perp_cashflow_neutral_twr_30d") {
    throw new Error("canonical metric_name must be perp_cashflow_neutral_twr_30d");
  }
  const runId = text(state.run_id, "canonical run_id");
  const asOfMs = integer(state.as_of_ms, "canonical as_of_ms");
  const nowMs = options.nowMs ?? Date.now();
  if (asOfMs > nowMs + 300_000) throw new Error("canonical as_of_ms is in the future");
  if (nowMs - asOfMs > options.maxAgeMs) throw new Error("canonical TOP 10 is stale; run the screener before autostart");
  if (state.canonical_state_updated === false || state.run_status === "PARTIAL") {
    throw new Error("canonical TOP 10 was produced by an incomplete run");
  }
  const coverageMode = text(state.coverage_mode, "canonical coverage_mode");
  const rankingScope = text(state.ranking_scope, "canonical ranking_scope");
  const configHash = text(state.config_hash, "canonical config_hash").toLowerCase();
  const candidatePoolHash = text(state.candidate_pool_hash, "canonical candidate_pool_hash").toLowerCase();
  const reportSha256 = text(state.report_sha256, "canonical report_sha256").toLowerCase();
  if (!SHA256.test(configHash) || !SHA256.test(candidatePoolHash) || !SHA256.test(reportSha256)) {
    throw new Error("canonical hashes must be lowercase SHA-256 values");
  }
  if (!Array.isArray(state.wallets) || state.wallets.length !== 10) throw new Error("canonical state must contain exactly 10 wallets");
  const finalists = Array.isArray(state.finalists) ? state.finalists : [];
  const wallets = state.wallets.map((wallet, index) => canonicalWallet(wallet, index, finalists));
  if (new Set(wallets.map((wallet) => wallet.address)).size !== wallets.length) throw new Error("canonical wallets must be unique");

  const report = json(options.reportPath, "canonical discovery report");
  if (hashValue(report.value) !== reportSha256) throw new Error("canonical report_sha256 does not match the saved report");
  if (text(report.value.run_id, "report run_id") !== runId) throw new Error("canonical state and report run_id differ");
  if (text(report.value.config_hash, "report config_hash").toLowerCase() !== configHash) {
    throw new Error("canonical state and report config_hash differ");
  }
  if (text(report.value.candidate_pool_hash, "report candidate_pool_hash").toLowerCase() !== candidatePoolHash) {
    throw new Error("canonical state and report candidate_pool_hash differ");
  }

  const candidate = json(options.candidatePath, "canonical candidate pool").value;
  if (text(candidate.run_id, "candidate run_id") !== runId) throw new Error("canonical state and candidate run_id differ");
  if (text(candidate.candidate_pool_hash, "candidate candidate_pool_hash").toLowerCase() !== candidatePoolHash) {
    throw new Error("canonical state and candidate file hash differ");
  }

  return { runId, asOfMs, coverageMode, rankingScope, configHash, candidatePoolHash, reportSha256, wallets };
};
