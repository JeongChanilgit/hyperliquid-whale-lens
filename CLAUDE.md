# hyperliquid_clone_trading - Project Instructions

This project inherits the global Claude workflow from `C:/Users/peter/.claude/CLAUDE.md`.

<!-- BEGIN PROJECT FILE MAP AND TASK WORKFLOWS -->

## Project File Map And Task Workflows

- File map: `docs/file-map.md`.
- Rule: consult the file map before broad source reads, and update it when structure, entrypoints, generated areas, or do-not-touch zones change.
- Task units:
  - Daily whale screening: `docs/workflows/daily-whale-screen.md`.
  - Wallet trading dashboard: `docs/workflows/wallet-trading-dashboard.md`.
- Screening rule: rank only by ledger-verified `perp_cashflow_neutral_twr_30d`, freeze VERIFIED TOP2000, then require at least 10 completed raw-fill position episodes for ACTIVE TOP10. Leaderboard ROI/PnL/turnover are discovery signals; MDD is diagnostic only.
- Fixed-window sample rule: use only real aligned `perpMonth` observations inside the run-wide fixed 30-day window; do not interpolate or relabel a nearby out-of-window observation as an exact boundary, and exclude wallets with fewer than two in-window observations.
- Carry-in rule: paper/backtest startup positions use the source average entry price; never substitute the current mark, and skip positions whose entry cannot be verified.
- Dashboard workflow scope: 30-day replay plus real-time paper/live copy monitoring; live signing remains server-only and risk-gated.
- Dashboard file map now includes `app/components/`, `app/hooks/`, `app/lib/realtime/`, and `app/api/copy-engine/` ownership boundaries.
- Hyperliquid live signing stays server-only in `dashboard/app/lib/realtime/hyperliquid-execution.ts` and `dashboard/services/copy-runner/hyperliquid_bridge.py`; never move target mappings or private keys into browser code.
- Durable dashboard scope includes login-free local audit, versioned preload data, hash-linked canonical TOP10/TOP2000 screening outputs, and the standalone SQLite copy runner documented in the file map/workflow.
- Canonical runner rule: a new copy-runner session must load `state/perp-twr-top10/latest_active_top10.json` and cross-check the matching discovery report and TOP2000 hashes; stale or partial output must fail closed.
- Explicit research exception: only after the user expressly authorizes the current turn, a SIMULATION-only session may use `VERIFIED_PARTIAL_RESEARCH` artifacts under `reports/perp-twr-research/` and `state/perp-twr-research/`. It must still require strict VERIFIED TWR, complete outside-shard coverage, zero outside-pool breach, at least 10 raw-fill episodes, hash-linked TOP10/TOP50 artifacts, and `COPY_RUNNER_ALLOW_PARTIAL_RESEARCH=true`; it never becomes canonical or live-capable.
- Local-first rule: run `npm run local:start` from `dashboard/`; publish, redeploy, or delete a Sites deployment only on explicit user request.
- Workflow rule: each task-unit workflow must list step-level allowed read paths. During a step, read only those folders/files unless the workflow is updated first.
- Cross-AI sync rule: when file map, task units, or workflow locations change, update both `AGENTS.md` and `CLAUDE.md` in the same turn.

<!-- END PROJECT FILE MAP AND TASK WORKFLOWS -->

## Project Notes

- Test with `python -m unittest discover -s tests -v`.
- Run one screening cycle with `python src/hyperliquid_whale_screener.py`.
- Treat `reports/` and `state/` as generated runner-owned data.
- Build the Vinext dashboard from `dashboard/`; host it only on explicit request, and never store exchange secrets in client-side code.
