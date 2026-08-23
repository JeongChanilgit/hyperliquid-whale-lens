"""Collect exact-window perpetual raw-fill count evidence for 3D TWR research.

This is an isolated public-data collector.  It never modifies rankings,
reports, dashboard data, or runner state.  The source window is frozen from
the cached portfolio identity in the research report, not recomputed from the
current clock.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import sys
import tempfile
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from whale_lens.api import HyperliquidApiClient, RetryPolicy, StageRequestBudget, WeightedTokenBucket
from whale_lens.episodes import is_spot_coin, raw_fills_request
from whale_lens.twr_3d_data import build_twr_3d_dataset


SCHEMA_VERSION = 2
FILL_RESPONSE_CAP = 2_000
MAX_TIME_PAGES_PER_WALLET = 24
DEFAULT_TIME_LIMIT_SECONDS = 15 * 60
DEFAULT_REPORT = Path("reports/perp-month-simple-twr/latest.json")
DEFAULT_EVIDENCE = Path("state/perp-month-simple-twr/twr-3d-count-evidence.json")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _atomic_write_json(path: Path, value: Mapping[str, Any]) -> None:
    """Durably replace the one owned checkpoint after every completed wallet."""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="\n", dir=path.parent, prefix=path.name + ".", suffix=".tmp", delete=False
        ) as handle:
            temporary_name = handle.name
            json.dump(value, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
        temporary_name = None
    finally:
        if temporary_name is not None:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _as_nonnegative_int(value: Any, *, field: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be an integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be an integer") from exc
    if parsed < 0 or str(parsed) != str(value).strip() and not isinstance(value, int):
        raise ValueError(f"{field} must be a non-negative integer")
    return parsed


def _wallet(value: Any) -> str:
    result = str(value).strip().lower()
    if len(result) != 42 or not result.startswith("0x") or any(char not in "0123456789abcdef" for char in result[2:]):
        raise ValueError(f"invalid wallet {value!r}")
    return result


def _error(error: BaseException) -> dict[str, str]:
    return {
        "type": type(error).__name__,
        "reason_code": str(getattr(error, "reason_code", None) or "UNEXPECTED_API_ERROR"),
        "message": str(error),
    }


def _row_identity(row: Any) -> str:
    if isinstance(row, Mapping) and row.get("tid") is not None:
        return "tid:" + _canonical_json(row["tid"])
    return "row:" + _canonical_json(row)


def _freeze_source(report_path: Path) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, int]]:
    raw = report_path.read_bytes()
    parsed = json.loads(raw)
    if not isinstance(parsed, Mapping):
        raise ValueError("source report must be an object")
    dataset = build_twr_3d_dataset(parsed)
    cache = parsed.get("cache_provenance")
    identity = cache.get("required_cache_identity") if isinstance(cache, Mapping) else None
    if not isinstance(identity, Mapping):
        raise ValueError("source report lacks cache_provenance.required_cache_identity")
    window = {
        "start_ms": _as_nonnegative_int(identity.get("window_start_ms"), field="window_start_ms"),
        "end_ms": _as_nonnegative_int(identity.get("window_end_ms"), field="window_end_ms"),
    }
    if window["end_ms"] < window["start_ms"]:
        raise ValueError("source report has an invalid frozen window")
    subjects: list[dict[str, Any]] = []
    seen: set[str] = set()
    for record in dataset["records"]:
        if not isinstance(record, Mapping):
            raise ValueError("3D dataset contains an invalid record")
        wallet = _wallet(record.get("wallet"))
        if wallet in seen:
            raise ValueError(f"3D dataset contains duplicate wallet {wallet}")
        seen.add(wallet)
        subjects.append(
            {
                "wallet": wallet,
                "rank": _as_nonnegative_int(record.get("rank"), field="rank"),
                "return_fraction": str(record.get("return_fraction")),
                "return_pct": record.get("return_pct"),
            }
        )
    if not subjects:
        raise ValueError("source report produced no eligible >=300% research wallets")
    source = {
        "path": report_path.as_posix(),
        "file_sha256": hashlib.sha256(raw).hexdigest(),
        "declared_report_sha256": parsed.get("report_sha256"),
        "run_id": parsed.get("run_id"),
        "research_only": True,
        "selection": dataset.get("selection"),
    }
    return source, subjects, window


def _client() -> HyperliquidApiClient:
    """Use the official public endpoint with a warm-zero 1,200 weight/minute bucket."""

    return HyperliquidApiClient(
        timeout_seconds=45.0,
        limiter=WeightedTokenBucket(capacity=1200.0, refill_per_second=20.0, initial_tokens=0.0),
        budgets=StageRequestBudget(limits={"fills": 512}),
        retry_policy=RetryPolicy(max_retries=2, base_delay_seconds=0.75, max_delay_seconds=6.0, jitter_fraction=0.15),
        endpoint_weights={"fills": 20.0},
    )


def _stable_count(rows: Sequence[Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Deduplicate only exact raw-row/tid repeats, then count non-spot fill rows."""

    unique_rows: list[Any] = []
    seen: set[str] = set()
    duplicate_count = 0
    for row in rows:
        identity = _row_identity(row)
        if identity in seen:
            duplicate_count += 1
            continue
        seen.add(identity)
        unique_rows.append(row)

    spot_count = 0
    perpetual_count = 0
    oid_values: set[str] = set()
    invalid_rows: list[dict[str, Any]] = []
    for index, row in enumerate(unique_rows):
        if not isinstance(row, Mapping):
            invalid_rows.append({"index": index, "reason_code": "INVALID_FILL_ROW", "message": "fill row was not an object"})
            continue
        coin = row.get("coin")
        if not isinstance(coin, str):
            invalid_rows.append({"index": index, "reason_code": "MISSING_FILL_COIN", "message": "fill row had no string coin"})
            continue
        if is_spot_coin(coin):
            spot_count += 1
            continue
        perpetual_count += 1
        if row.get("oid") is not None:
            oid_values.add(_canonical_json(row["oid"]))
    return (
        {
            "raw_fill_rows_returned": len(rows),
            "stable_deduplicated_fill_rows": len(unique_rows),
            "deduplicated_rows": duplicate_count,
            "spot_fill_rows_excluded": spot_count,
            "observed_perpetual_fill_rows": perpetual_count,
            "observed_distinct_non_null_oids": len(oid_values),
            "stable_row_identity_sha256": hashlib.sha256("\n".join(_row_identity(row) for row in unique_rows).encode("utf-8")).hexdigest(),
        },
        invalid_rows,
    )


