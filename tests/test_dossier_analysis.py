import json
import sys
import unittest
from copy import deepcopy
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from whale_lens.dossier_analysis import build_dossier_analysis  # noqa: E402


def fill(time, coin, start, side, size, price, *, closed="0", fee="0", token="USDC"):
    return {
        "time": time,
        "coin": coin,
        "startPosition": str(start),
        "side": side,
        "sz": str(size),
        "px": str(price),
        "closedPnl": str(closed),
        "fee": str(fee),
        "feeToken": token,
    }


def portfolio(accounts=((0, "100"), (10, "150"), (20, "120")), pnls=((0, "0"), (10, "50"), (20, "20")), vlm="1000"):
    return [["perpMonth", {"accountValueHistory": [list(row) for row in accounts], "pnlHistory": [list(row) for row in pnls], "vlm": vlm}]]


def base_wallet():
    return {
        "rank": 1,
        "wallet": "0xABC",
        "source_score": "1.25",
        "source_diagnostics": {
            "implied_flow_max_relative_to_previous_equity": "1.2",
            "implied_flow_nonzero_interval_count": 2,
        },
        "portfolio": portfolio(),
        "current_states": {
            "clearinghouseStates": [["", {
                "marginSummary": {"accountValue": "1000"},
                "assetPositions": [
                    {"position": {"coin": "BTC", "szi": "2", "entryPx": "100", "positionValue": "200", "unrealizedPnl": "5", "leverage": {"type": "cross", "value": "3"}}},
                    {"position": {"coin": "ETH", "szi": "-1", "entryPx": "100", "positionValue": "100", "unrealizedPnl": "-1", "leverage": {"type": "cross", "value": "2"}}},
                ],
            }]],
        },
        "open_orders": {
            "rows": [
                {"coin": "BTC", "side": "B", "sz": "1", "limitPx": "90", "orderType": "Limit", "oid": 2},
                {"coin": "ETH", "side": "A", "sz": "1", "triggerPx": "110", "triggerCondition": "SL", "orderType": "Trigger", "reduceOnly": True, "oid": 1},
            ],
        },
        "fills": {
            "rows": [
                fill(1, "BTC", 0, "B", 1, 100, fee=1),
                fill(2, "BTC", 1, "A", 1, 120, closed=20, fee=1),
                fill(3, "ETH", 0, "A", 1, 50, fee="0.5"),
                fill(4, "ETH", -1, "B", 1, 40, closed=10, fee="0.5"),
            ],
            "coverage": {"complete": True, "window_start_ms": 0, "window_end_ms": 30},
        },
        "ledger": {
            "rows": [
                {"time": 1, "delta": {"type": "deposit", "usdc": "100"}},
                {"time": 2, "delta": {"type": "withdraw", "usdc": "20"}},
            ],
            "coverage": {"complete": True},
        },
    }


def dossier(wallet):
    return build_dossier_analysis({
        "generated_at_ms": 123,
        "evidence_window": {"start_ms": 0, "end_ms": 30},
        "coverage": {"complete": True},
        "source_report": {"run_id": "research", "report_sha256": "abc"},
        "wallets": [wallet],
    })


