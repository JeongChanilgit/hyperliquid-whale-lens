#!/usr/bin/env python3
"""Run the Hyperliquid rolling 30-day whale screening workflow."""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, getcontext
from pathlib import Path
from typing import Any, Iterable

import requests


getcontext().prec = 40

LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"
INFO_URL = "https://api.hyperliquid.xyz/info"
THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
MIN_ACCOUNT_VALUE = Decimal("10000")
MIN_COMPLETED_EPISODES = 10
TARGET_WHALE_COUNT = 10
MDD_CUTOFF = Decimal("0.40")
RANKING_OFFICIAL_ROI = "official-roi"
RANKING_PORTFOLIO_GROWTH = "portfolio-growth"
RANKING_COMPOUNDED_GROWTH = "compounded-growth"
RANKING_PERP_TWR = "perp-cashflow-neutral-twr"
RANKING_LEGACY_MONTH_ROI = "legacy-month-roi"
TIME_PAGE_FLOOR = 500
FILL_AVAILABILITY_LIMIT = 10_000
# Hyperliquid position sizes use no more than 8 decimal places. Residuals below
# one tenth of the smallest tradable unit are arithmetic dust, not open risk.
ZERO_EPSILON = Decimal("1e-9")


def dec(value: Any) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"invalid decimal value: {value!r}") from exc


def is_zero(value: Decimal) -> bool:
    return abs(value) <= ZERO_EPSILON


def positions_match(left: Decimal, right: Decimal) -> bool:
    tolerance = max(ZERO_EPSILON, abs(left) * Decimal("1e-10"), abs(right) * Decimal("1e-10"))
    return abs(left - right) <= tolerance


def sign(value: Decimal) -> int:
    return 1 if value > 0 else -1 if value < 0 else 0


def is_spot_coin(coin: str) -> bool:
    return coin.startswith("@") or "/" in coin


@dataclass
class Episode:
    coin: str
    direction: str
    entry_time: int
    exit_time: int
    gross_closed_pnl: Decimal
    fees_usdc: Decimal
    net_pnl: Decimal
    duration_ms: int


