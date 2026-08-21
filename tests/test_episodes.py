import sys
import unittest
from decimal import Decimal
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from whale_lens.episodes import (  # noqa: E402
    FILL_AVAILABILITY_LIMIT,
    REASON_FILL_LIMIT,
    REASON_POSITION_DISCONTINUITY,
    raw_fills_request,
    reconstruct_completed_episodes,
)


def fill(time, coin, start, side, size, *, closed="0", fee="0", token="USDC", tid=1):
    return {
        "time": time,
        "coin": coin,
        "startPosition": str(start),
        "side": side,
        "sz": str(size),
        "closedPnl": str(closed),
        "fee": str(fee),
        "feeToken": token,
        "tid": tid,
    }


class EpisodeReconstructionTests(unittest.TestCase):
    def test_raw_request_explicitly_disables_aggregation(self):
        self.assertFalse(raw_fills_request("0xabc", 1, 2)["aggregateByTime"])

    def test_partial_entries_and_exits_are_one_episode(self):
        result = reconstruct_completed_episodes(
            [
                fill(1, "BTC", 0, "B", 1, fee=1),
                fill(2, "BTC", 1, "B", "0.5", fee="0.5"),
                fill(3, "BTC", "1.5", "A", "0.4", closed=4, fee="0.4"),
                fill(4, "BTC", "1.1", "A", "1.1", closed=11, fee="1.1"),
            ],
            0,
            10,
        )
        self.assertTrue(result.valid)
        self.assertEqual(result.completed_episodes, 1)
        self.assertEqual(result.episodes[0].net_pnl, Decimal("12"))

    def test_reversal_closes_old_episode_and_opens_new_one(self):
        result = reconstruct_completed_episodes(
            [
                fill(1, "SOL", 0, "B", 2, fee=2),
                fill(2, "SOL", 2, "A", 3, closed=10, fee=3),
                fill(3, "SOL", -1, "B", 1, closed=4, fee=1),
            ],
            0,
            10,
        )
        self.assertTrue(result.valid)
        self.assertEqual([episode.direction for episode in result.episodes], ["LONG", "SHORT"])
        self.assertEqual([episode.net_pnl for episode in result.episodes], [Decimal("6"), Decimal("2")])

    def test_carry_in_close_and_window_open_position_are_excluded(self):
        result = reconstruct_completed_episodes(
            [
                fill(1, "ETH", 2, "A", 2, closed=10),  # carry-in close
                fill(2, "ETH", 0, "B", 1),
                fill(3, "ETH", 1, "A", 1, closed=2),  # counted
                fill(4, "BTC", 0, "A", 1),  # still open at window end
            ],
            0,
            10,
        )
        self.assertTrue(result.valid)
        self.assertEqual(result.completed_episodes, 1)
        self.assertEqual(result.episodes[0].coin, "ETH")

    def test_spot_is_excluded_but_hip3_perpetuals_are_included(self):
        result = reconstruct_completed_episodes(
            [
                fill(1, "@123", 0, "B", 1),
                fill(2, "@123", 1, "A", 1),
                fill(3, "xyz:ABC", 0, "B", 1),
                fill(4, "xyz:ABC", 1, "A", 1),
                fill(5, "para:DEF", 0, "A", 1),
                fill(6, "para:DEF", -1, "B", 1),
            ],
            0,
            10,
        )
        self.assertTrue(result.valid)
        self.assertEqual([episode.coin for episode in result.episodes], ["xyz:ABC", "para:DEF"])

    def test_equal_timestamp_keeps_api_response_order(self):
        result = reconstruct_completed_episodes(
            [
                fill(1, "MORPHO", 0, "A", 1, tid=900),
                fill(2, "MORPHO", -1, "B", "0.4", tid=800),
                fill(2, "MORPHO", "-0.6", "B", "0.6", tid=100),
            ],
            0,
            10,
        )
        self.assertTrue(result.valid)
        self.assertEqual(result.completed_episodes, 1)

    def test_position_discontinuity_is_unverifiable(self):
        result = reconstruct_completed_episodes([fill(1, "BTC", 0, "B", 1), fill(2, "BTC", 2, "A", 2)], 0, 10)
        self.assertFalse(result.valid)
        self.assertEqual(result.reason_code, REASON_POSITION_DISCONTINUITY)

    def test_10k_limit_and_aggregated_responses_fail_closed(self):
        limit_result = reconstruct_completed_episodes([fill(1, "BTC", 0, "B", 1)] * FILL_AVAILABILITY_LIMIT, 0, 10)
        self.assertFalse(limit_result.valid)
        self.assertEqual(limit_result.reason_code, REASON_FILL_LIMIT)
        aggregate_result = reconstruct_completed_episodes([], 0, 10, aggregate_by_time=True)
        self.assertFalse(aggregate_result.valid)


if __name__ == "__main__":
    unittest.main()
