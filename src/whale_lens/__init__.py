"""Deterministic, fail-closed primitives for Whale Lens screening.

The package deliberately contains no HTTP or persistence code.  Callers keep
the raw API responses and use these functions to normalize, classify and score
them without silently converting missing data into a return.
"""

from .ledger import classify_non_funding_delta, dedupe_ledger_events
from .activity_census import build_activity_census_report, select_exact_twr_top10_with_fills
from .models import (
    CashFlowClassification,
    CashFlowEvent,
    DataQuality,
    PerpPortfolioSample,
    ReasonCode,
    TWRResult,
)
from .portfolio import normalize_perp_month
from .evidence_registry import ActivityStatus, DataQualityStatus, EvidenceRegistry, SelectionStatus
from .interval_twr import calculate_interval_rescue
from .reconciliation import reconcile_blocks
from .rescue import build_rescue_report, select_trade_qualified_top10
from .twr import calculate_provisional_perp_twr, calculate_verified_perp_twr
from .valuation import recover_flow_value

__all__ = [
    "CashFlowClassification",
    "CashFlowEvent",
    "DataQuality",
    "PerpPortfolioSample",
    "ReasonCode",
    "TWRResult",
    "ActivityStatus",
    "DataQualityStatus",
    "EvidenceRegistry",
    "SelectionStatus",
    "build_rescue_report",
    "build_activity_census_report",
    "calculate_interval_rescue",
    "calculate_provisional_perp_twr",
    "calculate_verified_perp_twr",
    "classify_non_funding_delta",
    "dedupe_ledger_events",
    "normalize_perp_month",
    "reconcile_blocks",
    "recover_flow_value",
    "select_trade_qualified_top10",
    "select_exact_twr_top10_with_fills",
]
