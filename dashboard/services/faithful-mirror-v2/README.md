# Five-Whale Faithful Mirror V2

This is a **faithful state mirror**, not a promise of identical exchange fills.
It follows at most five source wallets and assigns each one its own target
account.  PAPER and LIVE use the same `FiveWhaleFaithfulMirrorEngine` and
`FaithfulPairActor`; only their execution ports differ.

## What it mirrors

- At startup, current source positions are scaled from source equity/notional to
  each target's equity and reconciled at the current snapshot mark.
- Source Cross/isolated leverage is copied as a margin setting.  Leverage is
  never multiplied into copied size.  Isolated position margin is adjusted only
  when the signed side is known; otherwise LIVE fails closed.
- Every open source order is shadowed with a deterministic 16-byte target
  Cloid.  Create, modify, and cancel updates are mirrored immediately.
- Every source fill marks the latest desired state dirty without a debounce;
  the actor reconciles immediately and rechecks residuals at 250 ms and
  1,000 ms.
- Source and target runtime snapshots correct optimistic state.  Reconnects
  backfill fills from a short overlap and restore checkpoint cursors when the
  runtime exposes its recovery hook.

PAPER consumes public market data and uses synthetic, deterministic target
addresses.  It does not spawn a signing bridge and cannot send a signed
Hyperliquid action.  LIVE uses a separate private-key sidecar per pair and its
target user socket to post signed actions.

## Supported and unsupported accounts

Standard accounts are supported.  Unified account handling is disabled by
default and requires `runtime.allowApproxUnified=true`; its approximation must
be reviewed before use.  Portfolio Margin is rejected rather than estimated.

The following are explicitly not guaranteed: queue priority, exact fees,
matching fill prices, historical entry/PnL replay, ADL behavior, and identical
liquidation timing.  PAPER's liquidation/margin indications are approximate;
no actual liquidation behavior has been validated.  The testnet scenarios in
the handoff—especially isolated margin add/remove, subaccount ownership,
restart recovery, and liquidation behavior—remain operational validation work,
not a completed claim of this repository.

## Configuration and environment

`config.mjs` is the authoritative loader.  It rejects JSON keys that look like
private keys, passwords, tokens, secrets, mnemonics, or API keys.  Paths in the
JSON resolve inside this service directory.  The control token and LIVE
credentials must come from the environment.

Required for every mode:

```text
FMV2_CONFIG=config/five-whale-paper.json
FMV2_CONTROL_TOKEN=<at-least-16-random-characters>
```

LIVE additionally requires `FMV2_TESTNET`, a master account address, one
distinct agent private key per configured pair, `FMV2_PYTHON`, and optionally
`FMV2_BRIDGE_PATH`/`FMV2_ACTION_EXPIRES_AFTER_MS`.  For mainnet it also
requires the exact `FMV2_PRODUCTION_CONFIRMED=I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS`
environment value.  `.env.example` lists the complete names; do not commit an
actual `.env` file.

`config/five-whale-paper.json` is a committed, secret-free five-source PAPER
setup.  Each source has `$100` independent simulated capital and its explicit
target address equals the deterministic PAPER target derived from its `pairId`.
It reads mainnet public market data (`testnet: false`) but cannot submit a
signed action.

The five source addresses in that committed file are a frozen research/PAPER
cohort, not a permanent production allowlist.  Before starting a new operating
cohort, refresh the preserved wallet universe with the same-timestamp
`portfolio.perpMonth` account-value and cumulative-PnL samples, compute
`prod(1 + deltaPnl / previousEquity) - 1`, require latest perpetual equity of at
least `$10,000` and `perpMonth.vlm > 0`, then replace the source addresses with
the latest top one through five.  This metric must be labelled `perpMonth simple
TWR` / `PORTFOLIO_ONLY_ESTIMATE`; ledger quality, completed episodes, MDD, win
rate, and profit factor are diagnostics and must not silently reorder the
cohort.  The optional minimum prior-equity anomaly guard is a screener setting,
not a hidden Faithful Mirror risk cap.

## Local runs

For the integrated single-user PAPER service plus dashboard, run these from
`dashboard/`:

