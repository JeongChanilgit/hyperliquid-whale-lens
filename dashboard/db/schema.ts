import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const watchedWallets = sqliteTable(
  "watched_wallets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    address: text("address").notNull(),
    label: text("label").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_watched_wallets_user_address").on(table.userId, table.address),
    index("idx_watched_wallets_user_sort").on(table.userId, table.sortOrder),
  ],
);

export const engineRuns = sqliteTable(
  "engine_runs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    mode: text("mode").notNull(),
    state: text("state").notNull(),
    executionEnabled: integer("execution_enabled", { mode: "boolean" }).notNull().default(false),
    testnet: integer("testnet", { mode: "boolean" }).notNull().default(true),
    startedAt: integer("started_at").notNull(),
    stoppedAt: integer("stopped_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_engine_runs_user_started").on(table.userId, table.startedAt)],
);

export const copyOrders = sqliteTable(
  "copy_orders",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    runId: text("run_id").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    whaleAddress: text("whale_address").notNull(),
    symbol: text("symbol").notNull(),
    side: text("side").notNull(),
    segment: text("segment"),
    status: text("status").notNull(),
    size: real("size").notNull(),
    price: real("price"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_copy_orders_user_source_event").on(table.userId, table.sourceEventId),
    index("idx_copy_orders_user_created").on(table.userId, table.createdAt, table.id),
    index("idx_copy_orders_user_run_created").on(table.userId, table.runId, table.createdAt),
  ],
);

export const engineLogs = sqliteTable(
  "engine_logs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    runId: text("run_id").notNull(),
    eventKey: text("event_key").notNull(),
    kind: text("kind").notNull(),
    severity: text("severity").notNull(),
    message: text("message").notNull(),
    whaleAddress: text("whale_address"),
    symbol: text("symbol"),
    latencyMs: integer("latency_ms"),
    detailJson: text("detail_json"),
    occurredAt: integer("occurred_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_engine_logs_user_event_key").on(table.userId, table.eventKey),
    index("idx_engine_logs_user_occurred").on(table.userId, table.occurredAt, table.id),
    index("idx_engine_logs_user_run_occurred").on(table.userId, table.runId, table.occurredAt),
  ],
);

export const whalePerformance = sqliteTable(
  "whale_performance",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    runId: text("run_id").notNull(),
    whaleAddress: text("whale_address").notNull(),
    roi30d: real("roi_30d"),
    realizedPnl: real("realized_pnl").notNull().default(0),
    fees: real("fees").notNull().default(0),
    executedNotionalUsd: real("executed_notional_usd").notNull().default(0),
    executions: integer("executions").notNull().default(0),
    blockedExecutions: integer("blocked_executions").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_whale_performance_user_run_wallet").on(
      table.userId,
      table.runId,
      table.whaleAddress,
    ),
    index("idx_whale_performance_user_run_updated").on(
      table.userId,
      table.runId,
      table.updatedAt,
    ),
  ],
);
