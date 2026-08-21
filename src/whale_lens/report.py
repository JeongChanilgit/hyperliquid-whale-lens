"""Schema builders and fail-closed atomic output for the screening pipeline."""

from __future__ import annotations

from dataclasses import asdict, dataclass, is_dataclass
from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum
from hashlib import sha256
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Iterable, Mapping, Sequence

from .cache import atomic_replace_with_retry


METRIC_NAME = "perp_cashflow_neutral_twr_30d"
METRIC_VERSION = "1"
REASON_CANONICAL_BLOCKED = "CANONICAL_UPDATE_BLOCKED"


def to_jsonable(value: Any) -> Any:
    """Convert Decimal/dataclass values without silently coercing precision."""

    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, Enum):
        return value.value
    if is_dataclass(value):
        return to_jsonable(asdict(value))
    if isinstance(value, Mapping):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (tuple, list, set)):
        return [to_jsonable(item) for item in value]
    return value


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(to_jsonable(value), sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def report_sha256(report: Mapping[str, Any]) -> str:
    return sha256(canonical_json_bytes(report)).hexdigest()


def build_report_metadata(**overrides: Any) -> dict[str, Any]:
    """Build the required report metadata with explicit honest-coverage defaults."""

    defaults: dict[str, Any] = {
        "metric_name": METRIC_NAME,
        "metric_version": METRIC_VERSION,
        "run_id": None,
        "as_of_ms": None,
        "window_start_ms": None,
        "window_end_ms": None,
        "coverage_mode": "FAST_INCREMENTAL",
        "ranking_scope": "DISCOVERY_POOL_EXACT",
        "coverage_complete": False,
        "eligible_universe_count": 0,
        "discovery_pool_target": 6000,
        "discovery_pool_min": 5000,
        "discovery_pool_max": 7000,
        "discovery_pool_actual": 0,
        "discovery_signal_quotas": {
            "month_roi": 3000,
            "month_pnl": 2000,
            "turnover": 2000,
            "prior_verified": 2000,
            "new_wallets": 500,
            "rotating_sample": 500,
        },
        "provisional_scored_count": 0,
        "ledger_verification_initial_count": 2500,
        "ledger_verification_actual_count": 0,
        "verified_scored_count": 0,
        "boundary_probe_count": 0,
        "boundary_breach_count": 0,
        "candidate_count_requested": 2000,
        "candidate_count_actual": 0,
        "candidate_pool_complete": False,
        "candidate_pool_hash": None,
        "minimum_completed_episodes": 10,
        "fill_validation_mode": "UNTIL_10",
        "fills_scanned_candidate_count": 0,
        "outside_pool_sample_count": 0,
        "outside_pool_threshold_breach_count": 0,
        "discovery_cycle_id": None,
        "canonical_state_updated": False,
        "run_status": "PARTIAL",
    }
    defaults.update(overrides)
    return defaults


def build_run_report(
    metadata: Mapping[str, Any],
    wallet_rows: Iterable[Mapping[str, Any] | Any],
    *,
    candidate_rows: Iterable[Mapping[str, Any] | Any] = (),
    finalist_rows: Iterable[Mapping[str, Any] | Any] = (),
    errors: Iterable[Mapping[str, Any] | Any] = (),
) -> dict[str, Any]:
    """Build the JSON schema shared by discovery, candidate, and runner steps."""

    report = build_report_metadata(**dict(metadata))
    report["wallets"] = [to_jsonable(row) for row in wallet_rows]
    report["candidate_top2000"] = [to_jsonable(row) for row in candidate_rows]
    report["finalists"] = [to_jsonable(row) for row in finalist_rows]
    report["errors"] = [to_jsonable(row) for row in errors]
    report["finalist_count"] = len(report["finalists"])
    return report


def build_markdown_report(report: Mapping[str, Any]) -> str:
    """Produce a compact human-readable companion without changing JSON facts."""

    lines = [
        "# Perps cash-flow-neutral TWR screening run",
        "",
        f"- Run: `{report.get('run_id')}`",
        f"- Metric: `{report.get('metric_name')}` v{report.get('metric_version')}",
        f"- Coverage: `{report.get('coverage_mode')}` / `{report.get('ranking_scope')}`",
        f"- Candidate pool: {report.get('candidate_count_actual', 0)}/{report.get('candidate_count_requested', 0)}",
        f"- Candidate complete: `{report.get('candidate_pool_complete')}`",
        f"- Boundary breaches: {report.get('boundary_breach_count', 0)}",
        f"- Outside-pool threshold breaches: {report.get('outside_pool_threshold_breach_count', 0)}",
        f"- Fill validation: `{report.get('fill_validation_mode')}`; scanned {report.get('fills_scanned_candidate_count', 0)}",
        f"- Finalists: {report.get('finalist_count', len(report.get('finalists', [])))}",
        f"- Canonical state updated: `{report.get('canonical_state_updated')}`",
        "",
        "## Active wallets",
        "",
    ]
    finalists = report.get("finalists", [])
    if finalists:
        lines.extend(
            f"- `{row.get('wallet')}` — {row.get(METRIC_NAME)}" for row in finalists if isinstance(row, Mapping)
        )
    else:
        lines.append("- None (run is incomplete or no qualifying finalist was found).")
    return "\n".join(lines) + "\n"


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        atomic_replace_with_retry(temporary, path)
    except Exception:
        try:
            temporary.unlink(missing_ok=True)
        finally:
            raise


def write_json_atomic(path: str | Path, value: Mapping[str, Any]) -> str:
    """Atomically write canonical JSON and return its content SHA-256."""

    target = Path(path)
    data = json.dumps(to_jsonable(value), ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8") + b"\n"
    _atomic_write_bytes(target, data)
    return sha256(canonical_json_bytes(value)).hexdigest()


def write_text_atomic(path: str | Path, text: str) -> None:
    _atomic_write_bytes(Path(path), text.encode("utf-8"))


def write_report_bundle(
    report: Mapping[str, Any],
    *,
    run_json_path: str | Path,
    latest_json_path: str | Path | None = None,
    run_markdown_path: str | Path | None = None,
    latest_markdown_path: str | Path | None = None,
) -> str:
    """Write report artifacts before any caller attempts a canonical update."""

    digest = write_json_atomic(run_json_path, report)
    if latest_json_path is not None:
        write_json_atomic(latest_json_path, report)
    markdown = build_markdown_report(report)
    if run_markdown_path is not None:
        write_text_atomic(run_markdown_path, markdown)
    if latest_markdown_path is not None:
        write_text_atomic(latest_markdown_path, markdown)
    return digest


CANONICAL_REQUIRED_FIELDS = (
    "run_id",
    "as_of_ms",
    "metric_name",
    "metric_version",
    "coverage_mode",
    "ranking_scope",
    "window_start_ms",
    "window_end_ms",
    "wallets",
    "config_hash",
    "candidate_pool_hash",
    "report_sha256",
)


def build_canonical_state(
    report: Mapping[str, Any],
    finalists: Iterable[Mapping[str, Any] | Any],
    *,
    config_hash: str,
    report_digest: str | None = None,
) -> dict[str, Any]:
    """Build (but do not write) the canonical TOP 10 source-of-truth state."""

    final_rows = [to_jsonable(row) for row in finalists]
    wallets: list[str] = []
    for row in final_rows:
        if not isinstance(row, Mapping) or not isinstance(row.get("wallet"), str) or not row["wallet"].strip():
            raise ValueError("canonical finalists must each contain a wallet")
        wallets.append(row["wallet"])
    return {
        "run_id": report.get("run_id"),
        "as_of_ms": report.get("as_of_ms"),
        "metric_name": report.get("metric_name", METRIC_NAME),
        "metric_version": report.get("metric_version", METRIC_VERSION),
        "coverage_mode": report.get("coverage_mode"),
        "ranking_scope": report.get("ranking_scope"),
        "window_start_ms": report.get("window_start_ms"),
        "window_end_ms": report.get("window_end_ms"),
        "wallets": wallets,
        "finalists": final_rows,
        "config_hash": config_hash,
        "candidate_pool_hash": report.get("candidate_pool_hash"),
        "report_sha256": report_digest or report_sha256(report),
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
    }


def _missing_canonical_fields(state: Mapping[str, Any]) -> list[str]:
    missing: list[str] = []
    for key in CANONICAL_REQUIRED_FIELDS:
        value = state.get(key)
        if value is None:
            missing.append(key)
        elif key in {"as_of_ms", "window_start_ms", "window_end_ms"}:
            if not isinstance(value, int):
                missing.append(key)
        elif key == "wallets":
            if not isinstance(value, list) or any(not isinstance(wallet, str) or not wallet.strip() for wallet in value):
                missing.append(key)
        elif not isinstance(value, str) or not value.strip():
            missing.append(key)
    return missing


def canonical_update_block_reasons(
    report: Mapping[str, Any],
    canonical_state: Mapping[str, Any],
    *,
    runner_candidate_pool_hash: str | None = None,
) -> tuple[str, ...]:
    """Return every fail-closed reason; never infer missing success evidence."""

    reasons: list[str] = []
    requested = int(report.get("candidate_count_requested", 2000))
    actual = int(report.get("candidate_count_actual", 0))
    finalist_count = int(report.get("finalist_count", len(report.get("finalists", []))))
    minimum_finalists = int(report.get("target_count", 10))
    if report.get("run_status") != "COMPLETE":
        reasons.append("RUN_NOT_COMPLETE")
    if not report.get("candidate_pool_complete") or actual < requested:
        reasons.append("CANDIDATE_POOL_INCOMPLETE")
    if report.get("reason_code") in {"BOUNDARY_UNSTABLE", "CANDIDATE_POOL_INCOMPLETE"}:
        reasons.append(str(report.get("reason_code")))
    if int(report.get("outside_pool_threshold_breach_count", 0)) > 0:
        reasons.append("OUTSIDE_POOL_THRESHOLD_BREACH")
    if report.get("coverage_mode") == "FULL_DISCOVERY_REFRESH" and not report.get("coverage_complete"):
        reasons.append("FULL_DISCOVERY_REFRESH_INCOMPLETE")
    if finalist_count < minimum_finalists or len(canonical_state.get("wallets", [])) < minimum_finalists:
        reasons.append("INSUFFICIENT_FINALISTS")
    if report.get("candidate_pool_hash") != canonical_state.get("candidate_pool_hash"):
        reasons.append("CANDIDATE_POOL_HASH_MISMATCH")
    if runner_candidate_pool_hash is not None and runner_candidate_pool_hash != canonical_state.get("candidate_pool_hash"):
        reasons.append("RUNNER_CANDIDATE_POOL_HASH_MISMATCH")
    if canonical_state.get("report_sha256") != report_sha256(report):
        reasons.append("REPORT_SHA256_MISMATCH")
    missing = _missing_canonical_fields(canonical_state)
    if missing:
        reasons.append(f"MISSING_CANONICAL_FIELDS:{','.join(missing)}")
    return tuple(reasons)


@dataclass(frozen=True)
class CanonicalWriteResult:
    written: bool
    reason_code: str | None
    block_reasons: tuple[str, ...]
    path: str


def write_canonical_state_if_complete(
    canonical_state: Mapping[str, Any],
    path: str | Path,
    *,
    report: Mapping[str, Any],
    runner_candidate_pool_hash: str | None = None,
) -> CanonicalWriteResult:
    """Replace canonical state only after every required success gate passes."""

    target = Path(path)
    reasons = canonical_update_block_reasons(
        report, canonical_state, runner_candidate_pool_hash=runner_candidate_pool_hash
    )
    if reasons:
        return CanonicalWriteResult(False, REASON_CANONICAL_BLOCKED, reasons, str(target))
    write_json_atomic(target, canonical_state)
    return CanonicalWriteResult(True, None, (), str(target))


__all__ = [
    "CANONICAL_REQUIRED_FIELDS",
    "CanonicalWriteResult",
    "METRIC_NAME",
    "METRIC_VERSION",
    "build_canonical_state",
    "build_markdown_report",
    "build_report_metadata",
    "build_run_report",
    "canonical_update_block_reasons",
    "report_sha256",
    "to_jsonable",
    "write_canonical_state_if_complete",
    "write_json_atomic",
    "write_report_bundle",
    "write_text_atomic",
]
