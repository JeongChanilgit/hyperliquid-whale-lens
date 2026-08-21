import unittest
from decimal import Decimal

from whale_lens.interval_twr import calculate_interval_rescue, merge_guard_samples
from whale_lens.models import CashFlowEvent, PerpPortfolioSample


def sample(t, equity, pnl):
    return PerpPortfolioSample(t, Decimal(str(equity)), Decimal(str(pnl)))


def flow(t, amount):
    return CashFlowEvent(t, Decimal(str(amount)), "deposit" if amount >= 0 else "withdraw", "EXTERNAL_IN" if amount >= 0 else "EXTERNAL_OUT")


class IntervalRescueTests(unittest.TestCase):
    def test_zero_pnl_interval_flow_is_verified_zero_return(self) -> None:
        result = calculate_interval_rescue([sample(0, 100, 0), sample(100, 150, 0)], [flow(50, 50)])
        self.assertEqual(result.data_quality_status, "VERIFIED_INTERVAL")
        self.assertEqual(result.exact_twr, Decimal("0"))

    def test_multiple_flows_use_net_and_flow_plus_pnl_produces_bounds_and_dietz(self) -> None:
        flows = [flow(25, 50), flow(75, -20)]
        result = calculate_interval_rescue([sample(0, 100, 0), sample(100, 140, 10)], flows)
        self.assertEqual(result.data_quality_status, "ESTIMATED_MODIFIED_DIETZ")
        self.assertIsNotNone(result.twr_lower_bound)
        self.assertIsNotNone(result.twr_upper_bound)
        self.assertLessEqual(result.twr_lower_bound, result.estimated_twr)
        self.assertLessEqual(result.estimated_twr, result.twr_upper_bound)
        self.assertIn("MULTIPLE_FLOWS_SAME_INTERVAL", result.reason_codes)

    def test_guard_conflict_is_rejected_and_outside_return_is_not_added(self) -> None:
        window = [sample(100, 100, 0), sample(200, 110, 10)]
        merged = merge_guard_samples(window, [sample(50, 100, 0), sample(250, 110, 10)], window_start_ms=100, window_end_ms=200)
        self.assertEqual([item.time_ms for item in merged], [100, 200])
        with self.assertRaises(ValueError):
            merge_guard_samples(window, [sample(100, 999, 0)], window_start_ms=100, window_end_ms=200)

    def test_zero_capital_is_preserved_as_unresolved_not_divided(self) -> None:
        result = calculate_interval_rescue([sample(0, 0, 0), sample(100, 1, 1)], [])
        self.assertEqual(result.data_quality_status, "UNRESOLVED")
        self.assertIn("NONPOSITIVE_CAPITAL_BASE", result.reason_codes)


if __name__ == "__main__":
    unittest.main()
