# Standalone copy runner

Long-lived Node 22+ service for ten independent Hyperliquid source streams. It observes `orderUpdates`, `userFills`, `allDexsClearinghouseState`, and startup `frontendOpenOrders`; paper mode is the default.

## Paper configuration

```text
COPY_RUNNER_CONTROL_TOKEN=a-long-random-private-token
COPY_RUNNER_CANONICAL_STATE=../state/perp-twr-top10/latest_active_top10.json
COPY_RUNNER_CANONICAL_REPORT=../reports/perp-twr-discovery/latest.json
COPY_RUNNER_CANONICAL_CANDIDATES=../reports/perp-twr-candidates/latest-top2000.json
COPY_RUNNER_CANONICAL_MAX_AGE_MS=172800000
COPY_RUNNER_ALLOWED_SYMBOLS=*
COPY_RUNNER_FOLLOWER_CAPITAL_USD=1000
COPY_RUNNER_MAX_ACCOUNT_STATE_AGE_MS=60000
COPY_RUNNER_MIN_SOURCE_ACCOUNT_VALUE_USD=10000
COPY_RUNNER_MODE=SIMULATION
COPY_RUNNER_ENTRY_POLICY=NEW_POSITIONS_ONLY
COPY_RUNNER_MAX_NOTIONAL_USD=1000000000
COPY_RUNNER_MAX_DAILY_LOSS_USD=100
COPY_RUNNER_HOST=127.0.0.1
COPY_RUNNER_PORT=8788
COPY_RUNNER_DATABASE=./data/copy-runner.sqlite
COPY_RUNNER_SESSION_STARTED_AT_MS=1786752000000
COPY_RUNNER_SESSION_ENDS_AT_MS=1787011200000
```

The hash-verified canonical TOP 10 each own a separate $100 paper wallet. A new runner refuses stale/partial state or a report/config/candidate hash mismatch; an optional `COPY_RUNNER_WHALES` override is accepted only when its ordered addresses exactly match canonical. The dashboard's ten `ACTIVE` entries must also match canonical, preventing the analysis UI and paper runner from silently showing different whale sets (`COPY_RUNNER_REQUIRE_SEED_MATCH=false` is for isolated tests only). Quantity is `source order quantity * (current follower equity / current source equity)`. There is no default 20x cap: the source's public per-asset cross/isolated and leverage setting is the authority. Missing or stale source equity fails closed.

The explicitly authorized one-or-more-fill research cohort is still simulation-only. Set `COPY_RUNNER_ALLOW_TRADE_QUALIFIED_RESEARCH=true` and provide `COPY_RUNNER_RESCUE_SUMMARY` plus `COPY_RUNNER_ACTIVITY_CENSUS`. Its loader requires a terminal result for every preserved account, recomputes the global exact-TWR TOP10 among fill-positive accounts, and cross-checks the census, rescue summary, cohort, ordered-wallet, config, and discovery-pool hashes. The local lifecycle script supplies these paths automatically with `-AllowTradeQualifiedResearch`; this gate is rejected in live mode.

The login-free local lifecycle uses `COPY_RUNNER_ENTRY_POLICY=NEW_POSITIONS_ONLY` and rejects other startup policies. It leaves positions already open at session startup—and their reduce-only/TP/SL orders—out of the follower ledger, so every paper follower begins with zero tracked position. A same-direction increase after the session starts is tracked as new exposure without adopting the startup balance; later reductions can close only that tracked amount. A flat-to-open entry is copied normally, and a one-fill reversal copies only the new opposite-side remainder. `INCLUDE_EXISTING` retains the legacy source-entry carry-in behavior for explicitly configured non-local runs.

An explicitly authorized `SIMPLE_PERP_MONTH_TWR_RESEARCH` local session is simulation-only. It must load a compact state regenerated from the complete fixed-window `reports/perp-month-simple-twr/latest.json`, verify the full report file hash and independently reproduce its ordered TOP10, and use `NEW_POSITIONS_ONLY`. Startup fill snapshots and existing positions remain excluded. Current entry-capable resting orders are mirrored at startup; reduce-only/TP/SL orders whose source position was excluded are not actionable and remain excluded.

`REPLAY_OPEN_EPISODES` is simulation-only. For each position open at startup, it fetches unaggregated fills for the preceding 30 days and retries with 90 days when a current residual is not yet reconstructable. It accepts an episode only when a flat/reversal boundary, every `startPosition` transition, the final inventory, and the reported average entry price reconcile. Accepted fills are replayed from zero at one fixed bootstrap scale (`$100 / current source total equity` for the seeded setup), so prior entries, additions, and partial exits contribute to the new paper wallet instead of adopting only the residual position. Incomplete API coverage, a missing boundary, or a reconciliation mismatch blocks that current coin; it never falls back to residual adoption. The current open-order snapshot is then attached, and all subsequent fill/order changes are recorded from WebSocket events. Hyperliquid's public REST history does not expose every past order amendment/cancel event, so historical replay is fill-exact rather than a claim of full retrospective order-lifecycle recovery.

## Run and control

```bash
npm run copy-runner
curl http://127.0.0.1:8788/health
curl -H "x-copy-runner-control-token: $COPY_RUNNER_CONTROL_TOKEN" http://127.0.0.1:8788/status
```

`/start`, `/stop`, `/kill`, `/configure`, and `/status` require the token. `/health` returns only `{ "ok": true }`. One source WebSocket is used per whale because Hyperliquid order updates omit the address. When both session timestamps are set, the runner stops its WebSocket engine at the fixed end time. The same end time survives runner or Windows restarts, and an expired session cannot be restarted through the control endpoint.

## Hyperliquid live opt-in

Install the official SDK in the project virtual environment:

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r services/copy-runner/requirements.txt
```

Then start a dedicated runner process with server-only values:

```text
COPY_RUNNER_MODE=HYPERLIQUID
HYPERLIQUID_ENABLED=true
HYPERLIQUID_TESTNET=true
HYPERLIQUID_AGENT_PRIVATE_KEY=0x...
HYPERLIQUID_MASTER_ACCOUNT_ADDRESS=0x...
HYPERLIQUID_TARGETS_JSON={"0xsource":{"accountAddress":"0xtarget","vaultAddress":"0xtarget"}}
HYPERLIQUID_CATCHUP_SLIPPAGE=0.05
```

Every monitored source must map to a distinct target account/subaccount. The signer is a master-authorized API wallet; subaccounts have no private keys. Mainnet additionally requires:

```text
HYPERLIQUID_TESTNET=false
HYPERLIQUID_PRODUCTION_CONFIRMED=I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS
```

The live hot path uses a persistent official-SDK Python sidecar. Order detail and active-asset leverage are fetched in parallel, different whales use independent queues, and the same limit/trigger/TIF/reduce-only lifecycle is sent immediately with deterministic client order IDs. Absolute zero latency is not physically guaranteed; processing latency is logged with fractional milliseconds.

When the source order becomes fully filled, the runner waits one second from local receipt. If the target limit still has a deficit, it cancels the target remainder and submits only that deficit as a protected Hyperliquid market IOC. Catch-up quantity, average price, slippage, remaining quantity, and actual wait are persisted. Any unresolved remainder enables the kill switch.

## Operational limits

- Keep one runner per SQLite database.
- The private key never enters a browser, control request, log, or SQLite row.
- The target subaccounts must already be funded; the runner does not transfer funds.
- Testnet credential/funding/order validation is required before mainnet use.
- Internet, WebSocket, info-endpoint, signing, and exchange latency remain external constraints.
