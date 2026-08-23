<!-- BEGIN CODEX ECONOMIC AGENT DEFAULTS -->

## Codex Economic Agent Defaults

Apply these defaults to all non-trivial work in this project unless the user explicitly overrides them.

This managed section is the base layer for project instructions. Project-specific rules, commands, architecture notes, and constraints should be added after this section. Do not replace or delete this section when creating `AGENTS.md`, `agents.md`, `agent.md`, or `CLAUDE.md` unless the user explicitly asks.

- Optimize for outcome quality per token, wall-clock time, and cost.
- Start with cheap context inventory: file lists, `rg`, metadata, headings, source snippets, and current app state before reading whole files.
- Read deeply only where the next decision requires it.
- Keep raw context in files; bring compact facts, line references, source links, and decisions into the prompt.
- Prefer retrieval, summaries, durable notes, caches, and token ledgers over repeatedly loading large material.
- Route work before doing it: choose model/effort, context budget, tools, agents, and verification level based on task size, risk, freshness, and artifact type.
- Route all thinking-first work—ideation, brainstorming, architecture, hypothesis generation, strategy, tradeoff analysis, refutation, difficult judgment, and final synthesis—to `gpt-5.6-sol` with `max` reasoning. Cheaper models may retrieve, edit mechanically, compress, or verify, but must not own the substantive reasoning.
- Use cheaper/faster routes for routine search, edits, verification, compression, and source gathering; escalate only for architecture, hard debugging, high-risk judgment, or final synthesis.
- Retrieve before full-load and compress after retrieval. Use local search/snippets/context packing before reading entire folders, logs, or long docs.
- Reuse stable facts and recent equivalent work instead of rediscovering them. Store durable project decisions in `AGENTS.md`, project docs, skill references, or a local ledger when useful.
- At project start, ensure both `AGENTS.md` and `CLAUDE.md` exist. If either is missing, run `python C:/Users/peter/.codex/scripts/ensure_project_instructions.py .`.
- Maintain a project file map document for non-trivial repos. Consult it before broad source reads, and update it when the repo structure or important entrypoints change.
- Maintain named task-unit workflows for repeated or complex work. Each workflow should list its steps and the exact folders/files each step may read; during a step, read only those paths unless the workflow is updated first.
- Project `AGENTS.md`/`CLAUDE.md` files should point to the file map and list the active task units with their workflow locations.
- When a file map path, task unit, or workflow location changes, update both `AGENTS.md` and `CLAUDE.md` in the same turn.
- Retry flaky browser/tool setup once; then switch to static, DOM, command-line, or source-level verification instead of burning usage.
- For broad, research-heavy, or multi-file work, look for independent sidecar tasks that can run in parallel.
- Use subagents when permitted and useful for bounded research, disjoint implementation slices, verification, log compression, or risk review.
- Keep the immediate blocker and final integration local; do not delegate the next critical-path decision.
- Prefer 1-3 subagents by default, with clear role, ownership scope, output format, stop condition, and "do not revert others" warning.
- Verify with focused tests, source checks, screenshots, rendered artifacts, or line-level inspection as appropriate.
- Include material telemetry in handoffs: agents used, context loaded, tests run, cache reuse, and unresolved risk.
### Thin-Supervisor And Fixed Subagent Model

- Keep the main session as a context-preserving supervisor responsible for goals, constraints, architecture, task decomposition, critical-path decisions, conflict resolution, final integration, and user communication.
- For substantive work, delegate tool-heavy execution by default: file discovery, bounded source reading, research, implementation, tests, log inspection, visual checks, compression, and independent review.
- All spawned subagents must use `gpt-5.6-terra` with `xhigh` reasoning effort. Do not use Luna or another model for subagent work unless the user explicitly overrides this rule for the current task.
- Prefer `fork_turns: "none"` and send a minimal self-contained task packet containing allowed read paths, exact deliverable, relevant ideas and constraints, editable ownership, completion criteria, verification requirements, and stop conditions.
- Subagents return only completion status, changed files, verification result, supervisor decisions required, blockers, and residual risks. Do not return raw logs, full source files, or lengthy reasoning unless explicitly requested.
- Use at most three concurrent subagents with disjoint ownership and a prohibition on reverting or overwriting other agents' changes.
- The main session may directly handle brief conversation, immediate critical-path decisions, and genuinely tiny tasks where delegation would not preserve meaningful context.
- For substantive work, report the subagents used and their ownership. If delegation was skipped, state the reason briefly.
<!-- END CODEX ECONOMIC AGENT DEFAULTS -->

