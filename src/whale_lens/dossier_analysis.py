"""Pure, fail-closed analytics for a portfolio-only TOP10 dossier.

The dossier collector is deliberately separate from this module.  It supplies
one bounded snapshot per wallet and this module turns that snapshot into a
JSON-safe briefing.  No endpoint is called here and no ranking/copy-runner
state can be changed here.

All calculations use :class:`Decimal`; the compact HTML boundary converts
final values to JSON numbers.  Missing coverage is never converted into a
zero or an estimated result.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from decimal import Decimal, InvalidOperation
from statistics import median
from typing import Any

from .episodes import (
    FILL_AVAILABILITY_LIMIT,
    Episode,
    is_spot_coin,
    reconstruct_completed_episodes,
)
from .models import decimal_value


ZERO = Decimal("0")
ONE = Decimal("1")
DAY_MS = 86_400_000

COMPLETE = "COMPLETE"
PARTIAL = "PARTIAL"
UNKNOWN = "UNKNOWN"


def _decimal(value: Any, field_name: str) -> Decimal | None:
    """Parse a possibly absent API decimal without ever using a float."""

    if value is None or value == "":
        return None
    try:
        return decimal_value(value, field_name=field_name)
    except ValueError:
        return None


def _text(value: Decimal | None) -> int | float | None:
    """Return a JSON number only at the output boundary.

    Every intermediate calculation remains Decimal.  The browser-facing
    compact dossier intentionally uses JSON numbers as requested by its HTML
    contract; callers that require lossless accounting must retain the raw
    source evidence instead of reusing this presentation artefact.
    """

    if value is None:
        return None
    normalized = ZERO if value == ZERO else value
    if normalized == normalized.to_integral_value():
        return int(normalized)
    return float(normalized)


def _value(mapping: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        if name in mapping and mapping[name] is not None:
            return mapping[name]
    return None


def _bool_value(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "yes", "complete", "completed", "full"}:
            return True
        if normalized in {"false", "no", "partial", "incomplete", "truncated"}:
            return False
    return None


def _coverage_status(value: Any) -> str:
    """Classify a collector coverage proof, without assuming missing means full."""

    direct = _bool_value(value)
    if direct is True:
        return COMPLETE
    if direct is False:
        return PARTIAL
    if not isinstance(value, Mapping):
        return UNKNOWN
    for key in ("complete", "coverage_complete", "pagination_complete", "is_complete"):
        parsed = _bool_value(value.get(key))
        if parsed is True:
            return COMPLETE
        if parsed is False:
            return PARTIAL
    for key in ("truncated", "capped", "limit_reached", "availability_limit_reached", "incomplete"):
        parsed = _bool_value(value.get(key))
        if parsed is True:
            return PARTIAL
    return UNKNOWN


def _coverage_detail(value: Any) -> dict[str, Any]:
    detail = {"status": _coverage_status(value)}
    if isinstance(value, Mapping):
        for key in (
            "complete",
            "coverage_complete",
            "pagination_complete",
            "truncated",
            "capped",
            "limit_reached",
            "availability_limit_reached",
            "window_start_ms",
            "window_end_ms",
            "reason_code",
            "reason_message",
        ):
            if key in value:
                detail[key] = value[key]
    return detail


def _rows_and_coverage(value: Any) -> tuple[list[Mapping[str, Any]], Any]:
    if not isinstance(value, Mapping):
        return [], None
    rows = value.get("rows", value.get("events", value.get("fills", [])))
    if not isinstance(rows, Sequence) or isinstance(rows, (str, bytes, bytearray)):
        rows = []
    return [row for row in rows if isinstance(row, Mapping)], value.get("coverage")


def _availability_limit_reached(value: Any, row_count: int) -> bool:
    if row_count >= FILL_AVAILABILITY_LIMIT:
        return True
    if not isinstance(value, Mapping):
        return False
    for key in ("availability_limit_reached", "limit_reached", "truncated", "capped"):
        if _bool_value(value.get(key)) is True:
            return True
    coverage = value.get("coverage")
    if isinstance(coverage, Mapping):
        return any(_bool_value(coverage.get(key)) is True for key in ("availability_limit_reached", "limit_reached", "truncated", "capped"))
    return False


def _coin_name(position: Mapping[str, Any], dex: str | None = None) -> str | None:
    coin = _value(position, "coin", "asset", "symbol")
    if coin is None:
        return None
    text = str(coin)
    if dex and dex not in {"", "perp", "default"} and ":" not in text:
        return f"{dex}:{text}"
    return text


def _state_records(value: Any) -> list[tuple[str | None, Mapping[str, Any]]]:
    """Normalize default and all-DEX current state responses."""

    if value is None:
        return []
    if isinstance(value, Mapping):
        # The dossier collector preserves each all-DEX response as a wrapper
        # (dex, fetched_at_ms, payload, source).  Unwrap it before examining
        # state keys so ``payload`` is never accidentally treated as a DEX.
        if "payload" in value and isinstance(value.get("payload"), Mapping) and (
            "dex" in value or "fetched_at_ms" in value or "source" in value
        ):
            dex = str(value.get("dex")) if value.get("dex") is not None else None
            return [(dex, value["payload"])]
        states = value.get("clearinghouseStates")
        if isinstance(states, Sequence) and not isinstance(states, (str, bytes, bytearray)):
            records: list[tuple[str | None, Mapping[str, Any]]] = []
            for item in states:
                if isinstance(item, Sequence) and not isinstance(item, (str, bytes, bytearray)) and len(item) >= 2 and isinstance(item[1], Mapping):
                    records.append((str(item[0]), item[1]))
                elif isinstance(item, Mapping):
                    records.append((str(item.get("dex")) if item.get("dex") is not None else None, item))
            return records
        if any(key in value for key in ("assetPositions", "marginSummary", "crossMarginSummary")):
            return [(str(value.get("dex")) if value.get("dex") is not None else None, value)]
        records = []
        for dex, state in value.items():
            if isinstance(state, Mapping) and any(key in state for key in ("assetPositions", "marginSummary", "crossMarginSummary")):
                records.append((str(dex), state))
        return records
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        records = []
        for item in value:
            if isinstance(item, Mapping):
                records.extend(_state_records(item))
            elif isinstance(item, Sequence) and not isinstance(item, (str, bytes, bytearray)) and len(item) >= 2 and isinstance(item[1], Mapping):
                records.append((str(item[0]), item[1]))
        return records
    return []


def _current_exposure(current_states: Any) -> dict[str, Any]:
    states = _state_records(current_states)
    if current_states is None:
        return {
            "status": UNKNOWN,
            "account_value_usd": None,
            "state_account_value_sum_usd": None,
            "state_account_value_sum_scope": "SUM_OF_DEX_STATE_ACCOUNT_VALUES; INDEPENDENT_MARGIN_RELATIONSHIP_NOT_VERIFIED",
            "total_notional_usd": None,
            "long_notional_usd": None,
            "short_notional_usd": None,
            "gross_exposure_usd": None,
            "net_exposure_usd": None,
            "effective_leverage": None,
            "effective_leverage_basis": "UNAVAILABLE_UNTIL_PORTFOLIO_LATEST_ACCOUNT_VALUE_IS_ATTACHED",
            "position_count": None,
            "coin_count": None,
            "positions": [],
            "data_gaps": ["CURRENT_STATE_MISSING"],
        }

    account_values: list[Decimal] = []
    positions: list[dict[str, Any]] = []
    gaps: list[str] = []
    for dex, state in states:
        margin = state.get("marginSummary")
        if not isinstance(margin, Mapping):
            margin = state.get("crossMarginSummary")
        if isinstance(margin, Mapping):
            account = _decimal(_value(margin, "accountValue", "account_value", "equity"), "account value")
            if account is None:
                gaps.append("ACCOUNT_VALUE_UNPARSEABLE")
            else:
                account_values.append(account)
        else:
            gaps.append("ACCOUNT_VALUE_MISSING")

        raw_positions = state.get("assetPositions", state.get("positions", []))
        if not isinstance(raw_positions, Sequence) or isinstance(raw_positions, (str, bytes, bytearray)):
            gaps.append("POSITIONS_MISSING")
            continue
        for raw_position in raw_positions:
            if not isinstance(raw_position, Mapping):
                gaps.append("POSITION_UNPARSEABLE")
                continue
            position = raw_position.get("position") if isinstance(raw_position.get("position"), Mapping) else raw_position
            if not isinstance(position, Mapping):
                gaps.append("POSITION_UNPARSEABLE")
                continue
            size = _decimal(_value(position, "szi", "size", "positionSize"), "position size")
            if size is None:
                gaps.append("POSITION_SIZE_MISSING")
                continue
            if size == ZERO:
                continue
            coin = _coin_name(position, dex)
            if coin is None:
                gaps.append("POSITION_COIN_MISSING")
                continue
            notional = _decimal(_value(position, "positionValue", "notional", "position_value"), "position notional")
            entry_price = _decimal(_value(position, "entryPx", "entryPrice", "entry_price"), "entry price")
            if notional is None and entry_price is not None:
                notional = abs(size) * entry_price
            if notional is None:
                gaps.append("POSITION_NOTIONAL_MISSING")
            else:
                notional = abs(notional)
            leverage = position.get("leverage")
            leverage_value = _decimal(leverage.get("value"), "position leverage") if isinstance(leverage, Mapping) else _decimal(leverage, "position leverage")
            positions.append(
                {
                    "coin": coin,
                    "side": "LONG" if size > ZERO else "SHORT",
                    "size": _text(size),
                    "notional_usd": _text(notional),
                    "entry_price": _text(entry_price),
                    "unrealized_pnl_usd": _text(_decimal(_value(position, "unrealizedPnl", "unrealized_pnl"), "unrealized pnl")),
                    "reported_leverage": _text(leverage_value),
                    "margin_type": leverage.get("type") if isinstance(leverage, Mapping) else None,
                }
            )

    positions.sort(key=lambda item: (item["coin"], item["side"], item["size"] or ""))
    known_positions = [item for item in positions if item["notional_usd"] is not None]
    long_notional = sum((_decimal(item["notional_usd"], "notional") or ZERO for item in known_positions if item["side"] == "LONG"), ZERO)
    short_notional = sum((_decimal(item["notional_usd"], "notional") or ZERO for item in known_positions if item["side"] == "SHORT"), ZERO)
    gross = long_notional + short_notional
    state_account_value_sum = sum(account_values, ZERO) if account_values else None
    if state_account_value_sum is not None and state_account_value_sum <= ZERO:
        gaps.append("NONPOSITIVE_ACCOUNT_VALUE")
    complete = bool(states) and not gaps and len(known_positions) == len(positions) and state_account_value_sum is not None
    status = COMPLETE if complete else (PARTIAL if states or positions or account_values else UNKNOWN)
    return {
        "status": status,
        "account_value_usd": None,
        "state_account_value_sum_usd": _text(state_account_value_sum),
        "state_account_value_sum_scope": "SUM_OF_DEX_STATE_ACCOUNT_VALUES; INDEPENDENT_MARGIN_RELATIONSHIP_NOT_VERIFIED",
        "total_notional_usd": _text(gross) if known_positions else ("0" if positions == [] and states else None),
        "long_notional_usd": _text(long_notional) if known_positions else ("0" if positions == [] and states else None),
        "short_notional_usd": _text(short_notional) if known_positions else ("0" if positions == [] and states else None),
        "gross_exposure_usd": _text(gross) if known_positions else ("0" if positions == [] and states else None),
        "net_exposure_usd": _text(long_notional - short_notional) if known_positions else ("0" if positions == [] and states else None),
        "effective_leverage": None,
        "effective_leverage_basis": "UNAVAILABLE_UNTIL_PORTFOLIO_LATEST_ACCOUNT_VALUE_IS_ATTACHED",
        "position_count": len(positions),
        "coin_count": len({item["coin"] for item in positions}),
        "positions": positions,
        "data_gaps": sorted(set(gaps)),
    }


def _flatten_orders(value: Any, dex: str | None = None) -> list[tuple[str | None, Mapping[str, Any]]]:
    if value is None:
        return []
    if isinstance(value, Mapping):
        # See _state_records: collector wrappers are evidence metadata, not
        # orders.  Their explicit DEX is authoritative over any outer key.
        if "payload" in value and (
            "dex" in value or "fetched_at_ms" in value or "source" in value
        ):
            wrapper_dex = str(value.get("dex")) if value.get("dex") is not None else dex
            return _flatten_orders(value.get("payload"), wrapper_dex)
        for key in ("rows", "orders", "openOrders", "frontendOpenOrders"):
            nested = value.get(key)
            if isinstance(nested, Sequence) and not isinstance(nested, (str, bytes, bytearray)):
                return _flatten_orders(nested, str(value.get("dex")) if value.get("dex") is not None else dex)
        if "order" in value and isinstance(value["order"], Mapping):
            return [(str(value.get("dex")) if value.get("dex") is not None else dex, value["order"])]
        if any(key in value for key in ("coin", "side", "oid", "orderType")):
            return [(str(value.get("dex")) if value.get("dex") is not None else dex, value)]
        result: list[tuple[str | None, Mapping[str, Any]]] = []
        for nested_dex, nested in value.items():
            if isinstance(nested, (Mapping, list, tuple)):
                result.extend(_flatten_orders(nested, str(nested_dex)))
        return result
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        result: list[tuple[str | None, Mapping[str, Any]]] = []
        for row in value:
            if isinstance(row, Sequence) and not isinstance(row, (str, bytes, bytearray)) and len(row) >= 2 and isinstance(row[0], str):
                result.extend(_flatten_orders(row[1], row[0]))
            else:
                result.extend(_flatten_orders(row, dex))
        return result
    return []


def _orders_summary(open_orders: Any) -> dict[str, Any]:
    if open_orders is None:
        return {"status": UNKNOWN, "order_count": None, "limit_count": None, "trigger_count": None, "stop_loss_count": None, "take_profit_count": None, "buy_count": None, "sell_count": None, "reduce_only_count": None, "unknown_side_count": None, "orders": []}
    orders = _flatten_orders(open_orders)
    counts: Counter[str] = Counter()
    detail_rows = []
    for dex, order in orders:
        raw_type = order.get("orderType", order.get("type", ""))
        if isinstance(raw_type, Mapping):
            raw_type = " ".join(str(value) for value in raw_type.values())
        type_text = str(raw_type).lower()
        trigger_text = str(_value(order, "triggerCondition", "trigger_condition", "triggerPx", "triggerPxType") or "").lower()
        is_trigger = bool(trigger_text) or _bool_value(order.get("isTrigger")) is True or "trigger" in type_text
        side = str(order.get("side", "")).upper()
        counts["buy" if side == "B" else "sell" if side == "A" else "unknown_side"] += 1
        if is_trigger:
            counts["trigger"] += 1
        else:
            counts["limit"] += 1
        combined = f"{type_text} {trigger_text}".lower()
        if "stop" in combined or "sl" in combined:
            counts["stop_loss"] += 1
        if "take" in combined or "tp" in combined:
            counts["take_profit"] += 1
        if _bool_value(order.get("reduceOnly")) is True or _bool_value(order.get("reduce_only")) is True:
            counts["reduce_only"] += 1
        detail_rows.append(
            {
                "dex": dex,
                "coin": _coin_name(order, dex),
                "side": side if side in {"A", "B"} else None,
                "size": _text(_decimal(_value(order, "sz", "size"), "order size")),
                "limitPx": _text(_decimal(_value(order, "limitPx", "limit_px", "px"), "limit price")),
                "triggerPx": _text(_decimal(_value(order, "triggerPx", "trigger_px"), "trigger price")),
                "orderType": str(raw_type) if raw_type else None,
                "reduceOnly": _bool_value(_value(order, "reduceOnly", "reduce_only")),
                "oid": _json_scalar(order.get("oid")),
            }
        )
    detail_rows.sort(key=lambda item: (item["dex"] or "", item["coin"] or "", str(item["oid"] or ""), item["side"] or ""))
    return {
        "status": COMPLETE,
        "order_count": len(orders),
        "limit_count": counts["limit"],
        "trigger_count": counts["trigger"],
        "stop_loss_count": counts["stop_loss"],
        "take_profit_count": counts["take_profit"],
        "buy_count": counts["buy"],
        "sell_count": counts["sell"],
        "reduce_only_count": counts["reduce_only"],
        "unknown_side_count": counts["unknown_side"],
        "orders": detail_rows,
    }


def _fill_volume(fill: Mapping[str, Any]) -> Decimal | None:
    size = _decimal(_value(fill, "sz", "size"), "fill size")
    price = _decimal(_value(fill, "px", "price"), "fill price")
    if size is None or price is None:
        return None
    return abs(size * price)


def _fill_summary(value: Any) -> dict[str, Any]:
    rows, coverage = _rows_and_coverage(value)
    coverage_detail = _coverage_detail(coverage)
    if value is None:
        return {
            "status": UNKNOWN,
            "coverage": coverage_detail,
            "raw_fill_count": None,
            "perpetual_fill_count": None,
            "fill_volume_usd": None,
            "fees_usd": None,
            "buy_count": None,
            "sell_count": None,
            "coin_concentration": [],
            "leading_coin_volume_share": None,
            "activity_day_count": None,
            "last_fill": None,
            "recent_fills": [],
            "recent_episodes": [],
            "episode_validation": {"status": UNKNOWN},
            "data_gaps": ["FILL_DATA_MISSING"],
        }

    perpetual_rows = [row for row in rows if str(row.get("coin", "")) and not is_spot_coin(str(row.get("coin")))]
    known_volume = ZERO
    missing_volume = 0
    known_fees = ZERO
    unpriced_fee_tokens: set[str] = set()
    buys = sells = unknown_sides = 0
    activity_days: set[int] = set()
    timestamped: list[tuple[int, int, Mapping[str, Any]]] = []
    coin_volume: defaultdict[str, Decimal] = defaultdict(lambda: ZERO)
    for index, row in enumerate(perpetual_rows):
        volume = _fill_volume(row)
        if volume is None:
            missing_volume += 1
        else:
            known_volume += volume
            coin_volume[str(row.get("coin"))] += volume
        side = str(row.get("side", "")).upper()
        if side == "B":
            buys += 1
        elif side == "A":
            sells += 1
        else:
            unknown_sides += 1
        fee = _decimal(row.get("fee", "0"), "fill fee")
        token = str(row.get("feeToken") or "USDC")
        if fee is None:
            unpriced_fee_tokens.add("UNKNOWN")
        elif token == "USDC":
            known_fees += fee
        elif fee != ZERO:
            unpriced_fee_tokens.add(token)
        try:
            time_ms = int(row["time"])
        except (KeyError, TypeError, ValueError):
            continue
        activity_days.add(time_ms // DAY_MS)
        timestamped.append((time_ms, index, row))

    availability_limit = _availability_limit_reached(value, len(rows))
    episode_coverage_complete = coverage_detail["status"] == COMPLETE
    window_start = _coverage_window(coverage, "window_start_ms", 0)
    window_end = _coverage_window(coverage, "window_end_ms", max((item[0] for item in timestamped), default=0))
    # Keep response order for equal timestamps; the existing reconstruction
    # preserves it internally and rejects an unprovable position transition.
    reconstruction = reconstruct_completed_episodes(
        perpetual_rows,
        window_start,
        window_end,
        coverage_complete=episode_coverage_complete,
        availability_limit_reached=availability_limit,
    )
    episode_summary = _episode_summary(reconstruction.episodes, reconstruction.valid, reconstruction.reason_code, reconstruction.reason_message, perpetual_rows)
    episode_summary["raw_fill_count"] = reconstruction.raw_fill_count
    episode_summary["availability_limit_reached"] = availability_limit

    coin_rows = []
    for coin, volume in sorted(coin_volume.items(), key=lambda item: (-item[1], item[0])):
        coin_rows.append({"coin": coin, "known_volume_usd": _text(volume), "volume_share": _text(volume / known_volume) if known_volume > ZERO else None})
    status = COMPLETE if coverage_detail["status"] == COMPLETE and missing_volume == 0 and not unpriced_fee_tokens else PARTIAL
    if coverage_detail["status"] == UNKNOWN:
        status = UNKNOWN
    last_fill = None
    if timestamped:
        time_ms, _index, row = max(timestamped, key=lambda item: (item[0], item[1]))
        last_fill = {"time_ms": time_ms, "coin": str(row.get("coin")), "side": str(row.get("side")) or None}
    gaps = []
    if coverage_detail["status"] != COMPLETE:
        gaps.append("FILL_COVERAGE_NOT_COMPLETE")
    if missing_volume:
        gaps.append("FILL_VOLUME_UNPRICED")
    if unpriced_fee_tokens:
        gaps.append("FEE_NOT_USD_PRICED")
    if unknown_sides:
        gaps.append("FILL_SIDE_UNKNOWN")
    return {
        "status": status,
        "coverage": coverage_detail,
        "raw_fill_count": len(rows),
        "perpetual_fill_count": len(perpetual_rows),
        "fill_volume_usd": _text(known_volume) if missing_volume == 0 else None,
        "observed_known_fill_volume_usd": _text(known_volume),
        "fees_usd": _text(known_fees) if not unpriced_fee_tokens else None,
        "observed_known_fees_usd": _text(known_fees),
        "unpriced_fee_tokens": sorted(unpriced_fee_tokens),
        "buy_count": buys,
        "sell_count": sells,
        "unknown_side_count": unknown_sides,
        "coin_concentration": coin_rows,
        "leading_coin_volume_share": coin_rows[0]["volume_share"] if coin_rows else None,
        "activity_day_count": len(activity_days),
        "last_fill": last_fill,
        "recent_fills": _recent_fills(perpetual_rows),
        "recent_episodes": _episode_rows(reconstruction.episodes) if reconstruction.valid else [],
        "episode_validation": episode_summary,
        "data_gaps": gaps,
    }


def _recent_fills(rows: Sequence[Mapping[str, Any]], *, limit: int = 50) -> list[dict[str, Any]]:
    """Return a small chronological evidence tail, preserving equal-time order."""

    ordered: list[tuple[int, int, Mapping[str, Any]]] = []
    for index, row in enumerate(rows):
        try:
            ordered.append((int(row["time"]), index, row))
        except (KeyError, TypeError, ValueError):
            continue
    ordered.sort(key=lambda item: item[0])  # stable: same-millisecond API order remains intact.
    result = []
    for time_ms, _index, row in ordered[-limit:]:
        result.append(
            {
                "time_ms": time_ms,
                "coin": str(row.get("coin")) if row.get("coin") is not None else None,
                "side": str(row.get("side")) if row.get("side") is not None else None,
                "size": _text(_decimal(_value(row, "sz", "size"), "fill size")),
                "price": _text(_decimal(_value(row, "px", "price"), "fill price")),
                "start_position": _text(_decimal(row.get("startPosition"), "startPosition")),
                "closed_pnl_usd": _text(_decimal(row.get("closedPnl", "0"), "closedPnl")),
                "fee_usd": _text(_decimal(row.get("fee", "0"), "fee")),
                "fee_token": str(row.get("feeToken")) if row.get("feeToken") is not None else "USDC",
            }
        )
    return result


def _episode_rows(episodes: Sequence[Episode], *, limit: int = 50) -> list[dict[str, Any]]:
    return [
        {
            "coin": episode.coin,
            "direction": episode.direction,
            "entry_time_ms": episode.entry_time_ms,
            "exit_time_ms": episode.exit_time_ms,
            "duration_ms": episode.duration_ms,
            "gross_closed_pnl_usd": _text(episode.gross_closed_pnl),
            "fees_usd": _text(episode.fees_usdc),
            "net_pnl_usd": _text(episode.net_pnl),
            "entry_notional_usd": _text(episode.entry_notional_usd),
        }
        for episode in episodes[-limit:]
    ]


def _coverage_window(coverage: Any, key: str, fallback: int) -> int:
    if isinstance(coverage, Mapping):
        try:
            return int(coverage.get(key, fallback))
        except (TypeError, ValueError):
            return fallback
    return fallback


def _started_open_episode_count(fills: Iterable[Mapping[str, Any]]) -> int:
    """Count window-started chains left open, after validation has succeeded."""

    by_coin: defaultdict[str, list[tuple[int, Mapping[str, Any]]]] = defaultdict(list)
    for index, fill in enumerate(fills):
        coin = str(fill.get("coin", ""))
        if not coin or is_spot_coin(coin):
            continue
        try:
            by_coin[coin].append((int(fill["time"]), fill))
        except (KeyError, TypeError, ValueError):
            continue
    result = 0
    for rows in by_coin.values():
        rows.sort(key=lambda item: item[0])
        active_started = False
        active_position: Decimal | None = None
        for _time, fill in rows:
            start = _decimal(fill.get("startPosition"), "startPosition")
            size = _decimal(fill.get("sz"), "size")
            side = str(fill.get("side", "")).upper()
            if start is None or size is None or side not in {"A", "B"}:
                continue
            end = start + (size if side == "B" else -size)
            if start == ZERO:
                active_started = end != ZERO
            elif active_position is None:
                active_started = False
            elif end == ZERO:
                active_started = False
            elif (start > ZERO) != (end > ZERO):
                active_started = True
            active_position = end
        if active_started:
            result += 1
    return result


def _episode_summary(
    episodes: Sequence[Episode],
    valid: bool,
    reason_code: str | None,
    reason_message: str | None,
    fills: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    if not valid:
        return {
            "status": PARTIAL,
            "completed_episode_count": None,
            "open_started_episode_count": None,
            "win_rate": None,
            "net_pnl_usd": None,
            "profit_factor": None,
            "profit_factor_status": UNKNOWN,
            "average_episode_pnl_usd": None,
            "median_episode_pnl_usd": None,
            "max_win_usd": None,
            "max_loss_usd": None,
            "long_episode_count": None,
            "short_episode_count": None,
            "reason_code": reason_code,
            "reason_message": reason_message,
        }
    pnl_values = [episode.net_pnl for episode in episodes]
    positives = sum((value for value in pnl_values if value > ZERO), ZERO)
    negatives = sum((value for value in pnl_values if value < ZERO), ZERO)
    if negatives < ZERO:
        profit_factor = positives / abs(negatives)
        profit_factor_status = COMPLETE
    elif positives > ZERO:
        profit_factor = None
        profit_factor_status = "NO_LOSSES"
    else:
        profit_factor = None
        profit_factor_status = "NO_CLOSED_EPISODES" if not pnl_values else "NO_WINS_OR_LOSSES"
    return {
        "status": COMPLETE,
        "completed_episode_count": len(episodes),
        "open_started_episode_count": _started_open_episode_count(fills),
        "win_rate": _text(Decimal(sum(value > ZERO for value in pnl_values)) / Decimal(len(pnl_values))) if pnl_values else None,
        "net_pnl_usd": _text(sum(pnl_values, ZERO)),
        "profit_factor": _text(profit_factor),
        "profit_factor_status": profit_factor_status,
        "average_episode_pnl_usd": _text(sum(pnl_values, ZERO) / Decimal(len(pnl_values))) if pnl_values else None,
        "median_episode_pnl_usd": _text(Decimal(str(median(pnl_values)))) if pnl_values else None,
        "max_win_usd": _text(max((value for value in pnl_values if value > ZERO), default=None)),
        "max_loss_usd": _text(min((value for value in pnl_values if value < ZERO), default=None)),
        "long_episode_count": sum(episode.direction == "LONG" for episode in episodes),
        "short_episode_count": sum(episode.direction == "SHORT" for episode in episodes),
        "reason_code": None,
        "reason_message": None,
    }


def _portfolio_period(value: Any) -> Mapping[str, Any] | None:
    if isinstance(value, Mapping):
        # Portfolio evidence uses a metadata wrapper around the raw public
        # endpoint array.  Do this first, before looking for period names.
        if "payload" in value and (
            "fetched_at_ms" in value or "source" in value
        ):
            return _portfolio_period(value.get("payload"))
        period = value.get("perpMonth")
        if isinstance(period, Mapping):
            return period
        nested = value.get("portfolio")
        if nested is not None and nested is not value:
            return _portfolio_period(nested)
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for item in value:
            if isinstance(item, Sequence) and not isinstance(item, (str, bytes, bytearray)) and len(item) >= 2 and item[0] == "perpMonth" and isinstance(item[1], Mapping):
                return item[1]
    return None


def _portfolio_summary(portfolio: Any, source_diagnostics: Any) -> dict[str, Any]:
    period = _portfolio_period(portfolio)
    diagnostics = source_diagnostics if isinstance(source_diagnostics, Mapping) else {}
    source_flow = {
        key: diagnostics.get(key)
        for key in (
            "implied_flow_max_abs_usd",
            "implied_flow_max_relative_to_previous_equity",
            "implied_flow_nonzero_interval_count",
            "minimum_pnl_changing_previous_equity_usd",
            "pnl_changing_interval_count",
        )
        if key in diagnostics
    }
    if period is None:
        return {
            "status": UNKNOWN,
            "account_value_sample_count": None,
            "aligned_sample_count": None,
            "start_account_value_usd": None,
            "end_account_value_usd": None,
            "latest_account_value_usd": None,
            "latest_time_ms": None,
            "pnl_delta_usd": None,
            "perp_month_vlm": None,
            "raw_account_value_mdd_fraction": None,
            "max_drawdown_fraction": None,
            "max_drawdown_basis": "RAW_ACCOUNT_VALUE_NOT_FLOW_NEUTRAL_COMPATIBILITY_ALIAS",
            "simple_twr_return": None,
            "simple_twr_mdd_fraction": None,
            "simple_twr_curve_base_100": [],
            "simple_twr_curve_truncated": False,
            "aligned_series": [],
            "series_truncated": False,
            "source_implied_flow_diagnostics": source_flow,
            "data_gaps": ["PERP_MONTH_MISSING"],
        }
    history = period.get("accountValueHistory", [])
    samples: list[tuple[int, Decimal]] = []
    pnl_by_time: dict[int, Decimal] = {}
    gaps = []
    if not isinstance(history, Sequence) or isinstance(history, (str, bytes, bytearray)):
        history = []
        gaps.append("ACCOUNT_VALUE_HISTORY_MISSING")
    for item in history:
        if not isinstance(item, Sequence) or isinstance(item, (str, bytes, bytearray)) or len(item) < 2:
            gaps.append("ACCOUNT_VALUE_SAMPLE_UNPARSEABLE")
            continue
        try:
            time_ms = int(item[0])
        except (TypeError, ValueError):
            gaps.append("ACCOUNT_VALUE_SAMPLE_UNPARSEABLE")
            continue
        account_value = _decimal(item[1], "account value history")
        if account_value is None:
            gaps.append("ACCOUNT_VALUE_SAMPLE_UNPARSEABLE")
            continue
        samples.append((time_ms, account_value))
    pnl_history = period.get("pnlHistory", [])
    if not isinstance(pnl_history, Sequence) or isinstance(pnl_history, (str, bytes, bytearray)):
        pnl_history = []
        gaps.append("PNL_HISTORY_MISSING")
    for item in pnl_history:
        if not isinstance(item, Sequence) or isinstance(item, (str, bytes, bytearray)) or len(item) < 2:
            gaps.append("PNL_SAMPLE_UNPARSEABLE")
            continue
        try:
            time_ms = int(item[0])
        except (TypeError, ValueError):
            gaps.append("PNL_SAMPLE_UNPARSEABLE")
            continue
        pnl = _decimal(item[1], "pnl history")
        if pnl is None:
            gaps.append("PNL_SAMPLE_UNPARSEABLE")
            continue
        pnl_by_time[time_ms] = pnl
    samples.sort(key=lambda item: item[0])
    aligned = [(time_ms, account, pnl_by_time[time_ms]) for time_ms, account in samples if time_ms in pnl_by_time]
    if len(aligned) != len(samples):
        gaps.append("ALIGNED_ACCOUNT_PNL_SAMPLES_INCOMPLETE")
    peak: Decimal | None = None
    raw_max_drawdown = ZERO
    for _time_ms, account in samples:
        if peak is None or account > peak:
            peak = account
        if peak is not None and peak > ZERO:
            raw_max_drawdown = max(raw_max_drawdown, (peak - account) / peak)
        elif peak is not None:
            gaps.append("NONPOSITIVE_PORTFOLIO_PEAK")
    compact_aligned, series_truncated = _compact_aligned_series(aligned)
    simple_twr, simple_twr_mdd, simple_curve, simple_curve_truncated, simple_gap = _simple_twr_curve(aligned)
    if simple_gap is not None:
        gaps.append(simple_gap)
    start = aligned[0] if aligned else None
    end = aligned[-1] if aligned else None
    vlm = _decimal(period.get("vlm"), "perpMonth vlm")
    return {
        "status": COMPLETE if samples and aligned and not gaps else (PARTIAL if samples else UNKNOWN),
        "account_value_sample_count": len(samples),
        "aligned_sample_count": len(aligned),
        "start_account_value_usd": _text(start[1]) if start else None,
        "end_account_value_usd": _text(end[1]) if end else None,
        "latest_account_value_usd": _text(samples[-1][1]) if samples else None,
        "latest_time_ms": samples[-1][0] if samples else None,
        "pnl_delta_usd": _text(end[2] - start[2]) if start and end else None,
        "perp_month_vlm": _text(vlm),
        "raw_account_value_mdd_fraction": _text(raw_max_drawdown) if samples and "NONPOSITIVE_PORTFOLIO_PEAK" not in gaps else None,
        # Kept for older renderers only.  It is intentionally not a
        # flow-neutral risk/copyability input; use simple_twr_mdd_fraction.
        "max_drawdown_fraction": _text(raw_max_drawdown) if samples and "NONPOSITIVE_PORTFOLIO_PEAK" not in gaps else None,
        "max_drawdown_basis": "RAW_ACCOUNT_VALUE_NOT_FLOW_NEUTRAL_COMPATIBILITY_ALIAS",
        "simple_twr_return": _text(simple_twr),
        "simple_twr_mdd_fraction": _text(simple_twr_mdd),
        "simple_twr_curve_base_100": simple_curve,
        "simple_twr_curve_truncated": simple_curve_truncated,
        "aligned_series": compact_aligned,
        "series_truncated": series_truncated,
        "source_implied_flow_diagnostics": source_flow,
        "data_gaps": sorted(set(gaps)),
    }


def _compact_aligned_series(samples: Sequence[tuple[int, Decimal, Decimal]], *, limit: int = 60) -> tuple[list[dict[str, Any]], bool]:
    """Keep exact observations while capping a chart payload deterministically."""

    if len(samples) <= limit:
        selected = list(samples)
        truncated = False
    else:
        # Include both boundaries and choose evenly spaced existing samples;
        # no synthetic timestamps or interpolated account values are created.
        indexes = sorted({round(index * (len(samples) - 1) / (limit - 1)) for index in range(limit)})
        selected = [samples[index] for index in indexes]
        truncated = True
    return ([{"time_ms": time_ms, "account_value_usd": _text(account), "pnl_usd": _text(pnl)} for time_ms, account, pnl in selected], truncated)


def _simple_twr_curve(
    samples: Sequence[tuple[int, Decimal, Decimal]], *, limit: int = 60,
) -> tuple[Decimal | None, Decimal | None, list[dict[str, Any]], bool, str | None]:
    """Build the exact aligned simple-TWR curve and its drawdown.

    This deliberately follows the research metric's direct recurrence and
    uses no account-value change as a return.  Therefore deposits and full
    withdrawals do not become trading drawdowns.  A nonpositive denominator
    or a below--100% interval is exposed as a data gap, not approximated.
    """

    if len(samples) < 2:
        return None, None, [], False, "SIMPLE_TWR_INSUFFICIENT_ALIGNED_SAMPLES"
    growth = ONE
    curve: list[tuple[int, Decimal]] = [(samples[0][0], Decimal("100"))]
    for previous, current in zip(samples, samples[1:]):
        previous_equity = previous[1]
        if previous_equity <= ZERO:
            return None, None, [], False, "SIMPLE_TWR_NONPOSITIVE_PREVIOUS_ACCOUNT_VALUE"
        interval_return = (current[2] - previous[2]) / previous_equity
        if interval_return < -ONE:
            return None, None, [], False, "SIMPLE_TWR_RETURN_BELOW_MINUS_100"
        growth *= ONE + interval_return
        curve.append((current[0], Decimal("100") * growth))
    peak = curve[0][1]
    max_drawdown = ZERO
    for _time_ms, index in curve:
        if index > peak:
            peak = index
        if peak > ZERO:
            max_drawdown = max(max_drawdown, (peak - index) / peak)
    if len(curve) <= limit:
        selected = curve
        truncated = False
    else:
        indexes = sorted({round(index * (len(curve) - 1) / (limit - 1)) for index in range(limit)})
        selected = [curve[index] for index in indexes]
        truncated = True
    return (
        growth - ONE,
        max_drawdown,
        [{"time_ms": time_ms, "base_100": _text(index)} for time_ms, index in selected],
        truncated,
        None,
    )


def _ledger_summary(value: Any) -> dict[str, Any]:
    rows, coverage = _rows_and_coverage(value)
    coverage_detail = _coverage_detail(coverage)
    if value is None:
        return {"status": UNKNOWN, "coverage": coverage_detail, "cash_flow_event_count": None, "net_cash_flow_usd": None, "type_summary": [], "data_gaps": ["LEDGER_DATA_MISSING"]}
    by_type: dict[tuple[str, str], dict[str, Any]] = {}
    unknown = False
    total = ZERO
    cash_flow_count = 0
    for row in rows:
        delta = row.get("delta") if isinstance(row.get("delta"), Mapping) else row
        if not isinstance(delta, Mapping):
            unknown = True
            continue
        delta_type = str(_value(delta, "type", "deltaType", "kind") or "UNKNOWN")
        amount = _decimal(_value(delta, "usdc", "amount_usd", "amount", "usdValue", "value"), "ledger amount")
        classification = _ledger_classification(delta_type, amount)
        key = (delta_type, classification)
        entry = by_type.setdefault(key, {"delta_type": delta_type, "classification": classification, "event_count": 0, "net_amount": ZERO, "known_amount": True})
        entry["event_count"] += 1
        if classification == "NOT_A_CASH_FLOW":
            continue
        cash_flow_count += 1
        if amount is None or classification == "UNKNOWN":
            entry["known_amount"] = False
            unknown = True
            continue
        signed = -abs(amount) if classification.endswith("OUT") else abs(amount)
        entry["net_amount"] += signed
        total += signed
    type_summary = []
    for _key, entry in sorted(by_type.items(), key=lambda item: (item[1]["delta_type"], item[1]["classification"])):
        type_summary.append({"delta_type": entry["delta_type"], "classification": entry["classification"], "event_count": entry["event_count"], "net_amount_usd": _text(entry["net_amount"]) if entry["known_amount"] else None})
    status = COMPLETE if coverage_detail["status"] == COMPLETE and not unknown else PARTIAL
    if coverage_detail["status"] == UNKNOWN:
        status = UNKNOWN
    gaps = []
    if coverage_detail["status"] != COMPLETE:
        gaps.append("LEDGER_COVERAGE_NOT_COMPLETE")
    if unknown:
        gaps.append("LEDGER_CASH_FLOW_UNCLASSIFIED_OR_UNPRICED")
    return {
        "status": status,
        "coverage": coverage_detail,
        "cash_flow_event_count": cash_flow_count,
        "net_cash_flow_usd": _text(total) if not unknown and coverage_detail["status"] == COMPLETE else None,
        "observed_known_net_cash_flow_usd": _text(total),
        "type_summary": type_summary,
        "data_gaps": gaps,
    }


def _ledger_classification(delta_type: str, amount: Decimal | None) -> str:
    text = delta_type.replace("_", "").replace(" ", "").lower()
    if any(word in text for word in ("funding", "trade", "liquidation", "realizedpnl")):
        return "NOT_A_CASH_FLOW"
    if "withdraw" in text or "send" in text:
        return "EXTERNAL_OUT"
    if "deposit" in text or "receive" in text:
        return "EXTERNAL_IN"
    if "transfer" in text or "vault" in text:
        if amount is None:
            return "UNKNOWN"
        return "NON_POSITION_IN" if amount >= ZERO else "NON_POSITION_OUT"
    return "UNKNOWN"


def _inference(exposure: Mapping[str, Any], fills: Mapping[str, Any], portfolio: Mapping[str, Any], ledger: Mapping[str, Any]) -> dict[str, Any]:
    """Label all non-observed judgments and include the exact fact basis."""

    flags: list[dict[str, Any]] = []
    leverage = _decimal(exposure.get("effective_leverage"), "effective leverage")
    if leverage is not None and leverage >= Decimal("10"):
        flags.append({"code": "EXTREME_EFFECTIVE_LEVERAGE", "severity": "HIGH", "basis": "current_exposure.effective_leverage"})
    elif leverage is not None and leverage >= Decimal("5"):
        flags.append({"code": "HIGH_EFFECTIVE_LEVERAGE", "severity": "MEDIUM", "basis": "current_exposure.effective_leverage"})
    concentration = _decimal(fills.get("leading_coin_volume_share"), "leading coin share")
    if concentration is not None and concentration >= Decimal("0.80"):
        flags.append({"code": "HIGH_FILL_CONCENTRATION", "severity": "MEDIUM", "basis": "fills.leading_coin_volume_share"})
    drawdown = _decimal(portfolio.get("simple_twr_mdd_fraction"), "simple twr drawdown")
    if drawdown is not None and drawdown >= Decimal("0.50"):
        flags.append({"code": "LARGE_SIMPLE_TWR_DRAWDOWN", "severity": "HIGH", "basis": "portfolio.simple_twr_mdd_fraction"})
    portfolio_latest = _decimal(portfolio.get("latest_account_value_usd"), "portfolio latest account value")
    state_sum = _decimal(exposure.get("state_account_value_sum_usd"), "state account value sum")
    if (portfolio_latest is not None and portfolio_latest <= ZERO) or (state_sum is not None and state_sum <= ZERO):
        flags.append({
            "code": "WITHDRAWN_OR_EMPTY_ACCOUNT",
            "severity": "MEDIUM",
            "evidence_type": "OBSERVED",
            "basis": "portfolio_30d.latest_account_value_usd/current.state_account_value_sum_usd",
        })
    source_flow = portfolio.get("source_implied_flow_diagnostics")
    if isinstance(source_flow, Mapping):
        implied_relative = _decimal(source_flow.get("implied_flow_max_relative_to_previous_equity"), "implied flow relative")
        if implied_relative is not None and implied_relative >= ONE:
            flags.append({"code": "LARGE_SOURCE_IMPLIED_FLOW", "severity": "MEDIUM", "basis": "portfolio.source_implied_flow_diagnostics"})
    if fills.get("status") != COMPLETE:
        flags.append({"code": "FILL_DATA_PARTIAL", "severity": "HIGH", "basis": "fills.coverage"})
    if ledger.get("status") != COMPLETE:
        flags.append({"code": "CASH_FLOW_DATA_PARTIAL", "severity": "MEDIUM", "basis": "cash_flows.coverage"})
    if exposure.get("position_count") not in (None, 0):
        flags.append({"code": "OPEN_POSITION_MARK_TO_MARKET_RISK", "severity": "LOW", "basis": "current_exposure.position_count"})

    net = _decimal(exposure.get("net_exposure_usd"), "net exposure")
    gross = _decimal(exposure.get("gross_exposure_usd"), "gross exposure")
    if gross is None:
        directional = "UNKNOWN"
    elif gross == ZERO:
        directional = "FLAT"
    elif net is not None and abs(net) / gross >= Decimal("0.60"):
        directional = "LONG_BIASED" if net > ZERO else "SHORT_BIASED"
    else:
        directional = "MIXED"
    fill_count = fills.get("perpetual_fill_count")
    activity_days = fills.get("activity_day_count")
    if isinstance(fill_count, int) and fill_count > 0 and isinstance(activity_days, int) and activity_days > 0:
        execution = "OBSERVED_CONTINUOUS_OR_SCALED_TRADING"
    elif isinstance(fill_count, int) and fill_count > 0:
        execution = "OBSERVED_TRADING"
    else:
        execution = "UNKNOWN"
    blocked = any(flag["severity"] == "HIGH" for flag in flags)
    return {
        "classification": "INFERENCE_NOT_OBSERVED_FACT",
        "strategy_style": {
            "current_directional_posture": directional,
            "execution_style": execution,
            "basis": ["current_exposure.net_exposure_usd", "current_exposure.gross_exposure_usd", "fills.perpetual_fill_count", "fills.activity_day_count"],
        },
        "copyability": {
            "assessment": "LIMITED" if blocked else ("CAUTION" if flags else "MORE_OBSERVABLE"),
            "not_a_trade_recommendation": True,
            "basis": ["raw-fill activity/coverage", "current leverage/exposure", "cash-flow coverage"],
        },
        "risk_flags": sorted(flags, key=lambda item: (item["severity"], item["code"])),
    }


def analyze_wallet(wallet_record: Mapping[str, Any]) -> dict[str, Any]:
    """Analyze one collector record into the fixed compact dossier schema."""

    wallet = str(wallet_record.get("wallet") or "").lower()
    exposure = _current_exposure(wallet_record.get("current_states"))
    orders = _orders_summary(wallet_record.get("open_orders"))
    fills = _fill_summary(wallet_record.get("fills"))
    portfolio = _portfolio_summary(wallet_record.get("portfolio"), wallet_record.get("source_diagnostics"))
    portfolio_denominator = _decimal(portfolio.get("latest_account_value_usd"), "portfolio latest account value")
    gross_exposure = _decimal(exposure.get("gross_exposure_usd"), "gross exposure")
    if portfolio_denominator is not None and portfolio_denominator > ZERO:
        exposure["account_value_usd"] = _text(portfolio_denominator)
        exposure["account_value_scope"] = "LATEST_PORTFOLIO_PERP_MONTH_ACCOUNT_VALUE; NOT_PROVEN_CONTEMPORANEOUS_WITH_CURRENT_STATE"
        exposure["effective_leverage"] = _text(gross_exposure / portfolio_denominator) if gross_exposure is not None else None
        exposure["effective_leverage_basis"] = "CURRENT_GROSS_NOTIONAL / LATEST_PORTFOLIO_PERP_MONTH_ACCOUNT_VALUE"
    else:
        exposure["account_value_scope"] = "PORTFOLIO_LATEST_ACCOUNT_VALUE_UNAVAILABLE"
        exposure["data_gaps"] = sorted(set(exposure["data_gaps"] + ["PORTFOLIO_LEVERAGE_DENOMINATOR_UNAVAILABLE"]))
    ledger = _ledger_summary(wallet_record.get("ledger"))
    inference = _inference(exposure, fills, portfolio, ledger)
    episodes = fills["episode_validation"]
    current = {key: value for key, value in exposure.items() if key not in {"positions", "position_count", "coin_count"}}
    positions = {
        "status": exposure["status"],
        "position_count": exposure["position_count"],
        "coin_count": exposure["coin_count"],
        "items": exposure["positions"],
        "data_gaps": exposure["data_gaps"],
    }
    activity = {key: value for key, value in fills.items() if key not in {"episode_validation", "recent_fills", "recent_episodes"}}
    strategy = {key: value for key, value in inference.items() if key != "risk_flags"}
    return {
        "rank": wallet_record.get("rank"),
        "wallet": wallet,
        "source_score": _json_scalar(wallet_record.get("source_score")),
        "source_diagnostics": _source_diagnostics(wallet_record.get("source_diagnostics")),
        "headline": {
            "current_account_value_usd": current["account_value_usd"],
            "current_account_value_basis": current["account_value_scope"],
            "gross_exposure_usd": current["gross_exposure_usd"],
            "effective_leverage": current["effective_leverage"],
            "effective_leverage_basis": current["effective_leverage_basis"],
            "completed_episode_count": episodes.get("completed_episode_count"),
            "episode_net_pnl_usd": episodes.get("net_pnl_usd"),
            "perpetual_fill_count": activity["perpetual_fill_count"],
            "summary_is_observed_or_direct_calculation": True,
        },
        "current": current,
        "performance": episodes,
        "activity": activity,
        "positions": positions,
        "orders": orders,
        "cashflows": ledger,
        "portfolio_30d": portfolio,
        "portfolio_series": portfolio,
        "recent_fills": fills["recent_fills"],
        "recent_episodes": fills["recent_episodes"],
        "strategy_inference": strategy,
        "risk_flags": inference["risk_flags"],
        "data_quality": _wallet_data_quality(exposure, fills, ledger, portfolio),
    }


def _json_scalar(value: Any) -> Any:
    if isinstance(value, Decimal):
        return _text(value)
    if isinstance(value, str):
        parsed = _decimal(value, "source scalar")
        return _text(parsed) if parsed is not None else value
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _source_diagnostics(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): _json_scalar(item) for key, item in sorted(value.items(), key=lambda item: str(item[0]))}


def _rank_key(value: Any) -> tuple[int, int | str]:
    try:
        return (0, int(value))
    except (TypeError, ValueError):
        return (1, "" if value is None else str(value))


def _wallet_data_quality(
    exposure: Mapping[str, Any],
    fills: Mapping[str, Any],
    ledger: Mapping[str, Any],
    portfolio: Mapping[str, Any],
) -> list[dict[str, str]]:
    """Flatten only evidence-quality warnings; never mix in risk judgments."""

    warnings: set[tuple[str, str]] = set()
    components = (("current", exposure), ("fills", fills), ("cashflows", ledger), ("portfolio_series", portfolio))
    for component, value in components:
        status = str(value.get("status", UNKNOWN))
        if status != COMPLETE:
            warnings.add((component, f"{component.upper()}_{status}"))
        gaps = value.get("data_gaps", [])
        if isinstance(gaps, Sequence) and not isinstance(gaps, (str, bytes, bytearray)):
            for gap in gaps:
                warnings.add((component, str(gap)))
    episode = fills.get("episode_validation", {})
    if isinstance(episode, Mapping) and episode.get("status") != COMPLETE:
        warnings.add(("performance", str(episode.get("reason_code") or "EPISODE_VALIDATION_PARTIAL")))
    return [{"component": component, "code": code} for component, code in sorted(warnings)]


def _evidence_window(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    result: dict[str, Any] = {}
    for key, item in sorted(value.items(), key=lambda pair: str(pair[0])):
        result[str(key)] = _json_scalar(item)
    return result


def _json_public(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _json_public(item) for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_json_public(item) for item in value]
    return _json_scalar(value)


def build_dossier_analysis(dataset: Mapping[str, Any]) -> dict[str, Any]:
    """Build a render-ready dossier from the documented raw collector contract.

    ``dataset`` must contain a ``wallets`` list.  The returned top-level and
    per-wallet key sets are stable for HTML rendering.  The report is
    explicitly research-only and never a copy-runner input.
    """

    raw_wallets = dataset.get("wallets", []) if isinstance(dataset, Mapping) else []
    records = [record for record in raw_wallets if isinstance(record, Mapping)] if isinstance(raw_wallets, Sequence) and not isinstance(raw_wallets, (str, bytes, bytearray)) else []
    analyzed = [analyze_wallet(record) for record in records]
    analyzed.sort(key=lambda row: (_rank_key(row["rank"]), row["wallet"]))
    fill_statuses = Counter(row["activity"]["coverage"]["status"] for row in analyzed)
    ledger_statuses = Counter(row["cashflows"]["coverage"]["status"] for row in analyzed)
    overall_statuses = [
        item
        for row in analyzed
        for item in (
            row["current"]["status"],
            row["activity"]["status"],
            row["cashflows"]["status"],
            row["portfolio_series"]["status"],
            row["performance"]["status"],
        )
    ]
    source_coverage = dataset.get("coverage") if isinstance(dataset, Mapping) else None
    source_report = dataset.get("source_report") if isinstance(dataset, Mapping) else None
    evidence_window = dataset.get("evidence_window") if isinstance(dataset, Mapping) else None
    if evidence_window is None and isinstance(dataset, Mapping):
        boundaries = {key: dataset[key] for key in ("window_start_ms", "window_end_ms") if key in dataset}
        evidence_window = boundaries or None
    if not analyzed:
        overall_status = UNKNOWN
    elif any(status == UNKNOWN for status in overall_statuses):
        overall_status = UNKNOWN
    elif any(status != COMPLETE for status in overall_statuses):
        overall_status = PARTIAL
    else:
        overall_status = COMPLETE
    return {
        "schema_version": 1,
        "generated_at_ms": _json_scalar(dataset.get("generated_at_ms")) if isinstance(dataset, Mapping) else None,
        "evidence_window": _evidence_window(evidence_window),
        "coverage": {
            "status": overall_status,
            "source": _coverage_detail(source_coverage),
            "wallet_record_count": len(records),
            "wallet_analysis_count": len(analyzed),
            "fill_coverage_status_counts": dict(sorted(fill_statuses.items())),
            "ledger_coverage_status_counts": dict(sorted(ledger_statuses.items())),
        },
        "analysis_type": "TOP10_PORTFOLIO_ONLY_DOSSIER",
        "source_report": _json_public(source_report) if source_report is not None else None,
        "research_only": True,
        "cashflow_neutral_verified": False,
        "copy_runner_input": False,
        "wallets": analyzed,
        "method": {
            "episodes": "raw perpetual fills only; aggregateByTime=false coverage must be complete; startPosition chains preserve partial entries/exits and split reversals",
            "facts_vs_inference": "facts are observed/direct calculations; strategy and copyability are explicitly labeled inferences",
            "missing_data": "missing or incomplete coverage is reported as UNKNOWN/PARTIAL and is never converted to zero",
            "numeric_representation": "Decimal-safe calculations, converted to JSON numbers only at the compact HTML boundary",
        },
    }


__all__ = ["analyze_wallet", "build_dossier_analysis"]
