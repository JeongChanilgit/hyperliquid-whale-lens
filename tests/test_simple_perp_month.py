from __future__ import annotations

import json
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from whale_lens.cache import RawResponseCache, make_raw_cache_key
from whale_lens.simple_perp_month import (
    REASON_INSUFFICIENT_ALIGNED_SAMPLES,
    REASON_LATEST_ACCOUNT_VALUE_BELOW_MINIMUM,
    REASON_MISSING_RAW_PORTFOLIO,
    REASON_PNL_INTERVAL_CAPITAL_BELOW_MINIMUM,
    REASON_VALID,
    REASON_VLM_NOT_POSITIVE,
    build_simple_perp_month_report,
    exact_perp_month_samples,
    load_matching_cached_portfolios,
    load_preserved_universe,
    rank_simple_scores,
    run_simple_perp_month_research,
    score_simple_perp_month,
)


def portfolio(accounts, pnls, *, volume="1"):
    return [
        ["perpMonth", {"accountValueHistory": accounts, "pnlHistory": pnls, "vlm": volume}],
        ["month", {"accountValueHistory": [[1, "999999"]], "pnlHistory": [[1, "999999"]], "vlm": "99"}],
    ]


class SimplePerpMonthScoringTests(unittest.TestCase):
    def test_pasted_cashflow_examples_use_pnl_delta_and_compounding(self):
        cases = {
            "deposit_only": (
                portfolio([[1, "10000"], [2, "20000"]], [[1, "0"], [2, "0"]]),
                Decimal("0"),
            ),
            "profit_then_deposit": (
                portfolio([[1, "10000"], [2, "20000"], [3, "30000"]], [[1, "0"], [2, "10000"], [3, "10000"]]),
                Decimal("1"),
            ),
            "withdrawal_only": (
                portfolio([[1, "20000"], [2, "10000"]], [[1, "0"], [2, "0"]]),
                Decimal("0"),
            ),
            "plus_ten_twice": (
                portfolio([[1, "10000"], [2, "11000"], [3, "12100"]], [[1, "0"], [2, "1000"], [3, "2100"]]),
                Decimal("0.21"),
            ),
            "minus_fifty_plus_fifty": (
                portfolio([[1, "20000"], [2, "10000"], [3, "20000"]], [[1, "0"], [2, "-10000"], [3, "-5000"]]),
                Decimal("-0.25"),
            ),
        }
        for name, (payload, expected) in cases.items():
            with self.subTest(name=name):
                result = score_simple_perp_month("0xabc", payload)
                self.assertEqual(result.reason_code, REASON_VALID)
                self.assertEqual(result.twr, expected)

    def test_filters_latest_value_volume_and_pnl_interval_capital(self):
        base_accounts = [[1, "10000"], [2, "11000"]]
        base_pnls = [[1, "0"], [2, "1000"]]
        self.assertEqual(
            score_simple_perp_month("0x1", portfolio(base_accounts, base_pnls, volume="0")).reason_code,
            REASON_VLM_NOT_POSITIVE,
        )
        self.assertEqual(
            score_simple_perp_month("0x2", portfolio([[1, "10000"], [2, "9999"]], base_pnls)).reason_code,
            REASON_LATEST_ACCOUNT_VALUE_BELOW_MINIMUM,
        )
        self.assertEqual(
            score_simple_perp_month("0x3", portfolio([[1, "9999"], [2, "11000"]], base_pnls)).reason_code,
            REASON_PNL_INTERVAL_CAPITAL_BELOW_MINIMUM,
        )

    def test_output_marks_this_as_a_portfolio_only_research_estimate_with_flow_diagnostics(self):
        result = score_simple_perp_month(
            "0x1",
            portfolio([[1, "10000"], [2, "22000"], [3, "23100"]], [[1, "0"], [2, "2000"], [3, "3100"]]),
        )
        row = result.to_dict()
        self.assertTrue(result.eligible)
        self.assertEqual(row["selection_type"], "PORTFOLIO_PERP_MONTH_SIMPLE_TWR_RESEARCH")
        self.assertEqual(row["data_quality"], "PORTFOLIO_ONLY_ESTIMATE")
        self.assertEqual(row["activity_evidence"], "PERP_MONTH_VLM_POSITIVE")
        self.assertIsNone(row["exact_trade_count_30d"])
        self.assertFalse(row["cashflow_neutral_verified"])
        self.assertEqual(row["minimum_pnl_changing_previous_equity_usd"], "10000")
        self.assertEqual(row["implied_flow_nonzero_interval_count"], 1)
        self.assertEqual(row["implied_flow_max_abs_usd"], "10000")
        self.assertEqual(row["implied_flow_max_relative_to_previous_equity"], "1")

    def test_only_exact_timestamp_matches_are_scored(self):
        payload = portfolio([[1, "10000"], [2, "11000"]], [[1, "0"], [3, "1000"]])
        self.assertEqual(len(exact_perp_month_samples(payload)), 1)
        result = score_simple_perp_month("0xabc", payload)
        self.assertEqual(result.reason_code, REASON_INSUFFICIENT_ALIGNED_SAMPLES)

    def test_ranking_is_descending_with_wallet_tie_break(self):
        high = score_simple_perp_month("0xB", portfolio([[1, "10000"], [2, "12000"]], [[1, "0"], [2, "2000"]]))
        tie_later = score_simple_perp_month("0xD", portfolio([[1, "10000"], [2, "11000"]], [[1, "0"], [2, "1000"]]))
        tie_first = score_simple_perp_month("0xC", portfolio([[1, "10000"], [2, "11000"]], [[1, "0"], [2, "1000"]]))
        self.assertEqual([score.wallet for score in rank_simple_scores([tie_later, high, tie_first])], ["0xb", "0xc", "0xd"])


