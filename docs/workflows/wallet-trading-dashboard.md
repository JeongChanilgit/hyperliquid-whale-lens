# Task unit: wallet trading dashboard

1. Confirm product rules and project surface.
   - Allowed reads: `AGENTS.md`, `CLAUDE.md`, `docs/file-map.md`, `docs/workflows/wallet-trading-dashboard.md`, `SKILL.md`.
2. Work on dashboard data behavior.
   - Allowed reads: `dashboard/app/lib/`, `dashboard/app/api/copy-engine/`, `dashboard/app/api/faithful-mirror-v2/`, `dashboard/app/api/audit/`, `dashboard/db/`, `dashboard/drizzle/`, `dashboard/scripts/`, `dashboard/services/copy-runner/`, `dashboard/services/faithful-mirror-v2/`, `dashboard/app/page.tsx`, `dashboard/package.json`.
   - Preserve lazy candle loading, IndexedDB reuse, explicit refresh, 30-day fill pagination, idempotent real-time fill handling, localhost-only runner control, and all three explicit paper entry policies. `REPLAY_OPEN_EPISODES` must remain simulation-only, reconstruct only verified flat/reversal-to-current fill chains, and fail closed instead of adopting an unverifiable residual position.
   - The login-free local lifecycle must default to and enforce `NEW_POSITIONS_ONLY`: every follower starts with zero tracked position, while post-start additions and new flat-to-open positions remain copyable.
   - A partial-research selection is permitted only with an explicit user authorization, hash-linked research artifacts, matching ACTIVE seeds, and `COPY_RUNNER_ALLOW_PARTIAL_RESEARCH=true`; the config must reject it outside `SIMULATION`.
   - A portfolio-only simple-TWR TOP10 is permitted only after explicit user authorization for that session. Require a complete fixed-window report, independently reproduced TOP10, a matching compact state/report-file hash, `COPY_RUNNER_ALLOW_SIMPLE_TWR_RESEARCH=true`, `NEW_POSITIONS_ONLY`, ignored startup fills/positions, and simulation mode. Mirror only current entry-capable resting orders; excluded-position reduce-only/TP/SL orders remain excluded.
   - Faithful Mirror V2 is a separate service and persistence domain. It accepts 1–5 unique source/target pairs, starts PAPER positions at current L2 prices, shadows current open orders, and must not read, migrate, stop, or replace the legacy runner or its session database. LIVE never auto-starts and requires explicit arming; mainnet execution remains prohibited unless separately authorized after testnet validation.
   - Faithful Mirror V2 browser observability is GET-only. Keep the control token in the server route, redact LIVE target mappings, bound audit tails, and expose missing/stale data instead of inventing PnL, margin, latency, or replication values.
3. Work on dashboard presentation.
   - Allowed reads: `dashboard/app/page.tsx`, `dashboard/app/layout.tsx`, `dashboard/app/globals.css`, `dashboard/app/components/`, `dashboard/public/`.
   - Keep analysis, paper trading, and live trading in one consistent interface; show connection, risk-gate, order, latency, and per-whale performance state.
   - For Faithful Mirror V2, show source/follower equity and exposure, effective leverage, margin health, open-order coverage, tracking debt, event/reconciliation counters, terminal reasons, and session-local equity history. Keep LIVE visibly locked and omit every browser arm/start/order control.
4. Verify locally; publish only on explicit request.
   - Allowed reads: `dashboard/package.json`, `dashboard/tests/`, `dashboard/app/lib/*.test.ts`, `dashboard/services/copy-runner/*.test.ts`, `dashboard/services/faithful-mirror-v2/`, `dashboard/scripts/`, `dashboard/public/preloaded/manifest.json`, `dashboard/.openai/hosting.json`, generated build output only when a failure requires it.
   - Verify all 30 preloads, local audit, runner persistence/reconciliation tests, production build, PowerShell commands, and the real chart in a local browser.
   - For the isolated V2 stack, use `npm run fmv2:local:start|status|stop`; do not stop, adopt, or rewrite the legacy runner/session. Preserve prior V2 audit evidence by moving it to the ignored history directory before a deliberately fresh PAPER start.

Stop conditions:

- Never collect or persist Binance secrets in browser code.
- Keep real trading disabled until server-side signing, runtime secret validation, explicit arming, risk gates, and a kill switch all pass.
- Never imply 24/7 monitoring when the chosen runtime requires an open browser session; surface runtime limits in the UI.
- Default to the login-free localhost UI and standalone SQLite runner. Do not publish, redeploy, or delete a Sites deployment without an explicit user request.
- Do not estimate missing Hyperliquid fills; surface incomplete data clearly.
