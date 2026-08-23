import { renameSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { buildSimpleTwrRunnerState } from "../services/copy-runner/simple-twr-whales";

const projectRoot = resolve(import.meta.dirname, "../..");
const reportPath = resolve(projectRoot, "reports/perp-month-simple-twr/latest.json");
const statePath = resolve(projectRoot, "state/perp-month-simple-twr/latest_active_top10.json");
const raw = readFileSync(reportPath);
const report = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
const state = buildSimpleTwrRunnerState(report, createHash("sha256").update(raw).digest("hex"));
const temporaryPath = `${statePath}.${process.pid}.tmp`;
writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
renameSync(temporaryPath, statePath);
process.stdout.write(`${JSON.stringify({ statePath, wallets: (state.wallets as unknown[]).length, sourceRunId: state.source_run_id }, null, 2)}\n`);
