import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const SECRET_KEY = /(?:private|secret|token|signature|signedpayload|authorization|password|mnemonic|api[_-]?key)/i;
const PRIVATE_KEY_VALUE = /^0x[a-f0-9]{64}$/i;
const MAX_DEPTH = 14;
const MAX_RECENT_IDS = 2_000;

const cloneSafe = (value, { secretValues = new Set(), depth = 0 } = {}) => {
  if (depth > MAX_DEPTH) return "[TRUNCATED_DEPTH]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (secretValues.has(value) || PRIVATE_KEY_VALUE.test(value)) return "[REDACTED]";
    return value;
  }
  if (value instanceof Error) return { name: value.name, message: cloneSafe(value.message, { secretValues, depth: depth + 1 }) };
  if (Array.isArray(value)) return value.slice(0, 2_000).map((item) => cloneSafe(item, { secretValues, depth: depth + 1 }));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? "[REDACTED]" : cloneSafe(item, { secretValues, depth: depth + 1 }),
    ]));
  }
  return String(value);
};

const atomicJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
};

const asInteger = (value, fallback = null) => Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
const asRecentIds = (value) => [...new Set((Array.isArray(value) ? value : []).map(String))].slice(-MAX_RECENT_IDS);

export const sanitizeForAudit = (value, secretValues = []) => cloneSafe(value, { secretValues: new Set(secretValues.filter(Boolean)) });

export const normalizePairRecoveryCheckpoint = (input, pair = {}) => {
  const value = input && typeof input === "object" ? input : {};
  const mappings = value.sourceOrderToTargetCloid && typeof value.sourceOrderToTargetCloid === "object"
    ? Object.fromEntries(Object.entries(value.sourceOrderToTargetCloid).map(([sourceOrderId, targetCloid]) => [String(sourceOrderId), String(targetCloid)]))
    : {};
  return {
    pairId: String(value.pairId ?? pair.pairId ?? ""),
    sourceAddress: String(value.sourceAddress ?? pair.sourceAddress ?? "").toLowerCase(),
    targetAddress: String(value.targetAddress ?? pair.targetAddress ?? "").toLowerCase(),
    lastSourceFillTime: asInteger(value.lastSourceFillTime),
    lastTargetFillTime: asInteger(value.lastTargetFillTime),
    recentSourceFillIds: asRecentIds(value.recentSourceFillIds),
    recentTargetFillIds: asRecentIds(value.recentTargetFillIds),
    sourceOrderToTargetCloid: mappings,
    accountMode: value.accountMode == null ? "UNKNOWN" : String(value.accountMode),
    lastSourceSnapshotAt: asInteger(value.lastSourceSnapshotAt),
    lastTargetSnapshotAt: asInteger(value.lastTargetSnapshotAt),
    killSwitch: value.killSwitch === true,
    sessionId: value.sessionId == null ? null : String(value.sessionId),
  };
};

export const normalizeRecoveryCheckpoint = ({ sessionId, mode, state, pairs = [], recoveryPairs = [], writtenAt = Date.now() } = {}) => {
  const pairDetails = Array.isArray(recoveryPairs) && recoveryPairs.length > 0 ? recoveryPairs : pairs;
  return {
    schemaVersion: 1,
    sessionId: sessionId == null ? null : String(sessionId),
    mode: mode == null ? null : String(mode),
    state: state == null ? null : String(state),
    writtenAt: asInteger(writtenAt, Date.now()),
    pairs: pairs.map((pair, index) => normalizePairRecoveryCheckpoint(pairDetails[index], pair)),
  };
};

export class JsonlAuditStore {
  constructor({ eventsPath, snapshotPath, recoveryPath = null, secretValues = [] }) {
    if (!eventsPath || !snapshotPath) throw new Error("Audit store requires eventsPath and snapshotPath");
    this.eventsPath = eventsPath;
    this.snapshotPath = snapshotPath;
    this.recoveryPath = recoveryPath;
    this.secretValues = secretValues.filter(Boolean);
    this.writeTail = Promise.resolve();
  }

  record(event) {
    const safeEvent = sanitizeForAudit(event, this.secretValues);
    const line = `${JSON.stringify(safeEvent)}\n`;
    this.writeTail = this.writeTail.then(async () => {
      await mkdir(dirname(this.eventsPath), { recursive: true });
      await appendFile(this.eventsPath, line, "utf8");
    });
    return this.writeTail;
  }

  writeSnapshot(snapshot) {
    const safeSnapshot = sanitizeForAudit(snapshot, this.secretValues);
    this.writeTail = this.writeTail.then(() => atomicJson(this.snapshotPath, safeSnapshot));
    return this.writeTail;
  }

  writeRecoveryCheckpoint(checkpoint) {
    if (!this.recoveryPath) throw new Error("Audit store does not have a recoveryPath");
    const normalized = normalizeRecoveryCheckpoint(checkpoint);
    this.writeTail = this.writeTail.then(() => atomicJson(this.recoveryPath, sanitizeForAudit(normalized, this.secretValues)));
    return this.writeTail;
  }

  async loadRecoveryCheckpoint() {
    if (!this.recoveryPath) return null;
    try {
      const raw = JSON.parse(await readFile(this.recoveryPath, "utf8"));
      if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.pairs)) throw new Error("Unsupported recovery checkpoint schema");
      return normalizeRecoveryCheckpoint(raw);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async flush() {
    await this.writeTail;
  }

  async close() {
    await this.flush();
  }
}
