import sys
import unittest
from decimal import Decimal
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from whale_lens.models import CashFlowClassification, CashFlowEvent, DataQuality, LedgerCoverage, PerpPortfolioSample, ReasonCode  # noqa: E402
from whale_lens.portfolio import normalize_perp_month  # noqa: E402
from whale_lens.twr import calculate_provisional_perp_twr, calculate_verified_perp_twr  # noqa: E402


def sample(time, equity, pnl):
    return PerpPortfolioSample(time, Decimal(equity), Decimal(pnl))


def flow(time, amount, delta_type="deposit", classification=CashFlowClassification.EXTERNAL_IN):
    return CashFlowEvent(time, Decimal(amount), delta_type, classification)


def complete_coverage(samples):
    return LedgerCoverage(samples[0].time_ms, samples[-1].time_ms, True)


class MandatoryReturnExamples(unittest.TestCase):
    def verified(self, samples, cashflows=()):
        result = calculate_verified_perp_twr(samples, cashflows, ledger_coverage=complete_coverage(samples))
        self.assertTrue(result.is_valid, result.reason_message)
        self.assertEqual(result.quality, DataQuality.VERIFIED)
        return result

    def test_4_1_deposit_only_is_zero(self):
        result = self.verified([sample(0, "1", "0"), sample(10, "101", "0")], [flow(10, "100")])
        self.assertEqual(result.twr, Decimal("0"))
        self.assertEqual(result.to_dict()["perp_cashflow_neutral_twr_30d"], "0")

    def test_4_2_profit_then_deposit_is_one_hundred_percent(self):
        result = self.verified(
            [sample(0, "1", "0"), sample(10, "2", "1"), sample(20, "102", "1")],
            [flow(20, "100")],
        )
        self.assertEqual(result.twr, Decimal("1"))

    def test_4_3_deposit_then_profit_uses_deposit_as_next_base(self):
        result = self.verified(
            [sample(0, "1", "0"), sample(10, "101", "0"), sample(20, "102", "1")],
            [flow(10, "100")],
        )
        self.assertEqual(result.twr, Decimal("1") / Decimal("101"))

    def test_4_4_withdrawal_only_is_zero(self):
        result = self.verified(
            [sample(0, "100", "0"), sample(10, "10", "0")],
            [flow(10, "-90", "withdraw", CashFlowClassification.EXTERNAL_OUT)],
        )
        self.assertEqual(result.twr, Decimal("0"))

    def test_4_5_profit_then_withdrawal_remains_twenty_percent(self):
        result = self.verified(
            [sample(0, "100", "0"), sample(10, "120", "20"), sample(20, "20", "20")],
            [flow(20, "-100", "withdraw", CashFlowClassification.EXTERNAL_OUT)],
        )
        self.assertEqual(result.twr, Decimal("0.2"))

    def test_4_6_withdrawal_then_profit_uses_remaining_equity(self):
        result = self.verified(
            [sample(0, "100", "0"), sample(10, "10", "0"), sample(20, "15", "5")],
            [flow(10, "-90", "withdraw", CashFlowClassification.EXTERNAL_OUT)],
        )
        self.assertEqual(result.twr, Decimal("0.5"))

    def test_4_7_deposit_withdrawal_round_trip_is_ten_percent(self):
        result = self.verified(
            [sample(0, "100", "0"), sample(10, "200", "0"), sample(20, "220", "20"), sample(30, "120", "20")],
            [flow(10, "100"), flow(30, "-100", "withdraw", CashFlowClassification.EXTERNAL_OUT)],
        )
        self.assertEqual(result.twr, Decimal("0.1"))

    def test_4_8_compounding_examples(self):
        up = self.verified([sample(0, "100", "0"), sample(10, "110", "10"), sample(20, "121", "21")])
        down_up = self.verified([sample(0, "100", "0"), sample(10, "50", "-50"), sample(20, "75", "-25")])
        self.assertEqual(up.twr, Decimal("0.21"))
        self.assertEqual(down_up.twr, Decimal("-0.25"))