def _coverage_status(*, accepted_count: int, errors: Sequence[Mapping[str, Any]]) -> str:
    if not errors:
        return "COMPLETE"
    if accepted_count:
        return "PARTIAL"
    return "ERROR"


def _fetch_wallet(
    client: HyperliquidApiClient,
    subject: Mapping[str, Any],
    window: Mapping[str, int],
    *,
    deadline: float,
) -> dict[str, Any]:
    """Fetch one exact frozen window using inclusive bisection and bounded pages."""

    wallet = _wallet(subject["wallet"])
    stack: list[tuple[int, int]] = [(window["start_ms"], window["end_ms"])]
    accepted_ranges: list[dict[str, int]] = []
    errors: list[dict[str, Any]] = []
    raw_rows: list[Any] = []
    request_count = 0
    while stack:
        if time.monotonic() >= deadline:
            errors.append(
                {
                    "reason_code": "TIME_LIMIT_EXHAUSTED",
                    "message": "run time limit reached before all time partitions were collected",
                    "unqueried_ranges": [{"start_ms": start, "end_ms": end} for start, end in stack],
                }
            )
            break
        if request_count >= MAX_TIME_PAGES_PER_WALLET:
            errors.append(
                {
                    "reason_code": "PAGINATION_PAGE_BUDGET_EXHAUSTED",
                    "message": f"more than {MAX_TIME_PAGES_PER_WALLET} time partitions were required",
                    "unqueried_ranges": [{"start_ms": start, "end_ms": end} for start, end in stack],
                }
            )
            break
        start_ms, end_ms = stack.pop()
        request_count += 1
        try:
            response = client.post_info(raw_fills_request(wallet, start_ms, end_ms), stage="fills")
        except BaseException as exc:
            errors.append({"reason_code": _error(exc)["reason_code"], "error": _error(exc), "range": {"start_ms": start_ms, "end_ms": end_ms}})
            continue
        if not isinstance(response, list):
            errors.append(
                {
                    "reason_code": "INVALID_API_RESPONSE",
                    "message": "userFillsByTime response was not a list",
                    "range": {"start_ms": start_ms, "end_ms": end_ms},
                }
            )
            continue
        if len(response) >= FILL_RESPONSE_CAP:
            if start_ms >= end_ms:
                errors.append(
                    {
                        "reason_code": "SATURATED_TIMESTAMP_RANGE",
                        "message": "response cap reached at an indivisible one-millisecond range",
                        "range": {"start_ms": start_ms, "end_ms": end_ms},
                        "response_cap": FILL_RESPONSE_CAP,
                    }
                )
                continue
            midpoint = start_ms + ((end_ms - start_ms) // 2)
            stack.append((midpoint + 1, end_ms))
            stack.append((start_ms, midpoint))
            continue
        accepted_ranges.append({"start_ms": start_ms, "end_ms": end_ms, "returned_rows": len(response)})
        raw_rows.extend(response)

    observed, invalid_rows = _stable_count(raw_rows)
    for invalid in invalid_rows:
        errors.append(invalid)
    status = _coverage_status(accepted_count=len(accepted_ranges), errors=errors)
    complete = status == "COMPLETE"
    return {
        **dict(subject),
        "evidence_source": "fresh_official_hyperliquid_info",
        "evidence_window": {"start_ms": window["start_ms"], "end_ms": window["end_ms"]},
        "fetched_at_ms": _now_ms(),
        "coverage": {
            "status": status,
            "complete": complete,
            "request_type": "userFillsByTime",
            "aggregate_by_time": False,
            "pagination_method": "inclusive_time_range_bisection",
            "response_cap": FILL_RESPONSE_CAP,
            "request_count": request_count,
            "accepted_ranges": accepted_ranges,
            "errors": errors,
        },
        "counts": {
            **observed,
            "count_status": "AVAILABLE_EXACT" if complete else "MISSING_INCOMPLETE_COVERAGE",
            "perpetual_fill_rows": observed["observed_perpetual_fill_rows"] if complete else None,
            "distinct_non_null_oids": observed["observed_distinct_non_null_oids"] if complete else None,
            "trade_count": observed["observed_perpetual_fill_rows"] if complete else None,
            "trade_count_basis": (
                "one stable-deduplicated non-spot raw userFillsByTime row equals one trade; aggregateByTime=false"
                if complete
                else None
            ),
            "trade_count_missing_reason": None if complete else "INCOMPLETE_OR_ERROR_FILL_COVERAGE",
        },
    }


def _load_reusable_complete_records(path: Path, window: Mapping[str, int]) -> dict[str, dict[str, Any]]:
    """Reuse only a complete record whose wallet and exact window both match."""

    if not path.is_file():
        return {}
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(document, Mapping) or document.get("schema_version") not in {1, SCHEMA_VERSION}:
        return {}
    records = document.get("wallets")
    if not isinstance(records, list):
        return {}
    reusable: dict[str, dict[str, Any]] = {}
    for record in records:
        if not isinstance(record, Mapping):
            continue
        try:
            wallet = _wallet(record.get("wallet"))
        except ValueError:
            continue
        evidence_window = record.get("evidence_window")
        coverage = record.get("coverage")
        counts = record.get("counts")
        if (
            isinstance(evidence_window, Mapping)
            and isinstance(coverage, Mapping)
            and isinstance(counts, Mapping)
            and evidence_window.get("start_ms") == window["start_ms"]
            and evidence_window.get("end_ms") == window["end_ms"]
            and coverage.get("status") == "COMPLETE"
            and coverage.get("complete") is True
        ):
            perpetual_rows = counts.get("perpetual_fill_rows")
            if not isinstance(perpetual_rows, int) or isinstance(perpetual_rows, bool) or perpetual_rows < 0:
                continue
            migrated = copy.deepcopy(dict(record))
            migrated_counts = dict(counts)
            migrated_counts.update(
                {
                    "count_status": "AVAILABLE_EXACT",
                    "trade_count": perpetual_rows,
                    "trade_count_basis": "one stable-deduplicated non-spot raw userFillsByTime row equals one trade; aggregateByTime=false",
                    "trade_count_missing_reason": None,
                }
            )
            migrated["counts"] = migrated_counts
            reusable[wallet] = migrated
    return reusable


def _summarise(wallets: Sequence[Mapping[str, Any]], *, timed_out: bool) -> dict[str, Any]:
    status_counts = {"COMPLETE": 0, "PARTIAL": 0, "ERROR": 0}
    reused = 0
    for wallet in wallets:
        coverage = wallet.get("coverage") if isinstance(wallet, Mapping) else None
        status = coverage.get("status") if isinstance(coverage, Mapping) else "ERROR"
        status_counts[status if status in status_counts else "ERROR"] += 1
        reused += int(wallet.get("evidence_source") == "checkpoint_reuse_exact_wallet_window")
    if status_counts["COMPLETE"] == len(wallets):
        status = "COMPLETE"
    elif status_counts["COMPLETE"] == 0 and status_counts["ERROR"]:
        status = "ERROR"
    else:
        status = "PARTIAL"
    return {
        "status": status,
        "complete": status == "COMPLETE",
        "wallets_total": len(wallets),
        "wallet_status_counts": status_counts,
        "reused_complete_wallets": reused,
        "timed_out": timed_out,
    }


def _document(
    *,
    source: Mapping[str, Any],
    window: Mapping[str, int],
    wallets: Sequence[Mapping[str, Any]],
    started_at_ms: int,
    timed_out: bool,
    client: HyperliquidApiClient,
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "research_only": True,
        "canonical_or_runner_eligible": False,
        "generated_at_ms": started_at_ms,
        "updated_at_ms": _now_ms(),
        "source_report": dict(source),
        "evidence_window": {"start_ms": window["start_ms"], "end_ms": window["end_ms"]},
        "collection_policy": {
            "request_type": "userFillsByTime",
            "aggregate_by_time": False,
            "perpetual_filter": "exclude spot coin when episodes.is_spot_coin(coin) is true",
            "trade_count_primary": "stable-deduplicated non-spot raw perpetual fill rows",
            "pagination": "inclusive_time_range_bisection",
            "response_cap": FILL_RESPONSE_CAP,
            "max_time_pages_per_wallet": MAX_TIME_PAGES_PER_WALLET,
            "rate_limit": "warm-zero token bucket, capacity 1200, refill 20 weight/second",
            "coverage_gate": "missing or incomplete coverage never receives a trade_count",
        },
        "wallets": [dict(wallet) for wallet in wallets],
        "coverage": _summarise(wallets, timed_out=timed_out),
        "request_budget_observation": client.budgets.snapshot(),
    }


def collect(*, report_path: Path, evidence_path: Path, time_limit_seconds: int) -> dict[str, Any]:
    source, subjects, window = _freeze_source(report_path)
    reusable = _load_reusable_complete_records(evidence_path, window)
    client = _client()
    started_at_ms = _now_ms()
    deadline = time.monotonic() + max(1, time_limit_seconds)
    wallets: list[dict[str, Any]] = []
    timed_out = False
    for position, subject in enumerate(subjects):
        wallet = subject["wallet"]
        prior = reusable.get(wallet)
        if prior is not None:
            prior.update(subject)
            prior["evidence_source"] = "checkpoint_reuse_exact_wallet_window"
            wallets.append(prior)
        elif time.monotonic() >= deadline:
            timed_out = True
            wallets.append(
                {
                    **subject,
                    "evidence_source": "not_collected_time_limit",
                    "evidence_window": dict(window),
                    "fetched_at_ms": None,
                    "coverage": {
                        "status": "PARTIAL",
                        "complete": False,
                        "request_type": "userFillsByTime",
                        "aggregate_by_time": False,
                        "errors": [{"reason_code": "TIME_LIMIT_EXHAUSTED", "message": "wallet not started before run time limit"}],
                    },
                    "counts": {
                        "count_status": "MISSING_INCOMPLETE_COVERAGE",
                        "perpetual_fill_rows": None,
                        "distinct_non_null_oids": None,
                        "trade_count": None,
                        "trade_count_basis": None,
                        "trade_count_missing_reason": "INCOMPLETE_OR_ERROR_FILL_COVERAGE",
                    },
                }
            )
        else:
            record = _fetch_wallet(client, subject, window, deadline=deadline)
            wallets.append(record)
            timed_out = timed_out or any(
                error.get("reason_code") == "TIME_LIMIT_EXHAUSTED"
                for error in record["coverage"].get("errors", [])
                if isinstance(error, Mapping)
            )
        checkpoint = _document(
            source=source,
            window=window,
            wallets=wallets,
            started_at_ms=started_at_ms,
            timed_out=timed_out,
            client=client,
        )
        _atomic_write_json(evidence_path, checkpoint)
    return _document(
        source=source,
        window=window,
        wallets=wallets,
        started_at_ms=started_at_ms,
        timed_out=timed_out,
        client=client,
    )


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--evidence", type=Path, default=DEFAULT_EVIDENCE)
    parser.add_argument("--time-limit-seconds", type=int, default=DEFAULT_TIME_LIMIT_SECONDS)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    document = collect(report_path=args.report, evidence_path=args.evidence, time_limit_seconds=args.time_limit_seconds)
    _atomic_write_json(args.evidence, document)
    print(_canonical_json({"evidence": args.evidence.as_posix(), "coverage": document["coverage"]}))
    return 0 if document["coverage"]["status"] == "COMPLETE" else 2


if __name__ == "__main__":
    raise SystemExit(main())
