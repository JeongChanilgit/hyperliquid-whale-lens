"""Fail-closed fill-presence census for every preserved screening account."""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, Sequence

from .evidence_registry import EXACT_RANKING_QUALITIES
from .report import report_sha256


ACTIVITY_CENSUS_SCHEMA_VERSION = "1"
ACTIVITY_CENSUS_COVERAGE_MODE = "FULL_PRESERVED_ACCOUNT_ACTIVITY"
HAS_FILL = "HAS_FILL"
ZERO_FILLS = "ZERO_FILLS"
FAILED = "FAILED"
SUCCESS_STATUSES = frozenset({HAS_FILL, ZERO_FILLS})
_EXACT_QUALITY_VALUES = frozenset(value.value for value in EXACT_RANKING_QUALITIES)


def normalize_wallet(value: Any) -> str:
    wallet = str(value).strip().lower()
    if len(wallet) != 42 or not wallet.startswith("0x"):
        raise ValueError("wallet must be a 20-byte 0x address")
    int(wallet[2:], 16)
    return wallet


def preserved_wallets(rescue_summary: Mapping[str, Any]) -> tuple[str, ...]:
    wallets = tuple(
        normalize_wallet(row["wallet"])
        for row in rescue_summary.get("accounts", ())
        if isinstance(row, Mapping) and row.get("wallet")
    )
    if len(wallets) != len(set(wallets)):
        raise ValueError("rescue summary contains duplicate wallets")
    expected = int(rescue_summary.get("discovered_accounts") or 0)
    if expected <= 0 or len(wallets) != expected:
        raise ValueError(f"rescue summary account count mismatch: expected {expected}, got {len(wallets)}")
    return wallets


def account_set_hash(wallets: Sequence[str]) -> str:
    return report_sha256({"wallets": sorted(normalize_wallet(wallet) for wallet in wallets)})


def fill_identity(fill: Mapping[str, Any]) -> tuple[Any, ...]:
    return tuple(fill.get(field) for field in ("time", "tid", "oid", "coin", "side", "sz", "px", "startPosition", "hash"))


