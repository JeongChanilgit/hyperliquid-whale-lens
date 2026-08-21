"""Explicit, simulation-only activation from an incomplete VERIFIED pool.

This module never writes the canonical TOP10 path.  It exists only for the
user-authorized research case where strict TWR verification produced fewer
than 2,000 candidates but enough high-quality wallets remain for paper
observation.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable, Mapping

from .cache import read_json
from .candidate import validate_candidates_until_finalists
from .report import METRIC_NAME, report_sha256, to_jsonable, write_json_atomic


SELECTION_MODE = "VERIFIED_PARTIAL_RESEARCH"


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} must be a JSON object")
    return dict(value)


def _wallet(row: Mapping[str, Any]) -> str:
    value = row.get("wallet", row.get("address"))
    if not isinstance(value, str) or not value.strip():
        raise ValueError("candidate wallet is missing")
    wallet = value.strip().lower()
    if len(wallet) != 42 or not wallet.startswith("0x"):
        raise ValueError(f"candidate wallet is invalid: {wallet}")
    return wallet


def _decimal(value: Any, label: str) -> Decimal:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be numeric") from exc
    if not parsed.is_finite():
        raise ValueError(f"{label} must be finite")
    return parsed


def _hash(value: Any) -> str:
    encoded = json.dumps(to_jsonable(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _compact(row: Mapping[str, Any]) -> dict[str, Any]:
    compact = {
        "wallet": _wallet(row),
        "candidate_rank": int(row["candidate_rank"]),
        "quality": str(row.get("quality", "")),
        METRIC_NAME: str(_decimal(row.get(METRIC_NAME), METRIC_NAME)),
        "current_account_value_usd": str(_decimal(row.get("current_account_value_usd"), "current_account_value_usd")),
    }
    for key in ("completed_episodes", "raw_fill_count", "reason_code", "reason_message"):
        if row.get(key) is not None:
            compact[key] = row[key]
    return compact


def activate_partial_research_top10(
    *,
    source_report_path: str | Path,
    source_candidate_path: str | Path,
    research_report_path: str | Path,
    research_candidate_path: str | Path,
    research_state_path: str | Path,
    fill_validator: Callable[[Mapping[str, Any]], Any],
    target_count: int = 10,
    standby_count: int = 40,
    minimum_completed_episodes: int = 10,
    authorized_at_utc: str | None = None,
) -> dict[str, Any]:
    """Validate fills, select research TOP10, and atomically write three artifacts."""

    source_report = _object(read_json(Path(source_report_path)), "source report")
    source_candidate = _object(read_json(Path(source_candidate_path)), "source candidate")
    if source_report.get("run_status") != "PARTIAL":
        raise ValueError("research override requires a PARTIAL source report")
    if source_report.get("reason_code") != "INSUFFICIENT_VERIFIED_CANDIDATES":
        raise ValueError("research override is limited to INSUFFICIENT_VERIFIED_CANDIDATES")
    if source_report.get("outside_shard_coverage_complete") is not True:
        raise ValueError("research override requires complete outside-shard coverage")
    if int(source_report.get("outside_pool_threshold_breach_count", 0)) != 0:
        raise ValueError("research override refuses an outside-pool threshold breach")
    if source_candidate.get("candidate_pool_complete") is not False:
        raise ValueError("research override requires an explicitly incomplete candidate pool")
    if source_report.get("run_id") != source_candidate.get("run_id"):
        raise ValueError("source report and candidate run_id differ")
    if source_report.get("candidate_pool_hash") != source_candidate.get("candidate_pool_hash"):
        raise ValueError("source report and candidate pool hash differ")

    raw_candidates = source_candidate.get("candidates")
    if not isinstance(raw_candidates, list) or len(raw_candidates) < target_count + standby_count:
        raise ValueError("research override requires enough VERIFIED candidates for TOP10 plus standby")
    ordered = [_object(row, "candidate") for row in raw_candidates]
    ordered.sort(key=lambda row: (int(row.get("candidate_rank", 2**31 - 1)), _wallet(row)))
    for expected_rank, row in enumerate(ordered, 1):
        if int(row.get("candidate_rank", 0)) != expected_rank:
            raise ValueError("source candidate ranks must be contiguous")
        if str(row.get("quality", "")) != "VERIFIED":
            raise ValueError("research override may use only VERIFIED candidates")
        _decimal(row.get(METRIC_NAME), METRIC_NAME)

    validation = validate_candidates_until_finalists(
        ordered,
        fill_validator,
        target_count=target_count,
        minimum_completed_episodes=minimum_completed_episodes,
        fill_validation_mode="UNTIL_10",
    )
    if not validation.complete or len(validation.finalists) != target_count:
        raise ValueError("fewer than 10 research finalists passed raw-fill episode validation")

    active_rows: list[dict[str, Any]] = []
    active_wallets: set[str] = set()
    for active_rank, raw in enumerate(validation.finalists, 1):
        row = _compact(raw)
        row.update(
            rank=active_rank,
            status="ACTIVE",
            label=f"Research TWR {active_rank:02d}",
        )
        active_rows.append(row)
        active_wallets.add(row["wallet"])

    scanned_by_wallet = {_wallet(row): row for row in validation.scanned_candidates}
    standby_rows: list[dict[str, Any]] = []
    for raw in ordered:
        wallet = _wallet(raw)
        if wallet in active_wallets:
            continue
        combined = {**raw, **scanned_by_wallet.get(wallet, {})}
        row = _compact(combined)
        rank = target_count + len(standby_rows) + 1
        row.update(rank=rank, status="PASS", label=f"Research TWR {rank:02d}")
        standby_rows.append(row)
        if len(standby_rows) == standby_count:
            break

    selected = active_rows + standby_rows
    source_run_id = str(source_report["run_id"])
    created_at = authorized_at_utc or datetime.now(timezone.utc).isoformat()
    stamp = created_at.replace("+00:00", "Z").replace("-", "").replace(":", "").replace(".", "")
    research_run_id = f"{source_run_id}-research-{stamp}"
    candidate_hash = _hash({
        "source_candidate_pool_hash": source_candidate["candidate_pool_hash"],
        "selected": selected,
    })
    compact_candidate = {
        "run_id": research_run_id,
        "source_run_id": source_run_id,
        "selection_mode": SELECTION_MODE,
        "metric_name": METRIC_NAME,
        "candidate_pool_hash": candidate_hash,
        "source_candidate_pool_hash": source_candidate["candidate_pool_hash"],
        "candidate_count_requested": source_candidate.get("candidate_count_requested"),
        "candidate_count_actual": source_candidate.get("candidate_count_actual"),
        "candidate_pool_complete": False,
        "fills_scanned_candidate_count": validation.fills_scanned_candidate_count,
        "minimum_completed_episodes": minimum_completed_episodes,
        "candidates": selected,
    }
    compact_report = {
        "run_id": research_run_id,
        "source_run_id": source_run_id,
        "as_of_ms": source_report["as_of_ms"],
        "window_start_ms": source_report["window_start_ms"],
        "window_end_ms": source_report["window_end_ms"],
        "metric_name": source_report.get("metric_name", METRIC_NAME),
        "metric_version": source_report.get("metric_version"),
        "coverage_mode": source_report["coverage_mode"],
        "ranking_scope": source_report["ranking_scope"],
        "config_hash": source_report["config_hash"],
        "candidate_pool_hash": candidate_hash,
        "source_candidate_pool_hash": source_candidate["candidate_pool_hash"],
        "source_report_sha256": report_sha256(source_report),
        "run_status": "PARTIAL_RESEARCH_OVERRIDE",
        "source_run_status": source_report["run_status"],
        "source_reason_code": source_report["reason_code"],
        "canonical_state_updated": False,
        "research_override_authorized": True,
        "selection_mode": SELECTION_MODE,
        "candidate_count_requested": source_report["candidate_count_requested"],
        "candidate_count_actual": source_report["candidate_count_actual"],
        "outside_shard_coverage_complete": True,
        "outside_pool_threshold_breach_count": 0,
        "minimum_completed_episodes": minimum_completed_episodes,
        "fills_scanned_candidate_count": validation.fills_scanned_candidate_count,
        "finalist_count": len(active_rows),
        "target_count": target_count,
        "finalists": active_rows,
        "top50": selected,
        "authorized_at_utc": created_at,
    }
    state = {
        "run_id": research_run_id,
        "source_run_id": source_run_id,
        "as_of_ms": compact_report["as_of_ms"],
        "metric_name": compact_report["metric_name"],
        "metric_version": compact_report["metric_version"],
        "coverage_mode": compact_report["coverage_mode"],
        "ranking_scope": compact_report["ranking_scope"],
        "window_start_ms": compact_report["window_start_ms"],
        "window_end_ms": compact_report["window_end_ms"],
        "wallets": [row["wallet"] for row in active_rows],
        "finalists": active_rows,
        "config_hash": compact_report["config_hash"],
        "candidate_pool_hash": candidate_hash,
        "source_candidate_pool_hash": source_candidate["candidate_pool_hash"],
        "report_sha256": report_sha256(compact_report),
        "created_at_utc": created_at,
        "run_status": "PARTIAL_RESEARCH_OVERRIDE",
        "canonical_state_updated": False,
        "research_override_authorized": True,
        "selection_mode": SELECTION_MODE,
    }

    write_json_atomic(research_candidate_path, compact_candidate)
    write_json_atomic(research_report_path, compact_report)
    write_json_atomic(research_state_path, state)
    return {"state": state, "report": compact_report, "candidate": compact_candidate}


__all__ = ["SELECTION_MODE", "activate_partial_research_top10"]