```powershell
npm run fmv2:local:start
npm run fmv2:local:status
npm run fmv2:local:stop
```

The integrated start verifies that the committed PAPER sources exactly match
saved simple-TWR ranks 1–5, moves prior V2 runtime evidence into the ignored
history directory, starts a fresh PAPER service on port 8790, and starts the
read-only dashboard on port 3001. It clears every LIVE signing environment
input and does not manage or stop the legacy copy runner on port 8788.

From this directory on PowerShell:

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
$env:FMV2_CONFIG = "config/five-whale-paper.json"
$env:FMV2_CONTROL_TOKEN = "replace-with-a-long-random-control-token"
npm test
npm run check
npm start
```

PAPER is the only mode permitted to set `autoStart: true`.  A LIVE config is
always born `STOPPED_UNARMED`, including on testnet, and never starts from
configuration alone.  Do not point a LIVE config at mainnet until the explicit
testnet validation plan has been completed.

## Localhost control plane

The HTTP service binds only to `127.0.0.1`, `::1`, or `localhost`.  `GET
/health` is intentionally public and returns only an `ok` indicator.  Every
other endpoint requires an exact, timing-safe `x-fmv2-control-token` header.

```powershell
curl http://127.0.0.1:8790/health
curl -H "x-fmv2-control-token: TOKEN" http://127.0.0.1:8790/status
curl -X POST -H "content-type: application/json" -H "x-fmv2-control-token: TOKEN" -d '{"confirmation":"I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS"}' http://127.0.0.1:8790/arm
curl -X POST -H "x-fmv2-control-token: TOKEN" http://127.0.0.1:8790/start
curl -X POST -H "x-fmv2-control-token: TOKEN" http://127.0.0.1:8790/reconcile
curl -X POST -H "x-fmv2-control-token: TOKEN" http://127.0.0.1:8790/stop
curl -X POST -H "x-fmv2-control-token: TOKEN" http://127.0.0.1:8790/kill
```

`/arm` is LIVE-only and expires after 60 seconds.  `/start` consumes the arm.
`/stop` blocks new actions, cancels known FMV2 shadow orders, and retains
positions.  `/kill` also records the persistent kill switch and does not
flatten positions.  `/reconcile` calls the runtime's explicit safe reconcile
hook; LIVE requires a fresh arm.  A process receiving `SIGINT`, `SIGTERM`, an
uncaught exception, or an unhandled rejection flushes state and stops/kill
fails safely.  Automatic flattening is intentionally absent.

## Audit and recovery

The configured `data/faithful-mirror-v2/` directory contains:

- `events.jsonl` — append-only, redacted event stream;
- `latest-state.json` — atomic latest safe status snapshot; and
- `recovery-checkpoint.json` — atomic durable pair cursors, bounded recent fill
  IDs, order-Cloid ownership mappings, account modes, snapshot times, and kill
  status.

These files never intentionally contain private keys, control tokens,
signatures, signed payloads, or a full environment dump.  On a restart the
service loads the checkpoint and feature-detects `restoreRecoveryCheckpoint`.
If a previously RUNNING LIVE checkpoint is present but that hook is absent,
the service enters `PAIR_RECOVERY_BLOCKED` and sends no action.  The runtime
must then reconcile actual source/target state before new LIVE actions are
allowed.

## Security and mainnet warning

`hyperliquid_pair_bridge.py` is a JSONL signer only: stdout contains JSON
replies, diagnostics never contain a private key, and it does not call the
exchange action endpoint.  The Node target socket submits a returned action
only after LIVE has passed configuration validation, the explicit arm/start
flow, signer preflight, target-account policy checks, and the mainnet double
confirmation.  Signer preflight queries the default perpetual DEX (`dex=""`)
and every HIP-3 DEX returned by `perpDexs`; a malformed or failed state/order
query prevents signing, and target position/order identities are deduplicated
by `dex+coin` and `dex+oid`; non-default coins are DEX-prefixed before any
cleanup signing request.  The bridge refuses all mainnet signing operations without the
same explicit confirmation.  Tests use fake bridges/transports and must never
be treated as funded-testnet or mainnet execution evidence.
