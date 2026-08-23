import { resolve } from "node:path";
import { MAX_TRACKED_WHALES, normalizeAddress } from "./domain.mjs";

const parseBoolean = (value, fallback = false) => value == null ? fallback : String(value).toLowerCase() === "true";
const parseNumber = (value, fallback, label) => {
  const number = value == null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be finite`);
  return number;
};

export const loadFaithfulMirrorConfig = (env = process.env) => {
  const mode = String(env.FMV2_MODE ?? "SIMULATION").toUpperCase();
  if (mode !== "SIMULATION" && mode !== "HYPERLIQUID") throw new Error("FMV2_MODE must be SIMULATION or HYPERLIQUID");
  let pairs;
  try { pairs = JSON.parse(env.FMV2_PAIRS_JSON ?? "[]"); }
  catch { throw new Error("FMV2_PAIRS_JSON must be valid JSON"); }
  if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > MAX_TRACKED_WHALES) {
    throw new Error(`FMV2_PAIRS_JSON must contain 1-${MAX_TRACKED_WHALES} pairs`);
  }
  const normalizedPairs = pairs.map((pair, index) => {
    if (!pair || typeof pair !== "object") throw new Error(`Pair ${index + 1} must be an object`);
    const sourceAddress = normalizeAddress(pair.sourceAddress);
    const targetAddress = pair.targetAddress == null || pair.targetAddress === ""
      ? mode === "HYPERLIQUID" ? (() => { throw new Error(`pair ${index + 1} targetAddress is required in HYPERLIQUID mode`); })() : null
      : normalizeAddress(pair.targetAddress);
    const targetCapitalUsd = parseNumber(pair.targetCapitalUsd ?? pair.capitalUsd, 100, `pair ${index + 1} targetCapitalUsd`);
    if (targetCapitalUsd <= 0) throw new Error(`pair ${index + 1} targetCapitalUsd must be positive`);
    return {
      pairId: String(pair.pairId ?? `pair-${index + 1}`),
      sourceAddress,
      ...(targetAddress ? { targetAddress } : {}),
      targetCapitalUsd,
      label: pair.label == null ? `Whale ${index + 1}` : String(pair.label),
    };
  });
  if (new Set(normalizedPairs.map((pair) => pair.sourceAddress)).size !== normalizedPairs.length) throw new Error("Source addresses must be unique");
  const targetAddresses = normalizedPairs.flatMap((pair) => pair.targetAddress ? [pair.targetAddress] : []);
  if (new Set(targetAddresses).size !== targetAddresses.length) throw new Error("Target addresses must be unique");

  const controlToken = String(env.FMV2_CONTROL_TOKEN ?? "");
  if (controlToken.length < 16) throw new Error("FMV2_CONTROL_TOKEN must contain at least 16 characters");

  const testnet = parseBoolean(env.FMV2_TESTNET, true);
  if (mode === "HYPERLIQUID" && !testnet && env.FMV2_PRODUCTION_CONFIRMED !== "I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS") {
    throw new Error("Mainnet requires FMV2_PRODUCTION_CONFIRMED=I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS");
  }
  return {
    mode,
    testnet,
    pairs: normalizedPairs,
    infoUrl: testnet ? "https://api.hyperliquid-testnet.xyz/info" : "https://api.hyperliquid.xyz/info",
    wsUrl: testnet ? "wss://api.hyperliquid-testnet.xyz/ws" : "wss://api.hyperliquid.xyz/ws",
    dataDirectory: resolve(env.FMV2_DATA_DIRECTORY ?? "./data/faithful-mirror-v2"),
    heartbeatMs: parseNumber(env.FMV2_HEARTBEAT_MS, 20_000, "FMV2_HEARTBEAT_MS"),
    staleConnectionMs: parseNumber(env.FMV2_STALE_CONNECTION_MS, 50_000, "FMV2_STALE_CONNECTION_MS"),
    reconnectMaxMs: parseNumber(env.FMV2_RECONNECT_MAX_MS, 30_000, "FMV2_RECONNECT_MAX_MS"),
    allowApproxUnified: parseBoolean(env.FMV2_ALLOW_APPROX_UNIFIED, false),
    minimumSourceEquityUsd: parseNumber(env.FMV2_MIN_SOURCE_EQUITY_USD, 10_000, "FMV2_MIN_SOURCE_EQUITY_USD"),
    controlHost: String(env.FMV2_CONTROL_HOST ?? "127.0.0.1"),
    controlPort: parseNumber(env.FMV2_CONTROL_PORT, 8790, "FMV2_CONTROL_PORT"),
    controlToken,
    snapshotIntervalMs: parseNumber(env.FMV2_SNAPSHOT_INTERVAL_MS, 1_000, "FMV2_SNAPSHOT_INTERVAL_MS"),
    autoStart: parseBoolean(env.FMV2_AUTO_START, mode === "SIMULATION"),
    paperFees: {
      takerFeeRate: parseNumber(env.FMV2_PAPER_TAKER_FEE_RATE, 0.00045, "FMV2_PAPER_TAKER_FEE_RATE"),
      makerFeeRate: parseNumber(env.FMV2_PAPER_MAKER_FEE_RATE, 0.00015, "FMV2_PAPER_MAKER_FEE_RATE"),
    },
    actorConfig: {
      immediateResidualNotionalUsd: parseNumber(env.FMV2_MIN_RESIDUAL_NOTIONAL_USD, 10, "FMV2_MIN_RESIDUAL_NOTIONAL_USD"),
      targetPositionToleranceBps: parseNumber(env.FMV2_TARGET_TOLERANCE_BPS, 5, "FMV2_TARGET_TOLERANCE_BPS"),
      verificationDelayMs: parseNumber(env.FMV2_VERIFY_DELAY_MS, 250, "FMV2_VERIFY_DELAY_MS"),
      terminalVerificationDelayMs: parseNumber(env.FMV2_TERMINAL_VERIFY_DELAY_MS, 1_000, "FMV2_TERMINAL_VERIFY_DELAY_MS"),
      maxCatchUpSlippageBps: parseNumber(env.FMV2_MAX_SLIPPAGE_BPS, 50, "FMV2_MAX_SLIPPAGE_BPS"),
      killOnTerminalResidual: parseBoolean(env.FMV2_KILL_ON_TERMINAL_RESIDUAL, true),
    },
  };
};
