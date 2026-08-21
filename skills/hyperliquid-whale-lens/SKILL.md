---
name: hyperliquid-whale-lens
description: Open, inspect, run, test, and maintain the private Hyperliquid Whale Lens workspace, including the verified 30-day perp TWR screener, trading-analysis dashboard, saved TOP2000/TOP10 lists, and simulation copy runner. Use when the user mentions Whale Lens, whale ranking, Hyperliquid tracking, paper copy trading, or this private repository.
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

## Screening contract

- Rank only by verified `perp_cashflow_neutral_twr_30d`; leaderboard ROI/PnL/turnover are discovery signals.
- Build a deterministic 5,000~7,000 wallet pool, score all provisionally, and fully score a persistent 1,000-wallet outside shard while backfilling the rotating 500 quota. Ledger-verify from the top 2,500 with 500-wallet expansion and 100-wallet boundary probes, freeze verified TOP2000, then scan raw fills until 10 wallets have at least 10 completed episodes.
- Use only `portfolio.perpMonth`, explicit non-funding-ledger cash-flow mappings, and `aggregateByTime:false` fills. MDD is diagnostic, not a selection filter.
- Clip to one run-wide fixed window and score only real aligned samples inside it; never interpolate or relabel an out-of-window observation as an exact boundary.
- Preserve the previous canonical TOP10 on pool or outside-shard coverage gaps, fewer than 2,000 verified candidates, boundary instability, fewer than 10 finalists, or report/candidate/config hash mismatch.
- Warm-start a new API limiter from zero tokens and retry failed checkpoint rows on resume so an initial 429 burst cannot silently create a canonical coverage hole.
- Keep timestamped lists and `latest` files under `reports/perp-twr-*` and `state/perp-twr-*`. The copy runner must load and cross-check canonical state instead of trusting hardcoded seeds.

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
python src\hyperliquid_whale_screener.py --resume
```

When handing off, state which worktree changed, what was verified, whether the private mirror was synchronized, and whether the running simulation was touched.
