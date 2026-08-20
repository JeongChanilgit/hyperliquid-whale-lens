import { resolve } from "node:path";
import type { CopyEngineConfig, CopyEntryPolicy, CopyMode, WhaleConfig } from "../../app/lib/copy-types";
import { SEED_WALLETS } from "../../app/seed-wallets";

export interface CopyRunnerConfig {
  engine: CopyEngineConfig;
  databasePath: string;
  host: string;
  port: number;
  controlToken: string;
  autoStart: boolean;
  requireFlatStart: boolean;
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
const DEFAULT_WHALES = JSON.stringify(
  SEED_WALLETS.filter((wallet) => wallet.status === "ACTIVE").slice(0, 10).map((wallet) => ({ address: wallet.address, copyRatio: 0.01 })),
);

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
  const whales = parseWhales(env.COPY_RUNNER_WHALES?.trim() || DEFAULT_WHALES);
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
    ...(sessionStartedAtMs !== undefined && sessionEndsAtMs !== undefined
      ? { session: { startedAtMs: sessionStartedAtMs, endsAtMs: sessionEndsAtMs } }
      : {}),
  };
};
