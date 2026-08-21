"""Typed Decimal-only data models for the cash-flow-neutral TWR pipeline."""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from enum import Enum
from typing import Any, Mapping, Sequence


ZERO = Decimal("0")


def decimal_value(value: Any, *, field_name: str = "value") -> Decimal:
    """Convert a finite API value to :class:`Decimal` without float arithmetic."""

    if isinstance(value, bool):
        raise ValueError(f"{field_name} must be a numeric value, not bool")
    try:
        result = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} is not a Decimal-compatible value: {value!r}") from exc
    if not result.is_finite():
        raise ValueError(f"{field_name} must be finite: {value!r}")
    return result


class CashFlowClassification(str, Enum):
    """How a non-funding ledger delta affects capital available to perps."""

    EXTERNAL_IN = "EXTERNAL_IN"
    EXTERNAL_OUT = "EXTERNAL_OUT"
    NON_POSITION_IN = "NON_POSITION_IN"
    NON_POSITION_OUT = "NON_POSITION_OUT"
    NOT_A_CASH_FLOW = "NOT_A_CASH_FLOW"
    UNKNOWN = "UNKNOWN"


class DataQuality(str, Enum):
    PROVISIONAL = "PROVISIONAL"
    VERIFIED = "VERIFIED"
    APPROXIMATE = "APPROXIMATE"
    UNVERIFIABLE = "UNVERIFIABLE"


class ReasonCode(str, Enum):
    VALID = "VALID"
    MISSING_PERP_MONTH = "MISSING_PERP_MONTH"
    INSUFFICIENT_PORTFOLIO_SAMPLES = "INSUFFICIENT_PORTFOLIO_SAMPLES"
    WINDOW_COVERAGE_INCOMPLETE = "WINDOW_COVERAGE_INCOMPLETE"
    PORTFOLIO_ALIGNMENT_FAILED = "PORTFOLIO_ALIGNMENT_FAILED"
    PROVISIONAL_SCORING_FAILED = "PROVISIONAL_SCORING_FAILED"
    LEDGER_COVERAGE_INCOMPLETE = "LEDGER_COVERAGE_INCOMPLETE"
    UNKNOWN_LEDGER_DELTA_TYPE = "UNKNOWN_LEDGER_DELTA_TYPE"
    NON_USD_FLOW_UNPRICED = "NON_USD_FLOW_UNPRICED"
    CASHFLOW_BOUNDARY_MISSING = "CASHFLOW_BOUNDARY_MISSING"
    EVENT_ORDER_AMBIGUOUS = "EVENT_ORDER_AMBIGUOUS"
    RECONCILIATION_RESIDUAL_TOO_LARGE = "RECONCILIATION_RESIDUAL_TOO_LARGE"
    NONPOSITIVE_CAPITAL_BASE = "NONPOSITIVE_CAPITAL_BASE"
    RETURN_BELOW_MINUS_100 = "RETURN_BELOW_MINUS_100"


@dataclass(frozen=True)
class PerpPortfolioSample:
    """One aligned ``perpMonth`` account-value/PnL observation."""

    time_ms: int
    account_value: Decimal
    cumulative_pnl: Decimal
    account_source_time_ms: int | None = None
    pnl_source_time_ms: int | None = None

    def __post_init__(self) -> None:
        if isinstance(self.time_ms, bool):
            raise ValueError("time_ms must be an integer")
        try:
            time_ms = int(self.time_ms)
        except (TypeError, ValueError) as exc:
            raise ValueError("time_ms must be an integer") from exc
        if time_ms < 0:
            raise ValueError("time_ms cannot be negative")
        object.__setattr__(self, "time_ms", time_ms)
        object.__setattr__(self, "account_value", decimal_value(self.account_value, field_name="account_value"))
        object.__setattr__(self, "cumulative_pnl", decimal_value(self.cumulative_pnl, field_name="cumulative_pnl"))
        account_time = time_ms if self.account_source_time_ms is None else int(self.account_source_time_ms)
        pnl_time = time_ms if self.pnl_source_time_ms is None else int(self.pnl_source_time_ms)
        object.__setattr__(self, "account_source_time_ms", account_time)
        object.__setattr__(self, "pnl_source_time_ms", pnl_time)


@dataclass(frozen=True)
class CashFlowEvent:
    """A signed, USD-valued capital flow: positive into the perp account."""

    time_ms: int
    amount_usd: Decimal
    delta_type: str
    classification: CashFlowClassification | str
    raw: Mapping[str, Any] | None = field(default=None, compare=False, repr=False)
    identity: str | None = None

    def __post_init__(self) -> None:
        if isinstance(self.time_ms, bool):
            raise ValueError("time_ms must be an integer")
        try:
            time_ms = int(self.time_ms)
        except (TypeError, ValueError) as exc:
            raise ValueError("time_ms must be an integer") from exc
        if time_ms < 0:
            raise ValueError("time_ms cannot be negative")
        try:
            classification = CashFlowClassification(self.classification)
        except ValueError as exc:
            raise ValueError(f"unknown cash-flow classification: {self.classification!r}") from exc
        delta_type = str(self.delta_type).strip()
        if not delta_type:
            raise ValueError("delta_type is required")
        object.__setattr__(self, "time_ms", time_ms)
        object.__setattr__(self, "amount_usd", decimal_value(self.amount_usd, field_name="amount_usd"))
        object.__setattr__(self, "delta_type", delta_type)
        object.__setattr__(self, "classification", classification)


