import { getD1Database } from "../../../db";
import { SEED_WALLETS } from "../../seed-wallets";
import type {
  AuditLog,
  AuditLogInput,
  AuditOrder,
  AuditOrderInput,
  AuditPerformance,
  AuditPerformanceInput,
  AuditReadResponse,
  AuditRun,
  AuditRunInput,
  AuditSyncInput,
  AuditWallet,
  AuditWalletInput,
} from "./audit-contract";

const MAX_WATCHED_WALLETS = 50;
const MAX_ORDERS_PER_SYNC = 200;
const MAX_LOGS_PER_SYNC = 500;
const MAX_PERFORMANCE_PER_SYNC = 30;
const MAX_PAGE_SIZE = 100;

const runtimeSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS watched_wallets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    address TEXT NOT NULL,
    label TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, address)
  )`,
  `CREATE TABLE IF NOT EXISTS engine_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    state TEXT NOT NULL,
    execution_enabled INTEGER NOT NULL DEFAULT 0,
    testnet INTEGER NOT NULL DEFAULT 1,
    started_at INTEGER NOT NULL,
    stopped_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS copy_orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    whale_address TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    segment TEXT,
    status TEXT NOT NULL,
    size REAL NOT NULL,
    price REAL,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, source_event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS engine_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    event_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    whale_address TEXT,
    symbol TEXT,
    latency_ms INTEGER,
    detail_json TEXT,
    occurred_at INTEGER NOT NULL,
    UNIQUE(user_id, event_key)
  )`,
  `CREATE TABLE IF NOT EXISTS whale_performance (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    whale_address TEXT NOT NULL,
    roi_30d REAL,
    realized_pnl REAL NOT NULL DEFAULT 0,
    fees REAL NOT NULL DEFAULT 0,
    executed_notional_usd REAL NOT NULL DEFAULT 0,
    executions INTEGER NOT NULL DEFAULT 0,
    blocked_executions INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, run_id, whale_address)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_watched_wallets_user_sort ON watched_wallets(user_id, sort_order)",
  "CREATE INDEX IF NOT EXISTS idx_engine_runs_user_started ON engine_runs(user_id, started_at)",
  "CREATE INDEX IF NOT EXISTS idx_copy_orders_user_created ON copy_orders(user_id, created_at, id)",
  "CREATE INDEX IF NOT EXISTS idx_copy_orders_user_run_created ON copy_orders(user_id, run_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_engine_logs_user_occurred ON engine_logs(user_id, occurred_at, id)",
  "CREATE INDEX IF NOT EXISTS idx_engine_logs_user_run_occurred ON engine_logs(user_id, run_id, occurred_at)",
  "CREATE INDEX IF NOT EXISTS idx_whale_performance_user_run_updated ON whale_performance(user_id, run_id, updated_at)",
  "PRAGMA optimize",
];

let runtimeInitialization: Promise<void> | undefined;

export type AuditUser = { id: string; email: string | null };
type Cursor = { at: number; id: string };

const LOCAL_PERSONAL_AUDIT_USER: AuditUser = {
  id: "local-personal-user",
  email: null,
};

function all<T>(statement: D1PreparedStatement): Promise<T[]> {
  return statement.all<T>().then((result) => result.results ?? []);
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 1;
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function now(): number {
  return Date.now();
}

function makeId(prefix: string, values: string[]): string {
  return `${prefix}:${values.join(":")}`.slice(0, 480);
}

function storedRunId(userId: string, runId: string): string {
  return makeId("run", [userId, runId]);
}

function decodeCursor(value: string | null): Cursor {
  if (!value) return { at: Number.MAX_SAFE_INTEGER, id: "\uffff" };
  try {
    const decoded = JSON.parse(atob(value)) as Partial<Cursor>;
    if (typeof decoded.id !== "string" || !Number.isFinite(decoded.at)) {
      throw new Error("invalid cursor");
    }
    return { at: decoded.at, id: decoded.id };
  } catch {
    return { at: Number.MAX_SAFE_INTEGER, id: "\uffff" };
  }
}

function encodeCursor(row: { createdAt?: number; occurredAt?: number; id: string } | undefined): string | null {
  if (!row) return null;
  return btoa(JSON.stringify({ at: row.createdAt ?? row.occurredAt, id: row.id }));
}

function pageSize(value: number | null | undefined): number {
  return Math.min(Math.max(Math.trunc(value ?? 50), 1), MAX_PAGE_SIZE);
}

async function runInBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }
}

