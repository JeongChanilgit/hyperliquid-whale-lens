"""Fail-closed reconstruction of completed perpetual position episodes.

Only raw ``userFillsByTime`` responses requested with ``aggregateByTime=false``
are valid input.  The public API does not expose enough information to infer a
missing position transition, so a discontinuity makes the complete wallet
unverifiable rather than allowing a best-effort episode count.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Mapping, Sequence


FILL_AVAILABILITY_LIMIT = 10_000
ZERO_EPSILON = Decimal("1e-9")

REASON_FILL_LIMIT = "FILL_10000_LIMIT"
REASON_FILL_PAGINATION_INCOMPLETE = "FILL_PAGINATION_INCOMPLETE"
REASON_POSITION_DISCONTINUITY = "POSITION_CHAIN_DISCONTINUITY"
REASON_INVALID_FILL = "INVALID_FILL"


def _decimal(value: Any, field: str) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"invalid {field}: {value!r}") from exc


def _is_zero(value: Decimal) -> bool:
    return abs(value) <= ZERO_EPSILON


def _normalise_zero(value: Decimal) -> Decimal:
    return Decimal("0") if _is_zero(value) else value


def _positions_match(left: Decimal, right: Decimal) -> bool:
    tolerance = max(ZERO_EPSILON, abs(left) * Decimal("1e-10"), abs(right) * Decimal("1e-10"))
    return abs(left - right) <= tolerance


def _sign(value: Decimal) -> int:
    return 1 if value > 0 else -1 if value < 0 else 0


def is_spot_coin(coin: str) -> bool:
    """Return whether a Hyperliquid fill is spot rather than a perpetual.

    HIP-3 perpetual markets (for example ``xyz:ABC`` and ``para:ABC``) are
    deliberately *not* excluded.  Hyperliquid spot symbols are represented by
    an ``@`` token identifier or a slash pair in the raw fill feed.
    """

    return coin.startswith("@") or "/" in coin


def raw_fills_request(user: str, start_time_ms: int, end_time_ms: int) -> dict[str, Any]:
    """Build the only fill request form accepted by this module."""

    return {
        "type": "userFillsByTime",
        "user": user,
        "startTime": start_time_ms,
        "endTime": end_time_ms,
        "aggregateByTime": False,
    }


@dataclass(frozen=True)
class Episode:
    coin: str
    direction: str
    entry_time_ms: int
    exit_time_ms: int
    gross_closed_pnl: Decimal
    fees_usdc: Decimal
    net_pnl: Decimal
    duration_ms: int
    entry_notional_usd: Decimal | None = None


@dataclass(frozen=True)
class EpisodeReconstructionResult:
    """The complete episode result for one wallet and one fixed window."""

    episodes: tuple[Episode, ...]
    raw_fill_count: int
    valid: bool
    reason_code: str | None = None
    reason_message: str | None = None

    @property
    def completed_episodes(self) -> int:
        return len(self.episodes)


def _failure(
    episodes: Sequence[Episode], raw_fill_count: int, reason_code: str, reason_message: str
) -> EpisodeReconstructionResult:
    return EpisodeReconstructionResult(
        episodes=tuple(episodes),
        raw_fill_count=raw_fill_count,
        valid=False,
        reason_code=reason_code,
        reason_message=reason_message,
    )


def _new_active(coin: str, position: Decimal, entry_time_ms: int | None, qualifying: bool) -> dict[str, Any]:
    return {
        "coin": coin,
        "direction": "LONG" if position > 0 else "SHORT",
        "entry_time_ms": entry_time_ms,
        "qualifying": qualifying,
        "gross_closed_pnl": Decimal("0"),
        "fees_usdc": Decimal("0"),
        "entry_notional_usd": Decimal("0"),
        "entry_notional_complete": True,
        "unpriced_fee_tokens": set(),
    }


def _add_entry_notional(active: dict[str, Any], fill: Mapping[str, Any], opened_size: Decimal) -> None:
    if opened_size <= 0:
        active["entry_notional_complete"] = False
        return
    try:
        price = _decimal(fill.get("px"), "px")
    except ValueError:
        active["entry_notional_complete"] = False
        return
    if price <= 0:
        active["entry_notional_complete"] = False
        return
    active["entry_notional_usd"] += opened_size * price


def _add_fee(active: dict[str, Any], fill: Mapping[str, Any], fraction: Decimal = Decimal("1")) -> None:
    fee = _decimal(fill.get("fee", "0"), "fee") * fraction
    if _is_zero(fee):
        return
    token = str(fill.get("feeToken") or "USDC")
    if token == "USDC":
        active["fees_usdc"] += fee
    else:
        active["unpriced_fee_tokens"].add(token)


def _finish_episode(active: dict[str, Any], exit_time_ms: int) -> tuple[Episode | None, str | None]:
    # A position that was already open at the left boundary is carry-in.  Its
    # close is not a window-started completed episode.
    if not active["qualifying"]:
        return None, None
    tokens = active["unpriced_fee_tokens"]
    if tokens:
        return None, f"completed perpetual episode has non-USDC fees ({','.join(sorted(tokens))})"
    entry_time_ms = active["entry_time_ms"]
    if entry_time_ms is None:
        return None, "qualified episode was missing an entry timestamp"
    gross = active["gross_closed_pnl"]
    fees = active["fees_usdc"]
    return (
        Episode(
            coin=active["coin"],
            direction=active["direction"],
            entry_time_ms=int(entry_time_ms),
            exit_time_ms=exit_time_ms,
            gross_closed_pnl=gross,
            fees_usdc=fees,
            net_pnl=gross - fees,
            duration_ms=exit_time_ms - int(entry_time_ms),
            entry_notional_usd=(
                active["entry_notional_usd"]
                if active["entry_notional_complete"] and active["entry_notional_usd"] > 0
                else None
            ),
        ),
        None,
    )


def reconstruct_completed_episodes(
    fills: Iterable[Mapping[str, Any]],
    window_start_ms: int,
    window_end_ms: int,
    *,
    aggregate_by_time: bool = False,
    coverage_complete: bool = True,
    availability_limit_reached: bool = False,
) -> EpisodeReconstructionResult:
    """Reconstruct per-coin position chains without inferring missing state.

    Equal-time fills retain the original API response order.  This is material:
    it encodes the position chain and must never be reordered by trade id.
    ``coverage_complete`` and ``availability_limit_reached`` are supplied by
    the paginator; a list of 10,000 fills is conservatively fail-closed even
    when the caller did not set the latter flag.
    """

    raw = list(fills)
    raw_fill_count = len(raw)
    if aggregate_by_time:
        return _failure(
            (), raw_fill_count, REASON_FILL_PAGINATION_INCOMPLETE,
            "episode validation requires aggregateByTime=false raw fills",
        )
    if availability_limit_reached or raw_fill_count >= FILL_AVAILABILITY_LIMIT:
        return _failure(
            (), raw_fill_count, REASON_FILL_LIMIT,
            "the 10,000 raw-fill availability limit prevents complete window validation",
        )
    if not coverage_complete:
        return _failure(
            (), raw_fill_count, REASON_FILL_PAGINATION_INCOMPLETE,
            "raw-fill pagination cannot prove complete coverage of the evaluation window",
        )

    by_coin: dict[str, list[tuple[int, Mapping[str, Any]]]] = {}
    for index, fill in enumerate(raw):
        try:
            timestamp = int(fill["time"])
        except (KeyError, TypeError, ValueError) as exc:
            return _failure((), raw_fill_count, REASON_INVALID_FILL, f"invalid fill timestamp: {exc}")
        if not window_start_ms <= timestamp <= window_end_ms:
            continue
        coin = str(fill.get("coin", ""))
        if not coin:
            return _failure((), raw_fill_count, REASON_INVALID_FILL, "fill was missing coin")
        if is_spot_coin(coin):
            continue
        by_coin.setdefault(coin, []).append((index, fill))

    completed: list[Episode] = []
    for coin, indexed_fills in by_coin.items():
        # Python's sort is stable, and the original index is retained solely as
        # an explicit audit of API order for same-millisecond responses.
        indexed_fills.sort(key=lambda item: int(item[1]["time"]))
        active: dict[str, Any] | None = None
        expected_position: Decimal | None = None

        for _index, fill in indexed_fills:
            try:
                timestamp = int(fill["time"])
                start_position = _normalise_zero(_decimal(fill["startPosition"], "startPosition"))
                size = _decimal(fill["sz"], "sz")
                closed_pnl = _decimal(fill.get("closedPnl", "0"), "closedPnl")
            except (KeyError, TypeError, ValueError) as exc:
                return _failure(completed, raw_fill_count, REASON_INVALID_FILL, f"invalid {coin} fill: {exc}")
            if size < 0:
                return _failure(completed, raw_fill_count, REASON_INVALID_FILL, f"negative fill size for {coin}")
            side = fill.get("side")
            if side == "B":
                delta = size
            elif side == "A":
                delta = -size
            else:
                return _failure(completed, raw_fill_count, REASON_INVALID_FILL, f"invalid fill side for {coin}")
            end_position = _normalise_zero(start_position + delta)

            if expected_position is not None and not _positions_match(expected_position, start_position):
                return _failure(
                    completed,
                    raw_fill_count,
                    REASON_POSITION_DISCONTINUITY,
                    f"position discontinuity for {coin}: expected {expected_position}, got {start_position}",
                )

            if start_position == 0:
                if active is not None:
                    return _failure(
                        completed, raw_fill_count, REASON_POSITION_DISCONTINUITY,
                        f"episode state mismatch at flat position for {coin}",
                    )
                if end_position != 0:
                    active = _new_active(coin, end_position, timestamp, qualifying=True)
                    active["gross_closed_pnl"] += closed_pnl
                    try:
                        _add_entry_notional(active, fill, abs(end_position))
                        _add_fee(active, fill)
                    except ValueError as exc:
                        return _failure(completed, raw_fill_count, REASON_INVALID_FILL, str(exc))
            else:
                if active is None:
                    # The first observed non-flat state is a carry-in chain;
                    # do not count it even if it later closes in this window.
                    active = _new_active(coin, start_position, None, qualifying=False)

                if end_position == 0 or _sign(start_position) == _sign(end_position):
                    active["gross_closed_pnl"] += closed_pnl
                    try:
                        if end_position != 0 and abs(end_position) > abs(start_position):
                            _add_entry_notional(active, fill, abs(end_position) - abs(start_position))
                        _add_fee(active, fill)
                    except ValueError as exc:
                        return _failure(completed, raw_fill_count, REASON_INVALID_FILL, str(exc))
                    if end_position == 0:
                        episode, error = _finish_episode(active, timestamp)
                        if error:
                            return _failure(completed, raw_fill_count, REASON_INVALID_FILL, error)
                        if episode is not None:
                            completed.append(episode)
                        active = None
                else:
                    # One reversal fill closes the old side and opens a new
                    # qualifying episode.  Allocate its fee by closed/opened
                    # size; its closedPnl belongs wholly to the closing side.
                    if _is_zero(size):
                        return _failure(
                            completed, raw_fill_count, REASON_INVALID_FILL, f"zero-size reversal for {coin}",
                        )
                    old_fraction = abs(start_position) / size
                    new_fraction = abs(end_position) / size
                    if not _positions_match(old_fraction + new_fraction, Decimal("1")):
                        return _failure(
                            completed, raw_fill_count, REASON_POSITION_DISCONTINUITY,
                            f"reversal size mismatch for {coin}",
                        )
                    active["gross_closed_pnl"] += closed_pnl
                    try:
                        _add_fee(active, fill, old_fraction)
                    except ValueError as exc:
                        return _failure(completed, raw_fill_count, REASON_INVALID_FILL, str(exc))
                    episode, error = _finish_episode(active, timestamp)
                    if error:
                        return _failure(completed, raw_fill_count, REASON_INVALID_FILL, error)
                    if episode is not None:
                        completed.append(episode)
                    active = _new_active(coin, end_position, timestamp, qualifying=True)
                    try:
                        _add_entry_notional(active, fill, abs(end_position))
                        _add_fee(active, fill, new_fraction)
                    except ValueError as exc:
                        return _failure(completed, raw_fill_count, REASON_INVALID_FILL, str(exc))

            expected_position = end_position

    completed.sort(key=lambda item: (item.exit_time_ms, item.coin, item.entry_time_ms))
    return EpisodeReconstructionResult(tuple(completed), raw_fill_count, True)


__all__ = [
    "Episode",
    "EpisodeReconstructionResult",
    "FILL_AVAILABILITY_LIMIT",
    "REASON_FILL_LIMIT",
    "REASON_FILL_PAGINATION_INCOMPLETE",
    "REASON_POSITION_DISCONTINUITY",
    "is_spot_coin",
    "raw_fills_request",
    "reconstruct_completed_episodes",
]
