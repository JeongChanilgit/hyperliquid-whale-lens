"""Residual diagnostics and deterministic 2/4/8-sample block reconciliation."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Iterable, Sequence

from .interval_twr import assign_flows_to_intervals
from .models import CashFlowEvent, PerpPortfolioSample
from .twr import reconciliation_tolerance


ZERO = Decimal("0")
ONE = Decimal("1")


@dataclass(frozen=True)
class ResidualObservation:
    interval_index: int
    residual_usd: Decimal
    residual_ratio: Decimal
    residual_next_1: Decimal | None
    residual_sum_2: Decimal | None
    residual_sum_4: Decimal | None
    residual_sum_8: Decimal | None
    open_position_notional_usd: Decimal = ZERO
    position_count: int = 0
    hip3_position_count: int = 0
    pattern: str = "PERSISTENT_UNEXPLAINED_RESIDUAL"

    def to_dict(self) -> dict[str, object]:
        text = lambda value: None if value is None else str(value)
        return {
            "interval_index": self.interval_index,
            "residual_usd": str(self.residual_usd),
            "residual_ratio": str(self.residual_ratio),
            "residual_next_1": text(self.residual_next_1),
            "residual_sum_2": text(self.residual_sum_2),
            "residual_sum_4": text(self.residual_sum_4),
            "residual_sum_8": text(self.residual_sum_8),
            "open_position_notional_usd": str(self.open_position_notional_usd),
            "position_count": self.position_count,
            "hip3_position_count": self.hip3_position_count,
            "pattern": self.pattern,
        }


@dataclass(frozen=True)
class ReconciledBlock:
    start_interval_index: int
    interval_count: int
    residual_sum_usd: Decimal
    block_return: Decimal
    quality_code: str

    def to_dict(self) -> dict[str, object]:
        return {
            "start_interval_index": self.start_interval_index,
            "interval_count": self.interval_count,
            "residual_sum_usd": str(self.residual_sum_usd),
            "block_return": str(self.block_return),
            "quality_code": self.quality_code,
        }


@dataclass(frozen=True)
class BlockReconciliationResult:
    data_quality_status: str
    twr: Decimal | None
    twr_lower_bound: Decimal | None
    twr_upper_bound: Decimal | None
    blocks: tuple[ReconciledBlock, ...]
    residuals: tuple[ResidualObservation, ...]
    unresolved_interval_indices: tuple[int, ...]
    reason_codes: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        text = lambda value: None if value is None else str(value)
        return {
            "data_quality_status": self.data_quality_status,
            "twr": text(self.twr),
            "twr_lower_bound": text(self.twr_lower_bound),
            "twr_upper_bound": text(self.twr_upper_bound),
            "blocks": [item.to_dict() for item in self.blocks],
            "residuals": [item.to_dict() for item in self.residuals],
            "unresolved_interval_indices": list(self.unresolved_interval_indices),
            "reason_codes": list(self.reason_codes),
        }


def _sum(values: Sequence[Decimal], start: int, count: int) -> Decimal | None:
    return sum(values[start : start + count], ZERO) if start + count <= len(values) else None


def classify_residual_pattern(values: Sequence[Decimal], index: int, tolerance: Decimal) -> str:
    current = values[index]
    next_value = values[index + 1] if index + 1 < len(values) else None
    if next_value is not None and current * next_value < ZERO and abs(current + next_value) <= tolerance:
        return "ALTERNATING_RESIDUAL"
    same_sign = [value for value in values[index : index + 3] if value != ZERO]
    if len(same_sign) >= 3 and all(value > ZERO for value in same_sign) or len(same_sign) >= 3 and all(value < ZERO for value in same_sign):
        return "PERSISTENT_STEP_RESIDUAL"
    return "TRANSIENT_POSITIVE_RESIDUAL" if current > ZERO else "TRANSIENT_NEGATIVE_RESIDUAL"


def diagnose_residuals(
    samples: Sequence[PerpPortfolioSample],
    cashflows: Iterable[CashFlowEvent],
    *,
    open_position_notional_usd: Decimal = ZERO,
    position_count: int = 0,
    hip3_position_count: int = 0,
) -> tuple[ResidualObservation, ...]:
    ordered = tuple(sorted(samples, key=lambda sample: sample.time_ms))
    by_interval, _ = assign_flows_to_intervals(ordered, cashflows)
    values: list[Decimal] = []
    for index, (left, right) in enumerate(zip(ordered, ordered[1:])):
        flow = sum((event.amount_usd for event in by_interval.get(index, ())), ZERO)
        pnl = right.cumulative_pnl - left.cumulative_pnl
        values.append(right.account_value - left.account_value - pnl - flow)
    result: list[ResidualObservation] = []
    for index, value in enumerate(values):
        left, right = ordered[index], ordered[index + 1]
        denominator = max(abs(left.account_value), abs(right.account_value), ONE)
        tolerance = reconciliation_tolerance(left.account_value, right.account_value)
        result.append(
            ResidualObservation(
                interval_index=index,
                residual_usd=value,
                residual_ratio=abs(value) / denominator,
                residual_next_1=values[index + 1] if index + 1 < len(values) else None,
                residual_sum_2=_sum(values, index, 2),
                residual_sum_4=_sum(values, index, 4),
                residual_sum_8=_sum(values, index, 8),
                open_position_notional_usd=open_position_notional_usd,
                position_count=position_count,
                hip3_position_count=hip3_position_count,
                pattern=classify_residual_pattern(values, index, tolerance),
            )
        )
    return tuple(result)


def reconcile_blocks(
    samples: Sequence[PerpPortfolioSample],
    cashflows: Iterable[CashFlowEvent],
    *,
    graph_noise_tolerance_usd: Decimal = Decimal("1"),
    absolute_cap_usd: Decimal = Decimal("25"),
) -> BlockReconciliationResult:
    """Greedily reconcile exact intervals, then deterministic 2/4/8 blocks."""

    if graph_noise_tolerance_usd < ZERO or absolute_cap_usd <= ZERO:
        raise ValueError("graph noise tolerance and absolute cap must be non-negative/positive")
    ordered = tuple(sorted(samples, key=lambda sample: sample.time_ms))
    events = tuple(cashflows)
    if len(ordered) < 2:
        return BlockReconciliationResult("UNRESOLVED", None, None, None, (), (), (), ("INSUFFICIENT_PORTFOLIO_SAMPLES",))
    by_interval, unmatched = assign_flows_to_intervals(ordered, events)
    residual_info = diagnose_residuals(ordered, events)
    if unmatched:
        return BlockReconciliationResult("UNRESOLVED", None, None, None, (), residual_info, (), ("WINDOW_EDGE_COVERAGE_GAP",))
    residuals = [item.residual_usd for item in residual_info]
    blocks: list[ReconciledBlock] = []
    unresolved: list[int] = []
    growth = ONE
    lower_growth = ONE
    upper_growth = ONE
    i = 0
    used_rescue_block = False
    while i < len(residuals):
        left, right = ordered[i], ordered[i + 1]
        exact_tolerance = reconciliation_tolerance(left.account_value, right.account_value)
        block_size = 1 if abs(residuals[i]) <= exact_tolerance else None
        if block_size is None and residual_info[i].pattern != "PERSISTENT_STEP_RESIDUAL":
            for candidate in (2, 4, 8):
                if i + candidate > len(residuals):
                    continue
                total_residual = sum(residuals[i : i + candidate], ZERO)
                calibrated = min(absolute_cap_usd, graph_noise_tolerance_usd)
                block_events = sum((len(by_interval.get(j, ())) for j in range(i, i + candidate)), 0)
                end = ordered[i + candidate]
                if (
                    abs(total_residual) <= calibrated
                    and block_events == 0
                    and left.account_value > ZERO
                    and end.account_value > ZERO
                ):
                    delta_pnl = end.cumulative_pnl - left.cumulative_pnl
                    block_return = delta_pnl / left.account_value
                    if block_return >= -ONE:
                        block_size = candidate
                        used_rescue_block = True
                        break
        if block_size is None:
            unresolved.append(i)
            uncertainty = abs(residuals[i]) / max(abs(left.account_value), ONE)
            base_return = (right.cumulative_pnl - left.cumulative_pnl) / max(abs(left.account_value), ONE)
            lower = max(-ONE, base_return - uncertainty)
            upper = base_return + uncertainty
            lower_growth *= ONE + lower
            upper_growth *= ONE + upper
            i += 1
            continue
        end = ordered[i + block_size]
        delta_pnl = end.cumulative_pnl - left.cumulative_pnl
        block_return = ZERO if left.account_value <= ZERO else delta_pnl / left.account_value
        if block_return < -ONE:
            unresolved.extend(range(i, i + block_size))
            i += block_size
            continue
        residual_sum = sum(residuals[i : i + block_size], ZERO)
        quality_code = "EXACT" if block_size == 1 else f"BLOCK_{block_size}_RECONCILES"
        blocks.append(ReconciledBlock(i, block_size, residual_sum, block_return, quality_code))
        growth *= ONE + block_return
        lower_growth *= ONE + block_return
        upper_growth *= ONE + block_return
        i += block_size
    if not unresolved:
        return BlockReconciliationResult(
            "VERIFIED_BLOCK_RECONCILED" if used_rescue_block else "VERIFIED_EXACT",
            growth - ONE,
            growth - ONE,
            growth - ONE,
            tuple(blocks), residual_info, (),
            tuple(sorted({block.quality_code for block in blocks if block.interval_count > 1})),
        )
    return BlockReconciliationResult(
        "BOUNDED", None,
        min(lower_growth, upper_growth) - ONE,
        max(lower_growth, upper_growth) - ONE,
        tuple(blocks), residual_info, tuple(unresolved),
        tuple(sorted({residual_info[index].pattern for index in unresolved} | {"PERSISTENT_UNEXPLAINED_RESIDUAL"})),
    )


__all__ = [
    "BlockReconciliationResult",
    "ReconciledBlock",
    "ResidualObservation",
    "classify_residual_pattern",
    "diagnose_residuals",
    "reconcile_blocks",
]