export function getAuditUser(): AuditUser {
  return LOCAL_PERSONAL_AUDIT_USER;
}

export async function initializeAuditDatabase(): Promise<D1Database> {
  const db = getD1Database();
  if (!runtimeInitialization) {
    runtimeInitialization = runInBatches(
      db,
      runtimeSchemaStatements.map((sql) => db.prepare(sql)),
    ).catch((error) => {
      runtimeInitialization = undefined;
      throw error;
    });
  }
  await runtimeInitialization;
  return db;
}

async function ensureSeedWallets(db: D1Database, user: AuditUser): Promise<void> {
  const existing = await db.prepare("SELECT COUNT(*) AS count FROM watched_wallets WHERE user_id = ?")
    .bind(user.id)
    .first<{ count: number }>();
  if (Number(existing?.count ?? 0) > 0) return;
  const timestamp = now();
  await runInBatches(db, SEED_WALLETS.map((wallet, sortOrder) => db.prepare(
    `INSERT OR IGNORE INTO watched_wallets (id, user_id, address, label, enabled, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    makeId("wallet", [user.id, wallet.address]),
    user.id,
    wallet.address.toLowerCase(),
    wallet.label,
    wallet.status === "ACTIVE" ? 1 : 0,
    sortOrder,
    timestamp,
    timestamp,
  )));
}

function normalizeWallets(wallets: AuditWalletInput[] | undefined): AuditWalletInput[] {
  if (!wallets) return [];
  const unique = new Map<string, AuditWalletInput>();
  wallets.slice(0, MAX_WATCHED_WALLETS).forEach((wallet, index) => {
    const address = typeof wallet.address === "string" ? wallet.address.trim().toLowerCase() : "";
    const label = typeof wallet.label === "string" ? wallet.label.trim() : "";
    if (!/^0x[a-f0-9]{40}$/.test(address) || !label || label.length > 120) return;
    unique.set(address, {
      address,
      label,
      enabled: wallet.enabled !== false,
      sortOrder: Number.isInteger(wallet.sortOrder) ? Math.max(0, wallet.sortOrder!) : index,
    });
  });
  return [...unique.values()];
}

function sanitizeRun(run: AuditRunInput | null | undefined): AuditRunInput | null {
  if (!run || typeof run.id !== "string" || !run.id || run.id.length > 240) return null;
  if (typeof run.mode !== "string" || typeof run.state !== "string") return null;
  return {
    id: run.id,
    mode: run.mode.slice(0, 64),
    state: run.state.slice(0, 64),
    startedAt: toFiniteNumber(run.startedAt, now()),
    stoppedAt: run.stoppedAt === null || run.stoppedAt === undefined ? null : toOptionalFiniteNumber(run.stoppedAt),
    executionEnabled: run.executionEnabled === true,
    testnet: run.testnet !== false,
  };
}

function sanitizeOrders(orders: AuditOrderInput[] | undefined): AuditOrderInput[] {
  if (!orders) return [];
  return orders.slice(0, MAX_ORDERS_PER_SYNC).flatMap((order) => {
    if (
      !order ||
      typeof order.id !== "string" ||
      typeof order.sourceEventId !== "string" ||
      typeof order.runId !== "string" ||
      typeof order.whaleAddress !== "string" ||
      typeof order.symbol !== "string" ||
      !order.id || !order.sourceEventId || !order.runId || !order.whaleAddress || !order.symbol ||
      !["long", "short"].includes(order.side)
    ) return [];
    return [{
      id: order.id.slice(0, 480),
      sourceEventId: order.sourceEventId.slice(0, 480),
      runId: order.runId.slice(0, 240),
      whaleAddress: order.whaleAddress.toLowerCase().slice(0, 160),
      symbol: order.symbol.toUpperCase().slice(0, 40),
      side: order.side,
      segment: typeof order.segment === "string" ? order.segment.slice(0, 32) : null,
      status: typeof order.status === "string" ? order.status.slice(0, 32) : "filled",
      size: toFiniteNumber(order.size),
      price: toOptionalFiniteNumber(order.price),
      createdAt: toFiniteNumber(order.createdAt, now()),
    }];
  });
}

function sanitizeLogs(logs: AuditLogInput[] | undefined): AuditLogInput[] {
  if (!logs) return [];
  return logs.slice(0, MAX_LOGS_PER_SYNC).flatMap((entry) => {
    if (!entry || typeof entry.id !== "string" || typeof entry.eventKey !== "string" || typeof entry.runId !== "string") return [];
    if (typeof entry.kind !== "string" || typeof entry.message !== "string" || !entry.id || !entry.eventKey || !entry.runId) return [];
    const detail = entry.detail && typeof entry.detail === "object" ? JSON.stringify(entry.detail).slice(0, 4_000) : null;
    return [{
      id: entry.id.slice(0, 480),
      eventKey: entry.eventKey.slice(0, 480),
      runId: entry.runId.slice(0, 240),
      kind: entry.kind.slice(0, 64),
      severity: entry.severity === "error" || entry.severity === "warning" ? entry.severity : "info",
      message: entry.message.slice(0, 2_000),
      whaleAddress: typeof entry.whaleAddress === "string" ? entry.whaleAddress.toLowerCase().slice(0, 160) : null,
      symbol: typeof entry.symbol === "string" ? entry.symbol.toUpperCase().slice(0, 40) : null,
      latencyMs: toOptionalFiniteNumber(entry.latencyMs),
      detail: detail ? JSON.parse(detail) as Record<string, unknown> : null,
      occurredAt: toFiniteNumber(entry.occurredAt, now()),
    }];
  });
}

function sanitizePerformance(performance: AuditPerformanceInput[] | undefined): AuditPerformanceInput[] {
  if (!performance) return [];
  return performance.slice(0, MAX_PERFORMANCE_PER_SYNC).flatMap((entry) => {
    if (!entry || typeof entry.runId !== "string" || typeof entry.whaleAddress !== "string" || !entry.runId || !entry.whaleAddress) return [];
    return [{
      runId: entry.runId.slice(0, 240),
      whaleAddress: entry.whaleAddress.toLowerCase().slice(0, 160),
      roi30d: toOptionalFiniteNumber(entry.roi30d),
      realizedPnl: toFiniteNumber(entry.realizedPnl),
      fees: toFiniteNumber(entry.fees),
      executedNotionalUsd: toFiniteNumber(entry.executedNotionalUsd),
      executions: Math.max(0, Math.trunc(toFiniteNumber(entry.executions))),
      blockedExecutions: Math.max(0, Math.trunc(toFiniteNumber(entry.blockedExecutions))),
      errors: Math.max(0, Math.trunc(toFiniteNumber(entry.errors))),
      updatedAt: toFiniteNumber(entry.updatedAt, now()),
    }];
  });
}

export async function syncAudit(user: AuditUser, input: AuditSyncInput): Promise<{ accepted: number }> {
  const db = await initializeAuditDatabase();
  await ensureSeedWallets(db, user);
  const timestamp = now();
  const statements: D1PreparedStatement[] = [];
  const wallets = normalizeWallets(input.wallets);
  const run = sanitizeRun(input.run);
  const orders = sanitizeOrders(input.orders);
  const logs = sanitizeLogs(input.logs);
  const performance = sanitizePerformance(input.performance);

  wallets.forEach((wallet) => {
    statements.push(db.prepare(
      `INSERT INTO watched_wallets (id, user_id, address, label, enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, address) DO UPDATE SET label = excluded.label, enabled = excluded.enabled, sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
    ).bind(
      makeId("wallet", [user.id, wallet.address]), user.id, wallet.address, wallet.label,
      wallet.enabled ? 1 : 0, wallet.sortOrder ?? 0, timestamp, timestamp,
    ));
  });

  if (run) {
    statements.push(db.prepare(
      `INSERT INTO engine_runs (id, user_id, mode, state, execution_enabled, testnet, started_at, stopped_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, execution_enabled = excluded.execution_enabled, testnet = excluded.testnet, stopped_at = excluded.stopped_at, updated_at = excluded.updated_at`,
    ).bind(
      storedRunId(user.id, run.id), user.id, run.mode, run.state, run.executionEnabled ? 1 : 0, run.testnet ? 1 : 0,
      run.startedAt, run.stoppedAt, timestamp, timestamp,
    ));
  }

  orders.forEach((order) => {
    statements.push(db.prepare(
      `INSERT INTO copy_orders (id, user_id, run_id, source_event_id, whale_address, symbol, side, segment, status, size, price, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, source_event_id) DO UPDATE SET run_id = excluded.run_id, status = excluded.status, segment = excluded.segment, size = excluded.size, price = excluded.price`,
    ).bind(
      makeId("order", [user.id, order.id]), user.id, storedRunId(user.id, order.runId), order.sourceEventId, order.whaleAddress, order.symbol,
      order.side, order.segment, order.status, order.size, order.price, order.createdAt,
    ));
  });

  logs.forEach((entry) => {
    statements.push(db.prepare(
      `INSERT INTO engine_logs (id, user_id, run_id, event_key, kind, severity, message, whale_address, symbol, latency_ms, detail_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, event_key) DO UPDATE SET run_id = excluded.run_id, severity = excluded.severity, message = excluded.message, latency_ms = excluded.latency_ms, detail_json = excluded.detail_json`,
    ).bind(
      makeId("log", [user.id, entry.id]), user.id, storedRunId(user.id, entry.runId), entry.eventKey, entry.kind, entry.severity, entry.message,
      entry.whaleAddress, entry.symbol, entry.latencyMs, entry.detail ? JSON.stringify(entry.detail) : null, entry.occurredAt,
    ));
  });

  performance.forEach((entry) => {
    statements.push(db.prepare(
      `INSERT INTO whale_performance (id, user_id, run_id, whale_address, roi_30d, realized_pnl, fees, executed_notional_usd, executions, blocked_executions, errors, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, run_id, whale_address) DO UPDATE SET roi_30d = excluded.roi_30d, realized_pnl = excluded.realized_pnl, fees = excluded.fees, executed_notional_usd = excluded.executed_notional_usd, executions = excluded.executions, blocked_executions = excluded.blocked_executions, errors = excluded.errors, updated_at = excluded.updated_at`,
    ).bind(
      makeId("performance", [user.id, entry.runId, entry.whaleAddress]), user.id, storedRunId(user.id, entry.runId),
      entry.whaleAddress, entry.roi30d, entry.realizedPnl, entry.fees, entry.executedNotionalUsd,
      entry.executions, entry.blockedExecutions, entry.errors, entry.updatedAt,
    ));
  });

  await runInBatches(db, statements);
  return { accepted: statements.length };
}

