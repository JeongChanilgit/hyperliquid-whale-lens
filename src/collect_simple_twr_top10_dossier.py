"""Collect hash-linked public API evidence for the research-only simple-TWR TOP10.

This program deliberately does *not* change any screener or copy-runner state.
It freezes the ten addresses in ``reports/perp-month-simple-twr/latest.json``
and records a single fixed-as-of, 30-day public-data snapshot for briefing.

The public ``info`` API has time-range page limits.  Advancing a cursor to the
last timestamp is unsafe when a timestamp contains more than one event, so
fills and ledger updates use inclusive time-range bisection instead.  A range
is accepted only when it is below the documented response cap; a saturated
one-millisecond range, API failure, or request budget exhaustion is reported
as incomplete coverage rather than estimated away.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from whale_lens.api import (
    ApiRequestError,
    HyperliquidApiClient,
    RetryPolicy,
    StageRequestBudget,
    WeightedTokenBucket,
)
from whale_lens.cache import atomic_write_json


SCHEMA_VERSION = 1
DAY_MS = 24 * 60 * 60 * 1000
WINDOW_DAYS = 30
INFO_ENDPOINT = "https://api.hyperliquid.xyz/info"

# Hyperliquid documents 2,000 fills by time and generic time-range pagination
# at 500 elements/distinct blocks.  Splitting an exactly-full response is
# intentional: exact equality cannot prove that it was not truncated.
FILL_RESPONSE_CAP = 2_000
LEDGER_RESPONSE_CAP = 500
# A full 128 saturated raw-fill pages can consume several minutes because the
# API charges returned fills by weight as well.  Twenty-four pages remains well
# above normal 30-day activity while making every TOP10 subject terminal in a
# bounded run; the evidence explicitly reports any remaining gap as PARTIAL.
MAX_TIME_PAGES_PER_WALLET_ENDPOINT = 24

DEFAULT_REPORT = Path("reports/perp-month-simple-twr/latest.json")
DEFAULT_OUTPUT = Path("reports/perp-month-simple-twr/top10-dossier-data.json")
DEFAULT_CHECKPOINT = Path("state/perp-month-simple-twr/top10-dossier-evidence.json")


@dataclass(frozen=True)
class FrozenSubjects:
    report_path: str
    report_file_sha256: str
    declared_report_sha256: str | None
    run_id: str
    source_window: dict[str, int | None]
    wallets: tuple[dict[str, Any], ...]


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _error_payload(error: BaseException) -> dict[str, str]:
    reason = getattr(error, "reason_code", None)
    return {
        "type": type(error).__name__,
        "reason_code": str(reason) if reason else "UNEXPECTED_API_ERROR",
        "message": str(error),
    }


def _expect_wallet(value: Any) -> str:
    wallet = str(value).lower()
    if len(wallet) != 42 or not wallet.startswith("0x") or any(char not in "0123456789abcdef" for char in wallet[2:]):
        raise ValueError(f"invalid TOP10 wallet address: {value!r}")
    return wallet


def _freeze_subjects(path: Path) -> FrozenSubjects:
    raw = path.read_bytes()
    report = json.loads(raw)
    if not isinstance(report, dict):
        raise ValueError("source report must be a JSON object")
    top10 = report.get("top10")
    if not isinstance(top10, list) or len(top10) != 10:
        raise ValueError("source report must contain exactly ten top10 rows")

    wallets: list[dict[str, Any]] = []
    seen: set[str] = set()
    for rank, source in enumerate(top10, start=1):
        if not isinstance(source, dict):
            raise ValueError(f"source top10 row {rank} is not an object")
        wallet = _expect_wallet(source.get("wallet"))
        if wallet in seen:
            raise ValueError(f"source top10 contains duplicate wallet {wallet}")
        seen.add(wallet)
        score = source.get("perp_month_simple_twr_30d")
        if score is None:
            raise ValueError(f"source top10 row {rank} lacks perp_month_simple_twr_30d")
        wallets.append({"rank": rank, "wallet": wallet, "source_score": score, "source_diagnostics": source})

    source_universe = report.get("source_universe")
    if not isinstance(source_universe, dict):
        source_universe = {}
    return FrozenSubjects(
        report_path=path.as_posix(),
        report_file_sha256=hashlib.sha256(raw).hexdigest(),
        declared_report_sha256=(str(report["report_sha256"]) if report.get("report_sha256") is not None else None),
        run_id=str(report.get("run_id") or ""),
        source_window={
            "start_ms": _as_int_or_none(source_universe.get("window_start_ms")),
            "end_ms": _as_int_or_none(source_universe.get("window_end_ms")),
        },
        wallets=tuple(wallets),
    )


def _as_int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _source_report_dict(subjects: FrozenSubjects) -> dict[str, Any]:
    return {
        "path": subjects.report_path,
        "sha256": subjects.report_file_sha256,
        "declared_report_sha256": subjects.declared_report_sha256,
        "run_id": subjects.run_id,
        "window": dict(subjects.source_window),
    }


def _fresh_response(
    client: HyperliquidApiClient,
    payload: dict[str, Any],
    *,
    stage: str,
    fetched_at_ms: int | None = None,
) -> dict[str, Any]:
    """Return fresh public data without hiding a bounded request error."""

    fetched_at_ms = _now_ms() if fetched_at_ms is None else fetched_at_ms
    try:
        return {
            "source": "fresh",
            "fetched_at_ms": fetched_at_ms,
            "payload": client.post_info(payload, stage=stage),
        }
    except BaseException as error:  # request errors must become evidence, not an inferred empty response
        return {"source": "fresh", "fetched_at_ms": fetched_at_ms, "error": _error_payload(error)}


def _normalise_dexes(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, list):
        raise ValueError("perpDexs response was not a list")
    dexes: list[dict[str, Any]] = []
    for index, record in enumerate(payload):
        if index == 0:
            # API convention: an empty dex selects the first/default perp dex.
            dexes.append({"index": 0, "name": "", "label": "first_perp_dex", "api_record": record})
            continue
        if not isinstance(record, dict) or not record.get("name"):
            # A sparse perpDexs entry has no callable name and is recorded as
            # unavailable, not queried using an invented replacement.
            dexes.append({"index": index, "name": None, "label": "unavailable_perp_dex", "api_record": record})
            continue
        dexes.append({"index": index, "name": str(record["name"]), "label": "perp_dex", "api_record": record})
    if not dexes:
        raise ValueError("perpDexs response was empty")
    return dexes


def _callable_dexes(dexes: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    return [dict(dex) for dex in dexes if isinstance(dex.get("name"), str)]


def _row_identity(row: Any, *, endpoint: str) -> str:
    """Use an API identifier when present; otherwise preserve complete row identity."""

    if isinstance(row, dict) and endpoint == "fills":
        tid = row.get("tid")
        if tid is not None:
            return "tid:" + str(tid)
    return "row:" + _canonical_json(row)


def _collect_time_partitioned(
    client: HyperliquidApiClient,
    *,
    endpoint: str,
    wallet: str,
    window_start_ms: int,
    window_end_ms: int,
    response_cap: int,
) -> dict[str, Any]:
    """Fetch a time range with loss-aware inclusive range bisection.

    A leaf is only accepted below its response cap.  The left/right children
    are disjoint ([start, mid], [mid + 1, end]), avoiding cursor-boundary
    duplicates while still allowing duplicate response identities to be
    recorded and removed deterministically.
    """

    if endpoint not in {"fills", "ledger"}:
        raise ValueError(f"unsupported paginated endpoint {endpoint!r}")
    request_type = "userFillsByTime" if endpoint == "fills" else "userNonFundingLedgerUpdates"
    stage = "fills" if endpoint == "fills" else "ledger"
    stack: list[tuple[int, int]] = [(window_start_ms, window_end_ms)]
    accepted_pages: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    raw_rows: list[Any] = []
    request_count = 0

    while stack:
        if request_count >= MAX_TIME_PAGES_PER_WALLET_ENDPOINT:
            errors.append(
                {
                    "reason_code": "PAGINATION_PAGE_BUDGET_EXHAUSTED",
                    "message": f"more than {MAX_TIME_PAGES_PER_WALLET_ENDPOINT} time partitions were required",
                    "unqueried_ranges": [{"start_ms": start, "end_ms": end} for start, end in stack],
                }
            )
            break
        start_ms, end_ms = stack.pop()
        request_count += 1
        payload: dict[str, Any] = {
            "type": request_type,
            "user": wallet,
            "startTime": start_ms,
            "endTime": end_ms,
        }
        if endpoint == "fills":
            payload["aggregateByTime"] = False
        response = _fresh_response(client, payload, stage=stage)
        if "error" in response:
            errors.append(
                {
                    "reason_code": response["error"]["reason_code"],
                    "message": response["error"]["message"],
                    "range": {"start_ms": start_ms, "end_ms": end_ms},
                }
            )
            continue
        page = response.get("payload")
        if not isinstance(page, list):
            errors.append(
                {
                    "reason_code": "INVALID_API_RESPONSE",
                    "message": f"{request_type} response was not a list",
                    "range": {"start_ms": start_ms, "end_ms": end_ms},
                }
            )
            continue
        row_count = len(page)
        if row_count >= response_cap:
            if start_ms >= end_ms:
                errors.append(
                    {
                        "reason_code": "SATURATED_TIMESTAMP_RANGE",
                        "message": f"{row_count} rows at one millisecond cannot be paginated safely",
                        "range": {"start_ms": start_ms, "end_ms": end_ms},
                        "response_cap": response_cap,
                    }
                )
                continue
            midpoint = start_ms + ((end_ms - start_ms) // 2)
            # LIFO stack gives deterministic chronological traversal.
            stack.append((midpoint + 1, end_ms))
            stack.append((start_ms, midpoint))
            continue
        accepted_pages.append({"start_ms": start_ms, "end_ms": end_ms, "returned_rows": row_count})
        raw_rows.extend(page)

    unique_rows: list[Any] = []
    seen: set[str] = set()
    duplicate_count = 0
    for row in raw_rows:
        identity = _row_identity(row, endpoint=endpoint)
        if identity in seen:
            duplicate_count += 1
            continue
        seen.add(identity)
        unique_rows.append(row)

    # Stable time ordering preserves response order for equal timestamps.
    indexed_rows = list(enumerate(unique_rows))
    indexed_rows.sort(key=lambda item: (_as_int_or_none(item[1].get("time")) if isinstance(item[1], dict) else None, item[0]))
    rows = [row for _index, row in indexed_rows]
    # Do not manufacture an availability cap from a documentation-era value.
    # The live endpoint can return more than 10,000 fills, so completeness is
    # established only by the observed disjoint accepted ranges and errors.
    complete = not errors
    coverage: dict[str, Any] = {
        "status": "COMPLETE" if complete else "PARTIAL",
        "complete": complete,
        "source": "fresh",
        "request_type": request_type,
        "aggregate_by_time": False if endpoint == "fills" else None,
        "window_start_ms": window_start_ms,
        "window_end_ms": window_end_ms,
        "response_cap": response_cap,
        "request_count": request_count,
        "accepted_ranges": accepted_pages,
        "raw_returned_rows": len(raw_rows),
        "unique_rows": len(rows),
        "deduplicated_rows": duplicate_count,
        "pagination_method": "inclusive_time_range_bisection",
        "availability_limit": None,
        "availability_limit_reached": False,
        "errors": errors,
    }
    return {"rows": rows, "coverage": coverage}


def _reassess_legacy_fill_availability(wallets: Sequence[Mapping[str, Any]]) -> None:
    """Correct a pre-v2 checkpoint that treated 10,000 rows as a hard API cap.

    The correction is evidence-preserving: only the unsupported synthetic cap
    is removed.  A genuine pagination or HTTP error remains PARTIAL.
    """

    for wallet in wallets:
        fills = wallet.get("fills")
        if not isinstance(fills, dict):
            continue
        coverage = fills.get("coverage")
        if not isinstance(coverage, dict) or coverage.get("availability_limit") != 10_000:
            continue
        coverage["availability_limit"] = None
        coverage["availability_limit_reached"] = False
        coverage.pop("availability_note", None)
        errors = coverage.get("errors")
        complete = isinstance(errors, list) and not errors
        coverage["complete"] = complete
        coverage["status"] = "COMPLETE" if complete else "PARTIAL"


def _collect_dex_snapshot(
    client: HyperliquidApiClient,
    *,
    wallet: str,
    dex: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    name = str(dex["name"])
    common = {"user": wallet, "dex": name}
    state = _fresh_response(client, {"type": "clearinghouseState", **common}, stage="current_state")
    orders = _fresh_response(client, {"type": "frontendOpenOrders", **common}, stage="open_orders")
    return (
        {"dex": name, "dex_index": dex["index"], **state},
        {"dex": name, "dex_index": dex["index"], **orders},
    )


def _wallet_current_record(
    client: HyperliquidApiClient,
    subject: Mapping[str, Any],
    *,
    dexes: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    wallet = str(subject["wallet"])
    portfolio = _fresh_response(client, {"type": "portfolio", "user": wallet}, stage="portfolio")
    current_states: list[dict[str, Any]] = []
    open_orders: list[dict[str, Any]] = []
    for dex in _callable_dexes(dexes):
        state, orders = _collect_dex_snapshot(client, wallet=wallet, dex=dex)
        current_states.append(state)
        open_orders.append(orders)
    return {
        "rank": int(subject["rank"]),
        "wallet": wallet,
        "source_score": subject["source_score"],
        "source_diagnostics": subject["source_diagnostics"],
        "portfolio": portfolio,
        "current_states": current_states,
        "open_orders": open_orders,
        "fills": {"rows": [], "coverage": {"status": "PENDING", "complete": False}},
        "ledger": {"rows": [], "coverage": {"status": "PENDING", "complete": False}},
    }


def _endpoint_complete(value: Mapping[str, Any]) -> bool:
    return "error" not in value


def _summarise_coverage(wallets: Sequence[Mapping[str, Any]], dexes: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    endpoint_counts = {
        "portfolio": {"complete": 0, "partial": 0},
        "current_states": {"complete": 0, "partial": 0},
        "open_orders": {"complete": 0, "partial": 0},
        "fills": {"complete": 0, "partial": 0},
        "ledger": {"complete": 0, "partial": 0},
    }
    for wallet in wallets:
        endpoint_counts["portfolio"]["complete" if _endpoint_complete(wallet["portfolio"]) else "partial"] += 1
        for item in wallet["current_states"]:
            endpoint_counts["current_states"]["complete" if _endpoint_complete(item) else "partial"] += 1
        for item in wallet["open_orders"]:
            endpoint_counts["open_orders"]["complete" if _endpoint_complete(item) else "partial"] += 1
        for endpoint in ("fills", "ledger"):
            endpoint_counts[endpoint]["complete" if wallet[endpoint]["coverage"]["complete"] else "partial"] += 1
    expected_dex_calls = len(wallets) * len(_callable_dexes(dexes))
    complete = (
        len(wallets) == 10
        and endpoint_counts["portfolio"]["partial"] == 0
        and endpoint_counts["current_states"]["partial"] == 0
        and endpoint_counts["current_states"]["complete"] == expected_dex_calls
        and endpoint_counts["open_orders"]["partial"] == 0
        and endpoint_counts["open_orders"]["complete"] == expected_dex_calls
        and endpoint_counts["fills"]["partial"] == 0
        and endpoint_counts["ledger"]["partial"] == 0
    )
    return {
        "status": "COMPLETE" if complete else "PARTIAL",
        "complete": complete,
        "wallets_expected": 10,
        "wallets_collected": len(wallets),
        "callable_dexes": len(_callable_dexes(dexes)),
        "expected_wallet_dex_calls": expected_dex_calls,
        "endpoint_counts": endpoint_counts,
    }


def _build_document(
    *,
    subjects: FrozenSubjects,
    generated_at_ms: int,
    as_of_ms: int,
    dexes: Sequence[Mapping[str, Any]],
    wallets: Sequence[Mapping[str, Any]],
    client: HyperliquidApiClient,
    collection_status: str,
    dex_error: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    evidence_start_ms = as_of_ms - WINDOW_DAYS * DAY_MS
    coverage = _summarise_coverage(wallets, dexes)
    coverage["collection_status"] = collection_status
    coverage["request_budget_observation"] = {
        "scope": "CURRENT_PROCESS_ONLY_NOT_CUMULATIVE_ACROSS_RESUME",
        "snapshot": client.budgets.snapshot(),
    }
    coverage["rate_limit"] = {"limit_weight_per_minute": 1200, "initial_tokens": 0}
    if dex_error is not None:
        coverage["perp_dexes_error"] = dict(dex_error)
        coverage["status"] = "PARTIAL"
        coverage["complete"] = False
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at_ms": generated_at_ms,
        "source_report": _source_report_dict(subjects),
        "evidence_window": {
            "start_ms": evidence_start_ms,
            "end_ms": as_of_ms,
            "as_of_ms": as_of_ms,
            "duration_days": WINDOW_DAYS,
        },
        "dexes": list(dexes),
        "wallets": list(wallets),
        "coverage": coverage,
    }


def _assert_document(document: Mapping[str, Any], subjects: FrozenSubjects) -> None:
    required = {"schema_version", "generated_at_ms", "source_report", "evidence_window", "dexes", "wallets", "coverage"}
    missing = required.difference(document)
    if missing:
        raise AssertionError(f"dossier document missing fields: {sorted(missing)}")
    if document["schema_version"] != SCHEMA_VERSION:
        raise AssertionError("unexpected dossier schema version")
    source = document["source_report"]
    if not isinstance(source, Mapping) or source.get("sha256") != subjects.report_file_sha256:
        raise AssertionError("source report hash mismatch")
    wallets = document["wallets"]
    if not isinstance(wallets, list) or len(wallets) != 10:
        raise AssertionError("dossier must contain exactly ten wallets")
    expected = [(entry["rank"], entry["wallet"]) for entry in subjects.wallets]
    actual = [(entry.get("rank"), entry.get("wallet")) for entry in wallets if isinstance(entry, Mapping)]
    if actual != expected:
        raise AssertionError("dossier wallet ranking no longer matches frozen source report")
    for wallet in wallets:
        fills = wallet.get("fills")
        ledger = wallet.get("ledger")
        if not isinstance(fills, Mapping) or not isinstance(ledger, Mapping):
            raise AssertionError("wallet is missing fills or ledger evidence")
        if not isinstance(fills.get("coverage"), Mapping) or not isinstance(ledger.get("coverage"), Mapping):
            raise AssertionError("wallet evidence is missing coverage metadata")


def _load_resume_document(path: Path, subjects: FrozenSubjects) -> dict[str, Any]:
    """Load only a checkpoint for the exact same frozen source TOP10."""

    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError(f"resume checkpoint does not exist: {path}") from error
    if not isinstance(document, dict):
        raise ValueError("resume checkpoint must be a JSON object")
    _assert_document(document, subjects)
    source = document["source_report"]
    if source.get("path") != subjects.report_path or source.get("sha256") != subjects.report_file_sha256:
        raise ValueError("resume checkpoint source report does not match the currently frozen TOP10")
    evidence_window = document["evidence_window"]
    as_of_ms = _as_int_or_none(evidence_window.get("as_of_ms")) if isinstance(evidence_window, Mapping) else None
    if as_of_ms is None or _as_int_or_none(evidence_window.get("start_ms")) != as_of_ms - WINDOW_DAYS * DAY_MS:
        raise ValueError("resume checkpoint has an invalid fixed evidence window")
    if not isinstance(document.get("dexes"), list):
        raise ValueError("resume checkpoint does not contain its frozen perpDex list")
    return document


def _client() -> HyperliquidApiClient:
    # Start empty: sharing a public-IP quota with another process must not cause
    # this task to begin with a 1,200-weight burst.  The retry policy is finite.
    limiter = WeightedTokenBucket(capacity=1200.0, refill_per_second=20.0, initial_tokens=0.0)
    budgets = StageRequestBudget(
        limits={
            "perp_dexes": 4,
            "portfolio": 40,
            "current_state": 400,
            "open_orders": 400,
            "fills": 512,
            "ledger": 512,
        }
    )
    return HyperliquidApiClient(
        timeout_seconds=45.0,
        limiter=limiter,
        budgets=budgets,
        retry_policy=RetryPolicy(max_retries=2, base_delay_seconds=0.75, max_delay_seconds=6.0, jitter_fraction=0.15),
        endpoint_weights={
            # Official rate-limit documentation assigns clearinghouseState
            # weight 2; the remaining calls here have the standard weight 20.
            "perp_dexes": 20.0,
            "portfolio": 20.0,
            "current_state": 2.0,
            "open_orders": 20.0,
            "fills": 20.0,
            "ledger": 20.0,
        },
    )


def collect(
    *,
    report_path: Path,
    output_path: Path,
    checkpoint_path: Path,
    resume: bool = False,
) -> dict[str, Any]:
    """Run one fresh, fixed-as-of dossier collection and atomically publish it."""

    subjects = _freeze_subjects(report_path)
    client = _client()
    if resume:
        checkpoint = _load_resume_document(checkpoint_path, subjects)
        generated_at_ms = int(checkpoint["generated_at_ms"])
        as_of_ms = int(checkpoint["evidence_window"]["as_of_ms"])
        evidence_start_ms = as_of_ms - WINDOW_DAYS * DAY_MS
        dexes = [dict(item) for item in checkpoint["dexes"]]
        wallets = [dict(item) for item in checkpoint["wallets"]]
        _reassess_legacy_fill_availability(wallets)
        existing_dex_error = checkpoint.get("coverage", {}).get("perp_dexes_error")
        dex_error = dict(existing_dex_error) if isinstance(existing_dex_error, Mapping) else None
    else:
        generated_at_ms = _now_ms()
        as_of_ms = generated_at_ms
        evidence_start_ms = as_of_ms - WINDOW_DAYS * DAY_MS
        dex_response = _fresh_response(client, {"type": "perpDexs"}, stage="perp_dexes", fetched_at_ms=generated_at_ms)
        dex_error = None
        if "error" in dex_response:
            dexes = []
            dex_error = dex_response["error"]
        else:
            try:
                dexes = _normalise_dexes(dex_response["payload"])
            except BaseException as error:
                dexes = []
                dex_error = _error_payload(error)

        wallets = []
        # Phase 1 intentionally gets every current portfolio/state/order snapshot
        # before any potentially page-heavy history work.  This gives all ten
        # wallets complete current DEX evidence even if a later historical endpoint
        # hits its availability cap or a bounded request budget.
        for subject in subjects.wallets:
            if dex_error is not None:
                record = {
                    "rank": subject["rank"],
                    "wallet": subject["wallet"],
                    "source_score": subject["source_score"],
                    "source_diagnostics": subject["source_diagnostics"],
                    "portfolio": {"source": "not_collected", "error": dict(dex_error)},
                    "current_states": [],
                    "open_orders": [],
                    "fills": {"rows": [], "coverage": {"status": "PARTIAL", "complete": False, "reason_code": "PERP_DEXES_UNAVAILABLE"}},
                    "ledger": {"rows": [], "coverage": {"status": "PARTIAL", "complete": False, "reason_code": "PERP_DEXES_UNAVAILABLE"}},
                }
            else:
                record = _wallet_current_record(
                    client,
                    subject,
                    dexes=dexes,
                )
            wallets.append(record)
            checkpoint = _build_document(
                subjects=subjects,
                generated_at_ms=generated_at_ms,
                as_of_ms=as_of_ms,
                dexes=dexes,
                wallets=wallets,
                client=client,
                collection_status="IN_PROGRESS",
                dex_error=dex_error,
            )
            atomic_write_json(checkpoint_path, checkpoint)

    # Phase 2: retrieve exact-window raw history only after the ten current
    # snapshots above have been persisted.  Each endpoint reports rather than
    # masks a saturated, incomplete, or failed time range.
    if dex_error is None:
        for record in wallets:
            wallet = str(record["wallet"])
            fill_coverage = record.get("fills", {}).get("coverage") if isinstance(record.get("fills"), Mapping) else None
            if not isinstance(fill_coverage, Mapping) or fill_coverage.get("status") == "PENDING":
                record["fills"] = _collect_time_partitioned(
                    client,
                    endpoint="fills",
                    wallet=wallet,
                    window_start_ms=evidence_start_ms,
                    window_end_ms=as_of_ms,
                    response_cap=FILL_RESPONSE_CAP,
                )
                checkpoint = _build_document(
                    subjects=subjects,
                    generated_at_ms=generated_at_ms,
                    as_of_ms=as_of_ms,
                    dexes=dexes,
                    wallets=wallets,
                    client=client,
                    collection_status="IN_PROGRESS",
                    dex_error=dex_error,
                )
                atomic_write_json(checkpoint_path, checkpoint)
            ledger_coverage = record.get("ledger", {}).get("coverage") if isinstance(record.get("ledger"), Mapping) else None
            if not isinstance(ledger_coverage, Mapping) or ledger_coverage.get("status") == "PENDING":
                record["ledger"] = _collect_time_partitioned(
                    client,
                    endpoint="ledger",
                    wallet=wallet,
                    window_start_ms=evidence_start_ms,
                    window_end_ms=as_of_ms,
                    response_cap=LEDGER_RESPONSE_CAP,
                )
                checkpoint = _build_document(
                    subjects=subjects,
                    generated_at_ms=generated_at_ms,
                    as_of_ms=as_of_ms,
                    dexes=dexes,
                    wallets=wallets,
                    client=client,
                    collection_status="IN_PROGRESS",
                    dex_error=dex_error,
                )
                atomic_write_json(checkpoint_path, checkpoint)

    document = _build_document(
        subjects=subjects,
        generated_at_ms=generated_at_ms,
        as_of_ms=as_of_ms,
        dexes=dexes,
        wallets=wallets,
        client=client,
        collection_status="COMPLETED",
        dex_error=dex_error,
    )
    _assert_document(document, subjects)
    atomic_write_json(checkpoint_path, document)
    atomic_write_json(output_path, document)
    return document


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT, help="research-only source latest.json")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="compact dossier evidence JSON")
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT, help="owned progress/evidence JSON")
    parser.add_argument("--resume", action="store_true", help="resume only PENDING history for the identical frozen checkpoint")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    document = collect(report_path=args.report, output_path=args.output, checkpoint_path=args.checkpoint, resume=args.resume)
    print(
        _canonical_json(
            {
                "output": args.output.as_posix(),
                "wallets": len(document["wallets"]),
                "coverage": document["coverage"]["status"],
                "generated_at_ms": document["generated_at_ms"],
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