class SimplePerpMonthPipelineTests(unittest.TestCase):
    def _universe_document(self):
        return {
            "source_run_id": "preserved-run",
            "source_report_sha256": "source-report-hash",
            "window_start_ms": 100,
            "window_end_ms": 200,
            "preserved_account_count": 4,
            "accounts": [{"wallet": "0xD"}, {"wallet": "0xC"}, {"wallet": "0xB"}, {"wallet": "0xA"}],
        }

    def test_cache_only_pipeline_reports_missing_and_writes_isolated_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            universe_path = root / "universe.json"
            universe_path.write_text(json.dumps(self._universe_document()), encoding="utf-8")
            universe = load_preserved_universe(universe_path)
            cache_root = root / "cache"
            cache = RawResponseCache(cache_root)
            cache.put(
                make_raw_cache_key(
                    wallet="0xa",
                    endpoint="portfolio",
                    window_start_ms=100,
                    window_end_ms=200,
                    as_of_ms=200,
                ),
                portfolio([[1, "10000"], [2, "12000"]], [[1, "0"], [2, "2000"]]),
            )
            cache.put(
                make_raw_cache_key(
                    wallet="0xc",
                    endpoint="portfolio",
                    window_start_ms=100,
                    window_end_ms=200,
                    as_of_ms=200,
                    raw_payload_schema_version="2",
                ),
                portfolio([[1, "10000"], [2, "12000"]], [[1, "0"], [2, "2000"]]),
            )
            cache.put(
                make_raw_cache_key(
                    wallet="0xd",
                    endpoint="portfolio",
                    window_start_ms=100,
                    window_end_ms=200,
                    as_of_ms=200,
                    coverage_mode="SIMPLE_PERP_MONTH_RESEARCH",
                ),
                portfolio([[1, "10000"], [2, "12000"]], [[1, "0"], [2, "2000"]]),
            )
            cache.put(
                make_raw_cache_key(
                    wallet="0xb",
                    endpoint="portfolio",
                    window_start_ms=100,
                    window_end_ms=200,
                    as_of_ms=200,
                    metric_version="2",
                ),
                portfolio([[1, "10000"], [2, "12000"]], [[1, "0"], [2, "2000"]]),
            )
            payloads, provenance = load_matching_cached_portfolios(cache_root, universe)
            self.assertEqual(sorted(payloads), ["0xa"])
            self.assertEqual(provenance["matching_portfolio_record_count"], 1)
            self.assertEqual(provenance["required_cache_identity"]["coverage_mode"], "FAST_INCREMENTAL")
            report, paths = run_simple_perp_month_research(
                universe_path=universe_path,
                cache_root=cache_root,
                reports_dir=root / "reports",
                state_dir=root / "state",
                run_id="simple-test",
            )
            self.assertEqual(report["run_status"], "PARTIAL")
            self.assertFalse(report["canonical_state_updated"])
            self.assertEqual(report["data_quality"], "PORTFOLIO_ONLY_ESTIMATE")
            self.assertTrue(report["cache_provenance"]["api_backfill_disabled"])
            self.assertEqual(report["coverage"]["missing_raw_payload_count"], 3)
            missing = next(row for row in report["wallets"] if row["wallet"] == "0xb")
            self.assertEqual(missing["reason_code"], REASON_MISSING_RAW_PORTFOLIO)
            self.assertTrue(Path(paths["report_json"]).is_file())
            self.assertTrue(Path(paths["state_latest_markdown"]).is_file())
            self.assertIn("research-only", Path(paths["report_markdown"]).read_text(encoding="utf-8").lower())

    def test_report_hash_and_top10_are_deterministic(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            universe_path = root / "universe.json"
            universe_path.write_text(json.dumps(self._universe_document()), encoding="utf-8")
            universe = load_preserved_universe(universe_path)
            payloads = {
                "0xa": portfolio([[1, "10000"], [2, "11000"]], [[1, "0"], [2, "1000"]]),
                "0xb": portfolio([[1, "10000"], [2, "12000"]], [[1, "0"], [2, "2000"]]),
            }
            left = build_simple_perp_month_report(universe, payloads, cache_provenance={}, run_id="repeatable")
            right = build_simple_perp_month_report(universe, payloads, cache_provenance={}, run_id="repeatable")
            self.assertEqual(left["report_sha256"], right["report_sha256"])
            self.assertEqual([row["wallet"] for row in left["top10"]], ["0xb", "0xa"])


if __name__ == "__main__":
    unittest.main()
