# Task unit: account preservation and rescue

1. Lock the rescue contract and preservation boundary.
   - Allowed reads: `hyperliquid_whale_lens_account_preservation_rescue_spec.md`, `AGENTS.md`, `CLAUDE.md`, `docs/file-map.md`, `docs/workflows/account-preservation-rescue.md`, `docs/workflows/daily-whale-screen.md`.
   - Preserve every discovered wallet and immutable raw-artifact reference; never promote estimated or bounded returns into the exact ranking.
2. Implement deterministic rescue primitives.
   - Allowed reads: `src/whale_lens/models.py`, `portfolio.py`, `ledger.py`, `twr.py`, `episodes.py`, `rescue.py`, `evidence_registry.py`, `interval_twr.py`, `valuation.py`, `reconciliation.py`, and matching `tests/test_*.py` files.
   - Keep data quality, activity, and selection status independent; append evaluation history; propagate uncertainty to explicit bounds.
3. Integrate preservation into screening and reporting.
   - Allowed reads: `src/whale_lens/pipeline.py`, `report.py`, `candidate.py`, `research.py`, `src/hyperliquid_whale_screener.py`, `state/perp-twr-cache/`, one selected checkpoint, and one selected run report.
   - Exact ranking remains limited to exact-quality rows. Rescue priority only controls work order. A partial rescue run cannot replace canonical state.
4. Expose rescue views in the local dashboard.
   - Allowed reads: `dashboard/app/page.tsx`, `dashboard/app/globals.css`, `dashboard/app/components/`, `dashboard/public/preloaded/`, `dashboard/scripts/`, and generated rescue reports.
   - Show exact, rescued, bounded, unresolved, and all-account views without presenting uncertainty as exact performance.
5. Validate and operate a research-only simulation cohort.
   - Allowed reads: `reports/perp-twr-rescue/`, `reports/perp-twr-trade-qualified/`, `state/account-evidence-registry/`, `state/perp-twr-trade-qualified/`, `dashboard/services/copy-runner/`, `dashboard/scripts/`, and local status endpoints.
   - A 30-day-trade-qualified TOP10 must be hash-linked, SIMULATION-only, and complete before replacing the current local session. Preserve prior runtime data in its existing database; do not enable live signing.
6. Run a complete preserved-account 30-day activity census when explicitly requested.
   - Allowed reads: `reports/perp-twr-rescue/latest-summary.json`, the matching `reports/perp-twr-discovery/run-*.json`, `src/whale_lens/api.py`, `cache.py`, `activity_census.py`, `activity_analysis.py`, `rescue.py`, `evidence_registry.py`, `src/run_account_preservation_rescue.py`, `src/scan_preserved_account_activity.py`, matching `tests/test_*.py`, the matching fixed-as-of `state/perp-twr-cache/leaderboard/` record, `state/perp-twr-activity-census/`, and `reports/perp-twr-trade-qualified/`.
   - Scan every preserved wallet with one fixed 30-day window. Positive official leaderboard month volume is sufficient proof of at least one execution across the leaderboard's perp scope, even if the default-DEX raw endpoint is empty; preserve that scope difference explicitly. Zero volume is not proof of inactivity and must be checked with a cached raw `aggregateByTime:false` response. Checkpoint every bounded shard, distinguish zero fills from not-yet-scanned and failed requests, and publish a replacement TOP10 only after all wallets have a terminal result. Rank only exact TWR rows with at least one proven fill.

Stop conditions:

- Do not overwrite immutable raw evidence or append-only evaluation history.
- Do not place `ESTIMATED_MODIFIED_DIETZ`, `BOUNDED`, `PROVISIONAL`, `RESCUE_PENDING`, or `UNRESOLVED` rows in the exact ranking.
- Do not infer missing prices, fills, or account-class effects without provenance and explicit bounds.
- Do not restart the healthy local runner until the replacement cohort and its hashes validate completely.
- Do not deploy the dashboard without an explicit user request.