@dataclass(frozen=True)
class ClassifiedCashFlow:
    """Classifier output retaining the raw ledger event for audit/recalculation."""

    time_ms: int
    amount_usd: Decimal | None
    classification: CashFlowClassification | str
    delta_type: str
    confidence: str
    raw: Mapping[str, Any]
    reason_code: ReasonCode | str | None = None
    reason_message: str | None = None
    identity: str | None = None

    def __post_init__(self) -> None:
        if isinstance(self.time_ms, bool):
            raise ValueError("time_ms must be an integer")
        object.__setattr__(self, "time_ms", int(self.time_ms))
        try:
            classification = CashFlowClassification(self.classification)
        except ValueError as exc:
            raise ValueError(f"unknown cash-flow classification: {self.classification!r}") from exc
        object.__setattr__(self, "classification", classification)
        if self.amount_usd is not None:
            object.__setattr__(self, "amount_usd", decimal_value(self.amount_usd, field_name="amount_usd"))
        if self.reason_code is not None:
            object.__setattr__(self, "reason_code", ReasonCode(self.reason_code))
        object.__setattr__(self, "delta_type", str(self.delta_type))
        object.__setattr__(self, "confidence", str(self.confidence))

    @property
    def is_unverifiable(self) -> bool:
        return self.classification is CashFlowClassification.UNKNOWN or self.amount_usd is None

    def to_event(self) -> CashFlowEvent | None:
        """Return an event only when this delta has an exact signed USD amount."""

        if self.is_unverifiable or self.classification is CashFlowClassification.NOT_A_CASH_FLOW:
            return None
        assert self.amount_usd is not None
        return CashFlowEvent(
            time_ms=self.time_ms,
            amount_usd=self.amount_usd,
            delta_type=self.delta_type,
            classification=self.classification,
            raw=self.raw,
            identity=self.identity,
        )

    def to_dict(self) -> dict[str, Any]:
        """JSON-boundary representation that keeps Decimal values lossless."""

        return {
            "time_ms": self.time_ms,
            "amount_usd": None if self.amount_usd is None else str(self.amount_usd),
            "classification": self.classification.value,
            "delta_type": self.delta_type,
            "confidence": self.confidence,
            "reason_code": None if self.reason_code is None else self.reason_code.value,
            "reason_message": self.reason_message,
            "identity": self.identity,
            "raw": self.raw,
        }


@dataclass(frozen=True)
class PortfolioNormalizationResult:
    """Normalized portfolio data or a precise fail-closed reason."""

    samples: tuple[PerpPortfolioSample, ...]
    reason_code: ReasonCode = ReasonCode.VALID
    reason_message: str | None = None
    raw_perp_month: Mapping[str, Any] | None = field(default=None, compare=False, repr=False)
    account_observation_count: int = 0
    pnl_observation_count: int = 0

    @property
    def is_valid(self) -> bool:
        return self.reason_code is ReasonCode.VALID


@dataclass(frozen=True)
class FlowAlignment:
    """A cash flow associated with exactly one current portfolio boundary."""

    event: CashFlowEvent
    sample_index: int
    sample_time_ms: int
    distance_ms: int


@dataclass(frozen=True)
class FlowAlignmentResult:
    alignments: tuple[FlowAlignment, ...]
    unmatched_events: tuple[CashFlowEvent, ...] = ()

    @property
    def is_complete(self) -> bool:
        return not self.unmatched_events


@dataclass(frozen=True)
class TWRInterval:
    previous_time_ms: int
    current_time_ms: int
    capital_base: Decimal
    delta_pnl: Decimal
    flow_at_current_usd: Decimal
    interval_return: Decimal | None
    growth_index: Decimal
    reconciliation_residual_usd: Decimal
    reconciliation_tolerance_usd: Decimal


