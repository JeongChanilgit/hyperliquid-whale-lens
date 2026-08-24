import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADDRESS = /^0x[a-f0-9]{40}$/i;
const PRIVATE_KEY = /^0x[a-f0-9]{64}$/i;
const CONFIRMATION = "I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS";
const SECRET_CONFIG_KEY = /(?:private|secret|token|password|mnemonic|api[_-]?key)/i;

const fail = (message) => { throw new Error(`FMV2 config: ${message}`); };
const asObject = (value, name) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
};
const asNumber = (value, name, { min = -Infinity, max = Infinity, integer = false } = {}) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) fail(`${name} is invalid`);
  return number;
};
const asBoolean = (value, name) => {
  if (typeof value !== "boolean") fail(`${name} must be boolean`);
  return value;
};
const envBoolean = (value, name) => {
  if (value == null || value === "") return null;
  if (/^(true|1)$/i.test(String(value))) return true;
  if (/^(false|0)$/i.test(String(value))) return false;
  fail(`${name} must be true or false`);
};
const asAddress = (value, name) => {
  if (!ADDRESS.test(String(value ?? ""))) fail(`${name} must be a 20-byte 0x address`);
  return String(value).toLowerCase();
};
const pathInsideService = (serviceRoot, value, name) => {
  if (typeof value !== "string" || !value.trim()) fail(`${name} is required`);
  const target = resolve(serviceRoot, value);
  const relation = relative(serviceRoot, target);
  if (relation.startsWith("..") || isAbsolute(relation)) fail(`${name} must stay inside the service root`);
  return target;
};
const resolvePython = (serviceRoot, value) => {
  const input = String(value ?? "python").trim();
  if (!input) fail("FMV2_PYTHON must not be empty");
  return /[\\/]/.test(input) || isAbsolute(input) ? pathInsideService(serviceRoot, input, "FMV2_PYTHON") : input;
};

const rejectEmbeddedSecrets = (value, path = "config") => {
  if (Array.isArray(value)) return value.forEach((item, index) => rejectEmbeddedSecrets(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_CONFIG_KEY.test(key)) fail(`${path}.${key} must be supplied through the environment, never JSON`);
    rejectEmbeddedSecrets(child, `${path}.${key}`);
  }
};

const parsePairs = (rawPairs, mode) => {
  if (!Array.isArray(rawPairs) || rawPairs.length < 1 || rawPairs.length > 5) fail("pairs must contain 1-5 entries");
  const pairIds = new Set();
  const sources = new Set();
  const targets = new Set();
  return rawPairs.map((rawPair, index) => {
    const pair = asObject(rawPair, `pairs[${index}]`);
    const pairId = String(pair.pairId ?? `whale-${index + 1}`).trim();
    if (!pairId || pairIds.has(pairId)) fail(`pairs[${index}].pairId must be unique`);
    pairIds.add(pairId);
    const sourceAddress = asAddress(pair.sourceAddress, `pairs[${index}].sourceAddress`);
    if (sources.has(sourceAddress)) fail("sourceAddress values must be unique");
    sources.add(sourceAddress);
    const targetProvided = pair.targetAddress != null && String(pair.targetAddress).trim() !== "";
    if (mode === "LIVE" && !targetProvided) fail(`pairs[${index}].targetAddress is required in LIVE`);
    const targetAddress = targetProvided ? asAddress(pair.targetAddress, `pairs[${index}].targetAddress`) : null;
    if (targetAddress) {
      if (targetAddress === sourceAddress) fail(`pairs[${index}] sourceAddress and targetAddress must differ`);
      if (targets.has(targetAddress)) fail("targetAddress values must be unique");
      targets.add(targetAddress);
    }
    const capitalUsd = pair.capitalUsd == null ? null : asNumber(pair.capitalUsd, `pairs[${index}].capitalUsd`, { min: Number.EPSILON });
    if (mode === "PAPER" && capitalUsd == null) fail(`pairs[${index}].capitalUsd is required in PAPER`);
    return { pairId, sourceAddress, targetAddress, capitalUsd };
  });
};

