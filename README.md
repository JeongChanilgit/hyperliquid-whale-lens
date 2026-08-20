# Hyperliquid Whale Lens

Private, local-first workspace for Hyperliquid whale screening, 30-day trading analysis, chart replay, and durable paper/live-copy research.

## Included

- The Python 30-day whale screener, tests, generated reports, and ranking state.
- The complete Vinext/React dashboard, TOP 50 preloaded wallet snapshots, chart and trading-log analysis.
- The standalone WebSocket copy runner, SQLite persistence code, order mirroring, open-episode replay, and focused tests.
- Local Windows start/status/stop scripts and server-only Hyperliquid execution bridge.
- Codex plugin metadata and the `hyperliquid-whale-lens` project skill.

Runtime databases, WAL files, logs, dependency folders, build output, `.env` files, and private keys are intentionally excluded. They are machine state or credentials, not portable source. The checked-in `.env.example` contains placeholders only.

## Local use

```powershell
cd dashboard
npm install
npm run local:start
npm run local:status
```

Open `http://localhost:3001`. The default workflow is simulation-only. Live execution must remain disabled until its documented server-side signing, arming, reconciliation, and risk gates are explicitly configured and verified.

## Verification

```powershell
python -m unittest discover -s tests -v
cd dashboard
npm test
```

Pushing this repository to GitHub does not deploy the dashboard and does not create hosting charges. `dashboard/.openai/hosting.json` is retained as project metadata, but no deployment is performed by this repository or plugin.

## Codex plugin

The repository itself is plugin-compatible through `.codex-plugin/plugin.json`. On this machine the personal plugin source is registered at `C:\Users\peter\plugins\hyperliquid-whale-lens`, and it points Codex to the local project and this private mirror.

