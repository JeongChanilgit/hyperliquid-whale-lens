import sys
import unittest
from decimal import Decimal
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from whale_lens.ledger import (  # noqa: E402
    LedgerCoverageTracker,
    classify_non_funding_delta,
    count_ledger_delta_types,
    dedupe_ledger_events,
)
from whale_lens.models import CashFlowClassification, ReasonCode  # noqa: E402


WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"


def event(time, delta, *, tx_hash="0xhash"):
    return {"time": time, "hash": tx_hash, "delta": delta}


class NonFundingCashFlowTests(unittest.TestCase):
    def assert_flow(self, result, amount, classification):
        self.assertEqual(result.amount_usd, Decimal(amount))
        self.assertEqual(result.classification, classification)
        self.assertFalse(result.is_unverifiable)

    def test_deposit_and_withdrawal_are_signed_perp_cashflows(self):
        self.assert_flow(
            classify_non_funding_delta(event(1, {"type": "deposit", "usdc": "100"}), WALLET),
            "100",
            CashFlowClassification.EXTERNAL_IN,
        )
        self.assert_flow(
            classify_non_funding_delta(event(2, {"type": "withdraw", "usdc": "90"}), WALLET),
            "-90",
            CashFlowClassification.EXTERNAL_OUT,
        )

    def test_master_subaccount_and_spot_transfer_follow_wallet_direction(self):
        outgoing = event(1, {"type": "subAccountTransfer", "usdc": "20", "user": WALLET, "destination": OTHER})
        incoming = event(2, {"type": "internalTransfer", "usdc": "20", "user": OTHER, "destination": WALLET})
        spot_out = event(
            3,
            {"type": "spotTransfer", "token": "HYPE", "usdcValue": "7.5", "user": WALLET, "destination": OTHER},
        )
        self.assert_flow(classify_non_funding_delta(outgoing, WALLET), "-20", CashFlowClassification.EXTERNAL_OUT)
        self.assert_flow(classify_non_funding_delta(incoming, WALLET), "20", CashFlowClassification.EXTERNAL_IN)
        self.assert_flow(classify_non_funding_delta(spot_out, WALLET), "-7.5", CashFlowClassification.EXTERNAL_OUT)

    def test_send_uses_exact_usd_value_and_wallet_direction(self):
        incoming = event(1, {
            "type": "send", "token": "HYPE", "usdcValue": "12.5", "user": OTHER, "destination": WALLET,
        })
        outgoing = event(2, {
            "type": "send", "token": "USDC", "usdcValue": "3", "user": WALLET, "destination": OTHER,
        })
        self.assert_flow(classify_non_funding_delta(incoming, WALLET), "12.5", CashFlowClassification.EXTERNAL_IN)
        self.assert_flow(classify_non_funding_delta(outgoing, WALLET), "-3", CashFlowClassification.EXTERNAL_OUT)

    def test_staking_transfer_without_usd_value_is_explicitly_unpriceable(self):
        result = classify_non_funding_delta(event(1, {
            "type": "cStakingTransfer", "token": "HYPE", "amount": "2", "isDeposit": True,
        }), WALLET)
        self.assertEqual(result.reason_code, ReasonCode.NON_USD_FLOW_UNPRICED)

    def test_spot_perp_account_class_direction_is_explicit(self):
        into_perp = event(1, {"type": "accountClassTransfer", "usdc": "12", "toPerp": True})
        out_of_perp = event(2, {"type": "accountClassTransfer", "usdc": "12", "toPerp": False})
        self.assert_flow(classify_non_funding_delta(into_perp, WALLET), "12", CashFlowClassification.EXTERNAL_IN)
        self.assert_flow(classify_non_funding_delta(out_of_perp, WALLET), "-12", CashFlowClassification.EXTERNAL_OUT)

    def test_usdc_hip3_class_transfer_is_signed_but_non_usd_is_not_guessed(self):
        into_hip3 = event(1, {"type": "perpDexClassTransfer", "token": "USDC", "amount": "12", "dex": "xyz", "toPerp": True})
        self.assert_flow(classify_non_funding_delta(into_hip3, WALLET), "12", CashFlowClassification.EXTERNAL_IN)
        unpriced = classify_non_funding_delta(
            event(2, {"type": "perpDexClassTransfer", "token": "HYPE", "amount": "12", "dex": "xyz", "toPerp": True}),
            WALLET,
        )
        self.assertEqual(unpriced.reason_code, ReasonCode.NON_USD_FLOW_UNPRICED)

    def test_vault_and_reward_events_are_neutralized_not_pnl(self):
        vault_deposit = event(1, {"type": "vaultDeposit", "usdc": "30"})
        vault_withdraw = event(2, {"type": "vaultWithdraw", "netWithdrawnUsd": "25"})
        commission = event(3, {"type": "vaultLeaderCommission", "usdc": "2"})
        reward = event(4, {"type": "rewardsClaim", "token": "USDC", "amount": "3"})
        self.assert_flow(classify_non_funding_delta(vault_deposit, WALLET), "-30", CashFlowClassification.EXTERNAL_OUT)
        self.assert_flow(classify_non_funding_delta(vault_withdraw, WALLET), "25", CashFlowClassification.EXTERNAL_IN)
        self.assert_flow(classify_non_funding_delta(commission, WALLET), "2", CashFlowClassification.NON_POSITION_IN)
        self.assert_flow(classify_non_funding_delta(reward, WALLET), "3", CashFlowClassification.NON_POSITION_IN)

    def test_liquidation_is_not_a_cashflow_and_unknowns_fail_closed(self):
        liquidation = classify_non_funding_delta(event(1, {"type": "liquidation", "accountValue": "0"}), WALLET)
        self.assertEqual(liquidation.classification, CashFlowClassification.NOT_A_CASH_FLOW)
        unknown = classify_non_funding_delta(event(2, {"type": "futureLedgerType", "usdc": "1"}), WALLET)
        self.assertTrue(unknown.is_unverifiable)
        self.assertEqual(unknown.reason_code, ReasonCode.UNKNOWN_LEDGER_DELTA_TYPE)

    def test_unpriced_non_usd_flow_fails_closed(self):
        unpriced = classify_non_funding_delta(
            event(1, {"type": "spotTransfer", "token": "HYPE", "amount": "10", "user": WALLET, "destination": OTHER}),
            WALLET,
        )
        self.assertTrue(unpriced.is_unverifiable)
        self.assertEqual(unpriced.reason_code, ReasonCode.NON_USD_FLOW_UNPRICED)

    def test_stable_deduplication_retains_first_raw_event_and_counts_types(self):
        first = event(1, {"type": "deposit", "usdc": "1"}, tx_hash="0xa")
        duplicate = dict(first)
        second = event(2, {"type": "withdraw", "usdc": "1"}, tx_hash="0xb")
        deduped = dedupe_ledger_events([first, duplicate, second], return_stats=True)
        self.assertEqual(deduped.raw_event_count, 3)
        self.assertEqual(deduped.duplicate_event_count, 1)
        self.assertEqual(list(deduped.unique_events), [first, second])
        self.assertEqual(count_ledger_delta_types(deduped.unique_events), {"deposit": 1, "withdraw": 1})

    def test_coverage_requires_a_terminal_uncapped_page_and_detects_stall(self):
        tracker = LedgerCoverageTracker(0, 100, response_cap=2)
        tracker.observe_page(0, [event(1, {"type": "deposit", "usdc": "1"}), event(2, {"type": "deposit", "usdc": "1"})])
        tracker.observe_page(2, [])
        self.assertTrue(tracker.finish().complete)

        stalled = LedgerCoverageTracker(0, 100, response_cap=2)
        stalled.observe_page(10, [event(10, {"type": "deposit", "usdc": "1"}), event(10, {"type": "deposit", "usdc": "2"}, tx_hash="0x2")])
        self.assertFalse(stalled.finish().complete)


if __name__ == "__main__":
    unittest.main()
