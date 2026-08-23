# Portfolio-only perpMonth TWR research

1. Confirm the saved universe and fixed cache identity.
   - Allowed reads: `AGENTS.md`, `CLAUDE.md`, `docs/file-map.md`, `docs/workflows/simple-perp-month-twr.md`, `reports/perp-twr-rescue/*-summary.json`, `state/perp-twr-cache/portfolio/`.
   - Require one fixed `window_start_ms`, `window_end_ms`/`as_of_ms`, metric version, schema version, and coverage mode across the whole universe. Missing cache records make the run PARTIAL; do not mix a current API response into an old snapshot.
2. Calculate the isolated estimate.
   - Allowed reads: `src/run_simple_perp_month_twr.py`, `src/whale_lens/simple_perp_month.py`, `src/whale_lens/cache.py`, `src/whale_lens/models.py`, `src/whale_lens/portfolio.py`.
   - Use only raw `perpMonth`, exact timestamp intersections, positive `vlm`, latest equity at least $10,000, and at least $10,000 previous equity on every PnL-changing interval. Compound `delta PnL / previous equity`; do not read ledger or fills for ranking.
3. Verify and publish research artifacts.
   - Allowed reads: `tests/test_simple_perp_month.py`, `reports/perp-month-simple-twr/`, `state/perp-month-simple-twr/`.
   - Run the focused test and full Python suite. Record coverage, exclusion reasons, flow diagnostics, deterministic hashes, and TOP10. Label outputs `PORTFOLIO_ONLY_ESTIMATE`; never promote them to canonical or a copy-runner cohort implicitly.
