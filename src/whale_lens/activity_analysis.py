"""Pure helpers for activity-qualified TWR candidate research.

This module deliberately does not change canonical or paper-runner state.  It
summarizes raw public fills and current all-DEX position snapshots for an
auditable research report.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from decimal import Decimal, InvalidOperation
from statistics import median
from typing import Any, Iterable, Mapping

from .episodes import FILL_AVAILABILITY_LIMIT, reconstruct_completed_episodes


def _decimal(value: Any, default: str = "0") -> Decimal:
    try:
        parsed = Decimal(str(default if value is None else value))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal(default)
    return parsed if parsed.is_finite() else Decimal(default)


def select_top_candidates_with_fills(
    candidates: Iterable[Mapping[str, Any]],
    cached_fill_results: Mapping[str, Mapping[str, Any]],
    *,
    target_count: int = 10,
) -> list[dict[str, Any]]:
    """Keep verified TWR order and select the first wallets with any raw fill."""

    if target_count <= 0:
        raise ValueError("target_count must be positive")
    ordered = sorted(
        (dict(row) for row in candidates),
        key=lambda row: (int(row.get("candidate_rank", 2**31 - 1)), str(row.get("wallet", ""))),
    )
    selected: list[dict[str, Any]] = []
    for row in ordered:
        if str(row.get("quality", "")) != "VERIFIED":
            continue
        wallet = str(row.get("wallet", "")).lower()
        cached = cached_fill_results.get(wallet)
        if not cached:
            continue
        raw_fill_count = int(cached.get("raw_fill_count", 0))
        if raw_fill_count <= 0:
            continue
        selected.append(
            {
                **row,
                "raw_fill_count_30d": raw_fill_count,
                "completed_episodes_30d": cached.get("completed_episodes"),
                "episode_validation_valid_30d": bool(cached.get("valid")),
                "episode_validation_reason_30d": cached.get("reason_code"),
            }
        )
        if len(selected) == target_count:
            break
    if len(selected) != target_count:
        raise ValueError(f"only {len(selected)} candidates with fills were available")
    return selected


def fill_identity(fill: Mapping[str, Any]) -> tuple[Any, ...]:
    return tuple(fill.get(field) for field in ("time", "tid", "oid", "coin", "side", "sz", "px", "startPosition", "hash"))


def summarize_fill_history(
    fills: Iterable[Mapping[str, Any]],
    *,
    window_start_ms: int,
    window_end_ms: int,
    coverage_complete: bool,
    availability_limit_reached: bool,
) -> dict[str, Any]:
    """Summarize observed activity and fail-closed completed episodes."""

    raw = [dict(fill) for fill in fills]
    raw.sort(key=lambda fill: int(fill.get("time", 0)))
    result = reconstruct_completed_episodes(
        raw,
        window_start_ms,
        window_end_ms,
        aggregate_by_time=False,
        coverage_complete=coverage_complete,
        availability_limit_reached=availability_limit_reached,
    )
    coin_fill_counts: Counter[str] = Counter()
    coin_notional: defaultdict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    direction_counts: Counter[str] = Counter()
    active_days: set[int] = set()
    taker_count = 0
    observed_notional = Decimal("0")
    timestamps: list[int] = []
    for fill in raw:
        timestamp = int(fill.get("time", 0))
        if not window_start_ms <= timestamp <= window_end_ms:
            continue
        coin = str(fill.get("coin") or "<MISSING>")
        notional = abs(_decimal(fill.get("px")) * _decimal(fill.get("sz")))
        coin_fill_counts[coin] += 1
        coin_notional[coin] += notional
        observed_notional += notional
        direction_counts[str(fill.get("dir") or fill.get("side") or "UNKNOWN")] += 1
        active_days.add(timestamp // 86_400_000)
        timestamps.append(timestamp)
        if fill.get("crossed") is True:
            taker_count += 1

    episodes = list(result.episodes)
    episode_coin_counts = Counter(episode.coin for episode in episodes)
    episode_direction_counts = Counter(episode.direction for episode in episodes)
    wins = sum(1 for episode in episodes if episode.net_pnl > 0)
    losses = sum(1 for episode in episodes if episode.net_pnl < 0)
    net_pnl = sum((episode.net_pnl for episode in episodes), Decimal("0"))
    fees = sum((episode.fees_usdc for episode in episodes), Decimal("0"))
    durations = [episode.duration_ms for episode in episodes]
    verified_episode_count = len(episodes) if result.valid else None
    return {
        "coverage_complete": coverage_complete,
        "availability_limit_reached": availability_limit_reached or len(raw) >= FILL_AVAILABILITY_LIMIT,
        "raw_fill_count_90d": len(raw),
        "first_fill_ms": min(timestamps) if timestamps else None,
        "last_fill_ms": max(timestamps) if timestamps else None,
        "active_days_90d": len(active_days),
        "observed_notional_usd": str(observed_notional),
        "taker_fill_ratio": (taker_count / len(timestamps)) if timestamps else None,
        "top_coins_by_notional": [
            {"coin": coin, "notional_usd": str(value), "fill_count": coin_fill_counts[coin]}
            for coin, value in sorted(coin_notional.items(), key=lambda item: (-item[1], item[0]))[:5]
        ],
        "fill_direction_counts": dict(sorted(direction_counts.items())),
        "episode_validation_valid_90d": result.valid,
        "episode_validation_reason_90d": result.reason_code,
        "episode_validation_message_90d": result.reason_message,
        "verified_completed_episodes_90d": verified_episode_count,
        "episodes_observed_before_failure": len(episodes) if not result.valid else 0,
        "episode_coin_counts": dict(sorted(episode_coin_counts.items())),
        "episode_direction_counts": dict(sorted(episode_direction_counts.items())),
        "episode_wins": wins if result.valid else None,
        "episode_losses": losses if result.valid else None,
        "episode_win_rate": (wins / len(episodes)) if result.valid and episodes else None,
        "episode_net_pnl_usd": str(net_pnl) if result.valid else None,
        "episode_fees_usdc": str(fees) if result.valid else None,
        "median_episode_duration_ms": int(median(durations)) if result.valid and durations else None,
        "recent_completed_episodes": [
            {
                "coin": episode.coin,
                "direction": episode.direction,
                "entry_time_ms": episode.entry_time_ms,
                "exit_time_ms": episode.exit_time_ms,
                "net_pnl_usd": str(episode.net_pnl),
                "duration_ms": episode.duration_ms,
            }
            for episode in sorted(episodes, key=lambda item: item.exit_time_ms, reverse=True)[:10]
        ],
    }


def summarize_current_positions(all_dex_payload: Mapping[str, Any] | None) -> dict[str, Any]:
    """Normalize the initial ``allDexsClearinghouseState`` WebSocket snapshot."""

    states = all_dex_payload.get("clearinghouseStates") if isinstance(all_dex_payload, Mapping) else None
    if not isinstance(states, list):
        return {"snapshot_complete": False, "open_position_count": None, "positions": []}
    positions: list[dict[str, Any]] = []
    total_account_value = Decimal("0")
    account_value_state_count = 0
    total_notional = Decimal("0")
    total_upnl = Decimal("0")
    for item in states:
        if not isinstance(item, list) or len(item) != 2 or not isinstance(item[1], Mapping):
            continue
        dex = str(item[0] or "default")
        margin_summary = item[1].get("marginSummary")
        if isinstance(margin_summary, Mapping) and margin_summary.get("accountValue") is not None:
            total_account_value += _decimal(margin_summary.get("accountValue"))
            account_value_state_count += 1
        asset_positions = item[1].get("assetPositions")
        if not isinstance(asset_positions, list):
            continue
        for wrapper in asset_positions:
            position = wrapper.get("position") if isinstance(wrapper, Mapping) else None
            if not isinstance(position, Mapping):
                continue
            size = _decimal(position.get("szi"))
            if size == 0:
                continue
            raw_coin = str(position.get("coin") or "<MISSING>")
            coin = raw_coin if ":" in raw_coin or dex == "default" else f"{dex}:{raw_coin}"
            position_value = abs(_decimal(position.get("positionValue")))
            if position_value == 0:
                position_value = abs(size * _decimal(position.get("entryPx")))
            upnl = _decimal(position.get("unrealizedPnl"))
            leverage = position.get("leverage") if isinstance(position.get("leverage"), Mapping) else {}
            total_notional += position_value
            total_upnl += upnl
            positions.append(
                {
                    "dex": dex,
                    "coin": coin,
                    "side": "LONG" if size > 0 else "SHORT",
                    "size": str(size),
                    "entry_price": position.get("entryPx"),
                    "position_value_usd": str(position_value),
                    "unrealized_pnl_usd": str(upnl),
                    "leverage_type": leverage.get("type"),
                    "leverage": leverage.get("value"),
                    "liquidation_price": position.get("liquidationPx"),
                }
            )
    positions.sort(key=lambda row: (-_decimal(row["position_value_usd"]), row["coin"]))
    return {
        "snapshot_complete": True,
        "perp_account_value_usd": str(total_account_value) if account_value_state_count else None,
        "account_value_state_count": account_value_state_count,
        "open_position_count": len(positions),
        "open_position_notional_usd": str(total_notional),
        "open_position_unrealized_pnl_usd": str(total_upnl),
        "positions": positions,
    }


__all__ = [
    "fill_identity",
    "select_top_candidates_with_fills",
    "summarize_current_positions",
    "summarize_fill_history",
]
