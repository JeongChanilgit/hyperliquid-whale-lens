import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTradeQualifiedTop10 } from "../services/copy-runner/trade-qualified-whales";
import { SEED_WALLETS } from "../app/seed-wallets";

type Row = Record<string, unknown>;
const dashboardRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(dashboardRoot, "..");
const statePath = resolve(projectRoot, "state/perp-twr-trade-qualified/latest_active_top10.json");
const reportPath = resolve(projectRoot, "reports/perp-twr-trade-qualified/latest.json");
const rescueSummaryPath = resolve(projectRoot, "reports/perp-twr-rescue/latest-summary.json");
const outputPath = resolve(dashboardRoot, "app/seed-wallets.ts");
const cohort = loadTradeQualifiedTop10({
  statePath,
  reportPath,
  rescueSummaryPath,
  maxAgeMs: 7 * 86_400_000,
});
const rescue = JSON.parse(readFileSync(rescueSummaryPath, "utf8")) as Row;
if (!Array.isArray(rescue.accounts)) throw new Error("Rescue summary has no account registry");

const activeAddresses = new Set(cohort.wallets.map((row) => row.address));
const candidates = (rescue.accounts as Row[])
  .filter((row) => row.data_quality_status === "VERIFIED_EXACT" && Number(row.raw_fill_count_30d) >= 1)
  .map((row) => {
    const scores = row.latest_scores && typeof row.latest_scores === "object" ? row.latest_scores as Row : {};
    return { address: String(row.wallet).toLowerCase(), twr30d: Number(scores.exact_twr) };
  })
  .filter((row) => /^0x[a-f0-9]{40}$/.test(row.address) && Number.isFinite(row.twr30d))
  .sort((left, right) => right.twr30d - left.twr30d || left.address.localeCompare(right.address));
const standby = candidates.filter((row) => !activeAddresses.has(row.address)).slice(0, 40);
const selected = [
  ...cohort.wallets.map((row) => ({ address: row.address, twr30d: row.twr30d })),
  ...standby,
];
const selectedAddresses = new Set(selected.map((row) => row.address));
const priorStandby = SEED_WALLETS
  .filter((row) => !selectedAddresses.has(row.address.toLowerCase()))
  .map((row) => ({ address: row.address.toLowerCase(), twr30d: row.screenedReturnPct / 100 }));
const rows = [...selected, ...priorStandby].slice(0, 50);
if (rows.length !== 50 || new Set(rows.map((row) => row.address)).size !== 50) {
  throw new Error("Trade-qualified seed generation requires 10 ACTIVE plus 40 unique PASS wallets");
}

const source = `export type SeedWallet = {
  address: string;
  label: string;
  screenedReturnPct: number;
  status: "ACTIVE" | "PASS";
};

// ACTIVE: hash-linked simulation-only exact-TWR cohort with at least one raw 30D fill.
// PASS: exact-TWR evidence/watchlist rows retained for trading analysis only.
// Run \`npm run data:sync-trade-qualified\` after regenerating account-preservation rescue evidence.
export const SEED_WALLETS: SeedWallet[] = [
${rows.map((row, index) => {
  const rank = index + 1;
  return `  { address: "${row.address}", label: "${rank <= 10 ? "Trade-qualified TWR" : "Verified TWR Watch"} ${String(rank).padStart(2, "0")}", screenedReturnPct: ${(row.twr30d * 100).toFixed(8)}, status: "${rank <= 10 ? "ACTIVE" : "PASS"}" },`;
}).join("\n")}
];
`;
writeFileSync(outputPath, source, "utf8");
console.log(`Wrote ${rows.length} exact-TWR trade-qualified seeds to ${outputPath}`);
