"""Interval matching, bounded TWR, guard samples, and Modified Dietz rescue."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal
from typing import Iterable, Mapping, Sequence

from .models import CashFlowEvent, PerpPortfolioSample, decimal_value
from .twr import reconciliation_tolerance


ZERO = Decimal("0")
ONE = Decimal("1")
EPSILON = Decimal("0.000001")


@dataclass(frozen=True)
class IntervalDiagnostic:
    interval_index: int
    left_sample_time_ms: int
    right_sample_time_ms: int
    containing_interval_ms: int
    flow_count_in_interval: int
    flow_sum_usd: Decimal
    delta_pnl_in_interval: Decimal
    nearest_boundary_distance_ms: int | None
    reason_codes: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "interval_index": self.interval_index,
            "left_sample_time_ms": self.left_sample_time_ms,
            "right_sample_time_ms": self.right_sample_time_ms,
            "containing_interval_ms": self.containing_interval_ms,
            "flow_count_in_interval": self.flow_count_in_interval,
            "flow_sum_usd": str(self.flow_sum_usd),
            "delta_pnl_in_interval": str(self.delta_pnl_in_interval),
            "nearest_boundary_distance_ms": self.nearest_boundary_distance_ms,
            "reason_codes": list(self.reason_codes),
        }


@dataclass(frozen=True)
class IntervalRescueResult:
    data_quality_status: str
    exact_twr: Decimal | None
    estimated_twr: Decimal | None
    twr_lower_bound: Decimal | None
    twr_upper_bound: Decimal | None
    estimated_twr_method: str | None
    diagnostics: tuple[IntervalDiagnostic, ...]
    reason_codes: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        text = lambda value: None if value is None else str(value)
        return {
            "data_quality_status": self.data_quality_status,
            "exact_twr": text(self.exact_twr),
            "estimated_twr": text(self.estimated_twr),
            "twr_lower_bound": text(self.twr_lower_bound),
            "twr_upper_bound": text(self.twr_upper_bound),
            "estimated_twr_method": self.estimated_twr_method,
            "diagnostics": [item.to_dict() for item in self.diagnostics],
            "reason_codes": list(self.reason_codes),
        }


def _distance_reason(distance_ms: int) -> str:
    if distance_ms <= 30_000:
        return "BOUNDARY_DISTANCE_5S_TO_30S"
    if distance_ms <= 120_000:
        return "BOUNDARY_DISTANCE_30S_TO_2M"
    if distance_ms <= 900_000:
        return "BOUNDARY_DISTANCE_2M_TO_15M"
    return "BOUNDARY_DISTANCE_OVER_15M"


def assign_flows_to_intervals(
    samples: Sequence[PerpPortfolioSample], cashflows: Iterable[CashFlowEvent]
) -> tuple[dict[int, tuple[CashFlowEvent, ...]], tuple[CashFlowEvent, ...]]:
    """Assign each flow to the unique interval ``left < flow <= right``."""

    ordered = tuple(sorted(samples, key=lambda sample: sample.time_ms))
    assigned: defaultdict[int, list[CashFlowEvent]] = defaultdict(list)
    unmatched: list[CashFlowEvent] = []
    for event in sorted(cashflows, key=lambda item: (item.time_ms, item.identity or "", item.delta_type)):
        index = next(
            (
                i
                for i, (left, right) in enumerate(zip(ordered, ordered[1:]))
                if left.time_ms < event.time_ms <= right.time_ms
            ),
            None,
        )
        if index is None:
            unmatched.append(event)
        else:
            assigned[index].append(event)
    return {index: tuple(values) for index, values in assigned.items()}, tuple(unmatched)


def modified_dietz_interval_return(
    start_equity: Decimal,
    end_equity: Decimal,
    start_time_ms: int,
    end_time_ms: int,
    flows: Sequence[CashFlowEvent],
) -> Decimal | None:
    duration = int(end_time_ms) - int(start_time_ms)
    if duration <= 0:
        raise ValueError("Modified Dietz interval duration must be positive")
    weighted_flow = ZERO
    total_flow = ZERO
    for event in flows:
        if not start_time_ms < event.time_ms <= end_time_ms:
            raise ValueError("Modified Dietz flow falls outside the interval")
        weight = Decimal(end_time_ms - event.time_ms) / Decimal(duration)
        weighted_flow += weight * event.amount_usd
        total_flow += event.amount_usd
    denominator = start_equity + weighted_flow
    if denominator <= ZERO:
        return None
    return (end_equity - start_equity - total_flow) / denominator


def merge_guard_samples(
    window_samples: Sequence[PerpPortfolioSample],
    guard_samples: Iterable[PerpPortfolioSample],
    *,
    window_start_ms: int,
    window_end_ms: int,
) -> tuple[PerpPortfolioSample, ...]:
    """Return only in-window samples plus consistent predecessor/successor guards."""

    base = {sample.time_ms: sample for sample in window_samples if window_start_ms <= sample.time_ms <= window_end_ms}
    guards = sorted(guard_samples, key=lambda sample: sample.time_ms)
    for guard in guards:
        current = base.get(guard.time_ms)
        if current is not None and (
            current.account_value != guard.account_value or current.cumulative_pnl != guard.cumulative_pnl
        ):
            raise ValueError(f"conflicting guard sample at {guard.time_ms}")
    predecessor = max((sample for sample in guards if sample.time_ms < window_start_ms), key=lambda item: item.time_ms, default=None)
    successor = min((sample for sample in guards if sample.time_ms > window_end_ms), key=lambda item: item.time_ms, default=None)
    # Guards are proof points only. They are not inserted as return-producing
    # intervals, so no out-of-window performance leaks into the score.
    result = sorted(base.values(), key=lambda sample: sample.time_ms)
    if predecessor is not None and result:
        first = result[0]
        if predecessor.account_value == first.account_value and predecessor.cumulative_pnl == first.cumulative_pnl:
            result[0] = PerpPortfolioSample(window_start_ms, first.account_value, first.cumulative_pnl, predecessor.time_ms, predecessor.time_ms)
    if successor is not None and result:
        last = result[-1]
        if successor.account_value == last.account_value and successor.cumulative_pnl == last.cumulative_pnl:
            result[-1] = PerpPortfolioSample(window_end_ms, last.account_value, last.cumulative_pnl, successor.time_ms, successor.time_ms)
    return tuple(result)


def calculate_interval_rescue(
    samples: Sequence[PerpPortfolioSample],
    cashflows: Iterable[CashFlowEvent],
    *,
    epsilon: Decimal = EPSILON,
) -> IntervalRescueResult:
    ordered = tuple(sorted(samples, key=lambda sample: sample.time_ms))
    events = tuple(cashflows)
    if len(ordered) < 2:
        return IntervalRescueResult("UNRESOLVED", None, None, None, None, None, (), ("INSUFFICIENT_PORTFOLIO_SAMPLES",))
    by_interval, unmatched = assign_flows_to_intervals(ordered, events)
    if unmatched:
        edge_reason = "WINDOW_EDGE_COVERAGE_GAP"
        return IntervalRescueResult("UNRESOLVED", None, None, None, None, None, (), (edge_reason,))

    growth_exact = ONE
    growth_estimate = ONE
    growth_lower = ONE
    growth_upper = ONE
    exact_possible = True
    bounded = False
    estimates_available = True
    diagnostics: list[IntervalDiagnostic] = []
    all_reasons: set[str] = set()
    for index, (left, right) in enumerate(zip(ordered, ordered[1:])):
        interval_flows = by_interval.get(index, ())
        net_flow = sum((event.amount_usd for event in interval_flows), ZERO)
        flow_in = sum((event.amount_usd for event in interval_flows if event.amount_usd > ZERO), ZERO)
        flow_out = -sum((event.amount_usd for event in interval_flows if event.amount_usd < ZERO), ZERO)
        delta_pnl = right.cumulative_pnl - left.cumulative_pnl
        residual = right.account_value - left.account_value - delta_pnl - net_flow
        tolerance = reconciliation_tolerance(left.account_value, right.account_value)
        distances = [min(event.time_ms - left.time_ms, right.time_ms - event.time_ms) for event in interval_flows]
        reasons: set[str] = set()
        if interval_flows:
            reasons.add("FLOW_BETWEEN_SAMPLES")
            reasons.add(_distance_reason(min(distances)))
            if len(interval_flows) > 1:
                reasons.add("MULTIPLE_FLOWS_SAME_INTERVAL")
            if delta_pnl != ZERO:
                reasons.add("FLOW_AND_PNL_SAME_INTERVAL")
        if abs(residual) > tolerance:
            reasons.add("RECONCILIATION_RESIDUAL_TOO_LARGE")
            exact_possible = False
        if left.account_value <= ZERO:
            reasons.add("NONPOSITIVE_CAPITAL_BASE")
            exact_possible = False
            estimates_available = False
        if not interval_flows or delta_pnl == ZERO:
            if left.account_value <= ZERO:
                # Keep the observation and its reason, but never manufacture a
                # return from a zero/negative capital base.
                interval_return = None
            else:
                interval_return = ZERO if delta_pnl == ZERO else delta_pnl / left.account_value
                if interval_return < -ONE:
                    reasons.add("RETURN_BELOW_MINUS_100")
                    exact_possible = False
                    estimates_available = False
                else:
                    growth_exact *= ONE + interval_return
                    growth_estimate *= ONE + interval_return
                    growth_lower *= ONE + interval_return
                    growth_upper *= ONE + interval_return
        else:
            exact_possible = False
            bounded = True
            capital_low = max(decimal_value(epsilon), left.account_value - flow_out)
            capital_high = left.account_value + flow_in
            if capital_high <= ZERO:
                estimates_available = False
                reasons.add("NONPOSITIVE_CAPITAL_BASE")
            else:
                r_a = delta_pnl / capital_low
                r_b = delta_pnl / capital_high
                lower = min(r_a, r_b)
                upper = max(r_a, r_b)
                if lower < -ONE:
                    estimates_available = False
                    reasons.add("RETURN_BELOW_MINUS_100")
                else:
                    growth_lower *= ONE + lower
                    growth_upper *= ONE + upper
                dietz = modified_dietz_interval_return(
                    left.account_value, right.account_value, left.time_ms, right.time_ms, interval_flows
                )
                if dietz is None or dietz < -ONE:
                    estimates_available = False
                else:
                    growth_estimate *= ONE + dietz
        all_reasons.update(reasons)
        diagnostics.append(
            IntervalDiagnostic(
                interval_index=index,
                left_sample_time_ms=left.time_ms,
                right_sample_time_ms=right.time_ms,
                containing_interval_ms=right.time_ms - left.time_ms,
                flow_count_in_interval=len(interval_flows),
                flow_sum_usd=net_flow,
                delta_pnl_in_interval=delta_pnl,
                nearest_boundary_distance_ms=min(distances) if distances else None,
                reason_codes=tuple(sorted(reasons)),
            )
        )
    if exact_possible:
        return IntervalRescueResult(
            "VERIFIED_INTERVAL", growth_exact - ONE, None, growth_exact - ONE, growth_exact - ONE,
            None, tuple(diagnostics), tuple(sorted(all_reasons)),
        )
    if bounded and estimates_available:
        return IntervalRescueResult(
            "ESTIMATED_MODIFIED_DIETZ",
            None,
            growth_estimate - ONE,
            min(growth_lower, growth_upper) - ONE,
            max(growth_lower, growth_upper) - ONE,
            "MODIFIED_DIETZ",
            tuple(diagnostics),
            tuple(sorted(all_reasons)),
        )
    if bounded:
        return IntervalRescueResult(
            "BOUNDED", None, None,
            min(growth_lower, growth_upper) - ONE,
            max(growth_lower, growth_upper) - ONE,
            None, tuple(diagnostics), tuple(sorted(all_reasons)),
        )
    return IntervalRescueResult("UNRESOLVED", None, None, None, None, None, tuple(diagnostics), tuple(sorted(all_reasons)))


__all__ = [
    "IntervalDiagnostic",
    "IntervalRescueResult",
    "assign_flows_to_intervals",
    "calculate_interval_rescue",
    "merge_guard_samples",
    "modified_dietz_interval_return",
]
