CREATE TABLE `copy_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`run_id` text NOT NULL,
	`source_event_id` text NOT NULL,
	`whale_address` text NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`segment` text,
	`status` text NOT NULL,
	`size` real NOT NULL,
	`price` real,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_copy_orders_user_source_event` ON `copy_orders` (`user_id`,`source_event_id`);--> statement-breakpoint
CREATE INDEX `idx_copy_orders_user_created` ON `copy_orders` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_copy_orders_user_run_created` ON `copy_orders` (`user_id`,`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `engine_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`run_id` text NOT NULL,
	`event_key` text NOT NULL,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`whale_address` text,
	`symbol` text,
	`latency_ms` integer,
	`detail_json` text,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_engine_logs_user_event_key` ON `engine_logs` (`user_id`,`event_key`);--> statement-breakpoint
CREATE INDEX `idx_engine_logs_user_occurred` ON `engine_logs` (`user_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_engine_logs_user_run_occurred` ON `engine_logs` (`user_id`,`run_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `engine_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`mode` text NOT NULL,
	`state` text NOT NULL,
	`execution_enabled` integer DEFAULT false NOT NULL,
	`testnet` integer DEFAULT true NOT NULL,
	`started_at` integer NOT NULL,
	`stopped_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_engine_runs_user_started` ON `engine_runs` (`user_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `watched_wallets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`address` text NOT NULL,
	`label` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`sort_order` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_watched_wallets_user_address` ON `watched_wallets` (`user_id`,`address`);--> statement-breakpoint
CREATE INDEX `idx_watched_wallets_user_sort` ON `watched_wallets` (`user_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `whale_performance` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`run_id` text NOT NULL,
	`whale_address` text NOT NULL,
	`roi_30d` real,
	`realized_pnl` real DEFAULT 0 NOT NULL,
	`fees` real DEFAULT 0 NOT NULL,
	`executed_notional_usd` real DEFAULT 0 NOT NULL,
	`executions` integer DEFAULT 0 NOT NULL,
	`blocked_executions` integer DEFAULT 0 NOT NULL,
	`errors` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_whale_performance_user_run_wallet` ON `whale_performance` (`user_id`,`run_id`,`whale_address`);--> statement-breakpoint
CREATE INDEX `idx_whale_performance_user_run_updated` ON `whale_performance` (`user_id`,`run_id`,`updated_at`);