"""Deterministic ledger-verification, candidate-freeze, and finalist logic.

The functions accept plain mapping rows so the discovery and cash-flow stages
can evolve independently.  They never use leaderboard ROI, absolute PnL, or
fill profitability as a candidate/finalist ordering signal.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, is_dataclass
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from typing import Any, Callable, Iterable, Mapping, Sequence


METRIC_NAME = "perp_cashflow_neutral_twr_30d"
QUALITY_VERIFIED = "VERIFIED"
REASON_BOUNDARY_BREACH = "BOUNDARY_BREACH"
REASON_BOUNDARY_UNSTABLE = "BOUNDARY_UNSTABLE"
REASON_INSUFFICIENT_VERIFIED = "INSUFFICIENT_VERIFIED_CANDIDATES"
REASON_OUTSIDE_POOL_BREACH = "OUTSIDE_POOL_THRESHOLD_BREACH"
REASON_NO_OBSERVED_RAW_FILLS = "NO_OBSERVED_RAW_FILLS"
REASON_RAW_FILL_COUNT_MISSING = "RAW_FILL_COUNT_MISSING"
REASON_RAW_FILL_COVERAGE_MISSING = "RAW_FILL_COVERAGE_MISSING"
REASON_RAW_FILL_AGGREGATION_UNVERIFIED = "RAW_FILL_AGGREGATION_UNVERIFIED"
REASON_INSUFFICIENT_FINALISTS = "INSUFFICIENT_FINALISTS"


def _row(value: Mapping[str, Any] | Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if is_dataclass(value):
        return asdict(value)
    if hasattr(value, "__dict__"):
        return dict(vars(value))
    raise TypeError(f"candidate row must be a mapping or dataclass, got {type(value).__name__}")


def _wallet(row: Mapping[str, Any]) -> str:
    wallet = row.get("wallet", row.get("ethAddress", row.get("address")))
    if not isinstance(wallet, str) or not wallet.strip():
        raise ValueError("candidate row is missing a wallet address")
    return wallet.strip()


def _decimal(value: Any, field: str) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"invalid {field}: {value!r}") from exc


def _metric(row: Mapping[str, Any], *, provisional: bool = False) -> Decimal:
    field = "provisional_perp_twr_30d" if provisional else METRIC_NAME
    return _decimal(row[field], field)


def _quality_rank(row: Mapping[str, Any]) -> int:
    supplied = row.get("data_quality_rank")
    if supplied is not None:
        try:
            return int(supplied)
        except (TypeError, ValueError):
            return 0
    return {"VERIFIED": 3, "APPROXIMATE": 2, "PROVISIONAL": 1}.get(str(row.get("quality", "")), 0)


def _observation_count(row: Mapping[str, Any]) -> int:
    try:
        return int(row.get("portfolio_observation_count", 0))
    except (TypeError, ValueError):
        return 0


def _account_value(row: Mapping[str, Any]) -> Decimal:
    try:
        return _decimal(row.get("current_account_value_usd", row.get("account_value", "0")), "account value")
    except ValueError:
        return Decimal("0")


def _canonical_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return format(value, "f")
    if is_dataclass(value):
        return {key: _canonical_value(item) for key, item in asdict(value).items()}
    if isinstance(value, Mapping):
        return {str(key): _canonical_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_canonical_value(item) for item in value]
    return value


def _pool_hash(candidates: Sequence[Mapping[str, Any]]) -> str:
    payload = [
        {
            "candidate_rank": int(row["candidate_rank"]),
            "wallet": _wallet(row).lower(),
            METRIC_NAME: format(_metric(row), "f"),
            "quality": str(row.get("quality", "")),
            "data_quality_rank": _quality_rank(row),
            "portfolio_observation_count": _observation_count(row),
            "current_account_value_usd": format(_account_value(row), "f"),
        }
        for row in candidates
    ]
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return sha256(encoded).hexdigest()


def rank_provisional_wallets(rows: Iterable[Mapping[str, Any] | Any]) -> tuple[dict[str, Any], ...]:
    """Order provisional wallets by provisional TWR, then deterministic ties."""

    valid: list[dict[str, Any]] = []
    for raw in rows:
        row = _row(raw)
        try:
            wallet = _wallet(row)
            value = _metric(row, provisional=True)
        except (KeyError, ValueError):
            continue
        row["wallet"] = wallet
        row["provisional_perp_twr_30d"] = value
        valid.append(row)
    valid.sort(key=lambda item: (-_metric(item, provisional=True), _wallet(item).lower()))
    for rank, row in enumerate(valid, 1):
        row["provisional_rank"] = rank
    return tuple(valid)


def select_initial_ledger_verification_pool(
    provisional_rows: Iterable[Mapping[str, Any] | Any], initial_count: int = 2500
) -> tuple[dict[str, Any], ...]:
    if initial_count <= 0:
        raise ValueError("initial_count must be positive")
    return rank_provisional_wallets(provisional_rows)[:initial_count]


@dataclass(frozen=True)
class CandidatePoolFreeze:
    candidates: tuple[dict[str, Any], ...]
    candidate_pool_hash: str
    candidate_pool_complete: bool
    candidate_count_requested: int
    source_run_id: str | None
    frozen_at: str | None
    reason_code: str | None = None

    @property
    def candidate_count_actual(self) -> int:
        return len(self.candidates)

    def as_dict(self) -> dict[str, Any]:
        return {
            "candidates": [_canonical_value(item) for item in self.candidates],
            "candidate_pool_hash": self.candidate_pool_hash,
            "candidate_pool_complete": self.candidate_pool_complete,
            "candidate_count_requested": self.candidate_count_requested,
            "candidate_count_actual": self.candidate_count_actual,
            "candidate_pool_source_run_id": self.source_run_id,
            "candidate_pool_frozen_at": self.frozen_at,
            "reason_code": self.reason_code,
        }


def freeze_candidate_top2000(
    verified_rows: Iterable[Mapping[str, Any] | Any],
    *,
    candidate_count: int = 2000,
    source_run_id: str | None = None,
    frozen_at: str | None = None,
) -> CandidatePoolFreeze:
    """Freeze the deterministic top-N of *only* VERIFIED wallet scores."""

    if candidate_count <= 0:
        raise ValueError("candidate_count must be positive")
    candidates: list[dict[str, Any]] = []
    seen_wallets: set[str] = set()
    for raw in verified_rows:
        row = _row(raw)
        if str(row.get("quality", "")) != QUALITY_VERIFIED:
            continue
        try:
            wallet = _wallet(row)
            twr = _metric(row)
        except (KeyError, ValueError):
            continue
        wallet_key = wallet.lower()
        if wallet_key in seen_wallets:
            # Duplicate wallet results cannot produce a deterministic candidate
            # pool, so retain the first raw verified record only.
            continue
        seen_wallets.add(wallet_key)
        row["wallet"] = wallet
        row[METRIC_NAME] = twr
        candidates.append(row)

    candidates.sort(
        key=lambda item: (
            -_metric(item),
            -_quality_rank(item),
            -_observation_count(item),
            -_account_value(item),
            _wallet(item).lower(),
        )
    )
    frozen = candidates[:candidate_count]
    for rank, row in enumerate(frozen, 1):
        row["candidate_rank"] = rank
        row["verified_twr"] = row[METRIC_NAME]
    complete = len(frozen) == candidate_count
    return CandidatePoolFreeze(
        candidates=tuple(frozen),
        candidate_pool_hash=_pool_hash(frozen),
        candidate_pool_complete=complete,
        candidate_count_requested=candidate_count,
        source_run_id=source_run_id,
        frozen_at=frozen_at,
        reason_code=None if complete else REASON_INSUFFICIENT_VERIFIED,
    )


@dataclass(frozen=True)
class CandidateAction:
    kind: str
    wallets: tuple[str, ...]
    reason_code: str | None = None


class CandidateVerificationStateMachine:
    """Drive 2,500 initial ledger checks, 500 expansions, and boundary probes.

    The caller fetches ledger data for wallets returned by :meth:`next_action`
    and returns normalized rows through :meth:`record_verifications`.  A row
    whose quality is not ``VERIFIED`` still resolves its pending request and is
    deliberately excluded by :func:`freeze_candidate_top2000`.
    """

    def __init__(
        self,
        provisional_rows: Iterable[Mapping[str, Any] | Any],
        *,
        candidate_count: int = 2000,
        initial_count: int = 2500,
        expand_step: int = 500,
        boundary_probe_count: int = 100,
        run_seed: str = "",
        high_unverifiable_rate: Decimal | str | float = Decimal("0.20"),
        source_run_id: str | None = None,
        frozen_at: str | None = None,
    ) -> None:
        if min(candidate_count, initial_count, expand_step, boundary_probe_count) <= 0:
            raise ValueError("candidate and verification counts must be positive")
        self.provisional_rows = rank_provisional_wallets(provisional_rows)
        self.candidate_count = candidate_count
        self.initial_count = initial_count
        self.expand_step = expand_step
        self.boundary_probe_count = boundary_probe_count
        self.run_seed = str(run_seed)
        self.high_unverifiable_rate = _decimal(high_unverifiable_rate, "high_unverifiable_rate")
        self.source_run_id = source_run_id
        self.frozen_at = frozen_at
        self.cursor = 0
        self.stage = "NEW"
        self.pending: set[str] = set()
        self.results: dict[str, dict[str, Any]] = {}
        self._last_probe: tuple[str, ...] = ()
        self._probe_cutoff: Decimal | None = None
        self.boundary_breach_count = 0
        self.cutoff_unstable = False
        self.reason_code: str | None = None

    @property
    def verification_count(self) -> int:
        return len(self.results)

    @property
    def verified_count(self) -> int:
        return sum(1 for row in self.results.values() if str(row.get("quality", "")) == QUALITY_VERIFIED)

    def freeze(self) -> CandidatePoolFreeze:
        return freeze_candidate_top2000(
            self.results.values(),
            candidate_count=self.candidate_count,
            source_run_id=self.source_run_id,
            frozen_at=self.frozen_at,
        )

    def mark_cutoff_unstable(self) -> None:
        """Allow a caller with extra diagnostics to require another expansion."""

        self.cutoff_unstable = True

    def record_verifications(self, rows: Iterable[Mapping[str, Any] | Any]) -> None:
        """Record ledger verification outputs for wallets previously requested."""

        for raw in rows:
            row = _row(raw)
            wallet = _wallet(row)
            key = wallet.lower()
            if key not in self.pending:
                raise ValueError(f"verification result was not requested for {wallet}")
            row["wallet"] = wallet
            self.results[key] = row
            self.pending.remove(key)

    def _issue_verification(self, count: int, stage: str, reason_code: str | None) -> CandidateAction:
        start = self.cursor
        end = min(len(self.provisional_rows), start + count)
        self.cursor = end
        self.stage = stage
        wallets: list[str] = []
        for row in self.provisional_rows[start:end]:
            wallet = _wallet(row)
            key = wallet.lower()
            if key not in self.results:
                self.pending.add(key)
                wallets.append(wallet)
        return CandidateAction("VERIFY", tuple(wallets), reason_code)

    def _probe_wallets(self) -> tuple[str, ...]:
        # Probe the next two expansion blocks.  Sorting by sha256 gives a
        # deterministic sample without leaking Python hash randomization.
        upper = min(len(self.provisional_rows), self.cursor + (self.expand_step * 2))
        rows = list(self.provisional_rows[self.cursor:upper])
        rows.sort(key=lambda row: sha256(f"{self.run_seed}:{_wallet(row).lower()}".encode("utf-8")).hexdigest())
        return tuple(_wallet(row) for row in rows[: self.boundary_probe_count])

    def _unverifiable_rate(self) -> Decimal:
        if not self.results:
            return Decimal("0")
        return Decimal(len(self.results) - self.verified_count) / Decimal(len(self.results))

    def _probe_breaches_cutoff(self) -> bool:
        if self._probe_cutoff is None:
            return False
        for wallet in self._last_probe:
            row = self.results.get(wallet.lower())
            if row is None or str(row.get("quality", "")) != QUALITY_VERIFIED:
                continue
            try:
                # Compare with the cutoff that existed *before* this probe.
                # Otherwise an exceptionally strong probe wallet can displace
                # the boundary and hide its own breach.
                if _metric(row) > self._probe_cutoff:
                    return True
            except (KeyError, ValueError):
                continue
        return False

    def _complete_or_block(self) -> CandidateAction:
        freeze = self.freeze()
        if not freeze.candidate_pool_complete:
            self.stage = "BLOCKED"
            self.reason_code = REASON_INSUFFICIENT_VERIFIED
            return CandidateAction("BLOCKED", (), self.reason_code)
        self.stage = "COMPLETE"
        self.reason_code = None
        return CandidateAction("COMPLETE", (), None)

    def next_action(self) -> CandidateAction:
        """Return the next bounded API-work batch or the terminal state."""

        if self.pending:
            return CandidateAction("WAITING", tuple(sorted(self.pending)), None)
        if self.stage == "BLOCKED":
            return CandidateAction("BLOCKED", (), self.reason_code)
        if self.stage == "COMPLETE":
            return CandidateAction("COMPLETE", (), None)
        if self.stage == "NEW":
            action = self._issue_verification(self.initial_count, "INITIAL", None)
            if action.wallets:
                return action
            return self._complete_or_block()

        if self.stage == "PROBING":
            if self._probe_breaches_cutoff():
                self.boundary_breach_count += 1
                self.cutoff_unstable = False
                if self.cursor >= len(self.provisional_rows):
                    self.stage = "BLOCKED"
                    self.reason_code = REASON_BOUNDARY_UNSTABLE
                    return CandidateAction("BLOCKED", (), self.reason_code)
                action = self._issue_verification(self.expand_step, "EXPANDING", REASON_BOUNDARY_BREACH)
                if action.wallets:
                    return action
                return self.next_action()
            return self._complete_or_block()

        # Completed INITIAL/EXPANDING verification: expand until the candidate
        # pool is numerically possible, or because the result quality signals
        # an unstable cutoff.  Never fabricate candidate entries from an
        # UNVERIFIABLE ledger outcome.
        freeze = self.freeze()
        must_expand = (
            not freeze.candidate_pool_complete
            or self.cutoff_unstable
            or self._unverifiable_rate() >= self.high_unverifiable_rate
        )
        if must_expand:
            self.cutoff_unstable = False
            if self.cursor >= len(self.provisional_rows):
                return self._complete_or_block()
            action = self._issue_verification(self.expand_step, "EXPANDING", REASON_INSUFFICIENT_VERIFIED)
            if action.wallets:
                return action
            return self.next_action()

        if self.cursor >= len(self.provisional_rows):
            return self._complete_or_block()
        self._last_probe = self._probe_wallets()
        self._probe_cutoff = _metric(freeze.candidates[-1])
        self.stage = "PROBING"
        for wallet in self._last_probe:
            key = wallet.lower()
            if key not in self.results:
                self.pending.add(key)
        if self.pending:
            return CandidateAction("PROBE", tuple(wallet for wallet in self._last_probe if wallet.lower() in self.pending), None)
        return self.next_action()


@dataclass(frozen=True)
class OutsidePoolBreachResult:
    breached_wallets: tuple[str, ...]
    cutoff: Decimal | None
    reason_code: str | None

    @property
    def blocks_canonical_update(self) -> bool:
        return bool(self.breached_wallets)


def detect_outside_pool_threshold_breach(
    outside_pool_rows: Iterable[Mapping[str, Any] | Any], candidate_freeze: CandidatePoolFreeze
) -> OutsidePoolBreachResult:
    """Detect a sampled/shard wallet that exceeds the current exact cutoff."""

    if not candidate_freeze.candidates:
        return OutsidePoolBreachResult((), None, None)
    cutoff = _metric(candidate_freeze.candidates[-1])
    breaches: list[str] = []
    for raw in outside_pool_rows:
        row = _row(raw)
        try:
            score = _metric(row) if str(row.get("quality", "")) == QUALITY_VERIFIED else _metric(row, provisional=True)
            wallet = _wallet(row)
        except (KeyError, ValueError):
            continue
        if score > cutoff:
            breaches.append(wallet)
    return OutsidePoolBreachResult(
        tuple(sorted(set(breaches), key=str.lower)), cutoff,
        REASON_OUTSIDE_POOL_BREACH if breaches else None,
    )


@dataclass(frozen=True)
class FinalistValidationResult:
    finalists: tuple[dict[str, Any], ...]
    scanned_candidates: tuple[dict[str, Any], ...]
    fills_scanned_candidate_count: int
    fill_validation_mode: str
    complete: bool
    reason_code: str | None = None


def _validation_fields(
    value: Any,
) -> tuple[bool, int | None, int | None, bool | None, bool | None, str | None, str | None]:
    if isinstance(value, Mapping):
        valid = bool(value.get("valid", value.get("coverage_complete", True)))
        episodes = value.get("completed_episodes", value.get("episode_count"))
        raw_count = value.get("raw_fill_count")
        coverage_complete = value.get("raw_fill_coverage_complete", value.get("coverage_complete"))
        aggregate_by_time = value.get("raw_fill_aggregate_by_time")
        return (
            valid,
            int(episodes) if episodes is not None else None,
            int(raw_count) if raw_count is not None else None,
            coverage_complete if isinstance(coverage_complete, bool) else None,
            aggregate_by_time if isinstance(aggregate_by_time, bool) else None,
            value.get("reason_code"),
            value.get("reason_message"),
        )
    valid = bool(getattr(value, "valid", True))
    episodes = getattr(value, "completed_episodes", getattr(value, "episode_count", None))
    raw_count = getattr(value, "raw_fill_count", None)
    coverage_complete = getattr(value, "raw_fill_coverage_complete", getattr(value, "coverage_complete", None))
    aggregate_by_time = getattr(value, "raw_fill_aggregate_by_time", None)
    return (
        valid,
        int(episodes) if episodes is not None else None,
        int(raw_count) if raw_count is not None else None,
        coverage_complete if isinstance(coverage_complete, bool) else None,
        aggregate_by_time if isinstance(aggregate_by_time, bool) else None,
        getattr(value, "reason_code", None),
        getattr(value, "reason_message", None),
    )


def validate_candidates_until_finalists(
    candidates: Iterable[Mapping[str, Any] | Any],
    fill_validator: Callable[[Mapping[str, Any]], Any],
    *,
    target_count: int = 10,
    minimum_raw_fills: int = 1,
    minimum_completed_episodes: int | None = None,
    fill_validation_mode: str = "UNTIL_10",
) -> FinalistValidationResult:
    """Choose the first rank-ordered candidates with observed raw-fill activity.

    ``minimum_completed_episodes`` is retained as an ignored compatibility
    argument.  Episode reconstruction is diagnostic-only.  A validator must
    fail closed when incomplete coverage prevents a zero-activity conclusion,
    while any observed ``aggregateByTime:false`` raw fill is positive proof.
    """

    mode = fill_validation_mode.upper()
    if mode not in {"UNTIL_10", "FULL_2000"}:
        raise ValueError("fill_validation_mode must be UNTIL_10 or FULL_2000")
    if target_count <= 0 or minimum_raw_fills <= 0:
        raise ValueError("target_count and minimum_raw_fills must be positive")
    ordered = [_row(row) for row in candidates]
    ordered.sort(key=lambda row: (int(row.get("candidate_rank", 2**31 - 1)), _wallet(row).lower()))
    finalists: list[dict[str, Any]] = []
    scanned: list[dict[str, Any]] = []
    for candidate in ordered:
        if mode == "UNTIL_10" and len(finalists) >= target_count:
            break
        row = dict(candidate)
        outcome: Any = None
        try:
            outcome = fill_validator(row)
            valid, episodes, raw_count, coverage_complete, aggregate_by_time, reason_code, reason_message = _validation_fields(outcome)
        except Exception as exc:
            valid, episodes, raw_count, coverage_complete, aggregate_by_time = False, None, None, None, None
            reason_code, reason_message = "FILL_VALIDATION_ERROR", str(exc)
        if episodes is not None:
            row["completed_episodes"] = episodes
        if raw_count is not None:
            row["raw_fill_count"] = raw_count
        if coverage_complete is not None:
            row["raw_fill_coverage_complete"] = coverage_complete
        if aggregate_by_time is not None:
            row["raw_fill_aggregate_by_time"] = aggregate_by_time
        if isinstance(outcome, Mapping):
            for key in (
                "raw_fill_coverage_complete",
                "raw_fill_aggregate_by_time",
                "raw_fill_activity_observed",
                "observed_raw_fill_count",
                "raw_fill_count_is_lower_bound",
                "episode_diagnostic_valid",
                "episode_diagnostic_reason_code",
                "episode_diagnostic_reason_message",
            ):
                if key in outcome:
                    row[key] = outcome[key]
        if not valid:
            row.update(status="UNVERIFIABLE", reason_code=reason_code or "FILL_PAGINATION_INCOMPLETE", reason_message=reason_message)
        elif raw_count is None:
            row.update(
                status="UNVERIFIABLE",
                reason_code=REASON_RAW_FILL_COUNT_MISSING,
                reason_message="complete raw-fill coverage did not include an observed fill count",
            )
        elif coverage_complete is None:
            row.update(
                status="UNVERIFIABLE",
                reason_code=REASON_RAW_FILL_COVERAGE_MISSING,
                reason_message="raw-fill coverage diagnostic is missing",
            )
        elif aggregate_by_time is not False:
            row.update(
                status="UNVERIFIABLE",
                reason_code=REASON_RAW_FILL_AGGREGATION_UNVERIFIED,
                reason_message="raw-fill evidence must be collected with aggregateByTime:false",
            )
        elif raw_count < minimum_raw_fills:
            row.update(
                status="DROP",
                reason_code=REASON_NO_OBSERVED_RAW_FILLS,
                reason_message=f"fewer than {minimum_raw_fills} observed raw fills",
            )
        elif len(finalists) < target_count:
            row.update(status="ACTIVE", reason_code=None, reason_message=None)
            finalists.append(row)
        else:
            row.update(status="PASS", reason_code=None, reason_message=None)
        scanned.append(row)

    complete = len(finalists) == target_count
    return FinalistValidationResult(
        finalists=tuple(finalists),
        scanned_candidates=tuple(scanned),
        fills_scanned_candidate_count=len(scanned),
        fill_validation_mode=mode,
        complete=complete,
        reason_code=None if complete else REASON_INSUFFICIENT_FINALISTS,
    )


__all__ = [
    "CandidateAction",
    "CandidatePoolFreeze",
    "CandidateVerificationStateMachine",
    "FinalistValidationResult",
    "METRIC_NAME",
    "OutsidePoolBreachResult",
    "QUALITY_VERIFIED",
    "detect_outside_pool_threshold_breach",
    "freeze_candidate_top2000",
    "rank_provisional_wallets",
    "select_initial_ledger_verification_pool",
    "validate_candidates_until_finalists",
]
