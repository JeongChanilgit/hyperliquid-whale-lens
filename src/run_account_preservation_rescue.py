"""Rebuild account-preservation rescue artifacts from one saved screening run."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from whale_lens.cache import RawResponseCache
from whale_lens.evidence_registry import EvidenceRegistry
from whale_lens.report import write_json_atomic, write_text_atomic
from whale_lens.rescue import build_rescue_markdown, build_rescue_report, select_trade_qualified_top10


def _read(path: Path) -> Mapping[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str).encode()).hexdigest()


def _rescue_summary(rescue: Mapping[str, Any]) -> dict[str, Any]:
    """Keep the dashboard/startup contract small while the full evidence stays local."""
    compact_accounts = []
    for row in rescue.get("accounts", []):
        compact_accounts.append(
            {
                key: row.get(key)
                for key in (
                    "wallet",
                    "data_quality_status",
                    "activity_status",
                    "selection_status",
                    "source_reason_codes",
                    "reason_codes",
                    "latest_scores",
                    "account_value_usd",
                    "raw_fill_count_30d",
                    "completed_episodes_30d",
                    "rescue_priority_score",
                )
            }
        )
    return {
        key: rescue.get(key)
        for key in (
            "schema_version",
            "rescue_engine_version",
            "source_run_id",
            "source_report_sha256",
            "window_start_ms",
            "window_end_ms",
            "discovered_accounts",
            "quality_counts",
            "activity_counts",
            "selection_counts",
            "reason_counts",
            "rescue_outcomes",
            "rescue_queue_count",
            "audit_samples",
        )
    } | {
        "full_report_canonical_sha256": _hash(rescue),
        "accounts": compact_accounts,
    }


def _trade_cohort(
    source: Mapping[str, Any],
    rescue: Mapping[str, Any],
    rescue_summary: Mapping[str, Any],
) -> dict[str, Any]:
    selected = select_trade_qualified_top10(rescue)
    wallets = []
    for rank, row in enumerate(selected, 1):
        wallets.append(
            {
                "rank": rank,
                "candidate_rank": row.get("rank"),
                "wallet": row["wallet"],
                "address": row["wallet"],
                "label": f"Trade-qualified TWR {rank:02d}",
                "status": "ACTIVE",
                "data_quality_status": row["data_quality_status"],
                "activity_status": row["activity_status"],
                "selection_status": "ACTIVE",
                "perp_cashflow_neutral_twr_30d": row["latest_scores"]["exact_twr"],
                "raw_fill_count_30d": row["raw_fill_count_30d"],
                "completed_episodes_30d": row["completed_episodes_30d"],
            }
        )
    wallet_hash = _hash([row["wallet"] for row in wallets])
    return {
        "schema_version": "1",
        "selection_type": "TRADE_QUALIFIED_TWR_RESEARCH",
        "simulation_only": True,
        "minimum_raw_fills_30d": 1,
        "minimum_completed_episodes": None,
        "source_run_id": source["run_id"],
        "source_as_of_ms": source["as_of_ms"],
        "source_window_start_ms": source["window_start_ms"],
        "source_window_end_ms": source["window_end_ms"],
        "source_coverage_mode": source.get("coverage_mode", "UNKNOWN"),
        "source_ranking_scope": source.get("ranking_scope", "DISCOVERY_POOL_EXACT"),
        "source_config_hash": source.get("config_hash") or source.get("metric_config_hash"),
        "source_candidate_pool_hash": source.get("candidate_pool_hash"),
        "source_rescue_report_sha256": _hash(rescue),
        "source_rescue_summary_sha256": _hash(rescue_summary),
        "wallet_order_hash": wallet_hash,
        "wallets": wallets,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-report", type=Path, required=True)
    parser.add_argument("--cache-root", type=Path, default=Path("state/perp-twr-cache"))
    parser.add_argument("--registry-root", type=Path, default=Path("state/account-evidence-registry"))
    parser.add_argument("--report-root", type=Path, default=Path("reports/perp-twr-rescue"))
    parser.add_argument("--cohort-report-root", type=Path, default=Path("reports/perp-twr-trade-qualified"))
    parser.add_argument("--cohort-state", type=Path, default=Path("state/perp-twr-trade-qualified/latest_active_top10.json"))
    parser.add_argument(
        "--reuse-latest-rescue",
        action="store_true",
        help="Regenerate compact/hash-linked artifacts from report-root/latest.json without reevaluating accounts.",
    )
    args = parser.parse_args()

    source = _read(args.source_report)
    rescue = (
        _read(args.report_root / "latest.json")
        if args.reuse_latest_rescue
        else build_rescue_report(
            source,
            cache=RawResponseCache(args.cache_root),
            registry=EvidenceRegistry(args.registry_root),
            progress=lambda message: print(message, flush=True),
        )
    )
    stamp = datetime.fromtimestamp(int(source["as_of_ms"]) / 1000, tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    if not args.reuse_latest_rescue:
        write_json_atomic(args.report_root / f"run-{stamp}.json", rescue)
        write_json_atomic(args.report_root / "latest.json", rescue)
        markdown = build_rescue_markdown(rescue)
        write_text_atomic(args.report_root / f"run-{stamp}.md", markdown)
        write_text_atomic(args.report_root / "latest.md", markdown)

    rescue_summary = _rescue_summary(rescue)
    write_json_atomic(args.report_root / f"run-{stamp}-summary.json", rescue_summary)
    write_json_atomic(args.report_root / "latest-summary.json", rescue_summary)

    cohort = _trade_cohort(source, rescue, rescue_summary)
    cohort["cohort_sha256"] = _hash(cohort)
    write_json_atomic(args.cohort_report_root / f"run-{stamp}.json", cohort)
    write_json_atomic(args.cohort_report_root / "latest.json", cohort)
    write_json_atomic(args.cohort_state, cohort)
    print(json.dumps({
        "preserved_accounts": rescue["discovered_accounts"],
        "quality_counts": rescue["quality_counts"],
        "rescue_queue_count": rescue["rescue_queue_count"],
        "trade_qualified_top10": [row["wallet"] for row in cohort["wallets"]],
        "cohort_sha256": cohort["cohort_sha256"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
