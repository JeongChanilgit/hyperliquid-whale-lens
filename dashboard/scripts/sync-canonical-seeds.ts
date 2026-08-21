import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Row = Record<string, unknown>;

const dashboardRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(dashboardRoot, "..");
const canonicalPath = resolve(projectRoot, "state/perp-twr-top10/latest_active_top10.json");
const candidatesPath = resolve(projectRoot, "reports/perp-twr-candidates/latest-top2000.json");
const outputPath = resolve(dashboardRoot, "app/seed-wallets.ts");
const addressPattern = /^0x[a-f0-9]{40}$/;

const json = (path: string): Row => JSON.parse(readFileSync(path, "utf8")) as Row;
const address = (row: unknown): string => {
  const record = row && typeof row === "object" ? row as Row : {};
  const value = String(record.wallet ?? record.address ?? "").toLowerCase();
  if (!addressPattern.test(value)) throw new Error(`Invalid candidate wallet: ${value}`);
  return value;
};
const twrPercent = (row: unknown): number => {
  const record = row && typeof row === "object" ? row as Row : {};
  const value = Number(record.perp_cashflow_neutral_twr_30d) * 100;
  if (!Number.isFinite(value)) throw new Error(`Invalid verified TWR for ${address(row)}`);
  return value;
};

const canonical = json(canonicalPath);
const candidates = json(candidatesPath);
if (canonical.run_id !== candidates.run_id || canonical.candidate_pool_hash !== candidates.candidate_pool_hash) {
  throw new Error("Canonical TOP10 and candidate TOP2000 do not share the same run/hash");
}
if (!Array.isArray(canonical.finalists) || canonical.finalists.length !== 10) {
  throw new Error("Canonical state must contain exactly ten finalists");
}
if (!Array.isArray(canonical.wallets) || canonical.wallets.length !== 10) {
  throw new Error("Canonical state must contain exactly ten ordered wallets");
}
if (!Array.isArray(candidates.candidates) || candidates.candidates.length < 50) {
  throw new Error("Candidate snapshot must contain at least fifty verified wallets");
}

const active = canonical.finalists as Row[];
const orderedCanonicalAddresses = (canonical.wallets as unknown[]).map((wallet) =>
  typeof wallet === "string" ? wallet.toLowerCase() : address(wallet),
);
const finalistAddresses = active.map(address);
if (orderedCanonicalAddresses.some((wallet, index) => wallet !== finalistAddresses[index])) {
  throw new Error("Canonical ordered wallets and finalists differ");
}
const activeAddresses = new Set(active.map(address));
const standby = (candidates.candidates as Row[]).filter((row) => !activeAddresses.has(address(row))).slice(0, 40);
const rows = [...active, ...standby];
if (rows.length !== 50 || new Set(rows.map(address)).size !== 50) {
  throw new Error("Canonical/standby seed generation did not produce fifty unique wallets");
}

const source = `export type SeedWallet = {
  address: string;
  label: string;
  screenedReturnPct: number;
  status: "ACTIVE" | "PASS";
};

// Generated from the hash-linked canonical TOP10 and VERIFIED TOP2000.
// Run \`npm run data:sync-canonical\` after a complete screener cycle.
export const SEED_WALLETS: SeedWallet[] = [
${rows.map((row, index) => {
  const rank = index + 1;
  const label = `Perp TWR ${String(rank).padStart(2, "0")}`;
  const status = rank <= 10 ? "ACTIVE" : "PASS";
  return `  { address: "${address(row)}", label: "${label}", screenedReturnPct: ${twrPercent(row).toFixed(8)}, status: "${status}" },`;
}).join("\n")}
];
`;

writeFileSync(outputPath, source, "utf8");
console.log(`Wrote ${rows.length} verified seeds to ${outputPath}`);