def summarize_fill_presence(payload: Any, *, window_start_ms: int, window_end_ms: int) -> dict[str, Any]:
    """Validate one raw API response and return only honest presence evidence.

    A capped non-empty response still proves at least one fill.  The observed
    count is deliberately not represented as the account's complete fill
    count because ``userFillsByTime`` may cap a page.
    """

    if not isinstance(payload, list):
        raise ValueError("userFillsByTime response must be a JSON list")
    identities: set[tuple[Any, ...]] = set()
    valid_rows = 0
    for item in payload:
        if not isinstance(item, Mapping):
            raise ValueError("userFillsByTime row must be an object")
        try:
            time_ms = int(item["time"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("userFillsByTime row has an invalid timestamp") from exc
        if time_ms < window_start_ms or time_ms > window_end_ms:
            raise ValueError("userFillsByTime returned a row outside the fixed window")
        identity = fill_identity(item)
        if identity not in identities:
            identities.add(identity)
            valid_rows += 1
    return {
        "status": HAS_FILL if valid_rows else ZERO_FILLS,
        "has_fill_30d": valid_rows > 0,
        "minimum_proven_fill_count_30d": 1 if valid_rows else 0,
        "observed_unique_fill_count_30d": valid_rows,
        "response_row_count": len(payload),
        "response_may_be_capped": len(payload) >= 2000,
    }


def summarize_positive_month_volume(payload: Any, wallets: Sequence[str]) -> dict[str, str]:
    """Return fixed-month positive-volume proofs after full set validation."""

    rows = payload.get("leaderboardRows") if isinstance(payload, Mapping) else None
    if not isinstance(rows, list):
        raise ValueError("official leaderboard payload is unavailable")
    preserved = {normalize_wallet(wallet) for wallet in wallets}
    seen: set[str] = set()
    positive: dict[str, str] = {}
    for value in rows:
        if not isinstance(value, Mapping):
            continue
        wallet = str(value.get("ethAddress") or "").strip().lower()
        if wallet not in preserved:
            continue
        if wallet in seen:
            raise ValueError("official leaderboard contains a duplicate preserved wallet")
        seen.add(wallet)
        windows = value.get("windowPerformances")
        month = next(
            (
                entry[1]
                for entry in windows
                if isinstance(entry, list) and len(entry) == 2 and entry[0] == "month" and isinstance(entry[1], Mapping)
            ),
            None,
        ) if isinstance(windows, list) else None
        if month is None:
            raise ValueError(f"official leaderboard lacks month performance for {wallet}")
        volume = _decimal(month.get("vlm"))
        if volume is None or volume < 0:
            raise ValueError(f"official leaderboard has invalid month volume for {wallet}")
        if volume > 0:
            positive[wallet] = str(volume)
    if seen != preserved:
        raise ValueError(f"official leaderboard matched {len(seen)}/{len(preserved)} preserved wallets")
    return positive


def build_activity_census_report(
    rescue_summary: Mapping[str, Any],
    source_report: Mapping[str, Any],
    results: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    wallets = preserved_wallets(rescue_summary)
    normalized_results = {normalize_wallet(wallet): dict(result) for wallet, result in results.items()}
    rescue_by_wallet = {
        normalize_wallet(row["wallet"]): row
        for row in rescue_summary.get("accounts", ())
        if isinstance(row, Mapping) and row.get("wallet")
    }
    unknown = sorted(set(normalized_results) - set(wallets))
    if unknown:
        raise ValueError(f"activity results contain {len(unknown)} wallets outside the preserved set")
    rows = []
    status_counts = {HAS_FILL: 0, ZERO_FILLS: 0, FAILED: 0, "NOT_SCANNED": 0}
    for wallet in wallets:
        rescue_row = rescue_by_wallet[wallet]
        result = normalized_results.get(wallet)
        if result is None:
            row = {"wallet": wallet, "status": "NOT_SCANNED", "has_fill_30d": None}
        else:
            row = {"wallet": wallet, **result}
            row["status"] = str(row.get("status") or FAILED)
            if row["status"] not in status_counts:
                row["status"] = FAILED
        row.update({
            "data_quality_status": rescue_row.get("data_quality_status"),
            "latest_scores": rescue_row.get("latest_scores"),
            "account_value_usd": rescue_row.get("account_value_usd"),
            "twr_calculation_attempted": True,
        })
        status_counts[row["status"]] += 1
        rows.append(row)
    complete = status_counts[FAILED] == 0 and status_counts["NOT_SCANNED"] == 0
    fill_positive_quality_counts: dict[str, int] = {}
    for row in rows:
        if row["status"] != HAS_FILL:
            continue
        quality = str(row.get("data_quality_status") or "UNKNOWN")
        fill_positive_quality_counts[quality] = fill_positive_quality_counts.get(quality, 0) + 1
    report = {
        "schema_version": ACTIVITY_CENSUS_SCHEMA_VERSION,
        "coverage_mode": ACTIVITY_CENSUS_COVERAGE_MODE,
        "run_id": f"activity-{source_report['run_id']}",
        "source_run_id": source_report["run_id"],
        "source_as_of_ms": int(source_report["as_of_ms"]),
        "window_start_ms": int(source_report["window_start_ms"]),
        "window_end_ms": int(source_report["window_end_ms"]),
        "source_rescue_summary_sha256": report_sha256(rescue_summary),
        "source_report_sha256": report_sha256(source_report),
        "account_set_hash": account_set_hash(wallets),
        "preserved_account_count": len(wallets),
        "scanned_account_count": status_counts[HAS_FILL] + status_counts[ZERO_FILLS],
        "has_fill_account_count": status_counts[HAS_FILL],
        "fill_positive_twr_calculation_attempted_count": status_counts[HAS_FILL],
        "fill_positive_twr_quality_counts": dict(sorted(fill_positive_quality_counts.items())),
        "fill_positive_exact_twr_count": sum(
            count for quality, count in fill_positive_quality_counts.items() if quality in _EXACT_QUALITY_VALUES
        ),
        "zero_fill_account_count": status_counts[ZERO_FILLS],
        "failed_account_count": status_counts[FAILED],
        "not_scanned_account_count": status_counts["NOT_SCANNED"],
        "coverage_complete": complete,
        "run_status": "COMPLETE" if complete else "PARTIAL",
        "status_counts": status_counts,
        "accounts": rows,
    }
    report["report_sha256"] = report_sha256(report)
    return report


def _decimal(value: Any) -> Decimal | None:
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return result if result.is_finite() else None


def select_exact_twr_top10_with_fills(
    rescue_summary: Mapping[str, Any],
    census: Mapping[str, Any],
    *,
    count: int = 10,
) -> list[dict[str, Any]]:
    if count <= 0:
        raise ValueError("count must be positive")
    if census.get("run_status") != "COMPLETE" or census.get("coverage_complete") is not True:
        raise ValueError("activity census is not complete")
    wallets = preserved_wallets(rescue_summary)
    if census.get("account_set_hash") != account_set_hash(wallets):
        raise ValueError("activity census account set does not match rescue summary")
    activity = {
        normalize_wallet(row["wallet"]): row
        for row in census.get("accounts", ())
        if isinstance(row, Mapping) and row.get("wallet")
    }
    if len(activity) != len(wallets) or any(activity[wallet].get("status") not in SUCCESS_STATUSES for wallet in wallets):
        raise ValueError("activity census does not contain one successful result per preserved wallet")
    eligible = []
    for row in rescue_summary.get("accounts", ()):
        if not isinstance(row, Mapping) or not row.get("wallet"):
            continue
        wallet = normalize_wallet(row["wallet"])
        if activity[wallet].get("status") != HAS_FILL:
            continue
        quality = str(row.get("data_quality_status") or "")
        score = _decimal((row.get("latest_scores") or {}).get("exact_twr"))
        if quality not in _EXACT_QUALITY_VALUES or score is None:
            continue
        eligible.append({
            **dict(row),
            "wallet": wallet,
            "activity_status": HAS_FILL,
            "has_fill_30d": True,
            "minimum_proven_fill_count_30d": int(activity[wallet].get("minimum_proven_fill_count_30d") or 0),
            "observed_unique_fill_count_30d": activity[wallet].get("observed_unique_fill_count_30d"),
            "perp_cashflow_neutral_twr_30d": str(score),
        })
    eligible.sort(key=lambda row: (-Decimal(row["perp_cashflow_neutral_twr_30d"]), row["wallet"]))
    if len(eligible) < count:
        raise ValueError(f"only {len(eligible)} exact-TWR accounts have a verified fill; need {count}")
    return eligible[:count]


__all__ = [
    "ACTIVITY_CENSUS_COVERAGE_MODE",
    "ACTIVITY_CENSUS_SCHEMA_VERSION",
    "FAILED",
    "HAS_FILL",
    "ZERO_FILLS",
    "account_set_hash",
    "build_activity_census_report",
    "fill_identity",
    "preserved_wallets",
    "select_exact_twr_top10_with_fills",
    "summarize_fill_presence",
    "summarize_positive_month_volume",
]