class InfoClient:
    def __init__(self, min_interval: float = 1.05, timeout: float = 45.0, retries: int = 3) -> None:
        self.min_interval = min_interval
        self.timeout = timeout
        self.retries = retries
        self.last_call_started = 0.0
        self.info_calls = 0
        self.retry_count = 0
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "codex-hyperliquid-whale-screener/1.0"})

    def _pace(self) -> None:
        remaining = self.min_interval - (time.monotonic() - self.last_call_started)
        if remaining > 0:
            time.sleep(remaining)

    def post_info(self, payload: dict[str, Any]) -> Any:
        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            self._pace()
            self.last_call_started = time.monotonic()
            self.info_calls += 1
            try:
                response = self.session.post(INFO_URL, json=payload, timeout=self.timeout)
                if response.status_code == 429 or response.status_code >= 500:
                    raise requests.HTTPError(
                        f"HTTP {response.status_code}: {response.text[:200]}", response=response
                    )
                response.raise_for_status()
                return response.json()
            except (requests.RequestException, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt >= self.retries:
                    break
                self.retry_count += 1
                time.sleep(min(20.0, 2.0 ** (attempt + 1)))
        raise RuntimeError(f"Hyperliquid info request failed after retries: {last_error}")


def fill_key(fill: dict[str, Any]) -> tuple[Any, ...]:
    return (
        fill.get("time"),
        fill.get("tid"),
        fill.get("oid"),
        fill.get("coin"),
        fill.get("side"),
        fill.get("sz"),
        fill.get("px"),
        fill.get("startPosition"),
        fill.get("hash"),
    )


def fetch_fills_by_time(
    client: InfoClient,
    user: str,
    start_time: int,
    end_time: int,
    *,
    aggregate_by_time: bool,
) -> tuple[list[dict[str, Any]], str | None]:
    cursor = start_time
    seen: set[tuple[Any, ...]] = set()
    fills: list[dict[str, Any]] = []

    for _page_number in range(30):
        payload = {
            "type": "userFillsByTime",
            "user": user,
            "startTime": cursor,
            "endTime": end_time,
            "aggregateByTime": aggregate_by_time,
        }
        page = client.post_info(payload)
        if not isinstance(page, list):
            return fills, "fills response was not a list"
        if not page:
            break

        try:
            # The API's order within one millisecond carries the position chain.
            # A trade id is not a chronological key, so preserve response order
            # for equal timestamps with Python's stable sort.
            page.sort(key=lambda item: int(item["time"]))
        except (KeyError, TypeError, ValueError):
            return fills, "fills response contained an invalid timestamp"

        added = 0
        for fill in page:
            key = fill_key(fill)
            if key not in seen:
                seen.add(key)
                fills.append(fill)
                added += 1

        if len(fills) >= FILL_AVAILABILITY_LIMIT:
            return fills, "10,000-fill availability limit reached"

        if len(page) < TIME_PAGE_FLOOR:
            break

        last_time = max(int(fill["time"]) for fill in page)
        if last_time < cursor:
            return fills, "fill pagination moved backwards"
        if last_time == cursor:
            if added == 0 or len(page) >= TIME_PAGE_FLOOR:
                return fills, "fill pagination stalled at a capped timestamp"
            cursor += 1
        else:
            cursor = last_time
    else:
        return fills, "fill pagination exceeded 30 pages"

    fills.sort(key=lambda item: int(item["time"]))
    return fills, None


def _new_active(coin: str, position: Decimal, entry_time: int | None, qualified: bool) -> dict[str, Any]:
    return {
        "coin": coin,
        "direction": "LONG" if position > 0 else "SHORT",
        "entry_time": entry_time,
        "qualified": qualified,
        "gross_closed_pnl": Decimal("0"),
        "fees_usdc": Decimal("0"),
        "unpriced_fee_tokens": set(),
    }


def _add_fee(active: dict[str, Any], fill: dict[str, Any], fraction: Decimal = Decimal("1")) -> None:
    fee = dec(fill.get("fee", "0")) * fraction
    if is_zero(fee):
        return
    token = str(fill.get("feeToken") or "USDC")
    if token == "USDC":
        active["fees_usdc"] += fee
    else:
        active["unpriced_fee_tokens"].add(token)


def _finish_episode(active: dict[str, Any], exit_time: int) -> tuple[Episode | None, str | None]:
    if not active["qualified"]:
        return None, None
    coin = active["coin"]
    if is_spot_coin(coin):
        return None, f"completed spot episode for {coin} has no comparable closedPnl basis"
    if active["unpriced_fee_tokens"]:
        tokens = ",".join(sorted(active["unpriced_fee_tokens"]))
        return None, f"completed episode has non-USDC fees ({tokens})"
    entry_time = active["entry_time"]
    if entry_time is None:
        return None, "qualified episode was missing an entry time"
    gross = active["gross_closed_pnl"]
    fees = active["fees_usdc"]
    return (
        Episode(
            coin=coin,
            direction=active["direction"],
            entry_time=int(entry_time),
            exit_time=exit_time,
            gross_closed_pnl=gross,
            fees_usdc=fees,
            net_pnl=gross - fees,
            duration_ms=exit_time - int(entry_time),
        ),
        None,
    )


def reconstruct_completed_episodes(
    fills: Iterable[dict[str, Any]], window_start: int, window_end: int
) -> tuple[list[Episode], str | None]:
    by_coin: dict[str, list[dict[str, Any]]] = {}
    for fill in fills:
        timestamp = int(fill.get("time", -1))
        if window_start <= timestamp <= window_end:
            by_coin.setdefault(str(fill.get("coin", "")), []).append(fill)

    completed: list[Episode] = []
    for coin, coin_fills in by_coin.items():
        coin_fills.sort(key=lambda item: int(item["time"]))
        active: dict[str, Any] | None = None
        expected_position: Decimal | None = None

        for fill in coin_fills:
            timestamp = int(fill["time"])
            try:
                start_position = dec(fill["startPosition"])
                size = dec(fill["sz"])
                closed_pnl = dec(fill.get("closedPnl", "0"))
            except (KeyError, ValueError) as exc:
                return completed, f"invalid fill for {coin}: {exc}"

            if size < 0:
                return completed, f"negative fill size for {coin}"
            delta = size if fill.get("side") == "B" else -size if fill.get("side") == "A" else None
            if delta is None:
                return completed, f"invalid fill side for {coin}"
            end_position = start_position + delta
            if is_zero(end_position):
                end_position = Decimal("0")
            if is_zero(start_position):
                start_position = Decimal("0")

            if expected_position is not None and not positions_match(expected_position, start_position):
                return completed, (
                    f"position discontinuity for {coin}: expected {expected_position}, got {start_position}"
                )

            if start_position == 0:
                if active is not None:
                    return completed, f"episode state mismatch at flat position for {coin}"
                if end_position != 0:
                    active = _new_active(coin, end_position, timestamp, True)
                    active["gross_closed_pnl"] += closed_pnl
                    _add_fee(active, fill)
            else:
                if active is None:
                    active = _new_active(coin, start_position, None, False)

                if end_position == 0 or sign(start_position) == sign(end_position):
                    active["gross_closed_pnl"] += closed_pnl
                    _add_fee(active, fill)
                    if end_position == 0:
                        episode, error = _finish_episode(active, timestamp)
                        if error:
                            return completed, error
                        if episode:
                            completed.append(episode)
                        active = None
                else:
                    if is_zero(size):
                        return completed, f"zero-size reversal for {coin}"
                    old_fraction = abs(start_position) / size
                    new_fraction = abs(end_position) / size
                    if not positions_match(old_fraction + new_fraction, Decimal("1")):
                        return completed, f"reversal size mismatch for {coin}"

                    active["gross_closed_pnl"] += closed_pnl
                    _add_fee(active, fill, old_fraction)
                    episode, error = _finish_episode(active, timestamp)
                    if error:
                        return completed, error
                    if episode:
                        completed.append(episode)

                    active = _new_active(coin, end_position, timestamp, True)
                    _add_fee(active, fill, new_fraction)

            expected_position = end_position

    completed.sort(key=lambda episode: (episode.exit_time, episode.coin))
    return completed, None


def calculate_episode_metrics(episodes: list[Episode], starting_equity: Decimal) -> dict[str, Any]:
    if starting_equity <= 0:
        raise ValueError("starting equity must be positive")

    equity = starting_equity
    peak = starting_equity
    mdd = Decimal("0")
    for episode in sorted(episodes, key=lambda item: (item.exit_time, item.coin)):
        equity += episode.net_pnl
        peak = max(peak, equity)
        drawdown = (peak - equity) / peak if peak > 0 else Decimal("Infinity")
        mdd = max(mdd, drawdown)

    net_pnl = sum((episode.net_pnl for episode in episodes), Decimal("0"))
    coin_counts = Counter(episode.coin for episode in episodes)
    wins = sum(1 for episode in episodes if episode.net_pnl > 0)
    losses = sum(1 for episode in episodes if episode.net_pnl < 0)
    durations = [episode.duration_ms for episode in episodes]
    return {
        "net_pnl": net_pnl,
        "roi": net_pnl / starting_equity,
        "mdd": mdd,
        "ending_equity": equity,
        "long_episodes": sum(1 for episode in episodes if episode.direction == "LONG"),
        "short_episodes": sum(1 for episode in episodes if episode.direction == "SHORT"),
        "wins": wins,
        "losses": losses,
        "win_rate": Decimal(wins) / Decimal(len(episodes)) if episodes else Decimal("0"),
        "average_holding_ms": sum(durations) // len(durations) if durations else 0,
        "max_single_episode_loss": min((episode.net_pnl for episode in episodes), default=Decimal("0")),
        "coin_counts": dict(coin_counts.most_common()),
    }


def summarize_episodes(episodes: list[Episode]) -> dict[str, Any]:
    net_pnl = sum((episode.net_pnl for episode in episodes), Decimal("0"))
    coin_counts = Counter(episode.coin for episode in episodes)
    wins = sum(1 for episode in episodes if episode.net_pnl > 0)
    losses = sum(1 for episode in episodes if episode.net_pnl < 0)
    durations = [episode.duration_ms for episode in episodes]
    return {
        "net_pnl": net_pnl,
        "long_episodes": sum(1 for episode in episodes if episode.direction == "LONG"),
        "short_episodes": sum(1 for episode in episodes if episode.direction == "SHORT"),
        "wins": wins,
        "losses": losses,
        "win_rate": Decimal(wins) / Decimal(len(episodes)) if episodes else Decimal("0"),
        "average_holding_ms": sum(durations) // len(durations) if durations else 0,
        "max_single_episode_loss": min((episode.net_pnl for episode in episodes), default=Decimal("0")),
        "coin_counts": dict(coin_counts.most_common()),
    }


def month_performance(row: dict[str, Any]) -> dict[str, Any]:
    performances = row.get("windowPerformances") or []
    try:
        return dict(performances).get("month", {})
    except (TypeError, ValueError):
        return {}


def calculate_portfolio_metrics(portfolio: Any, window_start: int, window_end: int) -> dict[str, Any] | None:
    if not isinstance(portfolio, list):
        return None
    try:
        month = dict(portfolio).get("month", {})
    except (TypeError, ValueError):
        return None
    account_history = month.get("accountValueHistory") or []
    pnl_history = month.get("pnlHistory") or []

    def parse_history(history: Any) -> dict[int, Decimal]:
        parsed: dict[int, Decimal] = {}
        if not isinstance(history, list):
            return parsed
        for item in history:
            try:
                timestamp = int(item[0])
                value = dec(item[1])
            except (IndexError, TypeError, ValueError):
                continue
            if window_start <= timestamp <= window_end and value.is_finite():
                parsed[timestamp] = value
        return parsed

    accounts = parse_history(account_history)
    pnls = parse_history(pnl_history)
    samples: list[tuple[int, Decimal, Decimal]] = []
    for timestamp in sorted(accounts.keys() & pnls.keys()):
        try:
            account_value = accounts[timestamp]
            pnl = pnls[timestamp]
        except KeyError:
            continue
        if account_value >= 0:
            samples.append((timestamp, account_value, pnl))
    if len(samples) < 2:
        return None

    first_positive_index = next(
        (index for index, (_timestamp, account_value, _pnl) in enumerate(samples) if account_value > 0),
        None,
    )
    if first_positive_index is None:
        return None
    samples = samples[first_positive_index:]
    if len(samples) < 2:
        return None

    first_time, first_account_value, first_pnl = samples[0]
    last_time, last_account_value, last_pnl = samples[-1]
    pnl_change_total = last_pnl - first_pnl

    # Net outside capital at each sample is account value less cumulative PnL.
    # Normalize the whole month to the maximum net outside capital committed.
    # This removes deposits/withdrawals without allowing a post-withdrawal dust
    # balance to become a microscopic denominator, and it does not count the
    # same capital repeatedly when it is withdrawn and later redeposited.
    outside_capital = [account_value - (pnl - first_pnl) for _, account_value, pnl in samples]
    capital_base = max([first_account_value, Decimal("0"), *outside_capital])
    if capital_base <= 0:
        return None

    # Hyperliquid's PnL series already removes deposits and withdrawals. Link
    # the sampled interval returns into a compounded curve. When a deposit and
    # PnL coexist in one coarse interval, treat the deposit as available at the
    # interval start. This conservative convention prevents a pre-deposit dust
    # balance from creating an astronomical return. Withdrawals remain at the
    # interval end. The result is an estimate, not exact event-boundary TWR.
    compounded_curve = Decimal("1")
    peak_curve = Decimal("1")
    mdd = Decimal("0")
    inferred_net_flow = Decimal("0")
    inferred_gross_deposits = Decimal("0")
    inferred_gross_withdrawals = Decimal("0")
    measured_intervals = 0
    for previous, current in zip(samples, samples[1:]):
        _previous_time, previous_account, previous_pnl = previous
        _current_time, current_account, current_pnl = current
        pnl_change = current_pnl - previous_pnl
        inferred_flow = current_account - previous_account - pnl_change
        inferred_net_flow += inferred_flow
        if inferred_flow > 0:
            inferred_gross_deposits += inferred_flow
        elif inferred_flow < 0:
            inferred_gross_withdrawals -= inferred_flow
        # A sampled withdrawal larger than the entire starting account must
        # have been funded by intra-interval PnL and/or additional transfers.
        # The public month series has no valuation at those internal event
        # boundaries, so compounding this interval would turn a dust balance
        # into a fictitious astronomical return. Fail closed instead.
        if inferred_flow < 0 and -inferred_flow > previous_account and pnl_change > 0:
            return None
        interval_capital_base = previous_account + inferred_flow if inferred_flow > 0 else previous_account
        if interval_capital_base <= 0:
            if not is_zero(pnl_change):
                return None
            continue
        interval_return = pnl_change / interval_capital_base
        measured_intervals += 1
        if interval_return <= Decimal("-1"):
            compounded_curve = Decimal("0")
            mdd = Decimal("1")
            break
        compounded_curve *= Decimal("1") + interval_return
        peak_curve = max(peak_curve, compounded_curve)
        if peak_curve > 0:
            mdd = max(mdd, (peak_curve - compounded_curve) / peak_curve)
    if measured_intervals == 0:
        return None

    return {
        "portfolio_mdd": mdd,
        "portfolio_start_time": first_time,
        "portfolio_end_time": last_time,
        "portfolio_start_account_value": first_account_value,
        "portfolio_end_account_value": last_account_value,
        "portfolio_pnl_change": pnl_change_total,
        "portfolio_inferred_net_flow": inferred_net_flow,
        "portfolio_inferred_gross_deposits": inferred_gross_deposits,
        "portfolio_inferred_gross_withdrawals": inferred_gross_withdrawals,
        "portfolio_capital_base": max([first_account_value, Decimal("0"), *outside_capital]),
        "portfolio_flow_adjusted_curve_roi": pnl_change_total / max(
            [first_account_value, Decimal("0"), *outside_capital]
        ),
        "portfolio_time_weighted_curve_roi": compounded_curve - Decimal("1"),
        "portfolio_compounded_return": compounded_curve - Decimal("1"),
        "portfolio_return_method": "sampled-cashflow-neutral-compounded-deposit-first",
        "portfolio_observations": len(samples),
    }


def serializable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Episode):
        return {key: serializable(item) for key, item in asdict(value).items()}
    if isinstance(value, dict):
        return {str(key): serializable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [serializable(item) for item in value]
    return value


def pct(value: str | Decimal | None) -> str:
    if value is None:
        return "—"
    number = dec(value) * Decimal("100")
    if not number.is_finite():
        return "—"
    return f"{number:,.2f}%"


def money(value: str | Decimal | None) -> str:
    if value is None:
        return "—"
    number = dec(value)
    return f"${number:,.2f}"


def short_wallet(wallet: str) -> str:
    return f"{wallet[:8]}…{wallet[-6:]}"


def ranking_value(row: dict[str, Any], metric: str) -> Decimal:
    if metric in {RANKING_PORTFOLIO_GROWTH, RANKING_COMPOUNDED_GROWTH}:
        return dec(row["portfolio_compounded_return"])
    return dec(row["official_30d_roi"])


def build_markdown(report: dict[str, Any]) -> str:
    params = report["parameters"]
    counts = report["counts"]
    ranking_metric = params.get("ranking_metric", RANKING_OFFICIAL_ROI)
    return_label = (
        "Estimated cash-flow-neutral compounded growth"
        if ranking_metric in {RANKING_PORTFOLIO_GROWTH, RANKING_COMPOUNDED_GROWTH}
        else "Hyperliquid official 30D ROI"
    )
    lines = [
        "# Hyperliquid 30D Whale Screener",
        "",
        f"- Run (UTC): `{report['run_at_utc']}`",
        f"- Window: `{params['window_start_utc']}` to `{params['window_end_utc']}`",
        f"- Leaderboard rows: {counts['leaderboard_rows']:,}",
        f"- Accounts with current value ≥ $10k: {counts['eligible_accounts']:,}",
        f"- Deep-screened candidates: {counts['analyzed_candidates']:,}",
        f"- Final pass count: {counts['pass']:,} (ACTIVE {counts['active']:,})",
        f"- DROP / UNVERIFIABLE: {counts['drop']:,} / {counts['unverifiable']:,}",
        "",
        f"## TOP {params.get('target_count', TARGET_WHALE_COUNT)}",
        "",
    ]
    ranked = report.get("ranked", report["top30"])
    if ranked:
        lines.extend(
            [
                f"| Rank | Wallet | Account Value | {return_label} | Episodes | Portfolio MDD | Completed Net PnL | Main Coins | Status | Change |",
                "|---:|---|---:|---:|---:|---:|---:|---|---|---|",
            ]
        )
        for row in ranked:
            coins = ", ".join(f"{coin}:{count}" for coin, count in list(row["coin_counts"].items())[:4])
            lines.append(
                "| {rank} | `{wallet}` | {account} | {roi} | {episodes} | {mdd} | {pnl} | {coins} | {status} | {change} |".format(
                    rank=row["rank"],
                    wallet=short_wallet(row["wallet"]),
                    account=money(row["account_value"]),
                    roi=pct(row["ranking_30d_return"]),
                    episodes=row["completed_episodes"],
                    mdd=pct(row["portfolio_mdd"]),
                    pnl=money(row["net_pnl"]),
                    coins=coins or "—",
                    status=row["status"],
                    change=row.get("change") or "—",
                )
            )
    else:
        lines.append("No wallet passed all checks in this cycle.")

    reason_counts = report.get("reason_counts", {})
    lines.extend(["", "## Exclusion summary", ""])
    if reason_counts:
        lines.extend([f"- {reason}: {count}" for reason, count in reason_counts.items()])
    else:
        lines.append("- None")

    if report.get("out_from_previous_active"):
        lines.extend(["", "## OUT from previous ACTIVE TOP 10", ""])
        lines.extend(f"- `{wallet}`" for wallet in report["out_from_previous_active"])

    lines.extend(
        [
            "",
            "## Data-quality policy applied",
            "",
            "- Calculations use `userFillsByTime` with `aggregateByTime: true`; a non-aggregated pass checks the 10,000-fill availability ceiling for wallets that otherwise meet the episode count.",
            (
                "- Final ranking compounds sampled interval returns. If a deposit and PnL share a coarse interval, the deposit is included in that interval's capital base; withdrawals are applied after the interval. This prevents dust-balance inflation. Because public portfolio points are sampled, this is an estimate rather than exact event-boundary TWR."
                if ranking_metric in {RANKING_PORTFOLIO_GROWTH, RANKING_COMPOUNDED_GROWTH}
                else "- Final ranking uses Hyperliquid's official 30D ROI, whose portfolio PnL is adjusted for deposits and withdrawals."
            ),
            f"- Deep-screen coverage is the first {params['candidate_limit']:,} eligible leaderboard wallets ordered by official 30D ROI; the report does not claim coverage outside that declared candidate pool.",
            f"- Wallets with fewer than {params['minimum_completed_episodes']} completed position episodes are excluded; partial fills never count as separate investments.",
            "- Portfolio MDD is measured on the same compounded cash-flow-neutral index and therefore includes open-position equity changes.",
            "- Carry-in and still-open positions are excluded only from the completed-episode count and completed net PnL diagnostic.",
            "- Completed spot episodes or completed episodes with non-USDC fees are marked UNVERIFIABLE because their net PnL cannot be compared exactly from the required fields.",
            "- Funding and unrealized PnL remain excluded from completed net PnL, but are represented in official portfolio ROI/MDD.",
            "",
        ]
    )
    return "\n".join(lines)


def write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def rerank_existing_report(args: argparse.Namespace) -> dict[str, Any]:
    source_path = Path(args.rerank_report)
    report = json.loads(source_path.read_text(encoding="utf-8"))
    params = report["parameters"]
    if args.refresh_window:
        window_end = int(datetime.now(timezone.utc).timestamp() * 1000)
        window_start = window_end - args.days * 24 * 60 * 60 * 1000
        params.update(
            days=args.days,
            window_start_ms=window_start,
            window_end_ms=window_end,
            window_start_utc=datetime.fromtimestamp(window_start / 1000, timezone.utc).isoformat(),
            window_end_utc=datetime.fromtimestamp(window_end / 1000, timezone.utc).isoformat(),
        )
    else:
        window_start = int(params["window_start_ms"])
        window_end = int(params["window_end_ms"])
    analyzed = report["analyzed"]
    candidates = [
        row
        for row in analyzed
        if int(row.get("completed_episodes", 0)) >= MIN_COMPLETED_EPISODES
        and row.get("portfolio_observations") is not None
        and row.get("status") != "UNVERIFIABLE"
    ]
    client = InfoClient(min_interval=args.request_delay, timeout=args.timeout, retries=args.retries)
    print(f"reranking {len(candidates)} previously fill-verified candidates", flush=True)
    for index, row in enumerate(candidates, 1):
        wallet = str(row["wallet"])
        try:
            portfolio = client.post_info({"type": "portfolio", "user": wallet})
            metrics = calculate_portfolio_metrics(portfolio, window_start, window_end)
            if metrics is None:
                row.update(status="UNVERIFIABLE", reason="missing aligned non-negative 30D portfolio history")
            else:
                row.update(**serializable(metrics))
                if dec(metrics["portfolio_mdd"]) >= MDD_CUTOFF:
                    row.update(status="DROP", reason="cashflow-adjusted portfolio MDD is at least 40%")
                else:
                    row.update(status="PASS", reason=None)
        except Exception as exc:
            row.update(status="UNVERIFIABLE", reason=f"portfolio rerank error: {exc}")
        print(
            f"[{index:03d}/{len(candidates):03d}] {short_wallet(wallet)} status={row['status']}",
            flush=True,
        )

    for row in analyzed:
        row.pop("rank", None)
        row.pop("change", None)
        row.pop("ranking_30d_return", None)
    passing = [row for row in analyzed if row.get("status") == "PASS"]
    passing.sort(key=lambda row: ranking_value(row, RANKING_COMPOUNDED_GROWTH), reverse=True)
    ranked = passing[: args.target_count]
    for rank, row in enumerate(ranked, 1):
        row["rank"] = rank
        row["ranking_30d_return"] = ranking_value(row, RANKING_COMPOUNDED_GROWTH)
        row["status"] = "ACTIVE" if rank <= 10 else "PASS"
        row["change"] = None

    status_counts = Counter(row.get("status") for row in analyzed)
    reason_counts = Counter(
        str(row.get("reason") or "unspecified")
        for row in analyzed
        if row.get("status") in {"DROP", "UNVERIFIABLE"}
    )
    report["reranked_at_utc"] = datetime.now(timezone.utc).isoformat()
    params.update(target_count=args.target_count, ranking_metric=RANKING_COMPOUNDED_GROWTH)
    report["counts"].update(
        {
            "pass": len(passing),
            "selected": len(ranked),
            "active": min(10, len(ranked)),
            "drop": status_counts["DROP"],
            "unverifiable": status_counts["UNVERIFIABLE"],
            "rerank_info_api_calls": client.info_calls,
            "rerank_api_retries": client.retry_count,
        }
    )
    report["ranked"] = ranked
    report["top30"] = ranked[:30]
    report["out_from_previous_active"] = []
    report["reason_counts"] = dict(reason_counts.most_common())

    reranked_at = datetime.fromisoformat(report["reranked_at_utc"])
    run_id = reranked_at.strftime("%Y%m%dT%H%M%SZ")
    reports_dir = Path(args.reports_dir)
    json_text = json.dumps(serializable(report), ensure_ascii=False, indent=2)
    markdown_text = build_markdown(serializable(report))
    write_text_atomic(reports_dir / f"run-{run_id}.json", json_text + "\n")
    write_text_atomic(reports_dir / f"run-{run_id}.md", markdown_text)
    write_text_atomic(reports_dir / "latest.json", json_text + "\n")
    write_text_atomic(reports_dir / "latest.md", markdown_text)
    print(
        f"rerank complete pass={len(passing)} selected={len(ranked)} "
        f"drop={status_counts['DROP']} unverifiable={status_counts['UNVERIFIABLE']} "
        f"info_calls={client.info_calls}",
        flush=True,
    )
    return report


def run(args: argparse.Namespace) -> dict[str, Any]:
    run_at = datetime.now(timezone.utc)
    window_end = int(run_at.timestamp() * 1000)
    window_start = window_end - args.days * 24 * 60 * 60 * 1000
    print(f"[{run_at.isoformat()}] downloading public leaderboard", flush=True)

    response = requests.get(LEADERBOARD_URL, timeout=args.timeout)
    response.raise_for_status()
    payload = response.json()
    rows = payload.get("leaderboardRows") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise RuntimeError("leaderboard response did not contain leaderboardRows")

    eligible: list[dict[str, Any]] = []
    for row in rows:
        try:
            account_value = dec(row.get("accountValue", "0"))
            official_roi = dec(month_performance(row).get("roi"))
        except ValueError:
            continue
        if account_value >= MIN_ACCOUNT_VALUE and official_roi.is_finite():
            eligible.append(row)
    eligible.sort(key=lambda row: dec(month_performance(row)["roi"]), reverse=True)
    candidates = eligible[: args.candidate_limit]
    print(
        f"leaderboard={len(rows):,} eligible={len(eligible):,} deep_screen={len(candidates):,}",
        flush=True,
    )

    client = InfoClient(min_interval=args.request_delay, timeout=args.timeout, retries=args.retries)
    analyzed: list[dict[str, Any]] = []
    started = time.monotonic()

    for index, row in enumerate(candidates, 1):
        wallet = str(row["ethAddress"])
        base = {
            "candidate_rank": index,
            "wallet": wallet,
            "account_value": dec(row["accountValue"]),
            "official_30d_roi": dec(month_performance(row)["roi"]),
            "completed_episodes": 0,
            "status": "DROP",
            "reason": None,
        }
        try:
            fills, fills_error = fetch_fills_by_time(
                client, wallet, window_start, window_end, aggregate_by_time=True
            )
            if fills_error:
                base.update(status="UNVERIFIABLE", reason=fills_error, aggregate_fill_count=len(fills))
                analyzed.append(base)
                continue

            episodes, episode_error = reconstruct_completed_episodes(fills, window_start, window_end)
            base["aggregate_fill_count"] = len(fills)
            base["completed_episodes"] = len(episodes)
            if episode_error:
                base.update(status="UNVERIFIABLE", reason=episode_error)
                analyzed.append(base)
                continue
            if len(episodes) < MIN_COMPLETED_EPISODES:
                base.update(reason=f"fewer than {MIN_COMPLETED_EPISODES} completed episodes")
                analyzed.append(base)
                continue

            raw_fills, raw_error = fetch_fills_by_time(
                client, wallet, window_start, window_end, aggregate_by_time=False
            )
            base["raw_fill_count"] = len(raw_fills)
            if raw_error:
                base.update(status="UNVERIFIABLE", reason=f"raw completeness check: {raw_error}")
                analyzed.append(base)
                continue

            portfolio = client.post_info({"type": "portfolio", "user": wallet})
            portfolio_metrics = calculate_portfolio_metrics(portfolio, window_start, window_end)
            if portfolio_metrics is None:
                base.update(status="UNVERIFIABLE", reason="missing aligned positive 30D portfolio history")
                analyzed.append(base)
                continue

            metrics = summarize_episodes(episodes)
            base.update(
                **portfolio_metrics,
                cashflow_adjusted_30d_roi=portfolio_metrics["portfolio_compounded_return"],
                net_pnl=metrics["net_pnl"],
                coin_counts=metrics["coin_counts"],
                long_episodes=metrics["long_episodes"],
                short_episodes=metrics["short_episodes"],
                wins=metrics["wins"],
                losses=metrics["losses"],
                win_rate=metrics["win_rate"],
                average_holding_ms=metrics["average_holding_ms"],
                max_single_episode_loss=metrics["max_single_episode_loss"],
                episodes=episodes,
            )
            if portfolio_metrics["portfolio_mdd"] >= MDD_CUTOFF:
                base.update(reason="cashflow-adjusted portfolio MDD is at least 40%")
            else:
                base.update(status="PASS", reason=None)
            analyzed.append(base)
        except Exception as exc:  # keep one bad wallet from invalidating the cycle
            base.update(status="UNVERIFIABLE", reason=f"request or calculation error: {exc}")
            analyzed.append(base)
        finally:
            current = analyzed[-1] if analyzed else base
            elapsed = time.monotonic() - started
            print(
                f"[{index:03d}/{len(candidates):03d}] {short_wallet(wallet)} "
                f"episodes={current.get('completed_episodes', 0)} status={current.get('status')} "
                f"elapsed={elapsed:.0f}s",
                flush=True,
            )
        if (
            args.ranking_metric == RANKING_OFFICIAL_ROI
            and sum(1 for candidate in analyzed if candidate["status"] == "PASS") >= args.target_count
        ):
            print(f"target pass count reached ({args.target_count}); stopping deep screen", flush=True)
            break

    passing = [row for row in analyzed if row["status"] == "PASS"]
    passing.sort(key=lambda row: ranking_value(row, args.ranking_metric), reverse=True)
    ranked = passing[: args.target_count]

    state_dir = Path(args.state_dir)
    prior_state_path = state_dir / "latest_active_top10.json"
    prior_wallets: list[str] | None = None
    if prior_state_path.exists() and not args.ignore_prior_state:
        try:
            prior = json.loads(prior_state_path.read_text(encoding="utf-8"))
            prior_wallets = [str(wallet) for wallet in prior.get("wallets", [])]
        except (OSError, json.JSONDecodeError, TypeError):
            prior_wallets = None

    for rank, row in enumerate(ranked, 1):
        row["rank"] = rank
        row["ranking_30d_return"] = ranking_value(row, args.ranking_metric)
        row["status"] = "ACTIVE" if rank <= 10 else "PASS"
        row["change"] = None
        if rank <= 10 and prior_wallets is not None:
            if row["wallet"] not in prior_wallets:
                row["change"] = "NEW"
            else:
                prior_rank = prior_wallets.index(row["wallet"]) + 1
                row["change"] = "UP" if rank < prior_rank else "DOWN" if rank > prior_rank else "SAME"

    active_wallets = [row["wallet"] for row in ranked[:10]]
    out_wallets = [] if prior_wallets is None else [wallet for wallet in prior_wallets if wallet not in active_wallets]
    reason_counts = Counter(
        str(row["reason"] or "unspecified") for row in analyzed if row["status"] in {"DROP", "UNVERIFIABLE"}
    )
    status_counts = Counter(row["status"] for row in analyzed)
    report = {
        "run_at_utc": run_at.isoformat(),
        "sources": {"leaderboard": LEADERBOARD_URL, "info": INFO_URL},
        "parameters": {
            "days": args.days,
            "window_start_ms": window_start,
            "window_end_ms": window_end,
            "window_start_utc": datetime.fromtimestamp(window_start / 1000, timezone.utc).isoformat(),
            "window_end_utc": datetime.fromtimestamp(window_end / 1000, timezone.utc).isoformat(),
            "minimum_account_value": MIN_ACCOUNT_VALUE,
            "candidate_limit": args.candidate_limit,
            "target_count": args.target_count,
            "ranking_metric": args.ranking_metric,
            "minimum_completed_episodes": MIN_COMPLETED_EPISODES,
            "mdd_cutoff": MDD_CUTOFF,
            "prior_state_ignored": args.ignore_prior_state,
        },
        "counts": {
            "leaderboard_rows": len(rows),
            "eligible_accounts": len(eligible),
            "analyzed_candidates": len(analyzed),
            "pass": len(passing),
            "selected": len(ranked),
            "active": min(10, len(ranked)),
            "drop": status_counts["DROP"],
            "unverifiable": status_counts["UNVERIFIABLE"],
            "info_api_calls": client.info_calls,
            "api_retries": client.retry_count,
        },
        "ranked": ranked,
        "top30": ranked[:30],
        "out_from_previous_active": out_wallets,
        "reason_counts": dict(reason_counts.most_common()),
        "analyzed": analyzed,
    }

    run_id = run_at.strftime("%Y%m%dT%H%M%SZ")
    reports_dir = Path(args.reports_dir)
    json_text = json.dumps(serializable(report), ensure_ascii=False, indent=2)
    markdown_text = build_markdown(serializable(report))
    write_text_atomic(reports_dir / f"run-{run_id}.json", json_text + "\n")
    write_text_atomic(reports_dir / f"run-{run_id}.md", markdown_text)
    write_text_atomic(reports_dir / "latest.json", json_text + "\n")
    write_text_atomic(reports_dir / "latest.md", markdown_text)
    write_text_atomic(
        prior_state_path,
        json.dumps({"run_at_utc": run_at.isoformat(), "wallets": active_wallets}, indent=2) + "\n",
    )
    print(
        f"complete pass={len(passing)} selected={len(ranked)} active={min(10, len(ranked))} "
        f"drop={status_counts['DROP']} unverifiable={status_counts['UNVERIFIABLE']} "
        f"info_calls={client.info_calls}",
        flush=True,
    )
    return report


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--candidate-limit", type=int, default=500, help=argparse.SUPPRESS)
    parser.add_argument("--target-count", type=int, default=TARGET_WHALE_COUNT)
    parser.add_argument(
        "--ranking-metric",
        choices=(RANKING_PERP_TWR, RANKING_LEGACY_MONTH_ROI),
        default=RANKING_PERP_TWR,
        help="rank by verified perp cash-flow-neutral TWR (default); legacy leaderboard ROI is opt-in only",
    )
    parser.add_argument("--coverage-mode", choices=("fast-incremental", "full-discovery-refresh"), default="fast-incremental")
    parser.add_argument("--minimum-account-value", type=Decimal, default=Decimal("10000"))
    parser.add_argument("--leaderboard-roi-top", type=int, default=3000)
    parser.add_argument("--leaderboard-pnl-top", type=int, default=2000)
    parser.add_argument("--leaderboard-turnover-top", type=int, default=2000)
    parser.add_argument("--prior-verified-top", type=int, default=2000)
    parser.add_argument("--new-wallet-top", type=int, default=500)
    parser.add_argument("--rotating-sample-count", type=int, default=500)
    parser.add_argument("--discovery-pool-target", type=int, default=6000)
    parser.add_argument("--discovery-pool-min", type=int, default=5000)
    parser.add_argument("--discovery-pool-max", type=int, default=7000)
    parser.add_argument("--ledger-verification-count", type=int, default=2500)
    parser.add_argument("--ledger-expand-step", type=int, default=500)
    parser.add_argument("--boundary-probe-count", type=int, default=100)
    parser.add_argument("--candidate-count", type=int, default=2000)
    parser.add_argument("--minimum-completed-episodes", type=int, default=10)
    parser.add_argument("--fill-validation-mode", choices=("until-10", "full-2000"), default="until-10")
    parser.add_argument("--strict-cashflow-boundaries", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--portfolio-request-budget", type=int, default=8000)
    parser.add_argument("--ledger-request-budget", type=int, default=7000)
    parser.add_argument("--fill-request-budget", type=int, default=4000)
    parser.add_argument("--cache-dir", default="state/perp-twr-cache")
    parser.add_argument("--run-id")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--request-delay", type=float, default=1.05)
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--reports-dir", default="reports")
    parser.add_argument("--state-dir", default="state")
    parser.add_argument(
        "--rerank-report",
        help="reuse a completed report's fill verification and refresh only portfolio growth/MDD",
    )
    parser.add_argument(
        "--refresh-window",
        action="store_true",
        help="with --rerank-report, score the current rolling window instead of the source report window",
    )
    parser.add_argument(
        "--ignore-prior-state",
        action="store_true",
        help="do not compare this run with the saved ACTIVE TOP 10; replace it after success",
    )
    args = parser.parse_args(argv)
    positive = (
        args.days, args.candidate_limit, args.target_count, args.leaderboard_roi_top,
        args.leaderboard_pnl_top, args.leaderboard_turnover_top, args.prior_verified_top,
        args.new_wallet_top, args.rotating_sample_count, args.discovery_pool_target,
        args.discovery_pool_min, args.discovery_pool_max, args.ledger_verification_count,
        args.ledger_expand_step, args.boundary_probe_count, args.candidate_count,
        args.minimum_completed_episodes, args.portfolio_request_budget,
        args.ledger_request_budget, args.fill_request_budget,
    )
    if any(value <= 0 for value in positive) or args.request_delay < 0 or args.minimum_account_value < 0:
        parser.error("screening counts and budgets must be positive; delays/account minimum cannot be negative")
    return args


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        if args.rerank_report:
            rerank_existing_report(args)
        elif args.ranking_metric == RANKING_PERP_TWR:
            from whale_lens.pipeline import ScreenConfig, ScreenPaths, WhaleScreenPipeline

            config = ScreenConfig(
                days=args.days,
                coverage_mode=args.coverage_mode.replace("-", "_").upper(),
                minimum_account_value_usd=args.minimum_account_value,
                leaderboard_roi_top_n=args.leaderboard_roi_top,
                leaderboard_pnl_top_n=args.leaderboard_pnl_top,
                leaderboard_turnover_top_n=args.leaderboard_turnover_top,
                prior_verified_top_n=args.prior_verified_top,
                new_wallet_top_n=args.new_wallet_top,
                rotating_sample_n=args.rotating_sample_count,
                discovery_pool_target=args.discovery_pool_target,
                discovery_pool_min=args.discovery_pool_min,
                discovery_pool_max=args.discovery_pool_max,
                ledger_verification_initial_n=args.ledger_verification_count,
                ledger_verification_expand_step=args.ledger_expand_step,
                boundary_probe_n=args.boundary_probe_count,
                candidate_count=args.candidate_count,
                final_active_count=args.target_count,
                minimum_completed_episodes=args.minimum_completed_episodes,
                fill_validation_mode=args.fill_validation_mode.replace("-", "_").upper(),
                strict_cashflow_boundaries=args.strict_cashflow_boundaries,
                portfolio_request_budget=args.portfolio_request_budget,
                ledger_request_budget=args.ledger_request_budget,
                fill_request_budget=args.fill_request_budget,
                timeout_seconds=args.timeout,
                retries=args.retries,
            )
            WhaleScreenPipeline(
                config,
                ScreenPaths(Path(args.reports_dir), Path(args.state_dir), Path(args.cache_dir)),
                run_id=args.run_id,
                resume=args.resume,
            ).run()
        else:
            args.ranking_metric = RANKING_OFFICIAL_ROI
            run(args)
        return 0
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"fatal: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
