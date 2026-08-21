import unittest
from decimal import Decimal

from whale_lens.models import CashFlowEvent, ClassifiedCashFlow, PerpPortfolioSample
from whale_lens.rescue import assign_rescue_priorities, evaluate_account, select_trade_qualified_top10


WALLET = "0x" + "12" * 20


class RescuePipelineTests(unittest.TestCase):
    def test_exact_status_is_independent_from_activity_and_selection(self) -> None:
        row = {"wallet": WALLET, "quality": "VERIFIED", "reason_code": "VALID", "perp_cashflow_neutral_twr_30d": "1.2", "provisional_perp_twr_30d": "1.1", "current_account_value_usd": "10000"}
        result = evaluate_account(row, fill_result={"valid": True, "raw_fill_count": 1, "completed_episodes": 0})
        self.assertEqual(result.data_quality_status.value, "VERIFIED_EXACT")
        self.assertEqual(result.activity_status.value, "INSUFFICIENT_COMPLETED_EPISODES")
        self.assertEqual(result.selection_status.value, "STANDBY")

    def test_boundary_failure_is_interval_rescued_without_erasing_original_reason(self) -> None:
        row = {"wallet": WALLET, "quality": "UNVERIFIABLE", "reason_code": "CASHFLOW_BOUNDARY_MISSING", "provisional_perp_twr_30d": "0.5", "current_account_value_usd": "10000"}
        samples = [PerpPortfolioSample(0, Decimal("100"), Decimal("0")), PerpPortfolioSample(100, Decimal("150"), Decimal("0"))]
        classified = [ClassifiedCashFlow(50, Decimal("50"), "EXTERNAL_IN", "deposit", "EXACT", {})]
        result = evaluate_account(row, samples=samples, classified_flows=classified)
        self.assertEqual(result.data_quality_status.value, "VERIFIED_INTERVAL")
        self.assertIn("CASHFLOW_BOUNDARY_MISSING", result.reason_codes)
        self.assertEqual(result.latest_scores["exact_twr"], "0")

    def test_trade_qualified_view_requires_one_fill_and_preserves_exact_order(self) -> None:
        rows = []
        for rank in range(1, 12):
            rows.append({
                "rank": rank, "wallet": f"0x{rank:040x}", "data_quality_status": "VERIFIED_EXACT",
                "raw_fill_count_30d": 0 if rank == 1 else 1,
                "latest_scores": {"exact_twr": str(100-rank)},
            })
        selected = select_trade_qualified_top10({"exact_ranking": rows})
        self.assertEqual([row["rank"] for row in selected], list(range(2, 12)))


if __name__ == "__main__":
    unittest.main()
