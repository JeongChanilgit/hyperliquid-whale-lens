# Portfolio-only TOP10 dossier

1. Freeze the subject list and source metric.
   - Allowed reads: `AGENTS.md`, `CLAUDE.md`, `docs/file-map.md`, `docs/workflows/top10-dossier.md`, `reports/perp-month-simple-twr/latest.json`.
   - Keep the exact ranked ten and source report hash. Never substitute the current canonical or simulation cohort.
2. Collect bounded public evidence.
   - Allowed reads: `src/whale_lens/api.py`, `src/whale_lens/cache.py`, `src/whale_lens/episodes.py`, `src/whale_lens/simple_perp_month.py`, `state/perp-twr-cache/`, `reports/perp-month-simple-twr/`.
   - Use the shared rate limiter and bounded retries. Collect current portfolio/account state, all-DEX positions and frontend orders, 30-day unaggregated fills, and non-funding ledger where complete. Preserve coverage and truncation status; never infer missing pages.
3. Analyze and render.
   - Allowed reads: `src/whale_lens/dossier_analysis.py`, `src/render_simple_twr_top10_dossier.py`, `reports/perp-month-simple-twr/top10-dossier-data.json`, `reports/perp-month-simple-twr/latest.json`.
   - Summarize episode outcomes, coin/side concentration, turnover, fees, leverage, current exposure, order mix, drawdown, implied-flow risk, and copyability. Distinguish observed facts from inference and show data timestamps.
4. Verify and publish locally.
   - Allowed reads: `tests/test_top10_dossier.py`, `reports/perp-month-simple-twr/top10-dossier.html`, `reports/perp-month-simple-twr/top10-dossier-data.json`, `dashboard/.openai/hosting.json`.
   - Run focused/full tests and static HTML checks. Keep the report local unless the user explicitly requests deployment; GitHub synchronization may include the public-data report but never secrets or runtime databases.