class DossierAnalysisTests(unittest.TestCase):
    def test_fixed_contract_long_short_orders_cashflows_and_series(self):
        result = dossier(base_wallet())
        self.assertEqual(result["generated_at_ms"], 123)
        self.assertEqual(result["evidence_window"], {"end_ms": 30, "start_ms": 0})
        self.assertEqual(result["source_report"]["run_id"], "research")
        self.assertEqual(result["coverage"]["wallet_analysis_count"], 1)
        row = result["wallets"][0]
        self.assertEqual(
            set(row),
            {
                "rank", "wallet", "source_score", "source_diagnostics", "headline", "current", "performance", "activity",
                "positions", "orders", "cashflows", "portfolio_30d", "portfolio_series", "recent_fills", "recent_episodes",
                "strategy_inference", "risk_flags", "data_quality",
            },
        )
        self.assertEqual(row["current"]["long_notional_usd"], 200)
        self.assertEqual(row["current"]["short_notional_usd"], 100)
        self.assertEqual(row["current"]["gross_exposure_usd"], 300)
        self.assertEqual(row["current"]["net_exposure_usd"], 100)
        self.assertEqual(row["current"]["state_account_value_sum_usd"], 1000)
        self.assertEqual(row["current"]["account_value_usd"], 120)
        self.assertEqual(row["current"]["effective_leverage"], 2.5)
        self.assertIn("INDEPENDENT_MARGIN_RELATIONSHIP_NOT_VERIFIED", row["current"]["state_account_value_sum_scope"])
        self.assertEqual(row["orders"]["limit_count"], 1)
        self.assertEqual(row["orders"]["trigger_count"], 1)
        self.assertEqual(row["orders"]["stop_loss_count"], 1)
        self.assertEqual(row["orders"]["orders"][0]["oid"], 2)
        self.assertEqual(row["orders"]["orders"][1]["triggerPx"], 110)
        self.assertEqual(row["activity"]["perpetual_fill_count"], 4)
        self.assertEqual(row["activity"]["fill_volume_usd"], 310)
        self.assertEqual(row["activity"]["fees_usd"], 3)
        self.assertAlmostEqual(row["activity"]["leading_coin_volume_share"], 220 / 310)
        self.assertEqual(row["performance"]["completed_episode_count"], 2)
        self.assertEqual(row["performance"]["win_rate"], 1)
        self.assertEqual(row["performance"]["net_pnl_usd"], 27)
        self.assertEqual(row["performance"]["profit_factor_status"], "NO_LOSSES")
        self.assertEqual(row["cashflows"]["net_cash_flow_usd"], 80)
        self.assertEqual(row["portfolio_30d"]["aligned_sample_count"], 3)
        self.assertEqual(row["portfolio_30d"]["pnl_delta_usd"], 20)
        self.assertEqual(row["portfolio_30d"]["perp_month_vlm"], 1000)
        self.assertEqual(row["portfolio_30d"]["raw_account_value_mdd_fraction"], 0.2)
        self.assertEqual(row["portfolio_30d"]["max_drawdown_fraction"], 0.2)
        self.assertEqual(row["portfolio_30d"]["max_drawdown_basis"], "RAW_ACCOUNT_VALUE_NOT_FLOW_NEUTRAL_COMPATIBILITY_ALIAS")
        self.assertEqual(row["portfolio_30d"]["simple_twr_mdd_fraction"], 0.2)
        self.assertEqual([item["base_100"] for item in row["portfolio_30d"]["simple_twr_curve_base_100"]], [100, 150, 120])
        self.assertEqual(len(row["portfolio_30d"]["aligned_series"]), 3)
        self.assertEqual(len(row["recent_fills"]), 4)
        self.assertEqual(len(row["recent_episodes"]), 2)
        json.dumps(result)  # compact dossier is directly HTML/JSON serializable.

    def test_incomplete_fill_coverage_never_claims_episode_results(self):
        wallet = base_wallet()
        wallet["fills"]["coverage"] = {"complete": False, "reason_code": "PAGINATION"}
        row = dossier(wallet)["wallets"][0]
        self.assertEqual(row["activity"]["coverage"]["status"], "PARTIAL")
        self.assertIsNone(row["performance"]["completed_episode_count"])
        self.assertIn("FILL_DATA_PARTIAL", [flag["code"] for flag in row["risk_flags"]])
        self.assertIn({"component": "fills", "code": "FILL_COVERAGE_NOT_COMPLETE"}, row["data_quality"])

    def test_reversal_splits_completed_long_and_short_episodes(self):
        wallet = base_wallet()
        wallet["fills"]["rows"] = [
            fill(10, "SOL", 0, "B", 2, 100, fee=2),
            fill(20, "SOL", 2, "A", 3, 110, closed=10, fee=3),
            fill(30, "SOL", -1, "B", 1, 100, closed=4, fee=1),
        ]
        row = dossier(wallet)["wallets"][0]
        self.assertEqual(row["performance"]["completed_episode_count"], 2)
        self.assertEqual(row["performance"]["long_episode_count"], 1)
        self.assertEqual(row["performance"]["short_episode_count"], 1)
        self.assertEqual([episode["net_pnl_usd"] for episode in row["recent_episodes"]], [6, 2])

    def test_window_started_open_episode_is_retained_as_open_not_completed(self):
        wallet = base_wallet()
        wallet["fills"]["rows"] = [fill(10, "ETH", 0, "A", 2, 50, fee=1)]
        row = dossier(wallet)["wallets"][0]
        self.assertEqual(row["performance"]["completed_episode_count"], 0)
        self.assertEqual(row["performance"]["open_started_episode_count"], 1)
        self.assertEqual(row["performance"]["profit_factor_status"], "NO_CLOSED_EPISODES")

    def test_concentration_and_zero_denominators_are_explicit(self):
        wallet = base_wallet()
        wallet["fills"]["rows"] = [
            fill(1, "BTC", 0, "B", 9, 100),
            fill(2, "ETH", 0, "B", 1, 100),
        ]
        wallet["current_states"] = {"clearinghouseStates": [["", {"marginSummary": {"accountValue": "0"}, "assetPositions": []}]]}
        wallet["portfolio"] = portfolio(accounts=((0, "0"),), pnls=((0, "0"),), vlm="1")
        row = dossier(wallet)["wallets"][0]
        self.assertEqual(row["activity"]["leading_coin_volume_share"], 0.9)
        self.assertIsNone(row["current"]["effective_leverage"])
        self.assertEqual(row["performance"]["completed_episode_count"], 0)
        self.assertIsNone(row["performance"]["profit_factor"])
        self.assertEqual(row["performance"]["profit_factor_status"], "NO_CLOSED_EPISODES")

    def test_raw_withdrawal_drawdown_is_not_simple_twr_or_copy_blocking_drawdown(self):
        wallet = base_wallet()
        wallet["portfolio"] = portfolio(
            accounts=((0, "100"), (10, "0")),
            pnls=((0, "0"), (10, "0")),
            vlm="1",
        )
        row = dossier(wallet)["wallets"][0]
        series = row["portfolio_30d"]
        self.assertEqual(series["raw_account_value_mdd_fraction"], 1)
        self.assertEqual(series["max_drawdown_fraction"], 1)  # compatibility alias, explicitly non-flow-neutral
        self.assertEqual(series["simple_twr_return"], 0)
        self.assertEqual(series["simple_twr_mdd_fraction"], 0)
        self.assertEqual([point["base_100"] for point in series["simple_twr_curve_base_100"]], [100, 100])
        flags = {flag["code"]: flag for flag in row["risk_flags"]}
        self.assertNotIn("LARGE_SIMPLE_TWR_DRAWDOWN", flags)
        self.assertEqual(flags["WITHDRAWN_OR_EMPTY_ACCOUNT"]["severity"], "MEDIUM")
        self.assertEqual(flags["WITHDRAWN_OR_EMPTY_ACCOUNT"]["evidence_type"], "OBSERVED")

    def test_output_order_is_rank_then_wallet(self):
        first = base_wallet()
        second = deepcopy(first)
        first["rank"], first["wallet"] = 2, "0xbbb"
        second["rank"], second["wallet"] = 1, "0xaaa"
        result = build_dossier_analysis({"wallets": [first, second]})
        self.assertEqual([row["wallet"] for row in result["wallets"]], ["0xaaa", "0xbbb"])

    def test_collector_payload_wrappers_preserve_explicit_dex(self):
        wallet = base_wallet()
        state_payload = wallet["current_states"]["clearinghouseStates"][0][1]
        order_payload = wallet["open_orders"]["rows"]
        portfolio_payload = wallet["portfolio"]
        wallet["portfolio"] = {"fetched_at_ms": 1, "source": "api", "payload": portfolio_payload}
        wallet["current_states"] = [{"dex": "xyz", "dex_index": 1, "fetched_at_ms": 1, "source": "api", "payload": state_payload}]
        wallet["open_orders"] = [{"dex": "xyz", "dex_index": 1, "fetched_at_ms": 1, "source": "api", "payload": order_payload}]
        row = dossier(wallet)["wallets"][0]
        self.assertEqual(row["portfolio_30d"]["status"], "COMPLETE")
        self.assertTrue(row["positions"]["items"])
        self.assertTrue(all(not item["coin"].startswith("payload:") for item in row["positions"]["items"]))
        self.assertTrue(all(item["coin"].startswith("xyz:") for item in row["positions"]["items"]))
        self.assertEqual({item["dex"] for item in row["orders"]["orders"]}, {"xyz"})
        self.assertTrue(all(not item["dex"].startswith("payload") for item in row["orders"]["orders"]))


if __name__ == "__main__":
    unittest.main()
