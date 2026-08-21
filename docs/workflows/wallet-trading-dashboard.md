# Task unit: wallet trading dashboard

1. Confirm product rules and project surface.
   - Allowed reads: `AGENTS.md`, `CLAUDE.md`, `docs/file-map.md`, `docs/workflows/wallet-trading-dashboard.md`, `SKILL.md`.
2. Work on dashboard data behavior.
   - Allowed reads: `dashboard/app/lib/`, `dashboard/app/api/copy-engine/`, `dashboard/app/api/audit/`, `dashboard/db/`, `dashboard/drizzle/`, `dashboard/scripts/`, `dashboard/services/copy-runner/`, `dashboard/app/page.tsx`, `dashboard/package.json`.
   - Preserve lazy candle loading, IndexedDB reuse, explicit refresh, 30-day fill pagination, idempotent real-time fill handling, localhost-only runner control, and all three explicit paper entry policies. `REPLAY_OPEN_EPISODES` must remain simulation-only, reconstruct only verified flat/reversal-to-current fill chains, and fail closed instead of adopting an unverifiable residual position.
   - A partial-research selection is permitted only with an explicit user authorization, hash-linked research artifacts, matching ACTIVE seeds, and `COPY_RUNNER_ALLOW_PARTIAL_RESEARCH=true`; the config must reject it outside `SIMULATION`.
3. Work on dashboard presentation.
   - Allowed reads: `dashboard/app/page.tsx`, `dashboard/app/layout.tsx`, `dashboard/app/globals.css`, `dashboard/app/components/`, `dashboard/public/`.
   - Keep analysis, paper trading, and live trading in one consistent interface; show connection, risk-gate, order, latency, and per-whale performance state.
4. Verify locally; publish only on explicit request.
   - Allowed reads: `dashboard/package.json`, `dashboard/tests/`, `dashboard/app/lib/*.test.ts`, `dashboard/services/copy-runner/*.test.ts`, `dashboard/scripts/`, `dashboard/public/preloaded/manifest.json`, `dashboard/.openai/hosting.json`, generated build output only when a failure requires it.
   - Verify all 30 preloads, local audit, runner persistence/reconciliation tests, production build, PowerShell commands, and the real chart in a local browser.

Stop conditions:

- Never collect or persist Binance secrets in browser code.
- Keep real trading disabled until server-side signing, runtime secret validation, explicit arming, risk gates, and a kill switch all pass.
- Never imply 24/7 monitoring when the chosen runtime requires an open browser session; surface runtime limits in the UI.
- Default to the login-free localhost UI and standalone SQLite runner. Do not publish, redeploy, or delete a Sites deployment without an explicit user request.
- Do not estimate missing Hyperliquid fills; surface incomplete data clearly.
