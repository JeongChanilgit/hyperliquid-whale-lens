import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CopyEngineConfig, CopyEntryPolicy, CopyMode, WhaleConfig } from "../../app/lib/copy-types";
import { SEED_WALLETS } from "../../app/seed-wallets";
import { loadCanonicalTop10 } from "./canonical-whales";
import { loadSimpleTwrTop10 } from "./simple-twr-whales";
import { loadTradeQualifiedTop10 } from "./trade-qualified-whales";

export interface CopyRunnerConfig {
  engine: CopyEngineConfig;
  databasePath: string;
  host: string;
  port: number;
  controlToken: string;
  autoStart: boolean;
  requireFlatStart: boolean;
  canonical: {
    runId: string;
    asOfMs: number;
    coverageMode: string;
    rankingScope: string;
    configHash: string;
    candidatePoolHash: string;
    selectionMode: "CANONICAL" | "VERIFIED_PARTIAL_RESEARCH" | "TRADE_QUALIFIED_TWR_RESEARCH" | "SIMPLE_PERP_MONTH_TWR_RESEARCH";
    researchOverride: boolean;
  };
  session?: {
    startedAtMs: number;
    endsAtMs: number;
  };
}

const required = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
};

const number = (env: NodeJS.ProcessEnv, key: string, fallback: number, min: number): number => {
  const value = env[key];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${key} must be at least ${min}`);
  return parsed;
};

const truthy = (value: string | undefined, fallback: boolean): boolean => value === undefined ? fallback : value === "true";
const csv = (value: string | undefined): string[] => (value ?? "").split(",").map((item) => item.trim().toUpperCase()).filter(Boolean);
const timestamp = (env: NodeJS.ProcessEnv, key: string): number | undefined => {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${key} must be a positive Unix timestamp in milliseconds`);
  return parsed;
};
const DEFAULT_SYMBOLS = "*";
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_CANONICAL_STATE = resolve(PROJECT_ROOT, "state/perp-twr-top10/latest_active_top10.json");
const DEFAULT_DISCOVERY_REPORT = resolve(PROJECT_ROOT, "reports/perp-twr-discovery/latest.json");
const DEFAULT_CANDIDATE_REPORT = resolve(PROJECT_ROOT, "reports/perp-twr-candidates/latest-top2000.json");
const DEFAULT_TRADE_STATE = resolve(PROJECT_ROOT, "state/perp-twr-trade-qualified/latest_active_top10.json");
const DEFAULT_TRADE_REPORT = resolve(PROJECT_ROOT, "reports/perp-twr-trade-qualified/latest.json");
const DEFAULT_RESCUE_SUMMARY = resolve(PROJECT_ROOT, "reports/perp-twr-rescue/latest-summary.json");
const DEFAULT_ACTIVITY_CENSUS = resolve(PROJECT_ROOT, "reports/perp-twr-activity-census/latest.json");
const DEFAULT_SIMPLE_TWR_STATE = resolve(PROJECT_ROOT, "state/perp-month-simple-twr/latest_active_top10.json");
const DEFAULT_SIMPLE_TWR_REPORT = resolve(PROJECT_ROOT, "reports/perp-month-simple-twr/latest.json");

const parseWhales = (raw: string): WhaleConfig[] => {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { throw new Error("COPY_RUNNER_WHALES must be a JSON array"); }
  if (!Array.isArray(decoded) || decoded.length === 0 || decoded.length > 10) throw new Error("COPY_RUNNER_WHALES must contain 1-10 wallets");
  return decoded.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Each whale config must be an object");
    const record = item as Record<string, unknown>;
    const address = typeof record.address === "string" ? record.address.trim().toLowerCase() : "";
    const label = typeof record.label === "string" ? record.label.trim() : "";
    const copyRatio = Number(record.copyRatio);
    const allowedCoins = Array.isArray(record.allowedCoins) ? record.allowedCoins.filter((coin): coin is string => typeof coin === "string") : undefined;
    if (!/^0x[a-f0-9]{40}$/.test(address) || !Number.isFinite(copyRatio) || copyRatio <= 0 || copyRatio > 1) throw new Error("COPY_RUNNER_WHALES contains an invalid address or copyRatio");
    if (label.length > 64) throw new Error("COPY_RUNNER_WHALES contains a label longer than 64 characters");
    return { address, ...(label ? { label } : {}), copyRatio, ...(allowedCoins?.length ? { allowedCoins } : {}) };
  });
};