@dataclass(frozen=True)
class TWRResult:
    """Return and diagnostics.  A non-``VALID`` result never exposes a score."""

    quality: DataQuality | str
    reason_code: ReasonCode | str
    reason_message: str | None = None
    twr: Decimal | None = None
    growth_index: Decimal | None = None
    intervals: tuple[TWRInterval, ...] = ()
    portfolio_observation_count: int = 0
    cashflow_event_count: int = 0
    gross_cash_in_usd: Decimal = ZERO
    gross_cash_out_usd: Decimal = ZERO
    non_position_income_neutralized_usd: Decimal = ZERO
    max_abs_reconciliation_residual_usd: Decimal = ZERO
    max_reconciliation_residual_ratio: Decimal = ZERO
    minimum_capital_base_usd: Decimal | None = None
    maximum_interval_return: Decimal | None = None
    number_of_extreme_return_intervals: int = 0
    aligned_cashflows: tuple[FlowAlignment, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "quality", DataQuality(self.quality))
        object.__setattr__(self, "reason_code", ReasonCode(self.reason_code))
        for field_name in (
            "gross_cash_in_usd",
            "gross_cash_out_usd",
            "non_position_income_neutralized_usd",
            "max_abs_reconciliation_residual_usd",
            "max_reconciliation_residual_ratio",
        ):
            object.__setattr__(self, field_name, decimal_value(getattr(self, field_name), field_name=field_name))
        for field_name in ("twr", "growth_index", "minimum_capital_base_usd", "maximum_interval_return"):
            value = getattr(self, field_name)
            if value is not None:
                object.__setattr__(self, field_name, decimal_value(value, field_name=field_name))

    @property
    def is_valid(self) -> bool:
        return self.reason_code is ReasonCode.VALID and self.twr is not None

    @property
    def perp_cashflow_neutral_twr_30d(self) -> Decimal | None:
        return self.twr

    def to_dict(self) -> dict[str, Any]:
        """Lossless report/CLI boundary representation with raw-free diagnostics."""

        def text(value: Decimal | None) -> str | None:
            return None if value is None else str(value)

        return {
            "perp_cashflow_neutral_twr_30d": text(self.twr),
            "growth_index": text(self.growth_index),
            "quality": self.quality.value,
            "reason_code": self.reason_code.value,
            "reason_message": self.reason_message,
            "portfolio_observation_count": self.portfolio_observation_count,
            "cashflow_event_count": self.cashflow_event_count,
            "gross_cash_in_usd": text(self.gross_cash_in_usd),
            "gross_cash_out_usd": text(self.gross_cash_out_usd),
            "non_position_income_neutralized_usd": text(self.non_position_income_neutralized_usd),
            "max_abs_reconciliation_residual_usd": text(self.max_abs_reconciliation_residual_usd),
            "max_reconciliation_residual_ratio": text(self.max_reconciliation_residual_ratio),
            "minimum_capital_base_usd": text(self.minimum_capital_base_usd),
            "maximum_interval_return": text(self.maximum_interval_return),
            "number_of_extreme_return_intervals": self.number_of_extreme_return_intervals,
            "intervals": [
                {
                    "previous_time_ms": interval.previous_time_ms,
                    "current_time_ms": interval.current_time_ms,
                    "capital_base": str(interval.capital_base),
                    "delta_pnl": str(interval.delta_pnl),
                    "flow_at_current_usd": str(interval.flow_at_current_usd),
                    "interval_return": text(interval.interval_return),
                    "growth_index": str(interval.growth_index),
                    "reconciliation_residual_usd": str(interval.reconciliation_residual_usd),
                    "reconciliation_tolerance_usd": str(interval.reconciliation_tolerance_usd),
                }
                for interval in self.intervals
            ],
        }


@dataclass(frozen=True)
class LedgerPageObservation:
    """One cursor/page fact retained by the ledger fetcher for coverage proof."""

    cursor_start_ms: int
    event_count: int
    max_event_time_ms: int | None
    request_end_ms: int
    response_capped: bool = False


@dataclass(frozen=True)
class LedgerCoverage:
    """Completeness result; an incomplete ledger must not be scored as verified."""

    window_start_ms: int
    window_end_ms: int
    complete: bool
    reason_code: ReasonCode | str = ReasonCode.VALID
    reason_message: str | None = None
    pages: tuple[LedgerPageObservation, ...] = ()
    raw_event_count: int = 0
    unique_event_count: int = 0

    def __post_init__(self) -> None:
        object.__setattr__(self, "reason_code", ReasonCode(self.reason_code))
        if self.complete and self.reason_code is not ReasonCode.VALID:
            raise ValueError("complete ledger coverage must have VALID reason code")
        if not self.complete and self.reason_code is ReasonCode.VALID:
            object.__setattr__(self, "reason_code", ReasonCode.LEDGER_COVERAGE_INCOMPLETE)


def failure_result(
    reason_code: ReasonCode,
    message: str,
    *,
    quality: DataQuality = DataQuality.UNVERIFIABLE,
    portfolio_observation_count: int = 0,
    cashflow_event_count: int = 0,
) -> TWRResult:
    """Construct one consistent fail-closed result."""

    return TWRResult(
        quality=quality,
        reason_code=reason_code,
        reason_message=message,
        portfolio_observation_count=portfolio_observation_count,
        cashflow_event_count=cashflow_event_count,
    )


def as_tuple(values: Sequence[Any] | None) -> tuple[Any, ...]:
    """Small normalization helper used by APIs that accept iterables."""

    return tuple(values or ())
