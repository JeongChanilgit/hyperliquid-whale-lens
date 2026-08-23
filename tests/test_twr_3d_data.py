from __future__ import annotations

import unittest

from whale_lens.twr_3d_data import (
    MDD_MISSING_NO_EXACT_SAMPLES,
    PLOT_EXCLUSION_MDD,
    PLOT_EXCLUSION_TRADE_COUNT,
    TRADE_COUNT_MISSING,
    build_twr_3d_dataset,
)


def source_report(*wallets):
    return {
        "report_sha256": "source-report-sha",
        "run_id": "simple-research-run",
        "research_only": True,
        "selection_type": "PORTFOLIO_PERP_MONTH_SIMPLE_TWR_RESEARCH",
        "data_quality": "PORTFOLIO_ONLY_ESTIMATE",
        "metric_name": "perp_month_simple_twr_30d",
        "metric_version": "1",
        "activity_evidence": "PERP_MONTH_VLM_POSITIVE",
        "cashflow_neutral_verified": False,
        "source_universe": {"window_start_ms": 100, "window_end_ms": 200},
        "wallets": list(wallets),
    }


def eligible(wallet, twr, **overrides):
    row = {
        "wallet": wallet,
        "status": "ELIGIBLE",
        "perp_month_simple_twr_30d": twr,
        "exact_trade_count_30d": None,
        "pnl_changing_interval_count": 100,
        "activity_evidence": "PERP_MONTH_VLM_POSITIVE",
    }
    row.update(overrides)
    return row


class TWR3DDataTests(unittest.TestCase):
    def test_keeps_every_eligible_three_hundred_percent_wallet_but_fails_closed_for_missing_axes(self):
        report = source_report(
            eligible("0xB", "3"),
            eligible("0xA", "4.5", rank=17),
            eligible("0xC", "2.999999"),
            {"wallet": "0xD", "status": "EXCLUDED", "perp_month_simple_twr_30d": "100"},
        )

        dataset = build_twr_3d_dataset(report)

        self.assertEqual(dataset["record_count"], 2)
        self.assertEqual(dataset["plot_record_count"], 0)
        self.assertEqual(dataset["source"]["report_sha256"], "source-report-sha")
        self.assertEqual(dataset["source"]["as_of_ms"], 200)
        self.assertTrue(dataset["research_only"])
        self.assertFalse(dataset["canonical_or_runner_eligible"])
        first, second = dataset["records"]
        self.assertEqual((first["wallet"], first["rank"], first["source_rank"]), ("0xa", 1, 17))
        self.assertEqual((second["wallet"], second["rank"], second["source_rank"]), ("0xb", 2, None))
        self.assertEqual(first["return_pct"], 450.0)
        self.assertEqual(first["mdd_status"], "MISSING")
        self.assertEqual(first["mdd_missing_reason"], MDD_MISSING_NO_EXACT_SAMPLES)
        self.assertIsNone(first["trade_count_raw"])
        self.assertEqual(first["trade_count_missing_reason"], TRADE_COUNT_MISSING)
        self.assertEqual(first["trade_count_proxy_raw"], 100)
        self.assertEqual(first["trade_count_proxy_plot_log10"], 2.0)
        self.assertIsNone(first["trade_count_plot_log10"])
        self.assertFalse(first["plot_eligible"])
        self.assertEqual(
            first["plot_exclusion_reasons"],
            [PLOT_EXCLUSION_MDD, PLOT_EXCLUSION_TRADE_COUNT],
        )

    def test_exact_count_and_explicit_aligned_samples_unlock_three_axis_plot(self):
        report = source_report(
            eligible(
                "0xA",
                "3.01",
                exact_trade_count_30d="10",
                pnl_changing_interval_count=4,
                exact_aligned_account_pnl_samples=[
                    {"timestamp_ms": 1, "account_value_usd": "100", "cumulative_pnl_usd": "0"},
                    {"timestamp_ms": 2, "account_value_usd": "120", "cumulative_pnl_usd": "20"},
                    {"timestamp_ms": 3, "account_value_usd": "90", "cumulative_pnl_usd": "-10"},
                    {"timestamp_ms": 4, "account_value_usd": "150", "cumulative_pnl_usd": "50"},
                ],
            )
        )

        record = build_twr_3d_dataset(report)["records"][0]

        self.assertEqual(record["mdd_pct"], 25.0)
        self.assertEqual(record["mdd_status"], "AVAILABLE")
        self.assertEqual(record["trade_count_raw"], 10)
        self.assertEqual(record["trade_count_plot_log10"], 1.0)
        self.assertEqual(record["trade_count_proxy_raw"], 4)
        self.assertEqual(record["trade_count_proxy_plot_log10"], 0.6020599913279624)
        self.assertTrue(record["plot_eligible"])
        self.assertEqual(record["plot_exclusion_reasons"], [])

    def test_rejects_a_source_that_is_not_explicitly_research_only(self):
        report = source_report(eligible("0xA", "3"))
        report["research_only"] = False

        with self.assertRaisesRegex(ValueError, "research_only"):
            build_twr_3d_dataset(report)


if __name__ == "__main__":
    unittest.main()
