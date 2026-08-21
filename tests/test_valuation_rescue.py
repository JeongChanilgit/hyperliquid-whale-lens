import unittest
from decimal import Decimal

from whale_lens.models import ClassifiedCashFlow
from whale_lens.valuation import PriceEvidence, implied_flow_consistent, recover_flow_value


def unknown(delta):
    return ClassifiedCashFlow(10, None, "UNKNOWN", delta["type"], "UNVERIFIABLE", {"time": 10, "delta": delta}, reason_code="NON_USD_FLOW_UNPRICED")


class ValuationRescueTests(unittest.TestCase):
    def test_raw_usdc_value_wins_and_vault_net_is_recovered(self) -> None:
        raw = recover_flow_value(unknown({"type": "spotTransfer", "usdcValue": "12", "toPerp": True}))
        self.assertTrue(raw.exact)
        self.assertEqual(raw.flow_usd_point, Decimal("12"))
        vault = recover_flow_value(unknown({"type": "vaultWithdraw", "requestedUsd": "10", "commission": "1", "closingCost": "2"}))
        self.assertEqual(vault.flow_usd_point, Decimal("7"))

    def test_non_perp_requires_account_and_equity_proof(self) -> None:
        value = recover_flow_value(unknown({"type": "spotGenesis", "amount": "5", "token": "ABC"}), account_context={"perp_equity_changed": False, "account_class_verified": True})
        self.assertEqual(value.classification, "NOT_A_CASH_FLOW")
        pending = recover_flow_value(unknown({"type": "spotGenesis", "amount": "5", "token": "ABC"}))
        self.assertFalse(pending.resolved)

    def test_price_range_is_bounded_and_cross_checked(self) -> None:
        quote = PriceEvidence("1m-candle", Decimal("10"), Decimal("9"), Decimal("11"), 10)
        value = recover_flow_value(unknown({"type": "cStakingTransfer", "amount": "2", "token": "HYPE", "toPerp": True}), price_evidence=quote)
        self.assertTrue(value.resolved)
        self.assertFalse(value.exact)
        self.assertEqual(value.flow_usd_low, Decimal("18"))
        self.assertTrue(implied_flow_consistent(previous_equity=Decimal("100"), current_equity=Decimal("120"), delta_pnl=Decimal("0"), known_other_flows=Decimal("0"), valuation=value))


if __name__ == "__main__":
    unittest.main()