export const loadCopyRunnerConfig = (env: NodeJS.ProcessEnv = process.env): CopyRunnerConfig => {
  const host = env.COPY_RUNNER_HOST?.trim() || "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host) && env.COPY_RUNNER_ALLOW_NONLOCAL !== "true") {
    throw new Error("COPY_RUNNER_HOST must remain localhost unless COPY_RUNNER_ALLOW_NONLOCAL=true");
  }
  const mode = (env.COPY_RUNNER_MODE ?? "SIMULATION").toUpperCase() as CopyMode;
  if (mode !== "SIMULATION" && mode !== "HYPERLIQUID") throw new Error("COPY_RUNNER_MODE must be SIMULATION or HYPERLIQUID");
  const entryPolicy = (env.COPY_RUNNER_ENTRY_POLICY ?? "INCLUDE_EXISTING").toUpperCase() as CopyEntryPolicy;
  if (entryPolicy !== "INCLUDE_EXISTING" && entryPolicy !== "NEW_POSITIONS_ONLY" && entryPolicy !== "REPLAY_OPEN_EPISODES") {
    throw new Error("COPY_RUNNER_ENTRY_POLICY must be INCLUDE_EXISTING, NEW_POSITIONS_ONLY, or REPLAY_OPEN_EPISODES");
  }
  if (entryPolicy === "REPLAY_OPEN_EPISODES" && mode !== "SIMULATION") {
    throw new Error("COPY_RUNNER_ENTRY_POLICY=REPLAY_OPEN_EPISODES is supported only in SIMULATION mode");
  }
  const allowPartialResearch = env.COPY_RUNNER_ALLOW_PARTIAL_RESEARCH === "true";
  const allowTradeQualifiedResearch = env.COPY_RUNNER_ALLOW_TRADE_QUALIFIED_RESEARCH === "true";
  const allowSimpleTwrResearch = env.COPY_RUNNER_ALLOW_SIMPLE_TWR_RESEARCH === "true";
  if ([allowPartialResearch, allowTradeQualifiedResearch, allowSimpleTwrResearch].filter(Boolean).length > 1) {
    throw new Error("Choose only one research cohort authorization");
  }
  if (allowPartialResearch && mode !== "SIMULATION") {
    throw new Error("COPY_RUNNER_ALLOW_PARTIAL_RESEARCH is supported only in SIMULATION mode");
  }
  if (allowTradeQualifiedResearch && mode !== "SIMULATION") {
    throw new Error("COPY_RUNNER_ALLOW_TRADE_QUALIFIED_RESEARCH is supported only in SIMULATION mode");
  }
  if (allowSimpleTwrResearch && mode !== "SIMULATION") {
    throw new Error("COPY_RUNNER_ALLOW_SIMPLE_TWR_RESEARCH is supported only in SIMULATION mode");
  }
  const maxCanonicalAgeMs = number(env, "COPY_RUNNER_CANONICAL_MAX_AGE_MS", 48 * 60 * 60 * 1_000, 60_000);
  const canonical = allowSimpleTwrResearch
    ? loadSimpleTwrTop10({
      statePath: resolve(env.COPY_RUNNER_CANONICAL_STATE?.trim() || DEFAULT_SIMPLE_TWR_STATE),
      reportPath: resolve(env.COPY_RUNNER_CANONICAL_REPORT?.trim() || DEFAULT_SIMPLE_TWR_REPORT),
      maxAgeMs: maxCanonicalAgeMs,
    })
    : allowTradeQualifiedResearch
    ? loadTradeQualifiedTop10({
      statePath: resolve(env.COPY_RUNNER_CANONICAL_STATE?.trim() || DEFAULT_TRADE_STATE),
      reportPath: resolve(env.COPY_RUNNER_CANONICAL_REPORT?.trim() || DEFAULT_TRADE_REPORT),
      rescueSummaryPath: resolve(env.COPY_RUNNER_RESCUE_SUMMARY?.trim() || DEFAULT_RESCUE_SUMMARY),
      activityCensusPath: resolve(env.COPY_RUNNER_ACTIVITY_CENSUS?.trim() || DEFAULT_ACTIVITY_CENSUS),
      maxAgeMs: maxCanonicalAgeMs,
    })
    : loadCanonicalTop10({
      statePath: resolve(env.COPY_RUNNER_CANONICAL_STATE?.trim() || DEFAULT_CANONICAL_STATE),
      reportPath: resolve(env.COPY_RUNNER_CANONICAL_REPORT?.trim() || DEFAULT_DISCOVERY_REPORT),
      candidatePath: resolve(env.COPY_RUNNER_CANONICAL_CANDIDATES?.trim() || DEFAULT_CANDIDATE_REPORT),
      maxAgeMs: maxCanonicalAgeMs,
      allowPartialResearch,
    });
  const canonicalWhales: WhaleConfig[] = canonical.wallets.map((wallet) => ({
    address: wallet.address,
    label: wallet.label,
    copyRatio: 0.01,
  }));
  if (env.COPY_RUNNER_REQUIRE_SEED_MATCH !== "false") {
    const activeSeedAddresses = SEED_WALLETS
      .filter((wallet) => wallet.status === "ACTIVE")
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((wallet) => wallet.address.toLowerCase());
    const canonicalAddresses = canonicalWhales.map((wallet) => wallet.address);
    if (JSON.stringify(activeSeedAddresses) !== JSON.stringify(canonicalAddresses)) {
      throw new Error("dashboard ACTIVE seed wallets do not exactly match the verified canonical TOP 10");
    }
  }
  if (env.COPY_RUNNER_WHALES?.trim()) {
    const configuredWhales = parseWhales(env.COPY_RUNNER_WHALES);
    const configuredAddresses = configuredWhales.map((wallet) => wallet.address);
    const canonicalAddresses = canonicalWhales.map((wallet) => wallet.address);
    if (JSON.stringify(configuredAddresses) !== JSON.stringify(canonicalAddresses)) {
      throw new Error("COPY_RUNNER_WHALES does not exactly match the verified canonical TOP 10");
    }
  }
  const whales = canonicalWhales;
  const allowedSymbols = csv(env.COPY_RUNNER_ALLOWED_SYMBOLS || DEFAULT_SYMBOLS);
  if (allowedSymbols.length === 0) throw new Error("COPY_RUNNER_ALLOWED_SYMBOLS must contain at least one symbol or *");
  const allowedWhales = whales.map((whale) => whale.address);
  const controlToken = required(env, "COPY_RUNNER_CONTROL_TOKEN");
  const sessionStartedAtMs = timestamp(env, "COPY_RUNNER_SESSION_STARTED_AT_MS");
  const sessionEndsAtMs = timestamp(env, "COPY_RUNNER_SESSION_ENDS_AT_MS");
  if ((sessionStartedAtMs === undefined) !== (sessionEndsAtMs === undefined)) {
    throw new Error("COPY_RUNNER_SESSION_STARTED_AT_MS and COPY_RUNNER_SESSION_ENDS_AT_MS must be provided together");
  }
  if (sessionStartedAtMs !== undefined && sessionEndsAtMs !== undefined && sessionEndsAtMs <= sessionStartedAtMs) {
    throw new Error("COPY_RUNNER_SESSION_ENDS_AT_MS must be later than COPY_RUNNER_SESSION_STARTED_AT_MS");
  }
  if (mode === "HYPERLIQUID" && controlToken === "whale-lens-local-simulation-only-v1") {
    throw new Error("Live Hyperliquid mode requires a private COPY_RUNNER_CONTROL_TOKEN");
  }
  return {
    engine: {
      whales,
      mode,
      entryPolicy,
      sizing: {
        mode: "SOURCE_EQUITY_RATIO",
        followerCapitalUsd: number(env, "COPY_RUNNER_FOLLOWER_CAPITAL_USD", 1_000, 1),
        maxAccountStateAgeMs: number(env, "COPY_RUNNER_MAX_ACCOUNT_STATE_AGE_MS", 60_000, 1_000),
        minSourceAccountValueUsd: number(env, "COPY_RUNNER_MIN_SOURCE_ACCOUNT_VALUE_USD", 10_000, 0),
      },
      risk: {
        allowedWhales,
        allowedSymbols,
        maxNotionalUsd: number(env, "COPY_RUNNER_MAX_NOTIONAL_USD", 1_000_000_000, 0.000001),
        maxSlippageProxyBps: number(env, "COPY_RUNNER_MAX_SLIPPAGE_BPS", 50, 0),
        maxDailyLossUsd: number(env, "COPY_RUNNER_MAX_DAILY_LOSS_USD", 100, 0.000001),
      },
    },
    databasePath: resolve(env.COPY_RUNNER_DATABASE?.trim() || "./data/copy-runner.sqlite"),
    host,
    port: number(env, "COPY_RUNNER_PORT", 8788, 1),
    controlToken,
    autoStart: truthy(env.COPY_RUNNER_AUTOSTART, true),
    requireFlatStart: truthy(env.COPY_RUNNER_REQUIRE_FLAT_START, true),
    canonical: {
      runId: canonical.runId,
      asOfMs: canonical.asOfMs,
      coverageMode: canonical.coverageMode,
      rankingScope: canonical.rankingScope,
      configHash: canonical.configHash,
      candidatePoolHash: canonical.candidatePoolHash,
      selectionMode: canonical.selectionMode,
      researchOverride: canonical.researchOverride,
    },
    ...(sessionStartedAtMs !== undefined && sessionEndsAtMs !== undefined
      ? { session: { startedAtMs: sessionStartedAtMs, endsAtMs: sessionEndsAtMs } }
      : {}),
  };
};
