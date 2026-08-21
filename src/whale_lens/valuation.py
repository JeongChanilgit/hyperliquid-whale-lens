"""Conservative non-USD ledger value recovery with explicit provenance/bounds."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping

from .models import CashFlowClassification, ClassifiedCashFlow, decimal_value


NON_PERP_TYPES = frozenset(
    {"spotTransfer", "spotGenesis", "rewardsClaim", "accountActivationGas", "cStakingTransfer", "stakingReward", "validatorReward", "deployGasAuction"}
)
RAW_USD_FIELDS = ("usdc", "usdcValue", "netWithdrawnUsd", "requestedUsd", "commission", "closingCost")


@dataclass(frozen=True)
class PriceEvidence:
    source: str
    point: Decimal | None
    low: Decimal
    high: Decimal
    observed_at_ms: int

    def __post_init__(self) -> None:
        if self.low < 0 or self.high < self.low:
            raise ValueError("invalid price evidence range")
        if self.point is not None and not self.low <= self.point <= self.high:
            raise ValueError("price point must lie inside its range")


@dataclass(frozen=True)
class ValuationResult:
    resolved: bool
    exact: bool
    classification: str
    reason_codes: tuple[str, ...]
    value_source: str | None = None
    token: str | None = None
    token_amount: Decimal | None = None
    price_source: str | None = None
    price_point: Decimal | None = None
    price_low: Decimal | None = None
    price_high: Decimal | None = None
    flow_usd_point: Decimal | None = None
    flow_usd_low: Decimal | None = None
    flow_usd_high: Decimal | None = None

    def to_dict(self) -> dict[str, object]:
        text = lambda value: None if value is None else str(value)
        return {
            "resolved": self.resolved,
            "exact": self.exact,
            "classification": self.classification,
            "reason_codes": list(self.reason_codes),
            "value_source": self.value_source,
            "token": self.token,
            "token_amount": text(self.token_amount),
            "price_source": self.price_source,
            "price_point": text(self.price_point),
            "price_low": text(self.price_low),
            "price_high": text(self.price_high),
            "flow_usd_point": text(self.flow_usd_point),
            "flow_usd_low": text(self.flow_usd_low),
            "flow_usd_high": text(self.flow_usd_high),
        }


def _delta(raw: Mapping[str, Any]) -> Mapping[str, Any]:
    value = raw.get("delta")
    return value if isinstance(value, Mapping) else raw


def _signed_direction(delta: Mapping[str, Any]) -> Decimal:
    if isinstance(delta.get("toPerp"), bool):
        return Decimal("1") if delta["toPerp"] else Decimal("-1")
    direction = str(delta.get("direction") or delta.get("side") or "").upper()
    if direction in {"IN", "DEPOSIT", "RECEIVE"}:
        return Decimal("1")
    if direction in {"OUT", "WITHDRAW", "SEND"}:
        return Decimal("-1")
    return Decimal("1")


def _raw_usd_value(delta: Mapping[str, Any]) -> tuple[Decimal, str] | None:
    if delta.get("netWithdrawnUsd") is not None:
        return decimal_value(delta["netWithdrawnUsd"]), "netWithdrawnUsd"
    if all(delta.get(field) is not None for field in ("requestedUsd", "commission", "closingCost")):
        return (
            decimal_value(delta["requestedUsd"])
            - decimal_value(delta["commission"])
            - decimal_value(delta["closingCost"]),
            "requestedUsd-commission-closingCost",
        )
    for field in ("usdc", "usdcValue"):
        if delta.get(field) is not None:
            return decimal_value(delta[field]), field
    return None


def recover_flow_value(
    flow: ClassifiedCashFlow,
    *,
    account_context: Mapping[str, Any] | None = None,
    price_evidence: PriceEvidence | None = None,
    maximum_exact_spread_ratio: Decimal = Decimal("0.001"),
) -> ValuationResult:
    """Recover one unknown flow without converting uncertainty into exactness."""

    if not flow.is_unverifiable and flow.amount_usd is not None:
        return ValuationResult(
            True, True, flow.classification.value, (), value_source="CLASSIFIED_LEDGER", flow_usd_point=flow.amount_usd,
            flow_usd_low=flow.amount_usd, flow_usd_high=flow.amount_usd,
        )
    raw = flow.raw if isinstance(flow.raw, Mapping) else {}
    delta = _delta(raw)
    delta_type = str(delta.get("type") or flow.delta_type)
    context = dict(account_context or {})
    if delta_type in NON_PERP_TYPES and context.get("perp_equity_changed") is False and context.get("account_class_verified") is True:
        reason = "PURE_STAKING_EVENT" if "staking" in delta_type.lower() else "NON_POSITION_REWARD" if "reward" in delta_type.lower() or delta_type == "rewardsClaim" else "PURE_SPOT_EVENT"
        return ValuationResult(True, True, CashFlowClassification.NOT_A_CASH_FLOW.value, (reason, "NON_PERP_EVENT_REQUIRES_NO_BOUNDARY"), value_source="ACCOUNT_CLASS_PROOF", flow_usd_point=Decimal("0"), flow_usd_low=Decimal("0"), flow_usd_high=Decimal("0"))
    raw_value = _raw_usd_value(delta)
    direction = _signed_direction(delta)
    if raw_value is not None:
        value, source = raw_value
        signed = value * direction
        classification = CashFlowClassification.EXTERNAL_IN.value if signed >= 0 else CashFlowClassification.EXTERNAL_OUT.value
        return ValuationResult(True, True, classification, ("RAW_LEDGER_ENRICHMENT_AVAILABLE",), value_source=f"RAW_LEDGER_EVENT:{source}", flow_usd_point=signed, flow_usd_low=signed, flow_usd_high=signed)
    token = str(delta.get("token") or "").upper() or None
    amount_raw = delta.get("amount", delta.get("tokenAmount"))
    if token is None or amount_raw is None:
        return ValuationResult(False, False, CashFlowClassification.UNKNOWN.value, ("RAW_LEDGER_VALUE_MISSING", "UNPRICED_TOKEN"), token=token)
    amount = abs(decimal_value(amount_raw))
    if price_evidence is None:
        return ValuationResult(False, False, CashFlowClassification.UNKNOWN.value, ("UNPRICED_TOKEN",), token=token, token_amount=amount)
    low = amount * price_evidence.low * direction
    high = amount * price_evidence.high * direction
    low, high = min(low, high), max(low, high)
    point = None if price_evidence.point is None else amount * price_evidence.point * direction
    spread_ratio = (high - low) / max(abs(point or high), Decimal("0.000001"))
    exact = point is not None and spread_ratio <= maximum_exact_spread_ratio
    classification = CashFlowClassification.EXTERNAL_IN.value if (point if point is not None else (low + high) / 2) >= 0 else CashFlowClassification.EXTERNAL_OUT.value
    return ValuationResult(
        True,
        exact,
        classification,
        ("PRICE_AT_EVENT_AVAILABLE" if exact else "PRICE_RANGE_ONLY",),
        value_source="EVENT_PRICE",
        token=token,
        token_amount=amount,
        price_source=price_evidence.source,
        price_point=price_evidence.point,
        price_low=price_evidence.low,
        price_high=price_evidence.high,
        flow_usd_point=point,
        flow_usd_low=low,
        flow_usd_high=high,
    )


def implied_flow_consistent(
    *,
    previous_equity: Decimal,
    current_equity: Decimal,
    delta_pnl: Decimal,
    known_other_flows: Decimal,
    valuation: ValuationResult,
) -> bool:
    if valuation.flow_usd_low is None or valuation.flow_usd_high is None:
        return False
    implied = current_equity - previous_equity - delta_pnl - known_other_flows
    return valuation.flow_usd_low <= implied <= valuation.flow_usd_high


__all__ = ["PriceEvidence", "ValuationResult", "implied_flow_consistent", "recover_flow_value"]
