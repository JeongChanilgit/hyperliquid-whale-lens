import sys
import unittest
from decimal import Decimal
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from hyperliquid_whale_screener import (  # noqa: E402
    Episode,
    MIN_COMPLETED_EPISODES,
    TARGET_WHALE_COUNT,
    calculate_episode_metrics,
    calculate_portfolio_metrics,
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
    def test_simple_long_includes_open_and_close_fees(self):
        fills = [
            fill(10, "BTC", "0", "B", "1", fee="1", tid=1),
            fill(20, "BTC", "1", "A", "1", closed="10", fee="1", tid=2),
        ]
        episodes, error = reconstruct_completed_episodes(fills, 0, 30)
        self.assertIsNone(error)
        self.assertEqual(len(episodes), 1)
        self.assertEqual(episodes[0].net_pnl, Decimal("8"))
        self.assertEqual(episodes[0].direction, "LONG")

    def test_scaled_entries_and_partial_exits_form_one_episode(self):
        fills = [
            fill(10, "BTC", "0", "B", "1", fee="1", tid=1),
            fill(11, "BTC", "1", "B", "0.5", fee="0.5", tid=2),
            fill(12, "BTC", "1.5", "A", "1.1", closed="10", fee="1.1", tid=3),
            fill(13, "BTC", "0.4", "B", "0.4", fee="0.4", tid=4),
            fill(14, "BTC", "0.8", "A", "0.8", closed="20", fee="0.8", tid=5),
        ]
        episodes, error = reconstruct_completed_episodes(fills, 0, 20)
        self.assertIsNone(error)
        self.assertEqual(len(episodes), 1)
        self.assertEqual(episodes[0].gross_closed_pnl, Decimal("30"))
        self.assertEqual(episodes[0].fees_usdc, Decimal("3.8"))
        self.assertEqual(episodes[0].net_pnl, Decimal("26.2"))

    def test_sub_tick_residual_is_treated_as_flat(self):
        fills = [
            fill(10, "CRV", "0", "B", "1", fee="0", tid=1),
            fill(20, "CRV", "1", "A", "0.9999999999", closed="5", fee="0", tid=2),
        ]
        episodes, error = reconstruct_completed_episodes(fills, 0, 30)
        self.assertIsNone(error)
        self.assertEqual(len(episodes), 1)
        self.assertEqual(episodes[0].net_pnl, Decimal("5"))

    def test_carry_in_is_excluded_then_new_episode_is_counted(self):
        fills = [
            fill(10, "ETH", "2", "A", "2", closed="9", fee="1", tid=1),
            fill(15, "ETH", "0", "A", "1", fee="1", tid=2),
            fill(25, "ETH", "-1", "B", "1", closed="5", fee="1", tid=3),
        ]
        episodes, error = reconstruct_completed_episodes(fills, 0, 30)
        self.assertIsNone(error)
        self.assertEqual(len(episodes), 1)
        self.assertEqual(episodes[0].net_pnl, Decimal("3"))
        self.assertEqual(episodes[0].direction, "SHORT")

    def test_reversal_splits_fee_between_old_and_new_episode(self):
        fills = [
            fill(10, "SOL", "0", "B", "2", fee="2", tid=1),
            fill(20, "SOL", "2", "A", "3", closed="10", fee="3", tid=2),
            fill(30, "SOL", "-1", "B", "1", closed="4", fee="1", tid=3),
        ]
        episodes, error = reconstruct_completed_episodes(fills, 0, 40)
        self.assertIsNone(error)
        self.assertEqual([episode.net_pnl for episode in episodes], [Decimal("6"), Decimal("2")])
        self.assertEqual([episode.direction for episode in episodes], ["LONG", "SHORT"])

    def test_position_discontinuity_is_unverifiable(self):
        fills = [
            fill(10, "BTC", "0", "B", "1", tid=1),
            fill(20, "BTC", "2", "A", "2", tid=2),
        ]
        _episodes, error = reconstruct_completed_episodes(fills, 0, 30)
        self.assertIn("position discontinuity", error)

    def test_equal_timestamp_preserves_api_position_order_not_tid_order(self):
        fills = [
            fill(10, "MORPHO", "0", "A", "1", fee="1", tid=900),
            fill(20, "MORPHO", "-1", "B", "0.4", closed="4", fee="0.4", tid=800),
            fill(20, "MORPHO", "-0.6", "B", "0.6", closed="6", fee="0.6", tid=100),
        ]
        episodes, error = reconstruct_completed_episodes(fills, 0, 30)
        self.assertIsNone(error)
        self.assertEqual(len(episodes), 1)
        self.assertEqual(episodes[0].net_pnl, Decimal("8"))

    def test_completed_spot_episode_is_unverifiable(self):
        fills = [
            fill(10, "@107", "0", "B", "1", fee="0.01", token="HYPE", tid=1),
            fill(20, "@107", "1", "A", "1", fee="0.01", token="HYPE", tid=2),
        ]
        _episodes, error = reconstruct_completed_episodes(fills, 0, 30)
        self.assertIn("completed spot episode", error)


class MetricTests(unittest.TestCase):
    def test_realized_equity_mdd(self):
        episodes = [
            Episode("BTC", "LONG", 0, 1, Decimal("10"), Decimal("0"), Decimal("10"), 1),
            Episode("ETH", "SHORT", 1, 2, Decimal("-44"), Decimal("0"), Decimal("-44"), 1),
            Episode("SOL", "LONG", 2, 3, Decimal("20"), Decimal("0"), Decimal("20"), 1),
        ]
        metrics = calculate_episode_metrics(episodes, Decimal("100"))
        self.assertEqual(metrics["net_pnl"], Decimal("-14"))
        self.assertEqual(metrics["roi"], Decimal("-0.14"))
        self.assertEqual(metrics["mdd"], Decimal("0.4"))

    def test_portfolio_compounds_no_flow_intervals(self):
        portfolio = [["month", {
            "accountValueHistory": [[1, "100"], [2, "110"], [3, "121"]],
            "pnlHistory": [[1, "0"], [2, "10"], [3, "21"]],
        }]]
        metrics = calculate_portfolio_metrics(portfolio, 0, 10)
        self.assertIsNotNone(metrics)
        self.assertEqual(metrics["portfolio_compounded_return"], Decimal("0.21"))
        self.assertEqual(metrics["portfolio_mdd"], Decimal("0"))

    def test_portfolio_deposit_is_excluded_before_next_return(self):
        portfolio = [["month", {
            "accountValueHistory": [[1, "100"], [2, "200"], [3, "220"]],
            "pnlHistory": [[1, "0"], [2, "0"], [3, "20"]],
        }]]
        metrics = calculate_portfolio_metrics(portfolio, 0, 10)
        self.assertIsNotNone(metrics)
        self.assertEqual(metrics["portfolio_compounded_return"], Decimal("0.1"))
        self.assertEqual(metrics["portfolio_inferred_net_flow"], Decimal("100"))

    def test_offset_deposit_and_withdrawal_do_not_double_count_capital(self):
        portfolio = [["month", {
            "accountValueHistory": [[1, "100"], [2, "200"], [3, "220"], [4, "120"]],
            "pnlHistory": [[1, "0"], [2, "0"], [3, "20"], [4, "20"]],
        }]]
        metrics = calculate_portfolio_metrics(portfolio, 0, 10)
        self.assertIsNotNone(metrics)
        self.assertEqual(metrics["portfolio_compounded_return"], Decimal("0.1"))
        self.assertEqual(metrics["portfolio_inferred_net_flow"], Decimal("0"))

    def test_deposit_and_pnl_in_same_sample_cannot_use_dust_denominator(self):
        portfolio = [["month", {
            "accountValueHistory": [[1, "0.02"], [2, "26383.02"]],
            "pnlHistory": [[1, "0"], [2, "1383"]],
        }]]
        metrics = calculate_portfolio_metrics(portfolio, 0, 10)
        self.assertIsNotNone(metrics)
        self.assertEqual(metrics["portfolio_inferred_net_flow"], Decimal("25000.00"))
        self.assertAlmostEqual(
            metrics["portfolio_compounded_return"],
            Decimal("1383") / Decimal("25000.02"),
            places=38,
        )

    def test_withdrawal_larger_than_starting_capital_is_unverifiable(self):
        portfolio = [["month", {
            "accountValueHistory": [[1, "0.005"], [2, "0.005"]],
            "pnlHistory": [[1, "0"], [2, "1815"]],
        }]]
        self.assertIsNone(calculate_portfolio_metrics(portfolio, 0, 10))

    def test_leading_zero_then_deposit_starts_measurement(self):
        portfolio = [["month", {
            "accountValueHistory": [[1, "0"], [2, "100"], [3, "110"]],
            "pnlHistory": [[1, "0"], [2, "0"], [3, "10"]],
        }]]
        metrics = calculate_portfolio_metrics(portfolio, 0, 10)
        self.assertIsNotNone(metrics)
        self.assertEqual(metrics["portfolio_compounded_return"], Decimal("0.1"))

    def test_unfunded_loss_is_terminal_minus_one_hundred_percent(self):
        portfolio = [["month", {
            "accountValueHistory": [[1, "100"], [2, "0"]],
            "pnlHistory": [[1, "0"], [2, "-100"]],
        }]]
        metrics = calculate_portfolio_metrics(portfolio, 0, 10)
        self.assertIsNotNone(metrics)
        self.assertEqual(metrics["portfolio_compounded_return"], Decimal("-1"))
        self.assertEqual(metrics["portfolio_mdd"], Decimal("1"))

    def test_withdrawal_to_dust_is_unverifiable_instead_of_astronomical(self):
        portfolio = [["month", {
            "accountValueHistory": [[1, "100"], [2, "0.003"], [3, "120"]],
            "pnlHistory": [[1, "0"], [2, "50"], [3, "70"]],
        }]]
        self.assertIsNone(calculate_portfolio_metrics(portfolio, 0, 10))

    def test_minimum_completed_episode_cut_is_ten(self):
        self.assertEqual(MIN_COMPLETED_EPISODES, 10)
        self.assertEqual(TARGET_WHALE_COUNT, 10)


if __name__ == "__main__":
    unittest.main()