class PerpTwrFailureAndNormalizationTests(unittest.TestCase):
    def test_perp_month_is_used_without_month_fallback(self):
        payload = [
            ["month", {"accountValueHistory": [[0, "100"], [10, "1000"]], "pnlHistory": [[0, "0"], [10, "900"]]}],
            ["perpMonth", {"accountValueHistory": [[0, "100"], [10, "110"]], "pnlHistory": [[0, "0"], [10, "10"]]}],
        ]
        normalized = normalize_perp_month(payload, 0, 10)
        self.assertTrue(normalized.is_valid, normalized.reason_message)
        result = calculate_provisional_perp_twr(normalized)
        self.assertEqual(result.twr, Decimal("0.1"))

        missing = normalize_perp_month(payload[:1], 0, 10)
        self.assertEqual(missing.reason_code, ReasonCode.MISSING_PERP_MONTH)

    def test_incomplete_window_and_alignment_fail_closed(self):
        payload = {"perpMonth": {"accountValueHistory": [[5, "100"], [10, "110"]], "pnlHistory": [[5, "0"], [10, "10"]]}}
        result = normalize_perp_month(payload, 0, 10, tolerance_ms=2)
        self.assertEqual(result.reason_code, ReasonCode.WINDOW_COVERAGE_INCOMPLETE)

        misaligned = {"perpMonth": {"accountValueHistory": [[0, "100"], [10, "110"]], "pnlHistory": [[3_000, "0"], [13_000, "10"]]}}
        result = normalize_perp_month(misaligned, 0, 13_000, tolerance_ms=2_000)
        self.assertEqual(result.reason_code, ReasonCode.PORTFOLIO_ALIGNMENT_FAILED)

    def test_verified_window_rejects_one_sided_boundary_relabeling(self):
        payload = {"perpMonth": {"accountValueHistory": [[5, "100"], [10, "110"]], "pnlHistory": [[5, "0"], [10, "10"]]}}
        provisional = normalize_perp_month(payload, 0, 10, window_coverage_tolerance_ms=10)
        self.assertTrue(provisional.is_valid, provisional.reason_message)
        verified = normalize_perp_month(
            payload,
            0,
            10,
            window_coverage_tolerance_ms=10,
            allow_single_sided_boundary_tolerance=False,
        )
        self.assertEqual(verified.reason_code, ReasonCode.WINDOW_COVERAGE_INCOMPLETE)

    def test_reconciliation_ambiguity_and_nonpositive_capital_are_diagnostic_failures(self):
        residual_samples = [sample(0, "100", "0"), sample(10, "110", "0")]
        residual = calculate_verified_perp_twr(residual_samples, [], ledger_coverage=complete_coverage(residual_samples))
        self.assertEqual(residual.reason_code, ReasonCode.RECONCILIATION_RESIDUAL_TOO_LARGE)

        ambiguous_samples = [sample(0, "100", "0"), sample(10, "210", "10")]
        ambiguous = calculate_verified_perp_twr(
            ambiguous_samples, [flow(10, "100")], ledger_coverage=complete_coverage(ambiguous_samples)
        )
        self.assertEqual(ambiguous.reason_code, ReasonCode.EVENT_ORDER_AMBIGUOUS)
        approximate = calculate_verified_perp_twr(
            ambiguous_samples, [flow(10, "100")], ledger_coverage=complete_coverage(ambiguous_samples), strict=False
        )
        self.assertEqual(approximate.quality, DataQuality.APPROXIMATE)

        nonpositive_samples = [sample(0, "0", "0"), sample(10, "1", "1")]
        nonpositive = calculate_verified_perp_twr(nonpositive_samples, [], ledger_coverage=complete_coverage(nonpositive_samples))
        self.assertEqual(nonpositive.reason_code, ReasonCode.NONPOSITIVE_CAPITAL_BASE)

    def test_minus_one_hundred_is_allowed_but_below_is_not(self):
        wiped_samples = [sample(0, "100", "0"), sample(10, "0", "-100")]
        wiped = calculate_verified_perp_twr(wiped_samples, [], ledger_coverage=complete_coverage(wiped_samples))
        self.assertTrue(wiped.is_valid)
        self.assertEqual(wiped.twr, Decimal("-1"))
        below_samples = [sample(0, "100", "0"), sample(10, "-10", "-110")]
        below = calculate_verified_perp_twr(below_samples, [], ledger_coverage=complete_coverage(below_samples))
        self.assertEqual(below.reason_code, ReasonCode.RETURN_BELOW_MINUS_100)

    def test_verified_requires_explicit_complete_ledger_coverage(self):
        result = calculate_verified_perp_twr([sample(0, "100", "0"), sample(10, "110", "10")], [])
        self.assertEqual(result.reason_code, ReasonCode.LEDGER_COVERAGE_INCOMPLETE)


if __name__ == "__main__":
    unittest.main()
