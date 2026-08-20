# Task unit: daily whale screening

1. Confirm rules and entrypoints.
   - Allowed reads: `AGENTS.md`, `CLAUDE.md`, `docs/file-map.md`, `docs/workflows/daily-whale-screen.md`, installed skill `C:\Users\peter\.codex\skills\hyperliquid-30d-whale-screener\SKILL.md`.
2. Validate calculation behavior.
   - Allowed reads: `src/hyperliquid_whale_screener.py`, `tests/test_screener.py`.
   - Run: `python -m unittest discover -s tests -v`.
3. Execute one rolling 30-day cycle.
   - Allowed reads: `src/hyperliquid_whale_screener.py`, `state/latest_active_top10.json` when present.
   - Run: `python src/hyperliquid_whale_screener.py`.
4. Verify and hand off results.
   - Allowed reads: `reports/latest.md`, `reports/latest.json`, `state/latest_active_top10.json`.
   - Check that all ranked rows have at least 10 completed episodes, MDD below 40% on the sampled cash-flow-neutral compounded curve, and are sorted by that compounded growth percentage.

Stop conditions:

- Retry transient HTTP failures at most three times per request.
- Mark a wallet `UNVERIFIABLE` instead of estimating missing or non-USD-denominated data.
- Abort the cycle if the public leaderboard itself cannot be retrieved or parsed.
- Never rank by completed PnL, the first non-zero balance, or leaderboard `month.roi`. Compound the sampled flow-neutral interval returns and fail closed on withdrawal-to-dust intervals whose event-boundary capital cannot be reconstructed.
