"""Resume-safe 30-day fill-presence census across every preserved account."""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping

from whale_lens.activity_census import (
    ACTIVITY_CENSUS_COVERAGE_MODE,
    FAILED,
    HAS_FILL,
    ZERO_FILLS,
    account_set_hash,
    build_activity_census_report,
    preserved_wallets,
    select_exact_twr_top10_with_fills,
    summarize_fill_presence,
    summarize_positive_month_volume,
)
from whale_lens.api import HyperliquidApiClient, RetryPolicy, StageRequestBudget, WeightedTokenBucket
from whale_lens.cache import CheckpointStore, RawResponseCache, ResumeIdentity, make_raw_cache_key
from whale_lens.report import report_sha256, write_json_atomic, write_text_atomic


def _read(path: Path) -> Mapping[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _source_cache_key(source: Mapping[str, Any], wallet: str, endpoint: str):
    return make_raw_cache_key(
        wallet=wallet,
        endpoint=endpoint,
        window_start_ms=int(source["window_start_ms"]),
        window_end_ms=int(source["window_end_ms"]),
        as_of_ms=int(source["as_of_ms"]),
        metric_version=str(source.get("metric_version", "1")),
        raw_payload_schema_version="1",
        coverage_mode=str(source["coverage_mode"]),
    )


def _activity_cache_key(source: Mapping[str, Any], wallet: str):
    return make_raw_cache_key(
        wallet=wallet,
        endpoint="userFillsByTime-activity-presence",
        window_start_ms=int(source["window_start_ms"]),
        window_end_ms=int(source["window_end_ms"]),
        as_of_ms=int(source["as_of_ms"]),
        metric_version=str(source.get("metric_version", "1")),
        raw_payload_schema_version="1",
        coverage_mode=ACTIVITY_CENSUS_COVERAGE_MODE,
    )


def _positive_month_volume_evidence(
    cache: RawResponseCache,
    source: Mapping[str, Any],
    preserved: tuple[str, ...],
) -> tuple[dict[str, str], str]:
    """Use the fixed-as-of official leaderboard only as positive fill proof.

    A positive 30-day perp volume proves at least one execution.  Zero volume
    is deliberately not treated as proof of zero fills and still goes through
    the raw ``userFillsByTime`` check.
    """

    key = _source_cache_key(source, "", "leaderboard")
    key = make_raw_cache_key(
        wallet=None,
        endpoint="leaderboard",
        window_start_ms=key.window_start_ms,
        window_end_ms=key.window_end_ms,
        as_of_ms=key.as_of_ms,
        metric_version=key.metric_version,
        raw_payload_schema_version=key.raw_payload_schema_version,
        coverage_mode=key.coverage_mode,
    )
    payload = cache.get(key)
    return summarize_positive_month_volume(payload, preserved), key.digest


def _presence_from_payload(payload: Any, source: Mapping[str, Any]) -> dict[str, Any]:
    return summarize_fill_presence(
        payload,
        window_start_ms=int(source["window_start_ms"]),
        window_end_ms=int(source["window_end_ms"]),
    )


def _reuse_normalized_fill_cache(
    cache: RawResponseCache,
    source: Mapping[str, Any],
    wallet: str,
) -> tuple[Any, dict[str, Any]] | None:
    key = _source_cache_key(source, wallet, "fills-normalized-episodes")
    payload = cache.get(key)
    if not isinstance(payload, Mapping) or not isinstance(payload.get("raw_fills"), list):
        return None
    raw_fills = payload["raw_fills"]
    presence = _presence_from_payload(raw_fills, source)
    if presence["status"] == ZERO_FILLS and payload.get("coverage_complete") is not True:
        return None
    return raw_fills, {
        **presence,
        "evidence_source": "REUSED_NORMALIZED_FILL_CACHE",
        "source_cache_key_sha256": key.digest,
    }


def _build_trade_cohort(
    source: Mapping[str, Any],
    rescue_summary: Mapping[str, Any],
    census: Mapping[str, Any],
) -> dict[str, Any]:
    selected = select_exact_twr_top10_with_fills(rescue_summary, census, count=10)
    wallets = []
    for rank, row in enumerate(selected, 1):
        minimum_proven = int(row["minimum_proven_fill_count_30d"])
        observed = row.get("observed_unique_fill_count_30d")
        wallets.append({
            "rank": rank,
            "candidate_rank": row.get("rank"),
            "wallet": row["wallet"],
            "address": row["wallet"],
            "label": f"Fill-positive TWR {rank:02d}",
            "status": "ACTIVE",
            "data_quality_status": row["data_quality_status"],
            "activity_status": HAS_FILL,
            "selection_status": "ACTIVE",
            "perp_cashflow_neutral_twr_30d": row["perp_cashflow_neutral_twr_30d"],
            "raw_fill_count_30d": minimum_proven,
            "raw_fill_count_is_lower_bound": observed is None,
            "minimum_proven_fill_count_30d": minimum_proven,
            "observed_unique_fill_count_30d": observed,
            "completed_episodes_30d": row.get("completed_episodes_30d"),
        })
    cohort = {
        "schema_version": "2",
        "selection_type": "TRADE_QUALIFIED_TWR_RESEARCH",
        "selection_basis": "FULL_PRESERVED_ACCOUNT_ACTIVITY_CENSUS_EXACT_TWR",
        "simulation_only": True,
        "minimum_raw_fills_30d": 1,
        "minimum_proven_fills_30d": 1,
        "activity_evidence_scope": "OFFICIAL_PERP_MONTH_VOLUME_OR_UNAGGREGATED_DEFAULT_DEX_FILLS",
        "minimum_completed_episodes": None,
        "activity_census_complete": True,
        "activity_census_report_sha256": report_sha256(census),
        "activity_census_account_set_hash": census["account_set_hash"],
        "activity_census_scanned_account_count": census["scanned_account_count"],
        "activity_census_preserved_account_count": census["preserved_account_count"],
        "activity_census_has_fill_account_count": census["has_fill_account_count"],
        "source_run_id": source["run_id"],
        "source_as_of_ms": source["as_of_ms"],
        "source_window_start_ms": source["window_start_ms"],
        "source_window_end_ms": source["window_end_ms"],
        "source_coverage_mode": source.get("coverage_mode", "UNKNOWN"),
        "source_ranking_scope": source.get("ranking_scope", "DISCOVERY_POOL_EXACT"),
        "source_config_hash": source.get("config_hash") or source.get("metric_config_hash"),
        "source_candidate_pool_hash": source.get("candidate_pool_hash"),
        "source_rescue_report_sha256": rescue_summary["full_report_canonical_sha256"],
        "source_rescue_summary_sha256": report_sha256(rescue_summary),
        "wallet_order_hash": report_sha256([row["wallet"] for row in wallets]),
        "wallets": wallets,
    }
    cohort["cohort_sha256"] = report_sha256(cohort)
    return cohort


def _checkpoint_payload(identity: ResumeIdentity, results: Mapping[str, Any], passes: int) -> dict[str, Any]:
    return {
        **identity.to_dict(),
        "passes": passes,
        "results": dict(results),
    }


def _markdown(census: Mapping[str, Any], cohort: Mapping[str, Any]) -> str:
    lines = [
        "# Preserved-account 30D activity census",
        "",
        f"- Source run: `{census['source_run_id']}`",
        f"- Fixed window: `{census['window_start_ms']}` → `{census['window_end_ms']}`",
        f"- Terminal coverage: **{census['scanned_account_count']:,}/{census['preserved_account_count']:,}**",
        f"- At least one proven fill: **{census['has_fill_account_count']:,}**",
        f"- Zero fills after raw check: **{census['zero_fill_account_count']:,}**",
        f"- Fill-positive exact-TWR accounts: **{census['fill_positive_exact_twr_count']:,}**",
        "",
        "Positive official leaderboard month volume proves at least one execution across the leaderboard perp scope. "
        "Zero-volume accounts are checked with unaggregated raw fills before they are called inactive.",
        "",
        "## Simulation TOP10",
        "",
        "| Rank | Wallet | Exact 30D TWR | Quality |",
        "|---:|---|---:|---|",
    ]
    for row in cohort["wallets"]:
        percent = Decimal(str(row["perp_cashflow_neutral_twr_30d"])) * Decimal(100)
        lines.append(f"| {row['rank']} | `{row['wallet']}` | {percent:.8f}% | {row['data_quality_status']} |")
    lines.extend(["", f"Census SHA-256: `{cohort['activity_census_report_sha256']}`", f"Cohort SHA-256: `{cohort['cohort_sha256']}`", ""])
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rescue-summary", type=Path, default=Path("reports/perp-twr-rescue/latest-summary.json"))
    parser.add_argument("--source-report", type=Path, default=Path("reports/perp-twr-discovery/run-perp-twr-20260821-final-v4-full7000.json"))
    parser.add_argument("--cache-root", type=Path, default=Path("state/perp-twr-cache"))
    parser.add_argument("--checkpoint-root", type=Path, default=Path("state/perp-twr-activity-census"))
    parser.add_argument("--report-root", type=Path, default=Path("reports/perp-twr-activity-census"))
    parser.add_argument("--cohort-report-root", type=Path, default=Path("reports/perp-twr-trade-qualified"))
    parser.add_argument("--cohort-state", type=Path, default=Path("state/perp-twr-trade-qualified/latest_active_top10.json"))
    parser.add_argument("--checkpoint-every", type=int, default=25)
    parser.add_argument("--max-passes", type=int, default=3)
    parser.add_argument("--weight-per-second", type=float, default=20.0)
    parser.add_argument("--timeout-seconds", type=float, default=45.0)
    args = parser.parse_args()
    if args.checkpoint_every <= 0 or args.max_passes <= 0 or args.weight_per_second <= 0:
        raise ValueError("checkpoint-every, max-passes and weight-per-second must be positive")

    rescue_summary = _read(args.rescue_summary)
    source = _read(args.source_report)
    if rescue_summary.get("source_run_id") != source.get("run_id"):
        raise ValueError("rescue summary and source report run_id differ")
    if rescue_summary.get("source_report_sha256") != report_sha256(source):
        raise ValueError("rescue summary does not match the source report digest")
    for key in ("window_start_ms", "window_end_ms"):
        if int(rescue_summary[key]) != int(source[key]):
            raise ValueError(f"rescue summary and source report {key} differ")

    wallets = preserved_wallets(rescue_summary)
    set_hash = account_set_hash(wallets)
    run_id = f"activity-{source['run_id']}"
    identity = ResumeIdentity(
        run_id=run_id,
        as_of_ms=int(source["as_of_ms"]),
        metric_version=str(source.get("metric_version", "1")),
        discovery_pool_hash=set_hash,
        coverage_mode=ACTIVITY_CENSUS_COVERAGE_MODE,
    )
    checkpoint_store = CheckpointStore(args.checkpoint_root)
    checkpoint = checkpoint_store.load(run_id, expected=identity)
    results: dict[str, dict[str, Any]] = {
        str(wallet).lower(): dict(value)
        for wallet, value in ((checkpoint or {}).get("results") or {}).items()
        if isinstance(value, Mapping)
    }
    cache = RawResponseCache(args.cache_root)
    positive_volume, leaderboard_cache_digest = _positive_month_volume_evidence(cache, source, wallets)
    for wallet, volume in positive_volume.items():
        existing_status = results.get(wallet, {}).get("status")
        if existing_status == HAS_FILL:
            continue
        results[wallet] = {
            "status": HAS_FILL,
            "has_fill_30d": True,
            "minimum_proven_fill_count_30d": 1,
            "observed_unique_fill_count_30d": None,
            "evidence_source": "OFFICIAL_LEADERBOARD_POSITIVE_MONTH_VOLUME",
            "official_month_volume_usd": volume,
            "source_cache_key_sha256": leaderboard_cache_digest,
            "default_dex_raw_fill_status": existing_status if existing_status == ZERO_FILLS else None,
            "scope_note": "Official leaderboard month volume proves an execution even when the default-DEX raw endpoint is empty.",
            "attempt_count": int(results.get(wallet, {}).get("attempt_count") or 0),
        }
    checkpoint_store.save(_checkpoint_payload(identity, results, int((checkpoint or {}).get("passes") or 0)))
    budget = StageRequestBudget({"fills": len(wallets) * (args.max_passes + 1) * 7})
    client = HyperliquidApiClient(
        timeout_seconds=args.timeout_seconds,
        limiter=WeightedTokenBucket(capacity=1200, refill_per_second=args.weight_per_second, initial_tokens=0),
        budgets=budget,
        retry_policy=RetryPolicy(max_retries=6, base_delay_seconds=1.0, max_delay_seconds=60.0, jitter_fraction=0.15),
        on_retry=lambda event: print(
            f"retry fills attempt={event['attempt']} delay={event['delay_seconds']:.1f}s error={event['error']}",
            flush=True,
        ),
    )
    started = time.monotonic()
    completed_this_run = 0
    pass_number = int((checkpoint or {}).get("passes") or 0)
    print(
        f"[{run_id}] fixed window={source['window_start_ms']}..{source['window_end_ms']} "
        f"preserved={len(wallets)} positive_volume_proofs={len(positive_volume)} "
        f"resumed={sum(1 for row in results.values() if row.get('status') in (HAS_FILL, ZERO_FILLS))}",
        flush=True,
    )

    for current_pass in range(1, args.max_passes + 1):
        pass_number += 1
        pending = [wallet for wallet in wallets if results.get(wallet, {}).get("status") not in (HAS_FILL, ZERO_FILLS)]
        if not pending:
            break
        print(f"pass {current_pass}/{args.max_passes}: pending={len(pending)}", flush=True)
        for wallet in pending:
            activity_key = _activity_cache_key(source, wallet)
            try:
                payload = cache.get(activity_key)
                result: dict[str, Any]
                if payload is not None:
                    result = {**_presence_from_payload(payload, source), "evidence_source": "ACTIVITY_RAW_CACHE"}
                else:
                    reused = _reuse_normalized_fill_cache(cache, source, wallet)
                    if reused is not None:
                        payload, result = reused
                    else:
                        payload = client.fetch_fills_by_time(
                            wallet,
                            int(source["window_start_ms"]),
                            int(source["window_end_ms"]),
                            aggregate_by_time=False,
                        )
                        result = {**_presence_from_payload(payload, source), "evidence_source": "PUBLIC_API"}
                    cache.put(activity_key, payload, metadata={"purpose": "30D fill presence only"})
                results[wallet] = {
                    **result,
                    "activity_cache_key_sha256": activity_key.digest,
                    "attempt_count": int(results.get(wallet, {}).get("attempt_count") or 0) + 1,
                }
            except Exception as exc:
                results[wallet] = {
                    "status": FAILED,
                    "has_fill_30d": None,
                    "attempt_count": int(results.get(wallet, {}).get("attempt_count") or 0) + 1,
                    "reason_code": str(getattr(exc, "reason_code", "ACTIVITY_SCAN_ERROR")),
                    "reason_message": str(exc)[:1000],
                }
            completed_this_run += 1
            if completed_this_run % args.checkpoint_every == 0:
                checkpoint_store.save(_checkpoint_payload(identity, results, pass_number))
                successful = sum(1 for row in results.values() if row.get("status") in (HAS_FILL, ZERO_FILLS))
                elapsed = max(time.monotonic() - started, 0.001)
                rate = completed_this_run / elapsed
                remaining = len(wallets) - successful
                eta_minutes = remaining / rate / 60 if rate else float("inf")
                print(
                    f"progress successful={successful}/{len(wallets)} has_fill="
                    f"{sum(1 for row in results.values() if row.get('status') == HAS_FILL)} "
                    f"failed={sum(1 for row in results.values() if row.get('status') == FAILED)} eta={eta_minutes:.1f}m",
                    flush=True,
                )
        checkpoint_store.save(_checkpoint_payload(identity, results, pass_number))

    census = build_activity_census_report(rescue_summary, source, results)
    stamp = datetime.fromtimestamp(int(source["as_of_ms"]) / 1000, tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    write_json_atomic(args.report_root / f"run-{stamp}.json", census)
    write_json_atomic(args.report_root / "latest.json", census)
    if census["run_status"] != "COMPLETE":
        print(json.dumps({
            "run_status": census["run_status"],
            "scanned_account_count": census["scanned_account_count"],
            "failed_account_count": census["failed_account_count"],
            "not_scanned_account_count": census["not_scanned_account_count"],
        }, indent=2), flush=True)
        raise SystemExit(2)

    cohort = _build_trade_cohort(source, rescue_summary, census)
    write_json_atomic(args.cohort_report_root / f"run-{stamp}.json", cohort)
    write_json_atomic(args.cohort_report_root / "latest.json", cohort)
    write_json_atomic(args.cohort_state, cohort)
    markdown = _markdown(census, cohort)
    write_text_atomic(args.report_root / f"run-{stamp}.md", markdown)
    write_text_atomic(args.report_root / "latest.md", markdown)
    print(json.dumps({
        "run_status": census["run_status"],
        "scanned_account_count": census["scanned_account_count"],
        "has_fill_account_count": census["has_fill_account_count"],
        "zero_fill_account_count": census["zero_fill_account_count"],
        "activity_census_report_sha256": cohort["activity_census_report_sha256"],
        "top10": [
            {"rank": row["rank"], "wallet": row["wallet"], "twr": row["perp_cashflow_neutral_twr_30d"]}
            for row in cohort["wallets"]
        ],
        "cohort_sha256": cohort["cohort_sha256"],
    }, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
