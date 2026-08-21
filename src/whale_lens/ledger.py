"""Non-funding ledger classification, stable deduplication, and coverage facts."""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from hashlib import sha256
import json
from typing import Any

from .models import (
    CashFlowClassification,
    ClassifiedCashFlow,
    LedgerCoverage,
    LedgerPageObservation,
    ReasonCode,
    decimal_value,
)


LEDGER_RESPONSE_CAP = 500


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def _address(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip().lower()
    return normalized or None


def _event_time(event: Mapping[str, Any]) -> int:
    value = event.get("time", event.get("timeMs", event.get("timestamp")))
    if isinstance(value, bool):
        raise ValueError("ledger event has invalid time")
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("ledger event has invalid time") from exc
    if result < 0:
        raise ValueError("ledger event time cannot be negative")
    return result


def ledger_event_identity(event: Mapping[str, Any]) -> str:
    """A stable identity for inclusive-page overlap deduplication.

    A transaction hash alone is not sufficient because one transaction can
    produce more than one ledger delta.  The canonical delta is included even
    when a hash is present; when no hash is available the full raw event is
    hashed instead of relying on a mutable page index.
    """

    if not isinstance(event, Mapping):
        raise ValueError("ledger event must be a mapping")
    time_ms = _event_time(event)
    delta = event.get("delta")
    if not isinstance(delta, Mapping):
        raise ValueError("ledger event has no delta mapping")
    transaction_hash = str(event.get("hash") or "")
    payload = {"time": time_ms, "hash": transaction_hash, "delta": delta}
    return sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class LedgerDeduplication:
    unique_events: tuple[Mapping[str, Any], ...]
    raw_event_count: int
    duplicate_event_count: int


def dedupe_ledger_events(
    events: Iterable[Mapping[str, Any]], *, return_stats: bool = False
) -> list[Mapping[str, Any]] | LedgerDeduplication:
    """Deduplicate inclusive-page overlap while retaining the first raw event.

    The order of distinct raw events is intentionally preserved.  That order
    is useful for auditing events with equal timestamps and no event is mutated
    or reconstructed during deduplication.
    """

    seen: set[str] = set()
    unique: list[Mapping[str, Any]] = []
    raw_count = 0
    duplicates = 0
    for event in events:
        raw_count += 1
        identity = ledger_event_identity(event)
        if identity in seen:
            duplicates += 1
            continue
        seen.add(identity)
        unique.append(event)
    result = LedgerDeduplication(tuple(unique), raw_count, duplicates)
    return result if return_stats else list(result.unique_events)


def count_ledger_delta_types(events: Iterable[Mapping[str, Any]]) -> dict[str, int]:
    """Return deterministic raw delta-type counts for reports and diagnostics."""

    counts: Counter[str] = Counter()
    for event in events:
        delta = event.get("delta") if isinstance(event, Mapping) else None
        delta_type = delta.get("type") if isinstance(delta, Mapping) else None
        counts[str(delta_type) if delta_type is not None else "<MISSING>"] += 1
    return dict(sorted(counts.items()))


def _failure(
    event: Mapping[str, Any],
    *,
    delta_type: str,
    reason_code: ReasonCode,
    message: str,
    identity: str | None = None,
) -> ClassifiedCashFlow:
    try:
        time_ms = _event_time(event)
    except ValueError:
        time_ms = 0
    return ClassifiedCashFlow(
        time_ms=time_ms,
        amount_usd=None,
        classification=CashFlowClassification.UNKNOWN,
        delta_type=delta_type or "<MISSING>",
        confidence="UNVERIFIABLE",
        raw=event,
        reason_code=reason_code,
        reason_message=message,
        identity=identity,
    )


def _exact_amount(delta: Mapping[str, Any], field_names: Sequence[str]) -> Decimal:
    for field_name in field_names:
        if field_name in delta and delta[field_name] is not None:
            amount = decimal_value(delta[field_name], field_name=field_name)
            if amount < 0:
                raise ValueError(f"{field_name} cannot be negative")
            return amount
    joined = ", ".join(field_names)
    raise ValueError(f"missing exact USD amount ({joined})")


def _net_vault_withdrawal(delta: Mapping[str, Any]) -> Decimal:
    if delta.get("netWithdrawnUsd") is not None:
        return _exact_amount(delta, ("netWithdrawnUsd",))
    required = ("requestedUsd", "commission", "closingCost")
    if all(delta.get(field) is not None for field in required):
        requested = _exact_amount(delta, ("requestedUsd",))
        commission = _exact_amount(delta, ("commission",))
        closing_cost = _exact_amount(delta, ("closingCost",))
        amount = requested - commission - closing_cost
        if amount < 0:
            raise ValueError("vault withdrawal net amount cannot be negative")
        return amount
    raise ValueError("vault withdrawal is missing netWithdrawnUsd or exact requested/commission/closingCost")


def _direction_for_transfer(delta: Mapping[str, Any], wallet: str | None) -> int:
    """Return +1 for the destination, -1 for source; reject any ambiguity."""

    if wallet is None:
        raise ValueError("wallet is required to classify a directional transfer")
    user = _address(delta.get("user"))
    destination = _address(delta.get("destination"))
    if user is None or destination is None:
        raise ValueError("transfer is missing user or destination")
    if user == destination:
        raise ValueError("transfer user and destination are identical")
    if wallet == destination:
        return 1
    if wallet == user:
        return -1
    raise ValueError("wallet is neither transfer source nor destination")


def _classified(
    event: Mapping[str, Any],
    *,
    delta_type: str,
    amount: Decimal | None,
    classification: CashFlowClassification,
    confidence: str = "EXACT",
    identity: str | None = None,
) -> ClassifiedCashFlow:
    return ClassifiedCashFlow(
        time_ms=_event_time(event),
        amount_usd=amount,
        classification=classification,
        delta_type=delta_type,
        confidence=confidence,
        raw=event,
        identity=identity,
    )


def classify_non_funding_delta(
    event: Mapping[str, Any], wallet: str | None = None
) -> ClassifiedCashFlow:
    """Classify one documented Hyperliquid non-funding ledger update.

    Returned ``amount_usd`` is signed from the evaluated perp account's point
    of view.  New delta types, missing directional fields and unpriced token
    movements are *not* treated as zero: each returns ``UNKNOWN`` so callers
    must mark the wallet ``UNVERIFIABLE``.
    """

    if not isinstance(event, Mapping):
        raise ValueError("ledger event must be a mapping")
    identity: str | None
    try:
        identity = ledger_event_identity(event)
    except ValueError:
        identity = None
    delta = event.get("delta")
    if not isinstance(delta, Mapping):
        return _failure(
            event,
            delta_type="<MISSING>",
            reason_code=ReasonCode.UNKNOWN_LEDGER_DELTA_TYPE,
            message="ledger event has no typed delta mapping",
            identity=identity,
        )
    delta_type = str(delta.get("type") or "")
    focal_wallet = _address(wallet)
    try:
        if delta_type == "deposit":
            return _classified(
                event,
                delta_type=delta_type,
                amount=_exact_amount(delta, ("usdc",)),
                classification=CashFlowClassification.EXTERNAL_IN,
                identity=identity,
            )
        if delta_type == "withdraw":
            return _classified(
                event,
                delta_type=delta_type,
                amount=-_exact_amount(delta, ("usdc",)),
                classification=CashFlowClassification.EXTERNAL_OUT,
                identity=identity,
            )
        if delta_type in {"internalTransfer", "subAccountTransfer"}:
            amount = _exact_amount(delta, ("usdc",)) * _direction_for_transfer(delta, focal_wallet)
            return _classified(
                event,
                delta_type=delta_type,
                amount=amount,
                classification=(
                    CashFlowClassification.EXTERNAL_IN if amount > 0 else CashFlowClassification.EXTERNAL_OUT
                ),
                identity=identity,
            )
        if delta_type == "send":
            # Address-to-address sends expose Hyperliquid's exact USD value.
            # Direction is always taken from the evaluated wallet; token
            # amounts are never priced locally.
            amount = _exact_amount(delta, ("usdcValue",)) * _direction_for_transfer(delta, focal_wallet)
            return _classified(
                event,
                delta_type=delta_type,
                amount=amount,
                classification=(
                    CashFlowClassification.EXTERNAL_IN if amount > 0 else CashFlowClassification.EXTERNAL_OUT
                ),
                identity=identity,
            )
        if delta_type == "accountClassTransfer":
            if not isinstance(delta.get("toPerp"), bool):
                raise ValueError("accountClassTransfer is missing boolean toPerp")
            amount = _exact_amount(delta, ("usdc",))
            amount = amount if delta["toPerp"] else -amount
            return _classified(
                event,
                delta_type=delta_type,
                amount=amount,
                classification=(
                    CashFlowClassification.EXTERNAL_IN if amount > 0 else CashFlowClassification.EXTERNAL_OUT
                ),
                identity=identity,
            )
        if delta_type == "spotTransfer":
            # ``usdcValue`` is Hyperliquid's explicit USD valuation.  A token
            # amount without it is intentionally unpriceable for this metric.
            amount = _exact_amount(delta, ("usdcValue",)) * _direction_for_transfer(delta, focal_wallet)
            return _classified(
                event,
                delta_type=delta_type,
                amount=amount,
                classification=(
                    CashFlowClassification.EXTERNAL_IN if amount > 0 else CashFlowClassification.EXTERNAL_OUT
                ),
                identity=identity,
            )
        if delta_type in {"vaultCreate", "vaultDeposit"}:
            return _classified(
                event,
                delta_type=delta_type,
                amount=-_exact_amount(delta, ("usdc",)),
                classification=CashFlowClassification.EXTERNAL_OUT,
                identity=identity,
            )
        if delta_type == "vaultDistribution":
            return _classified(
                event,
                delta_type=delta_type,
                amount=_exact_amount(delta, ("usdc",)),
                classification=CashFlowClassification.EXTERNAL_IN,
                identity=identity,
            )
        if delta_type == "vaultWithdraw":
            return _classified(
                event,
                delta_type=delta_type,
                amount=_net_vault_withdrawal(delta),
                classification=CashFlowClassification.EXTERNAL_IN,
                identity=identity,
            )
        if delta_type == "vaultLeaderCommission":
            return _classified(
                event,
                delta_type=delta_type,
                amount=_exact_amount(delta, ("usdc",)),
                classification=CashFlowClassification.NON_POSITION_IN,
                identity=identity,
            )
        if delta_type in {"rewardsClaim", "referralReward", "stakingReward", "validatorReward"}:
            # The documented rewards-claim delta has a USD amount.  For newer
            # variants, an explicit ``usdc``/``usdcValue`` is required.
            if delta_type == "rewardsClaim" and str(delta.get("token") or "").upper() not in {"USDC", "USD"}:
                raise ValueError("rewardsClaim amount is not denominated in USD")
            fields = ("usdc", "usdcValue", "amount") if delta_type == "rewardsClaim" else ("usdc", "usdcValue")
            return _classified(
                event,
                delta_type=delta_type,
                amount=_exact_amount(delta, fields),
                classification=CashFlowClassification.NON_POSITION_IN,
                identity=identity,
            )
        if delta_type == "liquidation":
            # Liquidation PnL belongs in perpMonth and must never be adjusted
            # again through the non-funding ledger.
            return _classified(
                event,
                delta_type=delta_type,
                amount=Decimal("0"),
                classification=CashFlowClassification.NOT_A_CASH_FLOW,
                identity=identity,
            )
        if delta_type == "perpDexClassTransfer":
            token = str(delta.get("token") or "").upper()
            if token not in {"USDC", "USD"}:
                raise ValueError("perpDexClassTransfer has no exact USD token valuation")
            if not isinstance(delta.get("toPerp"), bool):
                raise ValueError("perpDexClassTransfer is missing boolean toPerp")
            amount = _exact_amount(delta, ("amount",))
            amount = amount if delta["toPerp"] else -amount
            return _classified(
                event,
                delta_type=delta_type,
                amount=amount,
                classification=(
                    CashFlowClassification.EXTERNAL_IN if amount > 0 else CashFlowClassification.EXTERNAL_OUT
                ),
                identity=identity,
            )
        if delta_type in {"spotGenesis", "accountActivationGas", "deployGasAuction"}:
            return _failure(
                event,
                delta_type=delta_type,
                reason_code=ReasonCode.NON_USD_FLOW_UNPRICED,
                message=f"{delta_type} has no documented exact USD valuation in this event",
                identity=identity,
            )
        if delta_type == "cStakingTransfer":
            return _failure(
                event,
                delta_type=delta_type,
                reason_code=ReasonCode.NON_USD_FLOW_UNPRICED,
                message="cStakingTransfer contains a token amount without an exact USD valuation",
                identity=identity,
            )
    except ValueError as exc:
        return _failure(
            event,
            delta_type=delta_type,
            reason_code=(
                ReasonCode.NON_USD_FLOW_UNPRICED
                if delta_type in {"spotTransfer", "spotGenesis", "perpDexClassTransfer", "send", "cStakingTransfer", "rewardsClaim"}
                else ReasonCode.UNKNOWN_LEDGER_DELTA_TYPE
            ),
            message=str(exc),
            identity=identity,
        )
    return _failure(
        event,
        delta_type=delta_type,
        reason_code=ReasonCode.UNKNOWN_LEDGER_DELTA_TYPE,
        message=f"unsupported non-funding ledger delta type: {delta_type or '<MISSING>'}",
        identity=identity,
    )


def classify_non_funding_ledger(
    events: Iterable[Mapping[str, Any]], wallet: str | None = None
) -> tuple[ClassifiedCashFlow, ...]:
    """Deduplicate then classify raw events while preserving each raw mapping."""

    return tuple(classify_non_funding_delta(event, wallet) for event in dedupe_ledger_events(events))


class LedgerCoverageTracker:
    """Collect pagination facts and make incomplete coverage explicit."""

    def __init__(self, window_start_ms: int, window_end_ms: int, *, response_cap: int = LEDGER_RESPONSE_CAP) -> None:
        if int(window_end_ms) < int(window_start_ms):
            raise ValueError("window end precedes window start")
        if response_cap <= 0:
            raise ValueError("response_cap must be positive")
        self.window_start_ms = int(window_start_ms)
        self.window_end_ms = int(window_end_ms)
        self.response_cap = response_cap
        self._pages: list[LedgerPageObservation] = []
        self._failure: str | None = None
        self._raw_events: list[Mapping[str, Any]] = []

    def observe_page(
        self,
        cursor_start_ms: int,
        events: Sequence[Mapping[str, Any]],
        *,
        response_capped: bool | None = None,
    ) -> LedgerPageObservation:
        """Record one request page.  The caller retains and persists raw events."""

        cursor = int(cursor_start_ms)
        if cursor < self.window_start_ms or cursor > self.window_end_ms:
            self._failure = "ledger cursor was outside the requested fixed window"
        if self._pages and cursor < self._pages[-1].cursor_start_ms:
            self._failure = "ledger cursor moved backwards"
        times: list[int] = []
        for event in events:
            try:
                times.append(_event_time(event))
            except ValueError:
                self._failure = "ledger page contained an invalid event timestamp"
        max_time = max(times) if times else None
        capped = len(events) >= self.response_cap if response_capped is None else bool(response_capped)
        if capped and max_time is not None and max_time <= cursor:
            self._failure = "ledger pagination stalled at a capped timestamp"
        page = LedgerPageObservation(
            cursor_start_ms=cursor,
            event_count=len(events),
            max_event_time_ms=max_time,
            request_end_ms=self.window_end_ms,
            response_capped=capped,
        )
        self._pages.append(page)
        self._raw_events.extend(events)
        return page

    def mark_failed(self, reason: str) -> None:
        """Let the pagination orchestrator preserve a bounded-loop failure."""

        self._failure = str(reason) or "ledger pagination failed"

    def finish(self) -> LedgerCoverage:
        """Return complete only after a terminal uncapped page and no cursor fault."""

        deduped = dedupe_ledger_events(self._raw_events, return_stats=True)
        assert isinstance(deduped, LedgerDeduplication)
        if self._failure:
            return LedgerCoverage(
                self.window_start_ms,
                self.window_end_ms,
                complete=False,
                reason_message=self._failure,
                pages=tuple(self._pages),
                raw_event_count=deduped.raw_event_count,
                unique_event_count=len(deduped.unique_events),
            )
        if not self._pages or self._pages[-1].response_capped:
            return LedgerCoverage(
                self.window_start_ms,
                self.window_end_ms,
                complete=False,
                reason_message="ledger pagination ended without an uncapped terminal page",
                pages=tuple(self._pages),
                raw_event_count=deduped.raw_event_count,
                unique_event_count=len(deduped.unique_events),
            )
        return LedgerCoverage(
            self.window_start_ms,
            self.window_end_ms,
            complete=True,
            pages=tuple(self._pages),
            raw_event_count=deduped.raw_event_count,
            unique_event_count=len(deduped.unique_events),
        )
