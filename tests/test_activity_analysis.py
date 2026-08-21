import unittest

from whale_lens.activity_analysis import (
    select_top_candidates_with_fills,
    summarize_current_positions,
    summarize_fill_history,
)


class ActivityAnalysisTests(unittest.TestCase):
    def test_selection_keeps_verified_twr_order_but_requires_a_fill(self) -> None:
        candidates = [
            {"candidate_rank": 1, "wallet": "0x1", "quality": "VERIFIED"},
            {"candidate_rank": 2, "wallet": "0x2", "quality": "VERIFIED"},
            {"candidate_rank": 3, "wallet": "0x3", "quality": "UNVERIFIABLE"},
            {"candidate_rank": 4, "wallet": "0x4", "quality": "VERIFIED"},
        ]
        fills = {
            "0x1": {"raw_fill_count": 0, "valid": True},
            "0x2": {"raw_fill_count": 3, "valid": True, "completed_episodes": 0},
            "0x4": {"raw_fill_count": 1, "valid": False, "reason_code": "LIMIT"},
        }
        selected = select_top_candidates_with_fills(candidates, fills, target_count=2)
        self.assertEqual([row["candidate_rank"] for row in selected], [2, 4])
        self.assertEqual(selected[1]["episode_validation_reason_30d"], "LIMIT")

    def test_fill_summary_counts_a_completed_episode(self) -> None:
        fills = [
            {"time": 10, "coin": "BTC", "side": "B", "sz": "1", "px": "100", "startPosition": "0", "closedPnl": "0", "fee": "1", "feeToken": "USDC", "crossed": True, "dir": "Open Long"},
            {"time": 20, "coin": "BTC", "side": "A", "sz": "1", "px": "110", "startPosition": "1", "closedPnl": "10", "fee": "1", "feeToken": "USDC", "crossed": False, "dir": "Close Long"},
        ]
        summary = summarize_fill_history(
            fills,
            window_start_ms=0,
            window_end_ms=30,
            coverage_complete=True,
            availability_limit_reached=False,
        )
        self.assertTrue(summary["episode_validation_valid_90d"])
        self.assertEqual(summary["verified_completed_episodes_90d"], 1)
        self.assertEqual(summary["episode_net_pnl_usd"], "8")
        self.assertEqual(summary["taker_fill_ratio"], 0.5)

    def test_current_position_summary_qualifies_hip3_coin(self) -> None:
        payload = {
            "clearinghouseStates": [["xyz", {"marginSummary": {"accountValue": "123.45"}, "assetPositions": [{"position": {
                "coin": "ABC", "szi": "-2", "entryPx": "10", "positionValue": "20",
                "unrealizedPnl": "3", "leverage": {"type": "cross", "value": 5},
            }}]}]],
        }
        summary = summarize_current_positions(payload)
        self.assertEqual(summary["open_position_count"], 1)
        self.assertEqual(summary["positions"][0]["coin"], "xyz:ABC")
        self.assertEqual(summary["positions"][0]["side"], "SHORT")
        self.assertEqual(summary["perp_account_value_usd"], "123.45")


if __name__ == "__main__":
    unittest.main()