<!-- BEGIN PROJECT FILE MAP AND TASK WORKFLOWS -->

## Project File Map And Task Workflows

- File map: `docs/file-map.md`.
- Rule: consult the file map before broad source reads, and update it when structure, entrypoints, generated areas, or do-not-touch zones change.
- Task units:
  - Daily whale screening: `docs/workflows/daily-whale-screen.md`.
  - Portfolio-only perpMonth TWR research: `docs/workflows/simple-perp-month-twr.md`.
  - Account preservation and rescue: `docs/workflows/account-preservation-rescue.md`.
  - Wallet trading dashboard: `docs/workflows/wallet-trading-dashboard.md`.
- Screening rule: rank only by ledger-verified `perp_cashflow_neutral_twr_30d`, freeze VERIFIED TOP2000, then require at least 10 completed raw-fill position episodes for ACTIVE TOP10. Leaderboard ROI/PnL/turnover are discovery signals; MDD is diagnostic only.
- Portfolio-only research rule: `src/run_simple_perp_month_twr.py` is an isolated, non-canonical estimate using exact-timestamp raw `perpMonth` samples. Its outputs under `reports/perp-month-simple-twr/` and `state/perp-month-simple-twr/` must never be labeled VERIFIED, cash-flow-neutral, or used by the live/copy runner without a separate explicit promotion decision.
- Fixed-window sample rule: use only real aligned `perpMonth` observations inside the run-wide fixed 30-day window; do not interpolate or relabel a nearby out-of-window observation as an exact boundary, and exclude wallets with fewer than two in-window observations.
- Carry-in rule: paper/backtest startup positions use the source average entry price; never substitute the current mark, and skip positions whose entry cannot be verified.
- Dashboard workflow scope: 30-day replay plus real-time paper/live copy monitoring; live signing remains server-only and risk-gated.
- Dashboard file map now includes `app/components/`, `app/hooks/`, `app/lib/realtime/`, and `app/api/copy-engine/` ownership boundaries.
- Hyperliquid live signing stays server-only in `dashboard/app/lib/realtime/hyperliquid-execution.ts` and `dashboard/services/copy-runner/hyperliquid_bridge.py`; never move target mappings or private keys into browser code.
- Durable dashboard scope includes login-free local audit, versioned preload data, hash-linked canonical TOP10/TOP2000 screening outputs, and the standalone SQLite copy runner documented in the file map/workflow.
- Canonical runner rule: a new copy-runner session must load `state/perp-twr-top10/latest_active_top10.json` and cross-check the matching discovery report and TOP2000 hashes; stale or partial output must fail closed.
- Explicit research exception: only after the user expressly authorizes the current turn, a SIMULATION-only session may use `VERIFIED_PARTIAL_RESEARCH` artifacts under `reports/perp-twr-research/` and `state/perp-twr-research/`. It must still require strict VERIFIED TWR, complete outside-shard coverage, zero outside-pool breach, at least 10 raw-fill episodes, hash-linked TOP10/TOP50 artifacts, and `COPY_RUNNER_ALLOW_PARTIAL_RESEARCH=true`; it never becomes canonical or live-capable.
- Local-first rule: run `npm run local:start` from `dashboard/`; publish, redeploy, or delete a Sites deployment only on explicit user request.
- Local paper-entry rule: `npm run local:start` must enforce `NEW_POSITIONS_ONLY`, so every follower begins with zero tracked position while post-start additions and new flat-to-open positions remain eligible for copying.
- Workflow rule: each task-unit workflow must list step-level allowed read paths. During a step, read only those folders/files unless the workflow is updated first.
- Cross-AI sync rule: when file map, task units, or workflow locations change, update both `AGENTS.md` and `CLAUDE.md` in the same turn.

<!-- END PROJECT FILE MAP AND TASK WORKFLOWS -->
