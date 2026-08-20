import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CopyEngineAuditSink } from "../../app/lib/realtime/copy-engine";
import type { IdempotencyStore, RiskGateInitialState } from "../../app/lib/realtime/risk-gates";
import type { CopyAccountEquityPoint, CopyEngineSnapshot, CopyPerformance, EngineLogEntry, MirroredOrder, MirroredOrderEvent, SimulationLedgerEvent, SimulationPositionSnapshot } from "../../app/lib/copy-types";

export interface PersistedEngineState {
  performance: CopyPerformance;
  performanceByWhale: Record<string, CopyPerformance>;
  risk: RiskGateInitialState;
  simulationPositions: SimulationPositionSnapshot[];
}

export interface PersistedPosition {
  symbol: string;
  position: number;
}

const blankPerformance = (): CopyPerformance => ({ realizedPnl: 0, fees: 0, executedNotionalUsd: 0, simulatedFills: 0, executions: 0, blockedExecutions: 0, errors: 0 });
const safeJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

/** SQLite audit, idempotency, engine-state, whale-performance, and expected-position store. */
export class CopyRunnerStore implements IdempotencyStore, CopyEngineAuditSink {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS engine_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        state TEXT NOT NULL DEFAULT 'STOPPED',
        kill_switch INTEGER NOT NULL DEFAULT 0,
        risk_day TEXT NOT NULL DEFAULT '',
        daily_pnl REAL NOT NULL DEFAULT 0,
        performance_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        time INTEGER NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        whale TEXT,
        coin TEXT,
        symbol TEXT,
        idempotency_key TEXT,
        latency_ms INTEGER,
        detail_json TEXT
      );
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS simulation_events (
        source_fill_id TEXT PRIMARY KEY,
        whale TEXT NOT NULL,
        time INTEGER NOT NULL,
        realized_pnl REAL NOT NULL,
        fees REAL NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS simulation_positions (
        position_key TEXT PRIMARY KEY,
        whale TEXT NOT NULL,
        coin TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS whale_performance (
        whale TEXT PRIMARY KEY,
        performance_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_equity_history (
        whale TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        account_value_usd REAL NOT NULL,
        realized_pnl REAL NOT NULL,
        PRIMARY KEY (whale, captured_at)
      );
      CREATE INDEX IF NOT EXISTS idx_account_equity_history_time
        ON account_equity_history(captured_at, whale);
      CREATE TABLE IF NOT EXISTS mirrored_orders (
        order_key TEXT PRIMARY KEY,
        whale TEXT NOT NULL,
        source_oid TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS expected_positions (
        symbol TEXT PRIMARY KEY,
        position REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS binance_orders (
        client_order_id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        source_key TEXT NOT NULL,
        expected_position REAL NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  acquire(key: string): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO idempotency_keys (key, created_at) VALUES (?, ?)").run(key, Date.now());
    return result.changes === 1;
  }

  onLog(entry: EngineLogEntry): void {
    this.db.prepare(`INSERT INTO audit_log (event_id, time, kind, message, whale, coin, symbol, idempotency_key, latency_ms, detail_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(entry.id, entry.time, entry.kind, entry.message, entry.whale ?? null, entry.coin ?? null, entry.symbol ?? null, entry.idempotencyKey ?? null, entry.latencyMs ?? null, entry.detail ? JSON.stringify(entry.detail) : null);
  }

  onSimulation(event: SimulationLedgerEvent): void {
    const fees = event.fills.reduce((total, fill) => total + fill.fee, 0);
    const pnlAfterFees = event.realizedPnl - fees;
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO simulation_events (source_fill_id, whale, time, realized_pnl, fees, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)`).run(event.sourceFillId, event.whale, event.sourceFill.time, event.realizedPnl, fees, JSON.stringify(event));
    if (inserted.changes !== 1) return;
    const day = new Date(event.sourceFill.time).toISOString().slice(0, 10);
    this.db.prepare(`INSERT INTO engine_state (singleton, state, kill_switch, risk_day, daily_pnl, performance_json, updated_at)
      VALUES (1, 'RUNNING', 0, ?, ?, '{}', ?)
      ON CONFLICT(singleton) DO UPDATE SET
        risk_day = CASE WHEN engine_state.risk_day = excluded.risk_day THEN engine_state.risk_day ELSE excluded.risk_day END,
        daily_pnl = CASE WHEN engine_state.risk_day = excluded.risk_day THEN engine_state.daily_pnl + excluded.daily_pnl ELSE excluded.daily_pnl END,
      updated_at = excluded.updated_at`).run(day, pnlAfterFees, Date.now());
  }

  onSimulationPosition(position: SimulationPositionSnapshot): void {
    const positionKey = `${position.whale.toLowerCase()}|${position.coin.toUpperCase()}`;
    if (Math.abs(position.sourcePosition) <= 1e-9 && Math.abs(position.followerPosition) <= 1e-9) {
      this.db.prepare("DELETE FROM simulation_positions WHERE position_key = ?").run(positionKey);
      return;
    }
    this.db.prepare(`INSERT INTO simulation_positions (position_key, whale, coin, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(position_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`)
      .run(positionKey, position.whale.toLowerCase(), position.coin.toUpperCase(), JSON.stringify(position), position.updatedAt);
  }

  onMirrorOrder(event: MirroredOrderEvent): void {
    this.db.prepare(`INSERT INTO mirrored_orders (order_key, whale, source_oid, status, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(order_key) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json, updated_at = excluded.updated_at`)
      .run(event.order.id, event.order.whale, event.order.sourceOid, event.order.status, JSON.stringify(event.order), event.order.updatedAt);
  }

  onSnapshot(snapshot: CopyEngineSnapshot): void {
    const now = Date.now();
    const capturedAt = Math.floor(now / 60_000) * 60_000;
    this.db.prepare(`INSERT INTO engine_state (singleton, state, kill_switch, performance_json, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET state = excluded.state, kill_switch = excluded.kill_switch, performance_json = excluded.performance_json, updated_at = excluded.updated_at`)
      .run(snapshot.state, snapshot.killSwitch ? 1 : 0, JSON.stringify(snapshot.performance), now);
    const byWhale = (snapshot as CopyEngineSnapshot & { performanceByWhale?: Record<string, CopyPerformance> }).performanceByWhale ?? {};
    for (const [whale, performance] of Object.entries(byWhale)) {
      this.db.prepare(`INSERT INTO whale_performance (whale, performance_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(whale) DO UPDATE SET performance_json = excluded.performance_json, updated_at = excluded.updated_at`)
        .run(whale.toLowerCase(), JSON.stringify(performance), now);
    }
    const allocation = snapshot.sizing.allocationPerWhaleUsd
      ?? (snapshot.sizing.followerCapitalUsd && snapshot.watchedWhales.length > 0
        ? snapshot.sizing.followerCapitalUsd / snapshot.watchedWhales.length
        : undefined);
    const historyStatement = this.db.prepare(`INSERT INTO account_equity_history (whale, captured_at, account_value_usd, realized_pnl)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(whale, captured_at) DO UPDATE SET account_value_usd = excluded.account_value_usd, realized_pnl = excluded.realized_pnl`);
    for (const watchedWhale of snapshot.watchedWhales) {
      const whale = watchedWhale.toLowerCase();
      const performance = byWhale[whale] ?? blankPerformance();
      const sizing = snapshot.sizingByWhale[whale];
      const accountValueUsd = sizing?.followerAccountValueUsd
        ?? (allocation === undefined ? undefined : allocation + performance.realizedPnl - performance.fees);
      if (accountValueUsd === undefined || !Number.isFinite(accountValueUsd)) continue;
      historyStatement.run(whale, capturedAt, accountValueUsd, performance.realizedPnl);
    }
  }

  restoreEngineState(): PersistedEngineState {
    const state = this.db.prepare("SELECT kill_switch, risk_day, daily_pnl, performance_json FROM engine_state WHERE singleton = 1").get() as { kill_switch?: number; risk_day?: string; daily_pnl?: number; performance_json?: string } | undefined;
    const rows = this.db.prepare("SELECT whale, performance_json FROM whale_performance").all() as Array<{ whale: string; performance_json: string }>;
    const positionRows = this.db.prepare("SELECT payload_json FROM simulation_positions ORDER BY whale, coin").all() as Array<{ payload_json: string }>;
    return {
      performance: { ...blankPerformance(), ...safeJson(state?.performance_json, {}) },
      performanceByWhale: Object.fromEntries(rows.map((row) => [row.whale, { ...blankPerformance(), ...safeJson(row.performance_json, {}) }])),
      risk: { killSwitch: state?.kill_switch === 1, lossDay: state?.risk_day, realizedPnlToday: state?.daily_pnl },
      simulationPositions: positionRows.flatMap((row) => {
        const position = safeJson<SimulationPositionSnapshot | undefined>(row.payload_json, undefined);
        return position ? [position] : [];
      }),
    };
  }

  recentMirroredOrders(limit = 500): MirroredOrder[] {
    const safeLimit = Math.max(1, Math.min(2_000, Math.trunc(limit)));
    const rows = this.db.prepare("SELECT payload_json FROM mirrored_orders ORDER BY updated_at DESC LIMIT ?").all(safeLimit) as Array<{ payload_json: string }>;
    return rows.flatMap((row) => {
      const order = safeJson<MirroredOrder | undefined>(row.payload_json, undefined);
      if (!order) return [];
      return [order.coin.includes(":") ? { ...order, symbol: order.coin.toUpperCase() } : order];
    });
  }

  accountEquityHistory(limit = 30_000): CopyAccountEquityPoint[] {
    const safeLimit = Math.max(1, Math.min(50_000, Math.trunc(limit)));
    const rows = this.db.prepare(`SELECT whale, captured_at, account_value_usd, realized_pnl
      FROM (
        SELECT whale, captured_at, account_value_usd, realized_pnl
        FROM account_equity_history
        ORDER BY captured_at DESC, whale DESC
        LIMIT ?
      )
      ORDER BY captured_at ASC, whale ASC`).all(safeLimit) as Array<{
        whale: string;
        captured_at: number;
        account_value_usd: number;
        realized_pnl: number;
      }>;
    return rows.map((row) => ({
      whale: row.whale,
      time: Number(row.captured_at),
      accountValueUsd: Number(row.account_value_usd),
      realizedPnl: Number(row.realized_pnl),
    }));
  }

  expectedPositions(): PersistedPosition[] {
    return (this.db.prepare("SELECT symbol, position FROM expected_positions ORDER BY symbol").all() as Array<{ symbol: string; position: number }>)
      .map((row) => ({ symbol: row.symbol, position: Number(row.position) }));
  }

  expectedPosition(symbol: string): number {
    const row = this.db.prepare("SELECT position FROM expected_positions WHERE symbol = ?").get(symbol) as { position?: number } | undefined;
    return Number(row?.position ?? 0);
  }

  setExpectedPosition(symbol: string, position: number): void {
    this.db.prepare(`INSERT INTO expected_positions (symbol, position, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`).run(symbol, position, Date.now());
  }

  recordBinanceOrder(input: { clientOrderId: string; symbol: string; sourceKey: string; expectedPosition: number; status: string; payload: unknown }): void {
    this.db.prepare(`INSERT INTO binance_orders (client_order_id, symbol, source_key, expected_position, status, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_order_id) DO UPDATE SET status = excluded.status, expected_position = excluded.expected_position, payload_json = excluded.payload_json, updated_at = excluded.updated_at`)
      .run(input.clientOrderId, input.symbol, input.sourceKey, input.expectedPosition, input.status, JSON.stringify(input.payload), Date.now());
  }

  unresolvedOrders(): Array<{ clientOrderId: string; symbol: string; status: string }> {
    return this.db.prepare("SELECT client_order_id AS clientOrderId, symbol, status FROM binance_orders WHERE status NOT IN ('FILLED', 'CANCELED', 'EXPIRED', 'REJECTED')").all() as Array<{ clientOrderId: string; symbol: string; status: string }>;
  }

  close(): void {
    this.db.close();
  }
}
