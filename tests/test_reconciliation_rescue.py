import unittest
from decimal import Decimal

from whale_lens.models import PerpPortfolioSample
from whale_lens.reconciliation import classify_residual_pattern, diagnose_residuals, reconcile_blocks


def sample(t, equity, pnl):
    return PerpPortfolioSample(t, Decimal(str(equity)), Decimal(str(pnl)))


class ReconciliationRescueTests(unittest.TestCase):
    def test_alternating_residual_and_block2_reconcile(self) -> None:
        samples = [sample(0, 100, 0), sample(1, 111, 10), sample(2, 120, 20)]
        diagnostics = diagnose_residuals(samples, [])
        self.assertEqual(diagnostics[0].pattern, "ALTERNATING_RESIDUAL")
        result = reconcile_blocks(samples, [], graph_noise_tolerance_usd=Decimal("1"), absolute_cap_usd=Decimal("5"))
        self.assertEqual(result.data_quality_status, "VERIFIED_BLOCK_RECONCILED")
        self.assertEqual(result.blocks[0].interval_count, 2)

    def test_block4_and_block8_work_and_persistent_does_not_pass(self) -> None:
        def series(residuals):
            values = [sample(0, 100, 0)]
            equity = Decimal("100")
            pnl = Decimal("0")
            for index, residual in enumerate(residuals, 1):
                pnl += Decimal("1")
                equity += Decimal("1") + Decimal(str(residual))
                values.append(sample(index, equity, pnl))
            return values
        block4 = reconcile_blocks(series([1, 1, -1, -1]), [], graph_noise_tolerance_usd=Decimal("1"), absolute_cap_usd=Decimal("5"))
        self.assertEqual(block4.blocks[0].interval_count, 4)
        block8 = reconcile_blocks(series([1, 1, -1, 1, -1, -1, 1, -1]), [], graph_noise_tolerance_usd=Decimal("1"), absolute_cap_usd=Decimal("5"))
        self.assertEqual(block8.blocks[0].interval_count, 8)
        persistent = reconcile_blocks(series([1, 1, 1]), [], graph_noise_tolerance_usd=Decimal("5"), absolute_cap_usd=Decimal("5"))
        self.assertEqual(persistent.data_quality_status, "BOUNDED")

    def test_residual_pattern_helper(self) -> None:
        self.assertEqual(classify_residual_pattern([Decimal("2"), Decimal("-2")], 0, Decimal("0.1")), "ALTERNATING_RESIDUAL")


if __name__ == "__main__":
    unittest.main()