type WalletRow = {
  id: string; address: string; label: string; enabled: number; sort_order: number; created_at: number; updated_at: number;
};
type RunRow = {
  id: string; mode: string; state: string; execution_enabled: number; testnet: number; started_at: number; stopped_at: number | null; created_at: number; updated_at: number;
};
type OrderRow = {
  id: string; source_event_id: string; run_id: string; whale_address: string; symbol: string; side: "long" | "short"; segment: string | null; status: string; size: number; price: number | null; created_at: number;
};
type LogRow = {
  id: string; event_key: string; run_id: string; kind: string; severity: "info" | "warning" | "error"; message: string; whale_address: string | null; symbol: string | null; latency_ms: number | null; detail_json: string | null; occurred_at: number;
};
type PerformanceRow = {
  run_id: string; whale_address: string; roi_30d: number | null; realized_pnl: number; fees: number; executed_notional_usd: number; executions: number; blocked_executions: number; errors: number; updated_at: number;
};

function mapWallet(row: WalletRow): AuditWallet {
  return { id: row.id, address: row.address, label: row.label, enabled: toBoolean(row.enabled), sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapRun(row: RunRow): AuditRun {
  return { id: row.id, mode: row.mode, state: row.state, executionEnabled: toBoolean(row.execution_enabled), testnet: toBoolean(row.testnet), startedAt: row.started_at, stoppedAt: row.stopped_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapOrder(row: OrderRow): AuditOrder {
  return { id: row.id, sourceEventId: row.source_event_id, runId: row.run_id, whaleAddress: row.whale_address, symbol: row.symbol, side: row.side, segment: row.segment, status: row.status, size: row.size, price: row.price, createdAt: row.created_at };
}

function mapLog(row: LogRow): AuditLog {
  let detail: Record<string, unknown> | null = null;
  if (row.detail_json) {
    try { detail = JSON.parse(row.detail_json) as Record<string, unknown>; } catch { detail = null; }
  }
  return { id: row.id, eventKey: row.event_key, runId: row.run_id, kind: row.kind, severity: row.severity, message: row.message, whaleAddress: row.whale_address, symbol: row.symbol, latencyMs: row.latency_ms, detail, occurredAt: row.occurred_at };
}

function mapPerformance(row: PerformanceRow): AuditPerformance {
  return { runId: row.run_id, whaleAddress: row.whale_address, roi30d: row.roi_30d, realizedPnl: row.realized_pnl, fees: row.fees, executedNotionalUsd: row.executed_notional_usd, executions: row.executions, blockedExecutions: row.blocked_executions, errors: row.errors, updatedAt: row.updated_at };
}

export async function readAudit(
  user: AuditUser,
  options: { ordersCursor?: string | null; logsCursor?: string | null; ordersLimit?: number | null; logsLimit?: number | null } = {},
): Promise<AuditReadResponse> {
  const db = await initializeAuditDatabase();
  await ensureSeedWallets(db, user);
  const ordersLimit = pageSize(options.ordersLimit);
  const logsLimit = pageSize(options.logsLimit);
  const ordersCursor = decodeCursor(options.ordersCursor ?? null);
  const logsCursor = decodeCursor(options.logsCursor ?? null);

  const [walletRows, runRows, orderRows, logRows] = await Promise.all([
    all<WalletRow>(db.prepare(
      "SELECT id, address, label, enabled, sort_order, created_at, updated_at FROM watched_wallets WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC LIMIT ?",
    ).bind(user.id, MAX_WATCHED_WALLETS)),
    all<RunRow>(db.prepare(
      "SELECT id, mode, state, execution_enabled, testnet, started_at, stopped_at, created_at, updated_at FROM engine_runs WHERE user_id = ? ORDER BY started_at DESC, id DESC LIMIT 1",
    ).bind(user.id)),
    all<OrderRow>(db.prepare(
      "SELECT id, source_event_id, run_id, whale_address, symbol, side, segment, status, size, price, created_at FROM copy_orders WHERE user_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?",
    ).bind(user.id, ordersCursor.at, ordersCursor.at, ordersCursor.id, ordersLimit + 1)),
    all<LogRow>(db.prepare(
      "SELECT id, event_key, run_id, kind, severity, message, whale_address, symbol, latency_ms, detail_json, occurred_at FROM engine_logs WHERE user_id = ? AND (occurred_at < ? OR (occurred_at = ? AND id < ?)) ORDER BY occurred_at DESC, id DESC LIMIT ?",
    ).bind(user.id, logsCursor.at, logsCursor.at, logsCursor.id, logsLimit + 1)),
  ]);
  const run = runRows[0] ? mapRun(runRows[0]) : null;
  const performanceRows = run
    ? await all<PerformanceRow>(db.prepare(
      "SELECT run_id, whale_address, roi_30d, realized_pnl, fees, executed_notional_usd, executions, blocked_executions, errors, updated_at FROM whale_performance WHERE user_id = ? AND run_id = ? ORDER BY updated_at DESC LIMIT ?",
    ).bind(user.id, run.id, MAX_PERFORMANCE_PER_SYNC))
    : [];
  const orderPage = orderRows.slice(0, ordersLimit);
  const logPage = logRows.slice(0, logsLimit);

  return {
    wallets: walletRows.map(mapWallet),
    run,
    performance: performanceRows.map(mapPerformance),
    orders: orderPage.map(mapOrder),
    logs: logPage.map(mapLog),
    pages: {
      orders: { nextCursor: orderRows.length > ordersLimit ? encodeCursor(orderPage.at(-1)) : null },
      logs: { nextCursor: logRows.length > logsLimit ? encodeCursor(logPage.at(-1)) : null },
    },
  };
}

export async function readWatchedWallets(user: AuditUser): Promise<AuditWallet[]> {
  const db = await initializeAuditDatabase();
  await ensureSeedWallets(db, user);
  const rows = await all<WalletRow>(db.prepare(
    "SELECT id, address, label, enabled, sort_order, created_at, updated_at FROM watched_wallets WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC LIMIT ?",
  ).bind(user.id, MAX_WATCHED_WALLETS));
  return rows.map(mapWallet);
}

export const auditLimits = {
  watchedWallets: MAX_WATCHED_WALLETS,
  ordersPerSync: MAX_ORDERS_PER_SYNC,
  logsPerSync: MAX_LOGS_PER_SYNC,
  performancePerSync: MAX_PERFORMANCE_PER_SYNC,
  pageSize: MAX_PAGE_SIZE,
};
