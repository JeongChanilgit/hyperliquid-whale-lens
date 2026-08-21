import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const dashboardRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(dashboardRoot, "..");
const sourcePath = path.join(projectRoot, "reports", "perp-twr-rescue", "latest-summary.json");
const censusPath = path.join(projectRoot, "reports", "perp-twr-activity-census", "latest.json");
const targetPath = path.join(dashboardRoot, "public", "preloaded", "rescue", "latest.json");

const source = JSON.parse(await readFile(sourcePath, "utf8"));
if (!Array.isArray(source.accounts) || typeof source.discovered_accounts !== "number") {
  throw new Error("rescue report has an invalid account registry payload");
}
const census = JSON.parse(await readFile(censusPath, "utf8"));
if (census.run_status !== "COMPLETE" || census.coverage_complete !== true || !Array.isArray(census.accounts)
    || census.scanned_account_count !== source.discovered_accounts) {
  throw new Error("preserved-account activity census is incomplete or does not match the rescue registry");
}
const censusByWallet = new Map(
  census.accounts.map((row: Record<string, unknown>) => [String(row.wallet).toLowerCase(), row]),
);
if (censusByWallet.size !== source.discovered_accounts) throw new Error("activity census account set is incomplete");
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
  activity_census: {
    run_status: census.run_status,
    scanned_account_count: census.scanned_account_count,
    has_fill_account_count: census.has_fill_account_count,
    zero_fill_account_count: census.zero_fill_account_count,
  },
  accounts: source.accounts.map((row: Record<string, unknown>) => {
    const activity = censusByWallet.get(String(row.wallet).toLowerCase()) as Record<string, unknown> | undefined;
    if (!activity) throw new Error(`activity census is missing ${String(row.wallet)}`);
    return ({
    wallet: row.wallet,
    data_quality_status: row.data_quality_status,
    activity_status: activity.status,
    selection_status: row.selection_status,
    source_reason_codes: row.source_reason_codes,
    reason_codes: row.reason_codes,
    latest_scores: row.latest_scores,
    account_value_usd: row.account_value_usd,
    raw_fill_count_30d: activity.observed_unique_fill_count_30d ?? activity.minimum_proven_fill_count_30d ?? 0,
    raw_fill_count_is_lower_bound: activity.observed_unique_fill_count_30d == null,
    completed_episodes_30d: row.completed_episodes_30d,
    rescue_priority_score: row.rescue_priority_score,
    next_actions: queueActions.get(String(row.wallet)) ?? [],
    });
  }),
};
await mkdir(path.dirname(targetPath), { recursive: true });
await writeFile(targetPath, `${JSON.stringify(compact)}\n`, "utf8");
console.log(JSON.stringify({ targetPath, accounts: compact.accounts.length }));
