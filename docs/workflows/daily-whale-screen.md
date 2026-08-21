# Task unit: verified 30-day perp TWR screening

1. Confirm the fixed contract and current saved state.
   - Allowed reads: `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, `docs/file-map.md`, `docs/workflows/daily-whale-screen.md`, `state/perp-twr-top10/latest_active_top10.json`, `state/perp-twr-discovery/*.json`.
   - Fix one `as_of_ms` and one 30-day window for the run. Default to `FAST_INCREMENTAL / DISCOVERY_POOL_EXACT`.
2. Validate deterministic calculation primitives.
   - Allowed reads: `src/whale_lens/models.py`, `portfolio.py`, `ledger.py`, `twr.py`, `episodes.py`, and `tests/test_cashflows.py`, `test_perp_twr.py`, `test_episodes.py`.
   - Run: `python -m unittest discover -s tests -v`.
   - Clip every wallet to the fixed run window and use only real aligned samples inside it; never interpolate or relabel a nearby out-of-window observation as an exact boundary. A wallet with fewer than two in-window samples is excluded.
3. Build and score the discovery pool.
   - Allowed reads: `src/whale_lens/api.py`, `cache.py`, `discovery.py`, `pipeline.py`, `src/hyperliquid_whale_screener.py`, `state/perp-twr-cache/`, `state/perp-twr-runs/`.
   - Use ROI/PnL/turnover/prior/new/rotating signals to build 5,000~7,000 unique wallets (target 6,000). Calculate provisional `perpMonth` TWR for the entire pool, plus every wallet in the persistent 1,000-wallet outside shard; backfill the rotating 500 quota after A~E overlap removal.
4. Verify, freeze, and validate activity.
   - Allowed reads: `src/whale_lens/candidate.py`, `episodes.py`, `report.py`, `pipeline.py`, current-run cache/checkpoint files.
   - Ledger-verify provisional top 2,500, expand by 500 when needed, run deterministic 100-wallet boundary probes, freeze VERIFIED TOP2000, then validate `aggregateByTime:false` fills in candidate order until 10 wallets have at least 10 completed episodes.
5. Publish only complete local state.
   - Allowed reads: `reports/perp-twr-discovery/`, `reports/perp-twr-candidates/`, `state/perp-twr-top10/`, `dashboard/scripts/sync-canonical-seeds.ts`, `dashboard/services/copy-runner/canonical-whales.ts`, `dashboard/services/copy-runner/config.ts`.
   - Verify config/candidate/report hashes and exact runner wallet order. On success, run `npm run data:sync-canonical` before `npm run data:prefetch`; then start the bounded SIMULATION session. A partial run may write timestamped diagnostics/checkpoints but must not replace canonical TOP10 or restart the runner.
6. Handle an explicitly authorized partial-research exception.
   - Allowed reads: `src/whale_lens/research.py`, one PARTIAL discovery report, its matching candidate run file, `reports/perp-twr-research/`, `state/perp-twr-research/`, `dashboard/scripts/sync-canonical-seeds.ts`, `dashboard/services/copy-runner/canonical-whales.ts`, `dashboard/services/copy-runner/config.ts`.
   - Require `INSUFFICIENT_VERIFIED_CANDIDATES` as the sole source-run blocker, complete outside-shard coverage, zero outside-pool breach, strict VERIFIED candidates, and at least 10 completed raw-fill episodes. Write only research paths, run `npm run data:sync-research` and `npm run data:prefetch`, and start only with `COPY_RUNNER_ALLOW_PARTIAL_RESEARCH=true` in `SIMULATION`; never alter canonical state.

Stop conditions:

- Abort canonical publication if the leaderboard/discovery pool or outside shard is incompletely evaluated, fewer than 2,000 VERIFIED candidates exist, the boundary is unstable, fewer than 10 finalists qualify, or any critical hash/report write fails.
- Treat unknown or unpriced ledger types, missing cash-flow boundaries, material reconciliation residuals, incomplete fills/ledger pagination, and 10,000-fill truncation as `UNVERIFIABLE`.
- Share one 1,200-weight/min limiter across stages; respect stage budgets and bounded retries.
- Never rank by leaderboard `month.roi`, absolute PnL, MDD, or completed-episode PnL. MDD is diagnostic only.
