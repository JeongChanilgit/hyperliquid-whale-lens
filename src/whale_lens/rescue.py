"""Account-preserving rescue orchestration and ranking/watchlist views."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

from .cache import RawResponseCache, make_raw_cache_key
from .evidence_registry import (
    ActivityStatus,
    DataQualityStatus,
    EvidenceRegistry,
    EXACT_RANKING_QUALITIES,
    RESCUE_ENGINE_VERSION,
    SelectionStatus,
)
from .interval_twr import calculate_interval_rescue
from .models import CashFlowClassification, CashFlowEvent, ClassifiedCashFlow, PerpPortfolioSample
from .reconciliation import reconcile_blocks
from .valuation import recover_flow_value


METRIC = "perp_cashflow_neutral_twr_30d"


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return result if result.is_finite() else None


def _cache_key(report: Mapping[str, Any], wallet: str, endpoint: str):
    return make_raw_cache_key(
        wallet=wallet,
        endpoint=endpoint,
        window_start_ms=int(report["window_start_ms"]),
        window_end_ms=int(report["window_end_ms"]),
        as_of_ms=int(report["as_of_ms"]),
        metric_version=str(report.get("metric_version", "1")),
        raw_payload_schema_version="1",
        coverage_mode=str(report["coverage_mode"]),
    )


def _sample(value: Mapping[str, Any]) -> PerpPortfolioSample:
    return PerpPortfolioSample(
        time_ms=int(value["time_ms"]),
        account_value=Decimal(str(value["account_value"])),
        cumulative_pnl=Decimal(str(value["cumulative_pnl"])),
        account_source_time_ms=value.get("account_source_time_ms"),
        pnl_source_time_ms=value.get("pnl_source_time_ms"),
    )


def _classified(value: Mapping[str, Any]) -> ClassifiedCashFlow:
    return ClassifiedCashFlow(
        time_ms=int(value["time_ms"]),
        amount_usd=value.get("amount_usd"),
        classification=value.get("classification", "UNKNOWN"),
        delta_type=str(value.get("delta_type") or "<MISSING>"),
        confidence=str(value.get("confidence") or "UNVERIFIABLE"),
        raw=value.get("raw") if isinstance(value.get("raw"), Mapping) else {},
        reason_code=value.get("reason_code"),
        reason_message=value.get("reason_message"),
        identity=value.get("identity"),
    )


def _event_from_valuation(flow: ClassifiedCashFlow, result: Any) -> CashFlowEvent | None:
    if result.classification == CashFlowClassification.NOT_A_CASH_FLOW.value:
        return None
    amount = result.flow_usd_point
    if amount is None or not result.exact:
        return None
    return CashFlowEvent(
        flow.time_ms,
        amount,
        flow.delta_type,
        result.classification,
        raw=flow.raw,
        identity=flow.identity,
    )


def _reason_list(row: Mapping[str, Any]) -> list[str]:
    reasons = row.get("reason_codes")
    values = [str(item) for item in reasons] if isinstance(reasons, list) else []
    single = row.get("reason_code")
    if single and single != "VALID":
        values.append(str(single))
    return sorted(set(values))


def _activity(fill_result: Mapping[str, Any] | None, minimum_completed_episodes: int) -> tuple[ActivityStatus, int | None, int]:
    if not fill_result:
        return ActivityStatus.NOT_YET_SCANNED, None, 0
    raw_count = int(fill_result.get("raw_fill_count", 0))
    if not fill_result.get("valid"):
        return ActivityStatus.ACTIVITY_UNVERIFIABLE, None, raw_count
    completed = int(fill_result.get("completed_episodes", len(fill_result.get("episodes") or [])))
    return (
        ActivityStatus.QUALIFIED if completed >= minimum_completed_episodes else ActivityStatus.INSUFFICIENT_COMPLETED_EPISODES,
        completed,
        raw_count,
    )


@dataclass(frozen=True)
class RescueEvaluation:
    wallet: str
    data_quality_status: DataQualityStatus
    activity_status: ActivityStatus
    selection_status: SelectionStatus
    source_reason_codes: tuple[str, ...]
    reason_codes: tuple[str, ...]
    latest_scores: Mapping[str, str | None]
    account_value_usd: str | None
    raw_fill_count_30d: int
    completed_episodes_30d: int | None
    diagnostics: Mapping[str, Any]
    rescue_priority_score: Decimal = Decimal("0")

    def to_dict(self) -> dict[str, Any]:
        return {
            "wallet": self.wallet,
            "data_quality_status": self.data_quality_status.value,
            "activity_status": self.activity_status.value,
            "selection_status": self.selection_status.value,
            "source_reason_codes": list(self.source_reason_codes),
            "reason_codes": list(self.reason_codes),
            "latest_scores": dict(self.latest_scores),
            "account_value_usd": self.account_value_usd,
            "raw_fill_count_30d": self.raw_fill_count_30d,
            "completed_episodes_30d": self.completed_episodes_30d,
            "diagnostics": dict(self.diagnostics),
            "rescue_priority_score": str(self.rescue_priority_score),
        }


def evaluate_account(
    row: Mapping[str, Any],
    *,
    samples: Sequence[PerpPortfolioSample] = (),
    classified_flows: Sequence[ClassifiedCashFlow] = (),
    fill_result: Mapping[str, Any] | None = None,
    minimum_completed_episodes: int = 10,
) -> RescueEvaluation:
    wallet = str(row["wallet"]).lower()
    provisional = _decimal(row.get("provisional_perp_twr_30d"))
    exact = _decimal(row.get(METRIC)) if str(row.get("quality")) == "VERIFIED" else None
    source_reasons = tuple(_reason_list(row))
    reasons = set(source_reasons)
    activity, completed, raw_fills = _activity(fill_result, minimum_completed_episodes)
    scores: dict[str, str | None] = {
        "provisional_twr": None if provisional is None else str(provisional),
        "exact_twr": None if exact is None else str(exact),
        "estimated_twr": None,
        "twr_lower_bound": None,
        "twr_upper_bound": None,
    }
    diagnostics: dict[str, Any] = {}
    if exact is not None:
        quality = DataQualityStatus.VERIFIED_EXACT
    else:
        exact_events: list[CashFlowEvent] = []
        unresolved_flows = 0
        valuations = []
        for flow in classified_flows:
            valuation = recover_flow_value(flow)
            valuations.append(valuation.to_dict())
            reasons.update(valuation.reason_codes)
            event = flow.to_event() if not flow.is_unverifiable else _event_from_valuation(flow, valuation)
            if event is not None:
                exact_events.append(event)
            elif valuation.classification != CashFlowClassification.NOT_A_CASH_FLOW.value:
                unresolved_flows += 1
        diagnostics["valuations"] = valuations
        quality = DataQualityStatus.RESCUE_PENDING
        if samples and unresolved_flows == 0:
            if "RECONCILIATION_RESIDUAL_TOO_LARGE" in reasons:
                block = reconcile_blocks(samples, exact_events)
                diagnostics["block_reconciliation"] = block.to_dict()
                reasons.update(block.reason_codes)
                quality = DataQualityStatus(block.data_quality_status)
                if block.twr is not None:
                    scores["exact_twr"] = str(block.twr)
                scores["twr_lower_bound"] = None if block.twr_lower_bound is None else str(block.twr_lower_bound)
                scores["twr_upper_bound"] = None if block.twr_upper_bound is None else str(block.twr_upper_bound)
            else:
                interval = calculate_interval_rescue(samples, exact_events)
                diagnostics["interval_rescue"] = interval.to_dict()
                reasons.update(interval.reason_codes)
                quality = DataQualityStatus(interval.data_quality_status)
                scores["exact_twr"] = None if interval.exact_twr is None else str(interval.exact_twr)
                scores["estimated_twr"] = None if interval.estimated_twr is None else str(interval.estimated_twr)
                scores["twr_lower_bound"] = None if interval.twr_lower_bound is None else str(interval.twr_lower_bound)
                scores["twr_upper_bound"] = None if interval.twr_upper_bound is None else str(interval.twr_upper_bound)
        elif samples:
            quality = DataQualityStatus.UNRESOLVED
            reasons.add("UNRESOLVED_VALUE_CONFLICT" if valuations else "RAW_LEDGER_VALUE_MISSING")
        else:
            quality = DataQualityStatus.UNRESOLVED
            reasons.add("WINDOW_EDGE_COVERAGE_GAP")
    if quality in EXACT_RANKING_QUALITIES:
        selection = SelectionStatus.STANDBY
    elif scores["twr_lower_bound"] is not None or scores["estimated_twr"] is not None or provisional is not None:
        selection = SelectionStatus.HIGH_POTENTIAL_WATCHLIST
    else:
        selection = SelectionStatus.WATCHLIST
    return RescueEvaluation(
        wallet=wallet,
        data_quality_status=quality,
        activity_status=activity,
        selection_status=selection,
        source_reason_codes=source_reasons,
        reason_codes=tuple(sorted(reasons)),
        latest_scores=scores,
        account_value_usd=None if row.get("current_account_value_usd") is None else str(row.get("current_account_value_usd")),
        raw_fill_count_30d=raw_fills,
        completed_episodes_30d=completed,
        diagnostics=diagnostics,
    )


def _percentiles(values: Sequence[Decimal | None]) -> list[Decimal]:
    present = sorted(value for value in values if value is not None)
    if not present:
        return [Decimal("0") for _ in values]
    denominator = Decimal(max(1, len(present) - 1))
    return [Decimal("0") if value is None else Decimal(present.index(value)) / denominator for value in values]


def assign_rescue_priorities(evaluations: Sequence[RescueEvaluation]) -> tuple[RescueEvaluation, ...]:
    provisional = [_decimal(item.latest_scores.get("provisional_twr")) for item in evaluations]
    upper = [_decimal(item.latest_scores.get("twr_upper_bound")) for item in evaluations]
    activity = [Decimal(item.raw_fill_count_30d) for item in evaluations]
    account = [_decimal(item.account_value_usd) for item in evaluations]
    percentiles = [_percentiles(values) for values in (provisional, upper, activity, account)]
    result: list[RescueEvaluation] = []
    for index, item in enumerate(evaluations):
        recoverability = Decimal("1") if item.data_quality_status in {DataQualityStatus.RESCUE_PENDING, DataQualityStatus.BOUNDED, DataQualityStatus.ESTIMATED_MODIFIED_DIETZ} else Decimal("0.25")
        priority = (
            Decimal("0.30") * percentiles[0][index]
            + Decimal("0.30") * percentiles[1][index]
            + Decimal("0.15") * percentiles[2][index]
            + Decimal("0.10") * percentiles[3][index]
            + Decimal("0.10") * recoverability
            + Decimal("0.05")
        )
        result.append(RescueEvaluation(**{**item.__dict__, "rescue_priority_score": priority}))
    return tuple(result)


def _next_actions(reasons: Iterable[str]) -> list[str]:
    values = set(reasons)
    actions: list[str] = []
    if values & {"CASHFLOW_BOUNDARY_MISSING", "FLOW_BETWEEN_SAMPLES", "WINDOW_EDGE_COVERAGE_GAP"}:
        actions.extend(["INTERVAL_MATCH", "FETCH_GUARD_SAMPLES"])
    if values & {"RECONCILIATION_RESIDUAL_TOO_LARGE", "PERSISTENT_UNEXPLAINED_RESIDUAL", "PERSISTENT_STEP_RESIDUAL"}:
        actions.extend(["BLOCK_RECONCILIATION", "FETCH_EVENT_TIME_EQUITY"])
    if values & {"NON_USD_FLOW_UNPRICED", "RAW_LEDGER_VALUE_MISSING", "UNPRICED_TOKEN", "UNRESOLVED_VALUE_CONFLICT"}:
        actions.extend(["RECLASSIFY_ACCOUNT_CLASS", "FETCH_RAW_LEDGER", "FETCH_EVENT_PRICE"])
    return sorted(set(actions or ["RETRY_WITH_NEW_DATA"]))


def _group_outcomes(evaluations: Sequence[RescueEvaluation], source_reason: str) -> dict[str, Any]:
    group = [item for item in evaluations if source_reason in item.source_reason_codes]
    qualities = Counter(item.data_quality_status.value for item in group)
    result: dict[str, Any] = {"total": len(group), "quality_counts": dict(sorted(qualities.items()))}
    if source_reason == "CASHFLOW_BOUNDARY_MISSING":
        buckets = Counter()
        for item in group:
            interval = item.diagnostics.get("interval_rescue") if isinstance(item.diagnostics, Mapping) else None
            for diagnostic in (interval.get("diagnostics", []) if isinstance(interval, Mapping) else []):
                for code in diagnostic.get("reason_codes", []):
                    if str(code).startswith("BOUNDARY_DISTANCE_"):
                        buckets[str(code)] += 1
        result["boundary_distance_counts"] = dict(sorted(buckets.items()))
    elif source_reason == "RECONCILIATION_RESIDUAL_TOO_LARGE":
        blocks = Counter()
        patterns = Counter()
        for item in group:
            block = item.diagnostics.get("block_reconciliation") if isinstance(item.diagnostics, Mapping) else None
            if isinstance(block, Mapping):
                for value in block.get("blocks", []):
                    if int(value.get("interval_count", 1)) in {2, 4, 8}:
                        blocks[f"block{value['interval_count']}"] += 1
                for value in block.get("residuals", []):
                    patterns[str(value.get("pattern"))] += 1
        result["reconciled_block_counts"] = dict(sorted(blocks.items()))
        result["residual_pattern_counts"] = dict(sorted(patterns.items()))
    elif source_reason == "NON_USD_FLOW_UNPRICED":
        valuation = Counter()
        for item in group:
            for value in item.diagnostics.get("valuations", []):
                for code in value.get("reason_codes", []):
                    valuation[str(code)] += 1
        result["valuation_reason_counts"] = dict(sorted(valuation.items()))
    return result


def _audit_sample(evaluations: Sequence[RescueEvaluation], source_reason: str, size: int = 50) -> list[dict[str, Any]]:
    rows = [item for item in evaluations if source_reason in item.source_reason_codes]
    ordered = sorted(rows, key=lambda item: hashlib.sha256(f"{source_reason}|{item.wallet}".encode()).hexdigest())
    return [item.to_dict() for item in ordered[:size]]


def build_rescue_report(
    source_report: Mapping[str, Any],
    *,
    cache: RawResponseCache,
    registry: EvidenceRegistry,
    progress: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    rows = [dict(row) for row in source_report.get("wallets", []) if isinstance(row, Mapping) and row.get("wallet")]
    evaluations: list[RescueEvaluation] = []
    artifact_refs: dict[str, list[Any]] = {}
    for row_index, row in enumerate(rows, 1):
        wallet = str(row["wallet"]).lower()
        refs = []
        portfolio_raw = cache.get(_cache_key(source_report, wallet, "portfolio"))
        if portfolio_raw is not None:
            refs.append(registry.preserve_raw_artifact(endpoint="portfolio", run_id=str(source_report["run_id"]), captured_at_ms=int(source_report["as_of_ms"]), wallet=wallet, request_identity=_cache_key(source_report, wallet, "portfolio").to_dict(), payload=portfolio_raw))
        normalized_payload = cache.get(_cache_key(source_report, wallet, "portfolio-normalized-provisional"))
        normalization = normalized_payload.get("normalization") if isinstance(normalized_payload, Mapping) else None
        samples = tuple(_sample(value) for value in normalization.get("samples", []) if isinstance(value, Mapping)) if isinstance(normalization, Mapping) else ()
        ledger_payload = cache.get(_cache_key(source_report, wallet, "ledger-normalized-verified"))
        classified = tuple(_classified(value) for value in ledger_payload.get("classified_cashflows", []) if isinstance(value, Mapping)) if isinstance(ledger_payload, Mapping) else ()
        if ledger_payload is not None:
            refs.append(registry.preserve_raw_artifact(endpoint="ledger-normalized-verified", run_id=str(source_report["run_id"]), captured_at_ms=int(source_report["as_of_ms"]), wallet=wallet, request_identity=_cache_key(source_report, wallet, "ledger-normalized-verified").to_dict(), payload=ledger_payload))
        fill_payload = cache.get(_cache_key(source_report, wallet, "fills-normalized-episodes"))
        fill_result = fill_payload.get("result") if isinstance(fill_payload, Mapping) and isinstance(fill_payload.get("result"), Mapping) else None
        if fill_payload is not None:
            refs.append(registry.preserve_raw_artifact(endpoint="fills-normalized-episodes", run_id=str(source_report["run_id"]), captured_at_ms=int(source_report["as_of_ms"]), wallet=wallet, request_identity=_cache_key(source_report, wallet, "fills-normalized-episodes").to_dict(), payload=fill_payload))
        artifact_refs[wallet] = refs
        evaluations.append(
            evaluate_account(
                row,
                samples=samples,
                classified_flows=classified,
                fill_result=fill_result,
                minimum_completed_episodes=int(source_report.get("minimum_completed_episodes", 10)),
            )
        )
        if progress and (row_index % 250 == 0 or row_index == len(rows)):
            progress(f"rescue evidence {row_index}/{len(rows)}")
    evaluations = list(assign_rescue_priorities(evaluations))
    exact = sorted(
        (item for item in evaluations if item.data_quality_status in EXACT_RANKING_QUALITIES and _decimal(item.latest_scores.get("exact_twr")) is not None),
        key=lambda item: (-(_decimal(item.latest_scores.get("exact_twr")) or Decimal("-Infinity")), item.wallet),
    )
    watchlist = sorted(
        (item for item in evaluations if item.data_quality_status not in EXACT_RANKING_QUALITIES),
        key=lambda item: (
            -(_decimal(item.latest_scores.get("twr_lower_bound")) or Decimal("-Infinity")),
            -(_decimal(item.latest_scores.get("twr_upper_bound")) or Decimal("-Infinity")),
            -(_decimal(item.latest_scores.get("estimated_twr")) or Decimal("-Infinity")),
            -item.rescue_priority_score,
            item.wallet,
        ),
    )
    exact_rank = {item.wallet: index for index, item in enumerate(exact, 1)}
    for item in evaluations:
        refs = artifact_refs[item.wallet]
        registry.record_account(
            wallet=item.wallet,
            seen_at_ms=int(source_report["as_of_ms"]),
            run_id=str(source_report["run_id"]),
            discovery={"source": "SCREENING_POOL"},
            evaluation={**item.to_dict(), "exact_rank": exact_rank.get(item.wallet), "rescue_engine_version": RESCUE_ENGINE_VERSION},
            raw_artifact_refs=refs,
            latest_scores=item.latest_scores,
            data_quality_status=item.data_quality_status,
            activity_status=item.activity_status,
            selection_status=item.selection_status,
            reason_codes=item.reason_codes,
            last_known_account_value_usd=item.account_value_usd,
            last_known_completed_episodes=item.completed_episodes_30d,
            rescue_attempt={"attempted_at_ms": int(source_report["as_of_ms"]), "outcome": item.data_quality_status.value, "reason_codes": list(item.reason_codes)},
        )
    queue = [
        {
            "wallet": item.wallet,
            "priority": str(item.rescue_priority_score),
            "reason_codes": list(item.reason_codes),
            "next_actions": _next_actions(item.reason_codes),
            "attempt_count": 1,
            "last_attempt_at_ms": int(source_report["as_of_ms"]),
            "next_retry_at_ms": int(source_report["as_of_ms"]) + 86_400_000,
        }
        for item in evaluations
        if item.data_quality_status not in EXACT_RANKING_QUALITIES
    ]
    registry.write_rescue_queue(queue)
    quality_counts = Counter(item.data_quality_status.value for item in evaluations)
    reason_counts = Counter(reason for item in evaluations for reason in item.reason_codes)
    report = {
        "schema_version": "1",
        "rescue_engine_version": RESCUE_ENGINE_VERSION,
        "source_run_id": source_report["run_id"],
        "as_of_ms": source_report["as_of_ms"],
        "window_start_ms": source_report["window_start_ms"],
        "window_end_ms": source_report["window_end_ms"],
        "discovered_accounts": len(evaluations),
        "quality_counts": dict(sorted(quality_counts.items())),
        "reason_counts": dict(sorted(reason_counts.items())),
        "rescue_outcomes": {
            "cashflow_boundary": _group_outcomes(evaluations, "CASHFLOW_BOUNDARY_MISSING"),
            "reconciliation": _group_outcomes(evaluations, "RECONCILIATION_RESIDUAL_TOO_LARGE"),
            "unpriced_flow": _group_outcomes(evaluations, "NON_USD_FLOW_UNPRICED"),
        },
        "audit_samples": {
            "cashflow_boundary": _audit_sample(evaluations, "CASHFLOW_BOUNDARY_MISSING"),
            "reconciliation": _audit_sample(evaluations, "RECONCILIATION_RESIDUAL_TOO_LARGE"),
            "unpriced_flow": _audit_sample(evaluations, "NON_USD_FLOW_UNPRICED"),
        },
        "exact_ranking": [{"rank": index, **item.to_dict()} for index, item in enumerate(exact, 1)],
        "high_potential_watchlist": [item.to_dict() for item in watchlist],
        "accounts": [item.to_dict() for item in sorted(evaluations, key=lambda value: value.wallet)],
        "rescue_queue_count": len(queue),
        "source_report_sha256": hashlib.sha256(json.dumps(source_report, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest(),
    }
    registry.write_run_manifest(str(source_report["run_id"]), {"as_of_ms": source_report["as_of_ms"], "account_count": len(evaluations), "quality_counts": report["quality_counts"], "rescue_queue_count": len(queue), "source_report_sha256": report["source_report_sha256"]})
    return report


def select_trade_qualified_top10(rescue_report: Mapping[str, Any], *, target_count: int = 10) -> list[dict[str, Any]]:
    """Select exact-return accounts with at least one observed 30D raw fill."""

    rows = [dict(row) for row in rescue_report.get("exact_ranking", []) if isinstance(row, Mapping)]
    selected = [row for row in rows if int(row.get("raw_fill_count_30d", 0)) >= 1][:target_count]
    if len(selected) != target_count:
        raise ValueError(f"only {len(selected)} exact accounts have at least one verified/cached 30D trade")
    return selected


def build_rescue_markdown(report: Mapping[str, Any]) -> str:
    counts = report.get("quality_counts") if isinstance(report.get("quality_counts"), Mapping) else {}
    lines = [
        "# Account preservation and rescue report",
        "",
        f"- Source run: `{report.get('source_run_id')}`",
        f"- Preserved accounts: **{report.get('discovered_accounts', 0)}**",
        f"- Rescue queue: **{report.get('rescue_queue_count', 0)}**",
        "",
        "## Quality counts",
        "",
    ]
    lines.extend(f"- `{key}`: {value}" for key, value in sorted(counts.items()))
    lines.extend(["", "## Exact ranking", ""])
    for row in list(report.get("exact_ranking") or [])[:50]:
        lines.append(
            f"- {row.get('rank')}. `{row.get('wallet')}` — "
            f"{(row.get('latest_scores') or {}).get('exact_twr')} / {row.get('activity_status')}"
        )
    lines.extend(["", "## High-potential watchlist", ""])
    for row in list(report.get("high_potential_watchlist") or [])[:50]:
        scores = row.get("latest_scores") or {}
        lines.append(
            f"- `{row.get('wallet')}` — {row.get('data_quality_status')} / "
            f"lower={scores.get('twr_lower_bound')} upper={scores.get('twr_upper_bound')} "
            f"estimate={scores.get('estimated_twr')} priority={row.get('rescue_priority_score')}"
        )
    return "\n".join(lines) + "\n"


__all__ = [
    "RescueEvaluation",
    "assign_rescue_priorities",
    "build_rescue_report",
    "build_rescue_markdown",
    "evaluate_account",
    "select_trade_qualified_top10",
]
