---
name: hyperliquid-whale-lens
description: Open, inspect, run, test, and maintain the private Hyperliquid Whale Lens workspace, including the 30-day whale screener, trading-analysis dashboard, TOP 50 preloads, and simulation copy runner. Use when the user mentions Whale Lens, the whale dashboard, Hyperliquid tracking, paper copy trading, or this private repository.
---

# Hyperliquid Whale Lens

Use this skill to work on the user's private Whale Lens project.

## Project locations

- Active local runtime/source worktree: `C:\claude-develop\hyperliquid_clone_trading`
- Private GitHub mirror checkout: `C:\claude-develop\hyperliquid-whale-lens`
- Dashboard URL when running: `http://localhost:3001`

Treat the active worktree as authoritative for a currently running local simulation. Treat the private mirror as the publishable snapshot. Never assume that a change in one path is already synchronized to the other.

## Required routing

1. Read `AGENTS.md`, then `docs/file-map.md`, then only the workflow relevant to the request.
2. For live process status, inspect the active worktree and run `npm run local:status` from `dashboard/`, or use the localhost status endpoints. Do not stop or restart a healthy simulation unless the user asks.
3. For screening work, follow `docs/workflows/daily-whale-screen.md` and the repository `SKILL.md`.
4. For dashboard or copy-runner work, follow `docs/workflows/wallet-trading-dashboard.md`.
5. Verify focused tests before broad builds. Surface incomplete Hyperliquid data instead of estimating it.

## Safety boundaries

- Default to `SIMULATION`; never enable live execution merely because the live code exists.
- Never expose, print, copy, or commit private keys, real `.env` values, target-account mappings, runtime databases, WAL files, or logs.
- Keep signing and target mappings server-side.
- GitHub synchronization does not authorize deployment. Do not publish or change Sites hosting unless the user explicitly requests it.
- Preserve the user's active session and unrelated dirty changes.

## Common commands

Run from the active worktree unless the user explicitly wants the mirror:

```powershell
cd C:\claude-develop\hyperliquid_clone_trading\dashboard
npm run local:start
npm run local:status
npm run local:stop
npm test
```

For the screener:

```powershell
cd C:\claude-develop\hyperliquid_clone_trading
python -m unittest discover -s tests -v
python src\hyperliquid_whale_screener.py
```

When handing off, state which worktree changed, what was verified, whether the private mirror was synchronized, and whether the running simulation was touched.
