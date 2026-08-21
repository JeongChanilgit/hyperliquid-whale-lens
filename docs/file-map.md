# Project file map

- `SKILL.md`: project-local source of the registered Hyperliquid whale-screening skill.
- `hyperliquid_whale_lens_FINAL_development_agent_submission.md`: authoritative five-stage screening specification and completion checklist.
- `dashboard/`: Vinext/React dashboard for wallet management, lazy 30-day charts, trading-log analysis, and real-time paper/live copy tracking.
  - `dashboard/app/page.tsx`: dashboard composition and user interactions.
  - `dashboard/app/globals.css`: dashboard visual system and responsive layout.
  - `dashboard/app/components/`: candlestick replay, flow-neutral per-episode return analytics, and shared paper/live execution panels.
  - `dashboard/app/hooks/`: local runner status/audit UI state plus the legacy browser paper monitor.
  - `dashboard/app/lib/`: Hyperliquid API, IndexedDB cache, episode/log classification, historical carry-in entry reconstruction, real-time ledger, risk gates, and server-only Hyperliquid lifecycle execution bridge.
  - `dashboard/app/api/copy-engine/`: localhost-only bridge to the durable standalone runner; not itself a 24/7 worker.
  - `dashboard/app/api/audit/`, `dashboard/db/`, `dashboard/drizzle/`: single-user local audit, wallet, order, run, log, and performance persistence.
  - `dashboard/services/copy-runner/`: standalone long-lived Hyperliquid collector with SQLite audit, strict canonical TOP10/report/TOP2000 hash loader, and `hyperliquid_bridge.py`, a persistent official-SDK signer/executor used only by an explicitly enabled live runner.
  - `dashboard/scripts/`: preload/compaction tasks and Windows local stack start/status/stop commands; a new runner starts only from complete canonical screener output.
  - `dashboard/public/preloaded/`: generated 30-day wallet snapshots for all screened TOP 50 addresses; refresh through `npm run data:prefetch` rather than hand editing.
  - `dashboard/.openai/hosting.json`: Sites deployment configuration.
- `src/hyperliquid_whale_screener.py`: CLI and explicit legacy compatibility surface. The default route invokes verified perp TWR screening; `legacy-month-roi` is opt-in only.
- `src/whale_lens/`: modular exact-screening implementation.
  - `api.py`, `cache.py`: weighted public-API access, bounded retries/budgets, raw-response cache, atomic checkpoint/resume.
  - `discovery.py`: whole-leaderboard parsing, multi-signal RRF pool, rotating-sample backfill, and persistent 1,000-wallet outside refresh shards.
  - `portfolio.py`, `ledger.py`, `twr.py`, `models.py`: `perpMonth` normalization, explicit non-funding cash-flow classification, Decimal TWR and reconciliation diagnostics.
    - Screening clips to one fixed run window and scores only real aligned observations inside it; it does not manufacture exact start/end samples.
  - `candidate.py`, `episodes.py`, `report.py`: 2,500+500 verification state machine, TOP2000 freeze/hash, raw-fill episodes, atomic report/canonical gates.
  - `research.py`: explicit-user-authorization path that converts an insufficient-candidate PARTIAL run into hash-linked, SIMULATION-only TOP10/TOP50 research artifacts without writing canonical state.
  - `pipeline.py`: fixed-window five-stage orchestration and persisted output wiring.
- `tests/test_*.py`: unit and integration coverage for cash flows, TWR examples, discovery, resume/cache, candidate boundary probes, raw episodes, and complete canonical publication.
- `docs/workflows/daily-whale-screen.md`: bounded workflow for a daily screening cycle.
- `reports/perp-twr-discovery/`: timestamped and latest run JSON/Markdown reports.
- `reports/perp-twr-candidates/`: immutable run TOP2000 snapshots and complete `latest-top2000.json`.
- `reports/perp-twr-research/`: compact partial-research TOP50/finalist artifacts; never canonical or live-trading input.
- `state/perp-twr-top10/`: hash-linked canonical ACTIVE TOP10, replaced only by a complete run.
- `state/perp-twr-research/`: explicitly authorized SIMULATION-only TOP10 selection state.
- `state/perp-twr-runs/`, `state/perp-twr-cache/`, `state/perp-twr-discovery/`: checkpoints, recalculable raw/normalized cache, and rotating discovery-cycle state.
- `AGENTS.md`, `CLAUDE.md`: synchronized project instructions.

Build and test entrypoints:

- Test: `python -m unittest discover -s tests -v`
- Run: `python src/hyperliquid_whale_screener.py`
- Dashboard local stack: run `npm run local:start`, `npm run local:status`, or `npm run local:stop` from `dashboard/`.
- Dashboard dev: run `npm run dev` from `dashboard/`.
- Dashboard checks: run `npm run lint`, `npm run build`, and the focused Node tests from `dashboard/`.
- Dashboard canonical sync: after a complete hash-verified run, run `npm run data:sync-canonical` from `dashboard/` to regenerate the ACTIVE TOP10 plus 40 standby seeds.
- Dashboard preload: after canonical sync, run `npm run data:prefetch` from `dashboard/`.
- Copy runner: run `npm run copy-runner` from `dashboard/`; its server-only environment and persistent database are documented in `dashboard/services/copy-runner/README.md`.

Generated/do-not-touch zones:

- Treat `reports/` and `state/` as runner-owned generated data. Do not hand-edit a run result; publish only intentionally selected canonical/report snapshots, never caches or runtime DBs.
- Treat `dashboard/node_modules/`, `dashboard/.next/`, `dashboard/.vinext/`, `dashboard/.wrangler/`, `dashboard/dist/`, and `dashboard/build/` as generated.
- Treat `dashboard/public/preloaded/` as generated but versioned deployment input; never hand-edit individual wallet snapshots.
- Do not modify the installed skill under `C:\Users\peter\.codex\skills\hyperliquid-30d-whale-screener` from project code.
