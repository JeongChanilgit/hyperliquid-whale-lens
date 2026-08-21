"""Deterministic, fail-closed primitives for Whale Lens screening.

The package deliberately contains no HTTP or persistence code.  Callers keep
the raw API responses and use these functions to normalize, classify and score
them without silently converting missing data into a return.
"""

from .ledger import classify_non_funding_delta, dedupe_ledger_events
from .models import (
    CashFlowClassification,
    CashFlowEvent,
    DataQuality,
    PerpPortfolioSample,
    ReasonCode,
    TWRResult,
)
from .portfolio import normalize_perp_month
from .twr import calculate_provisional_perp_twr, calculate_verified_perp_twr

__all__ = [
    "CashFlowClassification",
    "CashFlowEvent",
    "DataQuality",
    "PerpPortfolioSample",
    "ReasonCode",
    "TWRResult",
    "calculate_provisional_perp_twr",
    "calculate_verified_perp_twr",
    "classify_non_funding_delta",
    "dedupe_ledger_events",
    "normalize_perp_month",
]
