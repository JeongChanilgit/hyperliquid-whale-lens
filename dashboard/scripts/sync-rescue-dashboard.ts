import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const dashboardRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(dashboardRoot, "..");
const sourcePath = path.join(projectRoot, "reports", "perp-twr-rescue", "latest-summary.json");
const targetPath = path.join(dashboardRoot, "public", "preloaded", "rescue", "latest.json");

const source = JSON.parse(await readFile(sourcePath, "utf8"));
if (!Array.isArray(source.accounts) || typeof source.discovered_accounts !== "number") {
  throw new Error("rescue report has an invalid account registry payload");
}
const queueActions = new Map(
  (JSON.parse(await readFile(path.join(projectRoot, "state", "account-evidence-registry", "rescue-queue.json"), "utf8")).entries ?? [])
    .map((row: { wallet: string; next_actions?: string[] }) => [row.wallet, row.next_actions ?? []]),
);
const compact = {
  schema_version: source.schema_version,
  rescue_engine_version: source.rescue_engine_version,
  source_run_id: source.source_run_id,
  discovered_accounts: source.discovered_accounts,
  quality_counts: source.quality_counts,
  rescue_queue_count: source.rescue_queue_count,
  accounts: source.accounts.map((row: Record<string, unknown>) => ({
    wallet: row.wallet,
    data_quality_status: row.data_quality_status,
    activity_status: row.activity_status,
    selection_status: row.selection_status,
    source_reason_codes: row.source_reason_codes,
    reason_codes: row.reason_codes,
    latest_scores: row.latest_scores,
    account_value_usd: row.account_value_usd,
    raw_fill_count_30d: row.raw_fill_count_30d,
    completed_episodes_30d: row.completed_episodes_30d,
    rescue_priority_score: row.rescue_priority_score,
    next_actions: queueActions.get(String(row.wallet)) ?? [],
  })),
};
await mkdir(path.dirname(targetPath), { recursive: true });
await writeFile(targetPath, `${JSON.stringify(compact)}\n`, "utf8");
console.log(JSON.stringify({ targetPath, accounts: compact.accounts.length }));
