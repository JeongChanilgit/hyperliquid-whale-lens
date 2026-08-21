"""Deterministic multi-signal discovery pool construction.

Leaderboard ROI is intentionally only one discovery signal.  This module
builds a bounded pool for provisional scoring and records why every wallet was
included so later stages never mistake a discovery rank for a verified score.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any


MONTH_ROI = "MONTH_ROI"
MONTH_PNL = "MONTH_PNL"
TURNOVER = "TURNOVER"
PRIOR_VERIFIED = "PRIOR_VERIFIED"
NEW_WALLET = "NEW_WALLET"
ROTATING_SAMPLE = "ROTATING_SAMPLE"
FILLER = "FILLER"

SIGNAL_TO_REASON = {
    "month_roi": MONTH_ROI,
    "month_pnl": MONTH_PNL,
    "turnover": TURNOVER,
}
PINNED_REASONS = (PRIOR_VERIFIED, NEW_WALLET, ROTATING_SAMPLE)
WALLET_PATTERN = re.compile(r"^0x[0-9a-fA-F]{40}$")


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return parsed if parsed.is_finite() else None


def normalise_wallet(wallet: Any) -> str | None:
    if not isinstance(wallet, str):
        return None
    candidate = wallet.strip()
    if not WALLET_PATTERN.fullmatch(candidate):
        return None
    return candidate.lower()


def _performance_window(row: Mapping[str, Any]) -> Mapping[str, Any]:
    direct = row.get("month")
    if isinstance(direct, Mapping):
        return direct
    windows = row.get("windowPerformances")
    if isinstance(windows, Mapping):
        month = windows.get("month")
        return month if isinstance(month, Mapping) else {}
    if isinstance(windows, list):
        for item in windows:
            if isinstance(item, (tuple, list)) and len(item) == 2 and item[0] == "month" and isinstance(item[1], Mapping):
                return item[1]
            if isinstance(item, Mapping) and item.get("name") == "month" and isinstance(item.get("performance"), Mapping):
                return item["performance"]
    return {}


def _first_decimal(values: Iterable[Any]) -> Decimal | None:
    for value in values:
        parsed = _decimal_or_none(value)
        if parsed is not None:
            return parsed
    return None


def _stable_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class LeaderboardWallet:
    wallet: str
    current_account_value_usd: Decimal
    month_roi: Decimal | None = None
    month_pnl: Decimal | None = None
    month_volume: Decimal | None = None
    display_name: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "wallet": self.wallet,
            "current_account_value_usd": str(self.current_account_value_usd),
            "month_roi": None if self.month_roi is None else str(self.month_roi),
            "month_pnl": None if self.month_pnl is None else str(self.month_pnl),
            "month_volume": None if self.month_volume is None else str(self.month_volume),
            "display_name": self.display_name,
        }


@dataclass(frozen=True)
class DiscoveryUniverse:
    wallets: tuple[LeaderboardWallet, ...]
    raw_row_count: int
    rejected_row_count: int
    duplicate_wallet_count: int
    signal_available: Mapping[str, bool]

    @property
    def eligible_count(self) -> int:
        return len(self.wallets)

    @property
    def unavailable_signals(self) -> tuple[str, ...]:
        return tuple(name for name, available in self.signal_available.items() if not available)

    def by_wallet(self) -> dict[str, LeaderboardWallet]:
        return {wallet.wallet: wallet for wallet in self.wallets}


@dataclass(frozen=True)
class DiscoveryConfig:
    minimum_account_value_usd: Decimal = Decimal("10000")
    leaderboard_roi_top_n: int = 3000
    leaderboard_pnl_top_n: int = 2000
    leaderboard_turnover_top_n: int = 2000
    prior_verified_top_n: int = 2000
    new_wallet_top_n: int = 500
    rotating_sample_n: int = 500
    discovery_pool_target: int = 6000
    discovery_pool_min: int = 5000
    discovery_pool_max: int = 7000
    rrf_k: int = 60

    def __post_init__(self) -> None:
        if self.minimum_account_value_usd < 0:
            raise ValueError("minimum_account_value_usd must be non-negative")
        if not (0 < self.discovery_pool_min <= self.discovery_pool_target <= self.discovery_pool_max):
            raise ValueError("discovery pool bounds must satisfy 0 < min <= target <= max")
        if self.rrf_k < 0:
            raise ValueError("rrf_k must be non-negative")
        for value in (
            self.leaderboard_roi_top_n,
            self.leaderboard_pnl_top_n,
            self.leaderboard_turnover_top_n,
            self.prior_verified_top_n,
            self.new_wallet_top_n,
            self.rotating_sample_n,
        ):
            if value < 0:
                raise ValueError("discovery bucket sizes must be non-negative")


@dataclass(frozen=True)
class DiscoverySignals:
    ranks: Mapping[str, Mapping[str, int]]
    values: Mapping[str, Mapping[str, Decimal]]
    available: Mapping[str, bool]

    def rank(self, signal: str, wallet: str) -> int | None:
        return self.ranks.get(signal, {}).get(wallet)

    def rrf_score(self, wallet: str, *, k: int = 60) -> Decimal:
        score = Decimal("0")
        for signal in SIGNAL_TO_REASON:
            rank = self.rank(signal, wallet)
            if rank is not None:
                score += Decimal(1) / Decimal(k + rank)
        return score


@dataclass(frozen=True)
class DiscoveryPoolEntry:
    wallet: str
    current_account_value_usd: Decimal
    inclusion_reasons: tuple[str, ...]
    signal_ranks: Mapping[str, int]
    fusion_score: Decimal

    def to_dict(self) -> dict[str, Any]:
        return {
            "wallet": self.wallet,
            "current_account_value_usd": str(self.current_account_value_usd),
            "discovery_inclusion_reasons": list(self.inclusion_reasons),
            "leaderboard_month_roi_rank": self.signal_ranks.get("month_roi"),
            "leaderboard_month_pnl_rank": self.signal_ranks.get("month_pnl"),
            "leaderboard_month_turnover_rank": self.signal_ranks.get("turnover"),
            "discovery_fusion_score": str(self.fusion_score),
        }


@dataclass(frozen=True)
class DiscoveryPoolResult:
    entries: tuple[DiscoveryPoolEntry, ...]
    discovery_cycle_id: str
    pool_hash: str
    complete: bool
    signal_available: Mapping[str, bool]
    bucket_actual_counts: Mapping[str, int]
    reason_codes: tuple[str, ...] = ()

    @property
    def wallets(self) -> tuple[str, ...]:
        return tuple(entry.wallet for entry in self.entries)

    @property
    def actual_count(self) -> int:
        return len(self.entries)

    def to_dict(self) -> dict[str, Any]:
        return {
            "discovery_cycle_id": self.discovery_cycle_id,
            "discovery_pool_hash": self.pool_hash,
            "discovery_pool_actual": self.actual_count,
            "discovery_pool_complete": self.complete,
            "signal_available": dict(self.signal_available),
            "discovery_signal_actual_counts": dict(self.bucket_actual_counts),
            "reason_codes": list(self.reason_codes),
            "wallets": [entry.to_dict() for entry in self.entries],
        }


def load_leaderboard_universe(
    payload: Mapping[str, Any] | list[Mapping[str, Any]],
    *,
    minimum_account_value_usd: Decimal = Decimal("10000"),
) -> DiscoveryUniverse:
    """Parse the *entire* leaderboard before filtering eligible wallets.

    Missing metric fields do not become zero.  They simply leave that row out
    of the corresponding signal; a completely absent field disables the signal
    and is surfaced through ``signal_available``.
    """

    rows: Any = payload.get("leaderboardRows") if isinstance(payload, Mapping) else payload
    if not isinstance(rows, list):
        raise ValueError("leaderboard response did not contain a leaderboardRows list")

    parsed: dict[str, LeaderboardWallet] = {}
    rejected = 0
    duplicate_count = 0
    for raw in rows:
        if not isinstance(raw, Mapping):
            rejected += 1
            continue
        wallet = normalise_wallet(raw.get("ethAddress") or raw.get("wallet") or raw.get("address"))
        account_value = _first_decimal((raw.get("accountValue"), raw.get("account_value"), raw.get("accountValueUsd")))
        if wallet is None or account_value is None or account_value < minimum_account_value_usd:
            rejected += 1
            continue
        performance = _performance_window(raw)
        month_roi = _first_decimal((performance.get("roi"), performance.get("return"), performance.get("returnPct")))
        month_pnl = _first_decimal((performance.get("pnl"), performance.get("pnlUsd"), performance.get("closedPnl")))
        month_volume = _first_decimal((performance.get("volume"), performance.get("vlm"), performance.get("turnover")))
        candidate = LeaderboardWallet(
            wallet=wallet,
            current_account_value_usd=account_value,
            month_roi=month_roi,
            month_pnl=month_pnl,
            month_volume=month_volume if month_volume is None or month_volume >= 0 else None,
            display_name=str(raw.get("displayName")) if raw.get("displayName") is not None else None,
        )
        previous = parsed.get(wallet)
        if previous is not None:
            duplicate_count += 1
            # Prefer the larger current value; break otherwise exact ties using
            # all score fields, then display name, so deduplication is stable.
            candidate_key = (
                candidate.current_account_value_usd,
                candidate.month_roi is not None,
                candidate.month_roi if candidate.month_roi is not None else Decimal("-Infinity"),
                candidate.month_pnl is not None,
                candidate.month_pnl if candidate.month_pnl is not None else Decimal("-Infinity"),
                candidate.display_name or "",
            )
            previous_key = (
                previous.current_account_value_usd,
                previous.month_roi is not None,
                previous.month_roi if previous.month_roi is not None else Decimal("-Infinity"),
                previous.month_pnl is not None,
                previous.month_pnl if previous.month_pnl is not None else Decimal("-Infinity"),
                previous.display_name or "",
            )
            if candidate_key <= previous_key:
                continue
        parsed[wallet] = candidate

    wallets = tuple(sorted(parsed.values(), key=lambda item: item.wallet))
    signal_available = {
        "month_roi": any(wallet.month_roi is not None for wallet in wallets),
        "month_pnl": any(wallet.month_pnl is not None for wallet in wallets),
        "turnover": any(wallet.month_volume is not None for wallet in wallets),
    }
    return DiscoveryUniverse(
        wallets=wallets,
        raw_row_count=len(rows),
        rejected_row_count=rejected,
        duplicate_wallet_count=duplicate_count,
        signal_available=signal_available,
    )


def compute_discovery_signals(universe: DiscoveryUniverse, config: DiscoveryConfig = DiscoveryConfig()) -> DiscoverySignals:
    """Compute global leaderboard ranks without truncating the universe."""

    value_extractors = {
        "month_roi": lambda wallet: wallet.month_roi,
        "month_pnl": lambda wallet: wallet.month_pnl,
        "turnover": lambda wallet: None
        if wallet.month_volume is None
        else wallet.month_volume / max(wallet.current_account_value_usd, config.minimum_account_value_usd),
    }
    ranks: dict[str, dict[str, int]] = {}
    values: dict[str, dict[str, Decimal]] = {}
    available: dict[str, bool] = {}
    for name, extract in value_extractors.items():
        scored = [(wallet, extract(wallet)) for wallet in universe.wallets]
        valid = [(wallet, value) for wallet, value in scored if value is not None and value.is_finite()]
        valid.sort(key=lambda item: (-item[1], item[0].wallet))
        ranks[name] = {wallet.wallet: index for index, (wallet, _value) in enumerate(valid, 1)}
        values[name] = {wallet.wallet: value for wallet, value in valid}
        available[name] = bool(valid)
    return DiscoverySignals(ranks=ranks, values=values, available=available)


def select_deterministic_rotating_sample(
    wallets: Iterable[LeaderboardWallet] | Iterable[str],
    count: int,
    discovery_cycle_id: str,
) -> tuple[str, ...]:
    """Choose ``count`` wallets by ``sha256(wallet + cycle_id)`` deterministically."""

    if count < 0:
        raise ValueError("count must be non-negative")
    canonical: set[str] = set()
    for item in wallets:
        address = item.wallet if isinstance(item, LeaderboardWallet) else normalise_wallet(item)
        if address:
            canonical.add(address)
    return tuple(sorted(canonical, key=lambda wallet: (_stable_hash(wallet + discovery_cycle_id), wallet))[:count])


def _wallet_references(references: Iterable[Any] | None, eligible_by_wallet: Mapping[str, LeaderboardWallet], limit: int) -> tuple[str, ...]:
    if references is None or limit == 0:
        return ()
    selected: list[str] = []
    seen: set[str] = set()
    for reference in references:
        raw_wallet = reference.get("wallet") if isinstance(reference, Mapping) else reference
        wallet = normalise_wallet(raw_wallet)
        if wallet and wallet in eligible_by_wallet and wallet not in seen:
            selected.append(wallet)
            seen.add(wallet)
            if len(selected) >= limit:
                break
    return tuple(selected)


def _pool_hash(entries: Iterable[DiscoveryPoolEntry], cycle_id: str) -> str:
    canonical = {
        "discovery_cycle_id": cycle_id,
        "entries": [entry.to_dict() for entry in entries],
    }
    encoded = json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _base_discovery_context(
    universe: DiscoveryUniverse,
    config: DiscoveryConfig,
    prior_verified_wallets: Iterable[Any] | None,
    previous_leaderboard_addresses: Iterable[str] | None,
) -> tuple[DiscoverySignals, dict[str, LeaderboardWallet], dict[str, set[str]]]:
    """Build A--E membership once for both pool construction and shard scope."""

    signals = compute_discovery_signals(universe, config)
    eligible_by_wallet = universe.by_wallet()
    reasons: dict[str, set[str]] = {}

    def add(wallet: str, reason: str) -> None:
        if wallet in eligible_by_wallet:
            reasons.setdefault(wallet, set()).add(reason)

    quotas = {
        "month_roi": config.leaderboard_roi_top_n,
        "month_pnl": config.leaderboard_pnl_top_n,
        "turnover": config.leaderboard_turnover_top_n,
    }
    for signal, quota in quotas.items():
        if not signals.available.get(signal, False):
            continue
        ranked = sorted(signals.ranks[signal].items(), key=lambda item: item[1])
        for wallet, _rank in ranked[:quota]:
            add(wallet, SIGNAL_TO_REASON[signal])

    prior = _wallet_references(prior_verified_wallets, eligible_by_wallet, config.prior_verified_top_n)
    for wallet in prior:
        add(wallet, PRIOR_VERIFIED)

    if previous_leaderboard_addresses is not None:
        previous = {wallet for raw in previous_leaderboard_addresses if (wallet := normalise_wallet(raw))}
        new_wallets = sorted(
            (wallet for wallet in eligible_by_wallet if wallet not in previous),
            key=lambda wallet: (-eligible_by_wallet[wallet].current_account_value_usd, wallet),
        )[: config.new_wallet_top_n]
        for wallet in new_wallets:
            add(wallet, NEW_WALLET)
    return signals, eligible_by_wallet, reasons


def outside_pool_eligible_wallets(
    universe: DiscoveryUniverse,
    *,
    config: DiscoveryConfig = DiscoveryConfig(),
    prior_verified_wallets: Iterable[Any] | None = None,
    previous_leaderboard_addresses: Iterable[str] | None = None,
) -> tuple[str, ...]:
    """Return the eligible universe outside A--E, before F/filler selection.

    This is deliberately separate from the final discovery pool: shard refresh
    must advance through wallets not already covered by the signal, retention,
    or new-wallet buckets.
    """

    _signals, eligible_by_wallet, reasons = _base_discovery_context(
        universe, config, prior_verified_wallets, previous_leaderboard_addresses
    )
    return tuple(sorted(wallet for wallet in eligible_by_wallet if wallet not in reasons))


def build_discovery_pool(
    universe: DiscoveryUniverse,
    *,
    config: DiscoveryConfig = DiscoveryConfig(),
    prior_verified_wallets: Iterable[Any] | None = None,
    previous_leaderboard_addresses: Iterable[str] | None = None,
    discovery_cycle_id: str = "0",
    rotating_wallets: Iterable[str] | None = None,
) -> DiscoveryPoolResult:
    """Fuse ROI/PnL/turnover/prior/new/rotating buckets into a bounded pool."""

    signals, eligible_by_wallet, reasons = _base_discovery_context(
        universe, config, prior_verified_wallets, previous_leaderboard_addresses
    )

    def add(wallet: str, reason: str) -> None:
        if wallet in eligible_by_wallet:
            reasons.setdefault(wallet, set()).add(reason)

    if rotating_wallets is None:
        rotating = select_deterministic_rotating_sample(
            (wallet for wallet in eligible_by_wallet.values() if wallet.wallet not in reasons),
            config.rotating_sample_n,
            discovery_cycle_id,
        )
    else:
        selected: list[str] = []
        selected_set: set[str] = set()
        for raw in rotating_wallets:
            wallet = normalise_wallet(raw)
            if wallet and wallet not in reasons and wallet in eligible_by_wallet and wallet not in selected_set:
                selected.append(wallet)
                selected_set.add(wallet)
                if len(selected) >= config.rotating_sample_n:
                    break
        rotating = tuple(selected)
        # A persistent shard can contain wallets that became A--E members
        # between runs.  Replace them deterministically so F remains a true
        # outside-pool quota whenever enough eligible wallets exist.
        if len(rotating) < config.rotating_sample_n:
            selected_set = set(rotating)
            backfill = select_deterministic_rotating_sample(
                (
                    wallet
                    for wallet in eligible_by_wallet.values()
                    if wallet.wallet not in reasons and wallet.wallet not in selected_set
                ),
                config.rotating_sample_n - len(rotating),
                discovery_cycle_id,
            )
            rotating = rotating + backfill
    for wallet in rotating:
        add(wallet, ROTATING_SAMPLE)

    # If the overlap-heavy union is too small, fill to the target with a
    # deterministic account-value-first ordering, not a concealed ROI cut.
    if len(reasons) < config.discovery_pool_min:
        fillers = sorted(
            (wallet for wallet in eligible_by_wallet if wallet not in reasons),
            key=lambda wallet: (
                -eligible_by_wallet[wallet].current_account_value_usd,
                _stable_hash(wallet + discovery_cycle_id),
                wallet,
            ),
        )
        for wallet in fillers[: max(0, config.discovery_pool_target - len(reasons))]:
            add(wallet, FILLER)

    def fusion_score(wallet: str) -> Decimal:
        return signals.rrf_score(wallet, k=config.rrf_k)

    # Preserve retention/safety buckets when the union would exceed the hard
    # maximum; compact only the ROI/PnL/turnover portion using RRF.
    if len(reasons) > config.discovery_pool_max:
        pinned = [wallet for wallet in reasons if any(reason in reasons[wallet] for reason in PINNED_REASONS)]
        pinned.sort(
            key=lambda wallet: (
                0 if PRIOR_VERIFIED in reasons[wallet] else 1,
                0 if NEW_WALLET in reasons[wallet] else 1,
                0 if ROTATING_SAMPLE in reasons[wallet] else 1,
                wallet,
            )
        )
        if len(pinned) > config.discovery_pool_max:
            # This cannot happen with the documented quotas, but retain the
            # documented priority deterministically instead of growing past max.
            pinned = pinned[: config.discovery_pool_max]
        remaining_slots = config.discovery_pool_max - len(pinned)
        dynamic = [wallet for wallet in reasons if wallet not in set(pinned)]
        dynamic.sort(
            key=lambda wallet: (
                -fusion_score(wallet),
                min((signals.rank(signal, wallet) or 10**12) for signal in SIGNAL_TO_REASON),
                wallet,
            )
        )
        keep = set(pinned + dynamic[:remaining_slots])
        reasons = {wallet: wallet_reasons for wallet, wallet_reasons in reasons.items() if wallet in keep}

    def entry_sort_key(wallet: str) -> tuple[Any, ...]:
        return (
            0 if PRIOR_VERIFIED in reasons[wallet] else 1,
            -fusion_score(wallet),
            -eligible_by_wallet[wallet].current_account_value_usd,
            wallet,
        )

    entries: list[DiscoveryPoolEntry] = []
    for wallet in sorted(reasons, key=entry_sort_key):
        ranks = {signal: rank for signal in SIGNAL_TO_REASON if (rank := signals.rank(signal, wallet)) is not None}
        entries.append(
            DiscoveryPoolEntry(
                wallet=wallet,
                current_account_value_usd=eligible_by_wallet[wallet].current_account_value_usd,
                inclusion_reasons=tuple(
                    reason
                    for reason in (MONTH_ROI, MONTH_PNL, TURNOVER, PRIOR_VERIFIED, NEW_WALLET, ROTATING_SAMPLE, FILLER)
                    if reason in reasons[wallet]
                ),
                signal_ranks=ranks,
                fusion_score=fusion_score(wallet),
            )
        )

    reason_codes: list[str] = []
    if len(entries) < config.discovery_pool_min:
        reason_codes.append("DISCOVERY_POOL_INCOMPLETE")
    if any(not available for available in signals.available.values()):
        reason_codes.append("DISCOVERY_SIGNAL_UNAVAILABLE")
    counts = {reason: sum(1 for entry in entries if reason in entry.inclusion_reasons) for reason in (MONTH_ROI, MONTH_PNL, TURNOVER, PRIOR_VERIFIED, NEW_WALLET, ROTATING_SAMPLE, FILLER)}
    return DiscoveryPoolResult(
        entries=tuple(entries),
        discovery_cycle_id=discovery_cycle_id,
        pool_hash=_pool_hash(entries, discovery_cycle_id),
        complete=len(entries) >= config.discovery_pool_min,
        signal_available=dict(signals.available),
        bucket_actual_counts=counts,
        reason_codes=tuple(reason_codes),
    )


@dataclass
class DiscoveryCycleState:
    """Persistent state used to sweep outside-pool wallets over 7--14 days."""

    discovery_cycle_id: str = "0"
    remaining_shards: list[list[str]] = field(default_factory=list)
    last_scored_at_by_wallet: dict[str, int] = field(default_factory=dict)
    outside_pool_sample_history: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any] | None) -> "DiscoveryCycleState":
        if not isinstance(payload, Mapping):
            return cls()
        shards = payload.get("remaining_shards")
        history = payload.get("outside_pool_sample_history")
        last_scored = payload.get("last_scored_at_by_wallet")
        return cls(
            discovery_cycle_id=str(payload.get("discovery_cycle_id", "0")),
            remaining_shards=[list(map(str, shard)) for shard in shards if isinstance(shard, list)] if isinstance(shards, list) else [],
            last_scored_at_by_wallet={str(wallet): int(value) for wallet, value in (last_scored or {}).items()} if isinstance(last_scored, Mapping) else {},
            outside_pool_sample_history=[dict(item) for item in history if isinstance(item, Mapping)] if isinstance(history, list) else [],
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "discovery_cycle_id": self.discovery_cycle_id,
            "remaining_shards": self.remaining_shards,
            "last_scored_at_by_wallet": self.last_scored_at_by_wallet,
            "outside_pool_sample_history": self.outside_pool_sample_history,
        }


def deterministic_refresh_shards(wallets: Iterable[str], discovery_cycle_id: str, *, shard_size: int = 1000) -> list[list[str]]:
    if shard_size < 1:
        raise ValueError("shard_size must be positive")
    canonical = sorted(
        {wallet for raw in wallets if (wallet := normalise_wallet(raw))},
        key=lambda wallet: (_stable_hash(wallet + discovery_cycle_id), wallet),
    )
    return [canonical[index : index + shard_size] for index in range(0, len(canonical), shard_size)]


def _next_cycle_id(cycle_id: str) -> str:
    try:
        return str(int(cycle_id) + 1)
    except ValueError:
        return _stable_hash(cycle_id)[:16]


def claim_next_refresh_shard(
    state: DiscoveryCycleState,
    eligible_wallets: Iterable[str],
    *,
    shard_size: int = 1000,
    scored_at_ms: int | None = None,
) -> tuple[DiscoveryCycleState, tuple[str, ...]]:
    """Claim one deterministic shard and return updated persistent state."""

    eligible = {wallet for raw in eligible_wallets if (wallet := normalise_wallet(raw))}
    remaining = [[wallet for wallet in shard if wallet in eligible] for shard in state.remaining_shards]
    remaining = [shard for shard in remaining if shard]
    cycle_id = state.discovery_cycle_id
    if not remaining:
        # An empty initial state starts cycle 0.  An empty state after a claim
        # starts the next cycle, yielding a different deterministic rotation.
        if state.remaining_shards or state.last_scored_at_by_wallet:
            cycle_id = _next_cycle_id(cycle_id)
        remaining = deterministic_refresh_shards(eligible, cycle_id, shard_size=shard_size)
    claimed = tuple(remaining.pop(0)) if remaining else ()
    scored = dict(state.last_scored_at_by_wallet)
    if scored_at_ms is not None:
        scored.update({wallet: int(scored_at_ms) for wallet in claimed})
    return (
        DiscoveryCycleState(
            discovery_cycle_id=cycle_id,
            remaining_shards=remaining,
            last_scored_at_by_wallet=scored,
            outside_pool_sample_history=list(state.outside_pool_sample_history),
        ),
        claimed,
    )


def record_outside_pool_sample(
    state: DiscoveryCycleState,
    wallets: Iterable[str],
    *,
    as_of_ms: int,
    threshold_breach_wallets: Iterable[str] = (),
) -> DiscoveryCycleState:
    selected = sorted({wallet for raw in wallets if (wallet := normalise_wallet(raw))})
    breaches = sorted({wallet for raw in threshold_breach_wallets if (wallet := normalise_wallet(raw))})
    history = list(state.outside_pool_sample_history)
    history.append({"as_of_ms": int(as_of_ms), "wallets": selected, "threshold_breach_wallets": breaches})
    return DiscoveryCycleState(
        discovery_cycle_id=state.discovery_cycle_id,
        remaining_shards=[list(shard) for shard in state.remaining_shards],
        last_scored_at_by_wallet=dict(state.last_scored_at_by_wallet),
        outside_pool_sample_history=history,
    )


def detect_outside_pool_threshold_breach(
    outside_scores: Mapping[str, Decimal | str | float | int | None],
    candidate_cutoff: Decimal | str | float | int | None,
) -> tuple[str, ...]:
    """Return outside wallets whose provisional/verified score exceeds cutoff."""

    cutoff = _decimal_or_none(candidate_cutoff)
    if cutoff is None:
        return ()
    breaches: list[str] = []
    for raw_wallet, raw_score in outside_scores.items():
        wallet = normalise_wallet(raw_wallet)
        score = _decimal_or_none(raw_score)
        if wallet and score is not None and score > cutoff:
            breaches.append(wallet)
    return tuple(sorted(set(breaches)))


# Names matching the pipeline vocabulary in the final specification.
parse_leaderboard_universe = load_leaderboard_universe
select_rotating_sample = select_deterministic_rotating_sample
build_refresh_shards = deterministic_refresh_shards
