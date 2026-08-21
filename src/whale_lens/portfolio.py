"""Strict ``portfolio.perpMonth`` extraction and timestamp alignment."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from decimal import Decimal
from typing import Any

from .models import (
    PerpPortfolioSample,
    PortfolioNormalizationResult,
    ReasonCode,
    decimal_value,
)


PORTFOLIO_ALIGNMENT_TOLERANCE_MS = 2_000


def _as_period_mapping(payload: Any) -> Mapping[str, Any] | None:
    """Accept the documented pair-list shape without accepting a ``month`` fallback."""

    if isinstance(payload, Mapping):
        period = payload.get("perpMonth")
        return period if isinstance(period, Mapping) else None
    if isinstance(payload, Sequence) and not isinstance(payload, (str, bytes, bytearray)):
        for item in payload:
            if not isinstance(item, Sequence) or isinstance(item, (str, bytes, bytearray)) or len(item) != 2:
                continue
            if item[0] == "perpMonth" and isinstance(item[1], Mapping):
                return item[1]
    return None


def extract_perp_month(portfolio_payload: Any) -> Mapping[str, Any] | None:
    """Return only the native ``perpMonth`` period; never substitute ``month``."""

    return _as_period_mapping(portfolio_payload)


def _history_item(item: Any, *, label: str) -> tuple[int, Decimal]:
    if isinstance(item, Mapping):
        time_value = item.get("time", item.get("timeMs", item.get("timestamp")))
        value = item.get("value", item.get("accountValue", item.get("pnl")))
    elif isinstance(item, Sequence) and not isinstance(item, (str, bytes, bytearray)) and len(item) >= 2:
        time_value, value = item[0], item[1]
    else:
        raise ValueError(f"{label} observation must be [time_ms, value]")
    if isinstance(time_value, bool):
        raise ValueError(f"{label} observation time is invalid")
    try:
        time_ms = int(time_value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} observation time is invalid") from exc
    if time_ms < 0:
        raise ValueError(f"{label} observation time cannot be negative")
    return time_ms, decimal_value(value, field_name=f"{label} observation value")


def _parse_history(history: Any, *, label: str) -> tuple[tuple[int, Decimal], ...]:
    if not isinstance(history, Sequence) or isinstance(history, (str, bytes, bytearray)):
        raise ValueError(f"{label} history is not a list")
    values: dict[int, Decimal] = {}
    for item in history:
        time_ms, value = _history_item(item, label=label)
        prior = values.get(time_ms)
        if prior is not None and prior != value:
            raise ValueError(f"{label} history has conflicting duplicate timestamp {time_ms}")
        values[time_ms] = value
    return tuple(sorted(values.items()))


def _align_histories(
    accounts: Iterable[tuple[int, Decimal]],
    pnls: Iterable[tuple[int, Decimal]],
    *,
    tolerance_ms: int,
) -> tuple[PerpPortfolioSample, ...]:
    """Exact-first, one-to-one alignment without interpolation.

    All exact pairs are linked before any near pairs.  The remaining candidates
    are processed by distance and timestamp, which is deterministic and never
    allows one PnL observation to be reused by two account observations.
    """

    if tolerance_ms < 0:
        raise ValueError("alignment tolerance cannot be negative")
    account_values = tuple(accounts)
    pnl_values = tuple(pnls)
    pnl_by_time = {time_ms: value for time_ms, value in pnl_values}
    used_pnl_times: set[int] = set()
    aligned: list[PerpPortfolioSample] = []
    unmatched_accounts: list[tuple[int, Decimal]] = []

    for account_time, account_value in account_values:
        pnl_value = pnl_by_time.get(account_time)
        if pnl_value is None:
            unmatched_accounts.append((account_time, account_value))
            continue
        used_pnl_times.add(account_time)
        aligned.append(
            PerpPortfolioSample(
                time_ms=account_time,
                account_value=account_value,
                cumulative_pnl=pnl_value,
                account_source_time_ms=account_time,
                pnl_source_time_ms=account_time,
            )
        )

    candidates: list[tuple[int, int, int, Decimal, Decimal]] = []
    for account_time, account_value in unmatched_accounts:
        for pnl_time, pnl_value in pnl_values:
            if pnl_time in used_pnl_times:
                continue
            distance = abs(account_time - pnl_time)
            if distance <= tolerance_ms:
                candidates.append((distance, account_time, pnl_time, account_value, pnl_value))
    used_account_times: set[int] = set()
    for distance, account_time, pnl_time, account_value, pnl_value in sorted(candidates):
        if account_time in used_account_times or pnl_time in used_pnl_times:
            continue
        used_account_times.add(account_time)
        used_pnl_times.add(pnl_time)
        aligned.append(
            PerpPortfolioSample(
                time_ms=account_time,
                account_value=account_value,
                cumulative_pnl=pnl_value,
                account_source_time_ms=account_time,
                pnl_source_time_ms=pnl_time,
            )
        )
    return tuple(sorted(aligned, key=lambda sample: sample.time_ms))


def align_perp_portfolio_samples(
    account_value_history: Any,
    pnl_history: Any,
    *,
    window_start_ms: int | None = None,
    window_end_ms: int | None = None,
    tolerance_ms: int = PORTFOLIO_ALIGNMENT_TOLERANCE_MS,
    require_window_coverage: bool = True,
    window_coverage_tolerance_ms: int | None = None,
    allow_single_sided_boundary_tolerance: bool = True,
) -> PortfolioNormalizationResult:
    """Parse and align histories into samples suitable for TWR.

    When a fixed window is supplied, the first and last *aligned* observations
    must reach both window boundaries within the alignment tolerance.  This is
    intentionally stricter than extrapolating an account value across a gap.
    """

    try:
        accounts = _parse_history(account_value_history, label="accountValue")
        pnls = _parse_history(pnl_history, label="pnl")
    except ValueError as exc:
        return PortfolioNormalizationResult(
            samples=(),
            reason_code=ReasonCode.PORTFOLIO_ALIGNMENT_FAILED,
            reason_message=str(exc),
        )
    if not accounts or not pnls:
        return PortfolioNormalizationResult(
            samples=(),
            reason_code=ReasonCode.INSUFFICIENT_PORTFOLIO_SAMPLES,
            reason_message="perpMonth requires non-empty accountValueHistory and pnlHistory",
            account_observation_count=len(accounts),
            pnl_observation_count=len(pnls),
        )
    try:
        samples = _align_histories(accounts, pnls, tolerance_ms=tolerance_ms)
    except ValueError as exc:
        return PortfolioNormalizationResult(
            samples=(),
            reason_code=ReasonCode.PORTFOLIO_ALIGNMENT_FAILED,
            reason_message=str(exc),
            account_observation_count=len(accounts),
            pnl_observation_count=len(pnls),
        )
    if not samples:
        return PortfolioNormalizationResult(
            samples=(),
            reason_code=ReasonCode.PORTFOLIO_ALIGNMENT_FAILED,
            reason_message="accountValueHistory and pnlHistory have no pairs within alignment tolerance",
            account_observation_count=len(accounts),
            pnl_observation_count=len(pnls),
        )
    if window_start_ms is not None or window_end_ms is not None:
        if window_start_ms is None or window_end_ms is None:
            return PortfolioNormalizationResult(
                samples=(),
                reason_code=ReasonCode.WINDOW_COVERAGE_INCOMPLETE,
                reason_message="window start and end must be provided together",
                account_observation_count=len(accounts),
                pnl_observation_count=len(pnls),
            )
        if int(window_end_ms) < int(window_start_ms):
            return PortfolioNormalizationResult(
                samples=(),
                reason_code=ReasonCode.WINDOW_COVERAGE_INCOMPLETE,
                reason_message="window end precedes window start",
                account_observation_count=len(accounts),
                pnl_observation_count=len(pnls),
            )
        coverage_tolerance = tolerance_ms if window_coverage_tolerance_ms is None else int(window_coverage_tolerance_ms)
        if coverage_tolerance < 0:
            return PortfolioNormalizationResult(
                samples=(),
                reason_code=ReasonCode.WINDOW_COVERAGE_INCOMPLETE,
                reason_message="window coverage tolerance cannot be negative",
                account_observation_count=len(accounts),
                pnl_observation_count=len(pnls),
            )
        all_samples = samples

        def boundary_sample(boundary: int) -> PerpPortfolioSample | None:
            exact = next((sample for sample in all_samples if sample.time_ms == boundary), None)
            if exact is not None:
                return exact
            left = next((sample for sample in reversed(all_samples) if sample.time_ms < boundary), None)
            right = next((sample for sample in all_samples if sample.time_ms > boundary), None)
            source: PerpPortfolioSample | None = None
            # Constant values on both sides prove that carrying the boundary
            # does not invent return or cash flow inside the unsampled gap.
            if left is not None and right is not None and (
                left.account_value == right.account_value and left.cumulative_pnl == right.cumulative_pnl
            ):
                source = left
            elif (
                allow_single_sided_boundary_tolerance
                and left is None
                and right is not None
                and right.time_ms - boundary <= coverage_tolerance
            ):
                source = right
            elif (
                allow_single_sided_boundary_tolerance
                and right is None
                and left is not None
                and boundary - left.time_ms <= coverage_tolerance
            ):
                source = left
            if source is None:
                return None
            return PerpPortfolioSample(
                time_ms=boundary,
                account_value=source.account_value,
                cumulative_pnl=source.cumulative_pnl,
                account_source_time_ms=source.account_source_time_ms,
                pnl_source_time_ms=source.pnl_source_time_ms,
            )

        start_boundary = boundary_sample(int(window_start_ms))
        end_boundary = boundary_sample(int(window_end_ms))
        samples = tuple(
            sample for sample in all_samples if int(window_start_ms) < sample.time_ms < int(window_end_ms)
        )
        if start_boundary is not None:
            samples = (start_boundary, *samples)
        if end_boundary is not None and int(window_end_ms) != int(window_start_ms):
            samples = (*samples, end_boundary)
        if require_window_coverage:
            if not samples or samples[0].time_ms != int(window_start_ms) or samples[-1].time_ms != int(window_end_ms):
                return PortfolioNormalizationResult(
                    samples=samples,
                    reason_code=ReasonCode.WINDOW_COVERAGE_INCOMPLETE,
                    reason_message="aligned perpMonth samples do not cover the fixed evaluation window",
                    account_observation_count=len(accounts),
                    pnl_observation_count=len(pnls),
                )
    if len(samples) < 2:
        return PortfolioNormalizationResult(
            samples=samples,
            reason_code=ReasonCode.INSUFFICIENT_PORTFOLIO_SAMPLES,
            reason_message="at least two aligned perpMonth observations are required",
            account_observation_count=len(accounts),
            pnl_observation_count=len(pnls),
        )
    return PortfolioNormalizationResult(
        samples=samples,
        account_observation_count=len(accounts),
        pnl_observation_count=len(pnls),
    )


def normalize_perp_month(
    portfolio_payload: Any,
    window_start_ms: int | None = None,
    window_end_ms: int | None = None,
    *,
    tolerance_ms: int = PORTFOLIO_ALIGNMENT_TOLERANCE_MS,
    require_window_coverage: bool = True,
    window_coverage_tolerance_ms: int | None = None,
    allow_single_sided_boundary_tolerance: bool = True,
) -> PortfolioNormalizationResult:
    """Extract, clip and align only ``perpMonth`` observations.

    A payload containing a valid ``month`` block but no ``perpMonth`` block is
    deliberately reported as :attr:`ReasonCode.MISSING_PERP_MONTH`.
    """

    period = extract_perp_month(portfolio_payload)
    if period is None:
        return PortfolioNormalizationResult(
            samples=(),
            reason_code=ReasonCode.MISSING_PERP_MONTH,
            reason_message="portfolio response has no perpMonth period",
        )
    result = align_perp_portfolio_samples(
        period.get("accountValueHistory"),
        period.get("pnlHistory"),
        window_start_ms=window_start_ms,
        window_end_ms=window_end_ms,
        tolerance_ms=tolerance_ms,
        require_window_coverage=require_window_coverage,
        window_coverage_tolerance_ms=window_coverage_tolerance_ms,
        allow_single_sided_boundary_tolerance=allow_single_sided_boundary_tolerance,
    )
    return PortfolioNormalizationResult(
        samples=result.samples,
        reason_code=result.reason_code,
        reason_message=result.reason_message,
        raw_perp_month=period,
        account_observation_count=result.account_observation_count,
        pnl_observation_count=result.pnl_observation_count,
    )
