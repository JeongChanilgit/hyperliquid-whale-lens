"""Cash-flow-neutral, Decimal-only perpetual time-weighted return calculations."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Sequence
from decimal import Decimal
from typing import Any

from .models import (
    CashFlowClassification,
    CashFlowEvent,
    ClassifiedCashFlow,
    DataQuality,
    FlowAlignment,
    FlowAlignmentResult,
    LedgerCoverage,
    PerpPortfolioSample,
    PortfolioNormalizationResult,
    ReasonCode,
    TWRInterval,
    TWRResult,
    ZERO,
    failure_result,
)


CASHFLOW_SAMPLE_MATCH_TOLERANCE_MS = 5_000
RECONCILIATION_ABSOLUTE_TOLERANCE_USD = Decimal("0.05")
RECONCILIATION_RELATIVE_TOLERANCE = Decimal("0.000001")
EXTREME_INTERVAL_RETURN = Decimal("1")


def reconciliation_tolerance(previous_equity: Decimal, current_equity: Decimal) -> Decimal:
    """The fixed, non-score-dependent tolerance specified for a sample boundary."""

    return max(
        RECONCILIATION_ABSOLUTE_TOLERANCE_USD,
        max(abs(previous_equity), abs(current_equity)) * RECONCILIATION_RELATIVE_TOLERANCE,
    )


def _samples_or_failure(
    samples: Iterable[PerpPortfolioSample] | PortfolioNormalizationResult,
) -> tuple[tuple[PerpPortfolioSample, ...] | None, TWRResult | None]:
    if isinstance(samples, PortfolioNormalizationResult):
        if not samples.is_valid:
            return None, failure_result(
                samples.reason_code,
                samples.reason_message or "perpMonth normalization failed",
                portfolio_observation_count=len(samples.samples),
            )
        normalized = samples.samples
    else:
        try:
            normalized = tuple(samples)
        except TypeError:
            return None, failure_result(
                ReasonCode.INSUFFICIENT_PORTFOLIO_SAMPLES,
                "portfolio samples are not iterable",
            )
    if len(normalized) < 2:
        return None, failure_result(
            ReasonCode.INSUFFICIENT_PORTFOLIO_SAMPLES,
            "at least two aligned perpMonth samples are required",
            portfolio_observation_count=len(normalized),
        )
    if any(not isinstance(sample, PerpPortfolioSample) for sample in normalized):
        return None, failure_result(
            ReasonCode.PORTFOLIO_ALIGNMENT_FAILED,
            "all samples must be PerpPortfolioSample instances",
            portfolio_observation_count=len(normalized),
        )
    ordered = tuple(sorted(normalized, key=lambda sample: sample.time_ms))
    if any(left.time_ms == right.time_ms for left, right in zip(ordered, ordered[1:])):
        return None, failure_result(
            ReasonCode.PORTFOLIO_ALIGNMENT_FAILED,
            "aligned samples have duplicate portfolio timestamps",
            portfolio_observation_count=len(ordered),
        )
    return ordered, None


def _flow_failure(
    reason_code: ReasonCode,
    message: str,
    *,
    portfolio_count: int,
    flow_count: int,
) -> TWRResult:
    return failure_result(
        reason_code,
        message,
        portfolio_observation_count=portfolio_count,
        cashflow_event_count=flow_count,
    )


def _cashflows_or_failure(
    cashflows: Iterable[CashFlowEvent | ClassifiedCashFlow], *, portfolio_count: int
) -> tuple[tuple[CashFlowEvent, ...] | None, TWRResult | None]:
    try:
        raw_values = tuple(cashflows)
    except TypeError:
        return None, _flow_failure(
            ReasonCode.UNKNOWN_LEDGER_DELTA_TYPE,
            "cash-flow events are not iterable",
            portfolio_count=portfolio_count,
            flow_count=0,
        )
    events: list[CashFlowEvent] = []
    for item in raw_values:
        if isinstance(item, ClassifiedCashFlow):
            if item.is_unverifiable:
                return None, _flow_failure(
                    item.reason_code or ReasonCode.UNKNOWN_LEDGER_DELTA_TYPE,
                    item.reason_message or f"unverifiable ledger delta: {item.delta_type}",
                    portfolio_count=portfolio_count,
                    flow_count=len(raw_values),
                )
            event = item.to_event()
            if event is None:
                continue
        elif isinstance(item, CashFlowEvent):
            event = item
        else:
            return None, _flow_failure(
                ReasonCode.UNKNOWN_LEDGER_DELTA_TYPE,
                "cash-flow input must be CashFlowEvent or ClassifiedCashFlow",
                portfolio_count=portfolio_count,
                flow_count=len(raw_values),
            )
        if event.classification is CashFlowClassification.UNKNOWN:
            return None, _flow_failure(
                ReasonCode.UNKNOWN_LEDGER_DELTA_TYPE,
                f"unverifiable ledger delta: {event.delta_type}",
                portfolio_count=portfolio_count,
                flow_count=len(raw_values),
            )
        if event.classification is CashFlowClassification.NOT_A_CASH_FLOW:
            continue
        if event.classification in {CashFlowClassification.EXTERNAL_IN, CashFlowClassification.NON_POSITION_IN} and event.amount_usd < ZERO:
            return None, _flow_failure(
                ReasonCode.UNKNOWN_LEDGER_DELTA_TYPE,
                f"inflow {event.delta_type} has a negative signed amount",
                portfolio_count=portfolio_count,
                flow_count=len(raw_values),
            )
        if event.classification in {CashFlowClassification.EXTERNAL_OUT, CashFlowClassification.NON_POSITION_OUT} and event.amount_usd > ZERO:
            return None, _flow_failure(
                ReasonCode.UNKNOWN_LEDGER_DELTA_TYPE,
                f"outflow {event.delta_type} has a positive signed amount",
                portfolio_count=portfolio_count,
                flow_count=len(raw_values),
            )
        events.append(event)
    # A stable sort gives deterministic tie handling without rewriting raw events.
    return tuple(sorted(events, key=lambda event: (event.time_ms, event.identity or "", event.delta_type))), None


def align_cashflows_to_samples(
    cashflows: Iterable[CashFlowEvent],
    samples: Iterable[PerpPortfolioSample],
    *,
    tolerance_ms: int = CASHFLOW_SAMPLE_MATCH_TOLERANCE_MS,
) -> FlowAlignmentResult:
    """Map every flow to one current sample boundary, exact timestamp first.

    More than one flow may land on a boundary and will be summed by the TWR
    calculator.  A single flow never lands on two boundaries; this avoids the
    duplicate-counting failure mode around close timestamps.
    """

    if tolerance_ms < 0:
        raise ValueError("cash-flow sample match tolerance cannot be negative")
    ordered_samples = tuple(sorted(samples, key=lambda sample: sample.time_ms))
    # The first sample has no preceding return interval, therefore it cannot
    # prove an event boundary for a strict calculation.
    boundaries = tuple(enumerate(ordered_samples[1:], start=1))
    exact: dict[int, list[tuple[int, PerpPortfolioSample]]] = defaultdict(list)
    for index, sample in boundaries:
        exact[sample.time_ms].append((index, sample))
    alignments: list[FlowAlignment] = []
    unmatched: list[CashFlowEvent] = []
    for event in cashflows:
        exact_matches = exact.get(event.time_ms, ())
        if exact_matches:
            index, sample = exact_matches[0]
            alignments.append(FlowAlignment(event, index, sample.time_ms, 0))
            continue
        candidates = [
            (abs(event.time_ms - sample.time_ms), sample.time_ms, index, sample)
            for index, sample in boundaries
            if abs(event.time_ms - sample.time_ms) <= tolerance_ms
        ]
        if not candidates:
            unmatched.append(event)
            continue
        distance, _sample_time, index, sample = min(candidates)
        alignments.append(FlowAlignment(event, index, sample.time_ms, distance))
    return FlowAlignmentResult(tuple(alignments), tuple(unmatched))


def _cashflow_totals(events: Iterable[CashFlowEvent]) -> tuple[Decimal, Decimal, Decimal]:
    gross_in = ZERO
    gross_out = ZERO
    non_position_income = ZERO
    for event in events:
        if event.amount_usd > ZERO:
            gross_in += event.amount_usd
        elif event.amount_usd < ZERO:
            gross_out -= event.amount_usd
        if event.classification is CashFlowClassification.NON_POSITION_IN:
            non_position_income += event.amount_usd
        elif event.classification is CashFlowClassification.NON_POSITION_OUT:
            non_position_income += event.amount_usd
    return gross_in, gross_out, non_position_income


def _result(
    *,
    quality: DataQuality,
    growth_index: Decimal,
    intervals: list[TWRInterval],
    samples: Sequence[PerpPortfolioSample],
    events: Sequence[CashFlowEvent],
    alignments: Sequence[FlowAlignment] = (),
    twr: Decimal | None = None,
) -> TWRResult:
    gross_in, gross_out, non_position_income = _cashflow_totals(events)
    residuals = [abs(interval.reconciliation_residual_usd) for interval in intervals]
    residual_ratios = [
        abs(interval.reconciliation_residual_usd)
        / max(abs(samples[index].account_value), abs(samples[index + 1].account_value), Decimal("1"))
        for index, interval in enumerate(intervals)
    ]
    bases = [interval.capital_base for interval in intervals]
    returns = [interval.interval_return for interval in intervals if interval.interval_return is not None]
    return TWRResult(
        quality=quality,
        reason_code=ReasonCode.VALID,
        # Carry the return directly as well as the growth index.  Repeatedly
        # doing ``(1 + r) - 1`` discards a Decimal digit for small returns.
        twr=growth_index - Decimal("1") if twr is None else twr,
        growth_index=growth_index,
        intervals=tuple(intervals),
        portfolio_observation_count=len(samples),
        cashflow_event_count=len(events),
        gross_cash_in_usd=gross_in,
        gross_cash_out_usd=gross_out,
        non_position_income_neutralized_usd=non_position_income,
        max_abs_reconciliation_residual_usd=max(residuals, default=ZERO),
        max_reconciliation_residual_ratio=max(residual_ratios, default=ZERO),
        minimum_capital_base_usd=min(bases) if bases else None,
        maximum_interval_return=max(returns) if returns else None,
        number_of_extreme_return_intervals=sum(
            1 for interval_return in returns if abs(interval_return) >= EXTREME_INTERVAL_RETURN
        ),
        aligned_cashflows=tuple(alignments),
    )


def calculate_provisional_perp_twr(
    samples: Iterable[PerpPortfolioSample] | PortfolioNormalizationResult,
) -> TWRResult:
    """Estimate TWR from ``perpMonth`` only, using conservative deposit-first bases.

    This result is deliberately marked ``PROVISIONAL``.  Inferred cash flow is
    useful for selecting ledger verification work, but must never become a
    verified candidate or canonical score.
    """

    ordered_samples, failed = _samples_or_failure(samples)
    if failed is not None:
        return TWRResult(
            quality=DataQuality.PROVISIONAL,
            reason_code=ReasonCode.PROVISIONAL_SCORING_FAILED,
            reason_message=failed.reason_message,
            portfolio_observation_count=failed.portfolio_observation_count,
        )
    assert ordered_samples is not None
    growth_index = Decimal("1")
    compounded_return = ZERO
    intervals: list[TWRInterval] = []
    for previous, current in zip(ordered_samples, ordered_samples[1:]):
        delta_pnl = current.cumulative_pnl - previous.cumulative_pnl
        inferred_flow = current.account_value - previous.account_value - delta_pnl
        # If a deposit and PnL share a coarse sample interval, assume the
        # deposit arrived at its start.  This is conservative and provisional.
        capital_base = previous.account_value + inferred_flow if inferred_flow > ZERO else previous.account_value
        tolerance = reconciliation_tolerance(previous.account_value, current.account_value)
        if capital_base <= ZERO:
            if delta_pnl != ZERO:
                return _flow_failure(
                    ReasonCode.NONPOSITIVE_CAPITAL_BASE,
                    "non-zero PnL occurred with non-positive provisional capital base",
                    portfolio_count=len(ordered_samples),
                    flow_count=0,
                )
            intervals.append(
                TWRInterval(
                    previous.time_ms,
                    current.time_ms,
                    capital_base,
                    delta_pnl,
                    inferred_flow,
                    None,
                    growth_index,
                    ZERO,
                    tolerance,
                )
            )
            continue
        interval_return = delta_pnl / capital_base
        if interval_return < Decimal("-1"):
            return _flow_failure(
                ReasonCode.RETURN_BELOW_MINUS_100,
                "provisional interval return is below -100%",
                portfolio_count=len(ordered_samples),
                flow_count=0,
            )
        compounded_return = compounded_return + interval_return + compounded_return * interval_return
        growth_index = Decimal("1") + compounded_return
        intervals.append(
            TWRInterval(
                previous.time_ms,
                current.time_ms,
                capital_base,
                delta_pnl,
                inferred_flow,
                interval_return,
                growth_index,
                ZERO,
                tolerance,
            )
        )
    return _result(
        quality=DataQuality.PROVISIONAL,
        growth_index=growth_index,
        intervals=intervals,
        samples=ordered_samples,
        events=(),
        twr=compounded_return,
    )


def calculate_verified_perp_twr(
    samples: Iterable[PerpPortfolioSample] | PortfolioNormalizationResult,
    cashflows: Iterable[CashFlowEvent | ClassifiedCashFlow],
    *,
    ledger_coverage: LedgerCoverage | None = None,
    strict: bool = True,
    cashflow_match_tolerance_ms: int = CASHFLOW_SAMPLE_MATCH_TOLERANCE_MS,
) -> TWRResult:
    """Calculate strict cash-flow-neutral TWR from aligned samples and ledger.

    Each exact return interval is ``delta_pnl / previous.account_value``.  A
    matched external flow reconciles the *current* equity boundary and changes
    the base for the following interval only.  Unmatched flows, ambiguous
    same-boundary PnL/flows, and material residuals fail closed in strict mode.
    """

    ordered_samples, failed = _samples_or_failure(samples)
    if failed is not None:
        return failed
    assert ordered_samples is not None
    if ledger_coverage is None:
        return _flow_failure(
            ReasonCode.LEDGER_COVERAGE_INCOMPLETE,
            "non-funding ledger coverage proof is required for VERIFIED scoring",
            portfolio_count=len(ordered_samples),
            flow_count=0,
        )
    if not ledger_coverage.complete:
        return _flow_failure(
            ReasonCode.LEDGER_COVERAGE_INCOMPLETE,
            ledger_coverage.reason_message or "non-funding ledger coverage is incomplete",
            portfolio_count=len(ordered_samples),
            flow_count=0,
        )
    events, flow_failed = _cashflows_or_failure(cashflows, portfolio_count=len(ordered_samples))
    if flow_failed is not None:
        return flow_failed
    assert events is not None
    try:
        alignment = align_cashflows_to_samples(
            events, ordered_samples, tolerance_ms=cashflow_match_tolerance_ms
        )
    except ValueError as exc:
        return _flow_failure(
            ReasonCode.CASHFLOW_BOUNDARY_MISSING,
            str(exc),
            portfolio_count=len(ordered_samples),
            flow_count=len(events),
        )
    if alignment.unmatched_events:
        details = ", ".join(
            f"{event.delta_type}@{event.time_ms}" for event in alignment.unmatched_events[:3]
        )
        return _flow_failure(
            ReasonCode.CASHFLOW_BOUNDARY_MISSING,
            f"cash flow has no matching portfolio boundary: {details}",
            portfolio_count=len(ordered_samples),
            flow_count=len(events),
        )
    flow_by_sample: defaultdict[int, Decimal] = defaultdict(lambda: ZERO)
    flows_by_sample: defaultdict[int, list[CashFlowEvent]] = defaultdict(list)
    for matched in alignment.alignments:
        flow_by_sample[matched.sample_index] += matched.event.amount_usd
        flows_by_sample[matched.sample_index].append(matched.event)

    growth_index = Decimal("1")
    compounded_return = ZERO
    intervals: list[TWRInterval] = []
    approximate = False
    for current_index, (previous, current) in enumerate(zip(ordered_samples, ordered_samples[1:]), start=1):
        delta_pnl = current.cumulative_pnl - previous.cumulative_pnl
        flow_at_current = flow_by_sample[current_index]
        expected_equity = previous.account_value + delta_pnl + flow_at_current
        residual = current.account_value - expected_equity
        tolerance = reconciliation_tolerance(previous.account_value, current.account_value)
        if abs(residual) > tolerance:
            return _flow_failure(
                ReasonCode.RECONCILIATION_RESIDUAL_TOO_LARGE,
                (
                    f"sample {current.time_ms} residual {residual} exceeds "
                    f"tolerance {tolerance}"
                ),
                portfolio_count=len(ordered_samples),
                flow_count=len(events),
            )
        if flows_by_sample[current_index] and delta_pnl != ZERO:
            if strict:
                return _flow_failure(
                    ReasonCode.EVENT_ORDER_AMBIGUOUS,
                    f"cash flow and PnL changed at sample boundary {current.time_ms}",
                    portfolio_count=len(ordered_samples),
                    flow_count=len(events),
                )
            approximate = True
        capital_base = previous.account_value
        if capital_base <= ZERO:
            if delta_pnl != ZERO:
                return _flow_failure(
                    ReasonCode.NONPOSITIVE_CAPITAL_BASE,
                    f"non-zero PnL at {current.time_ms} has capital base {capital_base}",
                    portfolio_count=len(ordered_samples),
                    flow_count=len(events),
                )
            intervals.append(
                TWRInterval(
                    previous.time_ms,
                    current.time_ms,
                    capital_base,
                    delta_pnl,
                    flow_at_current,
                    None,
                    growth_index,
                    residual,
                    tolerance,
                )
            )
            continue
        interval_return = delta_pnl / capital_base
        if interval_return < Decimal("-1"):
            return _flow_failure(
                ReasonCode.RETURN_BELOW_MINUS_100,
                f"interval return {interval_return} at {current.time_ms} is below -100%",
                portfolio_count=len(ordered_samples),
                flow_count=len(events),
            )
        compounded_return = compounded_return + interval_return + compounded_return * interval_return
        growth_index = Decimal("1") + compounded_return
        intervals.append(
            TWRInterval(
                previous.time_ms,
                current.time_ms,
                capital_base,
                delta_pnl,
                flow_at_current,
                interval_return,
                growth_index,
                residual,
                tolerance,
            )
        )
    return _result(
        quality=DataQuality.APPROXIMATE if approximate else DataQuality.VERIFIED,
        growth_index=growth_index,
        intervals=intervals,
        samples=ordered_samples,
        events=events,
        alignments=alignment.alignments,
        twr=compounded_return,
    )


# Explicit aliases keep the application boundary readable without duplicating
# the calculation.  There is intentionally no "month" or fee/funding variant.
calculate_perp_cashflow_neutral_twr = calculate_verified_perp_twr
calculate_exact_perp_twr = calculate_verified_perp_twr