export const publicConfig = (config) => ({
  configPath: config.configPath,
  mode: config.mode,
  testnet: config.testnet,
  autoStart: config.autoStart,
  pairs: config.pairs,
  actorConfig: config.actorConfig,
  runtime: config.runtime,
  paper: config.paper,
  audit: config.audit,
  control: { host: config.control.host, port: config.control.port },
  live: {
    exclusiveTargetAccount: config.live.exclusiveTargetAccount,
    adoptExistingTargetState: config.live.adoptExistingTargetState,
    masterAccountAddress: config.live.masterAccountAddress,
    pythonPath: config.live.pythonPath,
    bridgePath: config.live.bridgePath,
    actionExpiresAfterMs: config.live.actionExpiresAfterMs,
  },
});

export const parseServiceConfig = ({ rawConfig, env = process.env, configPath = resolve(HERE, "config.example.json"), serviceRoot = HERE } = {}) => {
  const raw = asObject(rawConfig, "root");
  rejectEmbeddedSecrets(raw);
  const mode = String(raw.mode ?? "").toUpperCase();
  if (mode !== "PAPER" && mode !== "LIVE") fail("mode must be PAPER or LIVE");
  const configTestnet = asBoolean(raw.testnet ?? true, "testnet");
  const suppliedTestnet = envBoolean(env.FMV2_TESTNET, "FMV2_TESTNET");
  if (suppliedTestnet != null && suppliedTestnet !== configTestnet) fail("FMV2_TESTNET must match config.testnet");
  if (mode === "LIVE" && suppliedTestnet == null) fail("LIVE requires explicit FMV2_TESTNET=true or false");
  const testnet = suppliedTestnet ?? configTestnet;
  const autoStart = raw.autoStart === true;
  if (mode === "LIVE" && autoStart) fail("LIVE must never set autoStart=true");
  const pairs = parsePairs(raw.pairs, mode);
  const controlToken = String(env.FMV2_CONTROL_TOKEN ?? "");
  if (controlToken.length < 16) fail("FMV2_CONTROL_TOKEN must be at least 16 characters");

  const actorRaw = asObject(raw.actorConfig ?? {}, "actorConfig");
  const actorConfig = {
    immediateResidualNotionalUsd: asNumber(actorRaw.immediateResidualNotionalUsd ?? 10, "actorConfig.immediateResidualNotionalUsd", { min: 0 }),
    targetPositionToleranceBps: asNumber(actorRaw.targetPositionToleranceBps ?? 5, "actorConfig.targetPositionToleranceBps", { min: 0, max: 10_000 }),
    verificationDelayMs: asNumber(actorRaw.verificationDelayMs ?? 250, "actorConfig.verificationDelayMs", { min: 1, max: 60_000, integer: true }),
    terminalVerificationDelayMs: asNumber(actorRaw.terminalVerificationDelayMs ?? 1000, "actorConfig.terminalVerificationDelayMs", { min: 1, max: 300_000, integer: true }),
    maxCatchUpSlippageBps: asNumber(actorRaw.maxCatchUpSlippageBps ?? 50, "actorConfig.maxCatchUpSlippageBps", { min: 0, max: 10_000 }),
    killOnTerminalResidual: asBoolean(actorRaw.killOnTerminalResidual ?? true, "actorConfig.killOnTerminalResidual"),
  };
  if (actorConfig.terminalVerificationDelayMs < actorConfig.verificationDelayMs) fail("terminalVerificationDelayMs must be >= verificationDelayMs");

  const runtimeRaw = asObject(raw.runtime ?? {}, "runtime");
  const runtime = {
    heartbeatMs: asNumber(runtimeRaw.heartbeatMs ?? 20_000, "runtime.heartbeatMs", { min: 1_000, max: 300_000, integer: true }),
    staleConnectionMs: asNumber(runtimeRaw.staleConnectionMs ?? 50_000, "runtime.staleConnectionMs", { min: 2_000, max: 900_000, integer: true }),
    reconnectMaxMs: asNumber(runtimeRaw.reconnectMaxMs ?? 30_000, "runtime.reconnectMaxMs", { min: 100, max: 300_000, integer: true }),
    allowApproxUnified: asBoolean(runtimeRaw.allowApproxUnified ?? false, "runtime.allowApproxUnified"),
  };
  if (runtime.staleConnectionMs <= runtime.heartbeatMs) fail("runtime.staleConnectionMs must exceed heartbeatMs");

  const paperRaw = asObject(raw.paper ?? {}, "paper");
  const paper = {
    takerFeeRate: asNumber(paperRaw.takerFeeRate ?? 0.00045, "paper.takerFeeRate", { min: 0, max: 0.1 }),
    makerFeeRate: asNumber(paperRaw.makerFeeRate ?? 0.00015, "paper.makerFeeRate", { min: 0, max: 0.1 }),
    defaultSlippageBps: asNumber(paperRaw.defaultSlippageBps ?? 50, "paper.defaultSlippageBps", { min: 0, max: 10_000 }),
  };
  const auditRaw = asObject(raw.audit ?? {}, "audit");
  const audit = {
    eventsPath: pathInsideService(serviceRoot, auditRaw.eventsPath ?? "data/faithful-mirror-v2/events.jsonl", "audit.eventsPath"),
    snapshotPath: pathInsideService(serviceRoot, auditRaw.snapshotPath ?? "data/faithful-mirror-v2/latest-state.json", "audit.snapshotPath"),
    recoveryPath: pathInsideService(serviceRoot, auditRaw.recoveryPath ?? "data/faithful-mirror-v2/recovery-checkpoint.json", "audit.recoveryPath"),
    snapshotIntervalMs: asNumber(auditRaw.snapshotIntervalMs ?? 5_000, "audit.snapshotIntervalMs", { min: 250, max: 300_000, integer: true }),
  };
  const controlRaw = asObject(raw.control ?? {}, "control");
  const host = String(controlRaw.host ?? "127.0.0.1");
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) fail("control.host must be localhost, 127.0.0.1, or ::1");
  const control = {
    host,
    port: asNumber(controlRaw.port ?? 8790, "control.port", { min: 1, max: 65_535, integer: true }),
    token: controlToken,
  };

  const liveRaw = asObject(raw.live ?? {}, "live");
  const live = {
    exclusiveTargetAccount: asBoolean(liveRaw.exclusiveTargetAccount ?? true, "live.exclusiveTargetAccount"),
    adoptExistingTargetState: asBoolean(liveRaw.adoptExistingTargetState ?? false, "live.adoptExistingTargetState"),
    masterAccountAddress: null,
    pythonPath: resolvePython(serviceRoot, env.FMV2_PYTHON),
    bridgePath: pathInsideService(serviceRoot, String(env.FMV2_BRIDGE_PATH ?? "hyperliquid_pair_bridge.py"), "FMV2_BRIDGE_PATH"),
    actionExpiresAfterMs: asNumber(env.FMV2_ACTION_EXPIRES_AFTER_MS ?? 5_000, "FMV2_ACTION_EXPIRES_AFTER_MS", { min: 100, max: 60_000, integer: true }),
    agentPrivateKeys: [],
  };
  if (live.exclusiveTargetAccount && live.adoptExistingTargetState) fail("live.exclusiveTargetAccount and live.adoptExistingTargetState cannot both be true");
  if (mode === "LIVE") {
    live.masterAccountAddress = asAddress(env.FMV2_MASTER_ACCOUNT_ADDRESS, "FMV2_MASTER_ACCOUNT_ADDRESS");
    if (!testnet && env.FMV2_PRODUCTION_CONFIRMED !== CONFIRMATION) fail("mainnet LIVE requires FMV2_PRODUCTION_CONFIRMED confirmation");
    const seenKeys = new Set();
    live.agentPrivateKeys = pairs.map((pair, index) => {
      const key = String(env[`FMV2_AGENT_PRIVATE_KEY_${index + 1}`] ?? "");
      if (!PRIVATE_KEY.test(key)) fail(`FMV2_AGENT_PRIVATE_KEY_${index + 1} is missing or invalid`);
      if (seenKeys.has(key)) fail("LIVE requires one distinct agent key per pair");
      seenKeys.add(key);
      return key;
    });
  }
  return { configPath: resolve(configPath), serviceRoot: resolve(serviceRoot), mode, testnet, autoStart, pairs, actorConfig, runtime, paper, audit, control, live };
};

export const loadConfig = async ({ env = process.env, serviceRoot = HERE, configPath = env.FMV2_CONFIG } = {}) => {
  if (!configPath) fail("FMV2_CONFIG is required");
  const resolvedConfigPath = isAbsolute(configPath) ? configPath : resolve(serviceRoot, configPath);
  let raw;
  try { raw = JSON.parse(await readFile(resolvedConfigPath, "utf8")); }
  catch (error) { fail(`cannot read FMV2_CONFIG (${error instanceof Error ? error.message : "unknown error"})`); }
  return parseServiceConfig({ rawConfig: raw, env, configPath: resolvedConfigPath, serviceRoot });
};

export const FMV2_MAINNET_CONFIRMATION = CONFIRMATION;
