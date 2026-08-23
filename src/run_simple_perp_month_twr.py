"""Run the isolated research-only simple ``portfolio.perpMonth`` ranking."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from whale_lens.simple_perp_month import run_simple_perp_month_research


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Research-only exact-timestamp perpMonth TWR. It reads the current "
            "preserved universe and does not update canonical TOP10/copy-runner state."
        )
    )
    parser.add_argument(
        "--universe",
        type=Path,
        default=Path("reports/perp-twr-rescue/latest-summary.json"),
        help="saved exact preserved-universe report (default: latest rescue summary)",
    )
    parser.add_argument(
        "--cache-root",
        type=Path,
        default=Path("state/perp-twr-cache"),
        help="existing raw-response cache root",
    )
    parser.add_argument(
        "--reports-dir",
        type=Path,
        default=Path("reports/perp-month-simple-twr"),
        help="research-only report output directory",
    )
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=Path("state/perp-month-simple-twr"),
        help="research-only state output directory",
    )
    parser.add_argument("--run-id", help="optional deterministic artifact run id")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    report, paths = run_simple_perp_month_research(
        universe_path=args.universe,
        cache_root=args.cache_root,
        reports_dir=args.reports_dir,
        state_dir=args.state_dir,
        run_id=args.run_id,
    )
    print(
        json.dumps(
            {
                "run_id": report["run_id"],
                "run_status": report["run_status"],
                "coverage": report["coverage"],
                "report_sha256": report["report_sha256"],
                "artifacts": paths,
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
