# Project file map

- `.codex-plugin/plugin.json`: Codex plugin manifest for opening and operating this private workspace.
- `skills/hyperliquid-whale-lens/SKILL.md`: local-first project routing, commands, and safety boundaries exposed by the plugin.
- `README.md`, `SECURITY.md`: repository setup, verification, publication limits, and credential policy.
- `SKILL.md`: project-local source of the registered Hyperliquid whale-screening skill.
- `dashboard/`: Vinext/React dashboard for wallet management, lazy 30-day charts, trading-log analysis, and real-time paper/live copy tracking.
  - `dashboard/app/page.tsx`: dashboard composition and user interactions.
  - `dashboard/app/globals.css`: dashboard visual system and responsive layout.
  - `dashboard/app/components/`: candlestick replay, flow-neutral per-episode return analytics, and shared paper/live execution panels.
  - `dashboard/app/hooks/`: local runner status/audit UI state plus the legacy browser paper monitor.
  - `dashboard/app/lib/`: Hyperliquid API, IndexedDB cache, episode/log classification, historical carry-in entry reconstruction, real-time ledger, risk gates, and server-only Hyperliquid lifecycle execution bridge.
  - `dashboard/app/api/copy-engine/`: localhost-only bridge to the durable standalone runner; not itself a 24/7 worker.
  - `dashboard/app/api/audit/`, `dashboard/db/`, `dashboard/drizzle/`: single-user local audit, wallet, order, run, log, and performance persistence.
  - `dashboard/services/copy-runner/`: standalone long-lived Hyperliquid collector with SQLite audit plus `hyperliquid_bridge.py`, a persistent official-SDK signer/executor used only by an explicitly enabled live runner.
  - `dashboard/scripts/`: deterministic 30-wallet preload/compaction tasks and Windows local stack start/status/stop commands.
  - `dashboard/public/preloaded/`: generated 30-day wallet snapshots for all screened TOP 50 addresses; refresh through `npm run data:prefetch` rather than hand editing.
  - `dashboard/.openai/hosting.json`: Sites deployment configuration.
- `src/hyperliquid_whale_screener.py`: daily Hyperliquid leaderboard, fill pagination, 20-episode activity filter, official cashflow-adjusted ROI ranking, flow-neutral portfolio MDD, and report generation entrypoint.
- `tests/test_screener.py`: focused episode-reconstruction and MDD tests.
- `docs/workflows/daily-whale-screen.md`: bounded workflow for a daily screening cycle.
- `reports/`: generated timestamped JSON and Markdown reports; `latest.*` is overwritten by each successful run.
- `state/`: generated prior-run ACTIVE TOP 10 state used for NEW/OUT/UP/DOWN/SAME comparisons.
- `AGENTS.md`, `CLAUDE.md`: synchronized project instructions.

Build and test entrypoints:

- Test: `python -m unittest discover -s tests -v`
- Run: `python src/hyperliquid_whale_screener.py`
- Dashboard local stack: run `npm run local:start`, `npm run local:status`, or `npm run local:stop` from `dashboard/`.
- Dashboard dev: run `npm run dev` from `dashboard/`.
- Dashboard checks: run `npm run lint`, `npm run build`, and the focused Node tests from `dashboard/`.
- Dashboard preload: run `npm run data:prefetch` from `dashboard/`.
- Copy runner: run `npm run copy-runner` from `dashboard/`; its server-only environment and persistent database are documented in `dashboard/services/copy-runner/README.md`.

Generated/do-not-touch zones:

- Treat `reports/` and `state/` as runner-owned generated data. Do not hand-edit a run result.
- Treat `dashboard/node_modules/`, `dashboard/.next/`, `dashboard/.vinext/`, `dashboard/.wrangler/`, `dashboard/dist/`, and `dashboard/build/` as generated.
- Treat `dashboard/public/preloaded/` as generated but versioned deployment input; never hand-edit individual wallet snapshots.
- Do not modify the installed skill under `C:\Users\peter\.codex\skills\hyperliquid-30d-whale-screener` from project code.
