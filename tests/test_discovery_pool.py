import sys
import unittest
from decimal import Decimal
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from whale_lens.discovery import (  # noqa: E402
    FILLER,
    MONTH_PNL,
    MONTH_ROI,
    NEW_WALLET,
    PRIOR_VERIFIED,
    ROTATING_SAMPLE,
    TURNOVER,
    DiscoveryConfig,
    DiscoveryCycleState,
    build_discovery_pool,
    claim_next_refresh_shard,
    detect_outside_pool_threshold_breach,
    load_leaderboard_universe,
    outside_pool_eligible_wallets,
    select_deterministic_rotating_sample,
)


def wallet(index: int) -> str:
    return f"0x{index:040x}"


def leaderboard_row(index: int, *, roi: str | int | None, pnl: str | int | None, volume: str | int | None, account: str | int = 10_000):
    performance = {}
    if roi is not None:
        performance["roi"] = str(roi)
    if pnl is not None:
        performance["pnl"] = str(pnl)
    if volume is not None:
        performance["volume"] = str(volume)
    return {
        "ethAddress": wallet(index),
        "accountValue": str(account),
        "windowPerformances": [["month", performance]],
    }


class DiscoveryPoolTests(unittest.TestCase):
    def setUp(self):
        rows = [leaderboard_row(index, roi=100 - index, pnl=index, volume=10, account=10_000 + index) for index in range(12)]
        rows[0] = leaderboard_row(0, roi=999, pnl=1, volume=10, account=10_000)
        rows[1] = leaderboard_row(1, roi=1, pnl=9_999, volume=10, account=10_001)
        rows[2] = leaderboard_row(2, roi=2, pnl=2, volume=10_000_000, account=10_002)
        self.universe = load_leaderboard_universe({"leaderboardRows": rows})
        self.config = DiscoveryConfig(
            leaderboard_roi_top_n=1,
            leaderboard_pnl_top_n=1,
            leaderboard_turnover_top_n=1,
            prior_verified_top_n=1,
            new_wallet_top_n=1,
            rotating_sample_n=1,
            discovery_pool_target=8,
            discovery_pool_min=7,
            discovery_pool_max=9,
        )

    def test_full_universe_multi_signal_pool_preserves_inclusion_reasons(self):
        previous = [wallet(index) for index in range(12) if index != 4]
        result = build_discovery_pool(
            self.universe,
            config=self.config,
            prior_verified_wallets=[wallet(3)],
            previous_leaderboard_addresses=previous,
            discovery_cycle_id="20260821",
        )
        by_wallet = {entry.wallet: entry for entry in result.entries}
        self.assertTrue(result.complete)
        self.assertGreaterEqual(result.actual_count, self.config.discovery_pool_min)
        self.assertLessEqual(result.actual_count, self.config.discovery_pool_max)
        self.assertIn(MONTH_ROI, by_wallet[wallet(0)].inclusion_reasons)
        self.assertIn(MONTH_PNL, by_wallet[wallet(1)].inclusion_reasons)
        self.assertIn(TURNOVER, by_wallet[wallet(2)].inclusion_reasons)
        self.assertIn(PRIOR_VERIFIED, by_wallet[wallet(3)].inclusion_reasons)
        self.assertIn(NEW_WALLET, by_wallet[wallet(4)].inclusion_reasons)
        self.assertTrue(any(ROTATING_SAMPLE in entry.inclusion_reasons for entry in result.entries))
        self.assertTrue(any(FILLER in entry.inclusion_reasons for entry in result.entries))
        # It cannot be an ROI-only prefix: wallet 1 has poor ROI but wins PnL.
        self.assertIn(wallet(1), result.wallets)

    def test_same_input_and_cycle_produce_same_pool_and_hash(self):
        kwargs = {
            "config": self.config,
            "prior_verified_wallets": [wallet(3)],
            "previous_leaderboard_addresses": [wallet(index) for index in range(12) if index != 4],
            "discovery_cycle_id": "stable-cycle",
        }
        first = build_discovery_pool(self.universe, **kwargs)
        second = build_discovery_pool(self.universe, **kwargs)
        self.assertEqual(first.wallets, second.wallets)
        self.assertEqual(first.pool_hash, second.pool_hash)
        candidates = [item for item in self.universe.wallets if item.wallet not in {wallet(0), wallet(1)}]
        self.assertEqual(
            select_deterministic_rotating_sample(candidates, 4, "stable-cycle"),
            select_deterministic_rotating_sample(reversed(candidates), 4, "stable-cycle"),
        )

    def test_hard_max_retains_prior_bucket_then_rrf_compacts_signal_union(self):
        rows = [leaderboard_row(index, roi=1000 - index, pnl=2000 - index, volume=5000 - index) for index in range(30)]
        universe = load_leaderboard_universe({"leaderboardRows": rows})
        config = DiscoveryConfig(
            leaderboard_roi_top_n=15,
            leaderboard_pnl_top_n=15,
            leaderboard_turnover_top_n=15,
            prior_verified_top_n=2,
            new_wallet_top_n=2,
            rotating_sample_n=2,
            discovery_pool_target=9,
            discovery_pool_min=8,
            discovery_pool_max=10,
        )
        result = build_discovery_pool(
            universe,
            config=config,
            prior_verified_wallets=[wallet(28), wallet(29)],
            previous_leaderboard_addresses=[wallet(index) for index in range(30)],
            discovery_cycle_id="max-bound",
        )
        self.assertEqual(result.actual_count, 10)
        self.assertIn(wallet(28), result.wallets)
        self.assertIn(wallet(29), result.wallets)
        self.assertIn(PRIOR_VERIFIED, next(entry for entry in result.entries if entry.wallet == wallet(28)).inclusion_reasons)

    def test_small_eligible_universe_is_explicitly_incomplete(self):
        universe = load_leaderboard_universe({"leaderboardRows": [leaderboard_row(index, roi=index, pnl=index, volume=index) for index in range(3)]})
        result = build_discovery_pool(universe, config=self.config, discovery_cycle_id="small")
        self.assertFalse(result.complete)
        self.assertIn("DISCOVERY_POOL_INCOMPLETE", result.reason_codes)
        self.assertEqual(result.actual_count, 3)

    def test_shard_state_and_outside_threshold_breach_are_deterministic(self):
        wallets = [wallet(index) for index in range(7)]
        state, first = claim_next_refresh_shard(DiscoveryCycleState(), wallets, shard_size=3, scored_at_ms=10)
        state, second = claim_next_refresh_shard(state, wallets, shard_size=3, scored_at_ms=11)
        state, third = claim_next_refresh_shard(state, wallets, shard_size=3, scored_at_ms=12)
        self.assertEqual(len(first), 3)
        self.assertEqual(len(second), 3)
        self.assertEqual(len(third), 1)
        refreshed, next_cycle_first = claim_next_refresh_shard(state, wallets, shard_size=3)
        self.assertEqual(refreshed.discovery_cycle_id, "1")
        self.assertEqual(len(next_cycle_first), 3)
        self.assertEqual(
            detect_outside_pool_threshold_breach({wallet(1): Decimal("0.25"), wallet(2): Decimal("0.20")}, Decimal("0.20")),
            (wallet(1),),
        )

    def test_missing_turnover_is_marked_unavailable_not_zero_ranked(self):
        universe = load_leaderboard_universe(
            {"leaderboardRows": [leaderboard_row(index, roi=index, pnl=index, volume=None) for index in range(8)]}
        )
        result = build_discovery_pool(universe, config=self.config, discovery_cycle_id="missing-turnover")
        self.assertFalse(result.signal_available["turnover"])
        self.assertIn("DISCOVERY_SIGNAL_UNAVAILABLE", result.reason_codes)
        self.assertFalse(any(TURNOVER in entry.inclusion_reasons for entry in result.entries))

    def test_outside_shard_is_1000_wallets_and_rotating_quota_is_backfilled_to_500(self):
        rows = [leaderboard_row(index, roi=2000 - index, pnl=2000 - index, volume=2000 - index) for index in range(1_505)]
        universe = load_leaderboard_universe({"leaderboardRows": rows})
        config = DiscoveryConfig(
            leaderboard_roi_top_n=1,
            leaderboard_pnl_top_n=1,
            leaderboard_turnover_top_n=1,
            prior_verified_top_n=0,
            new_wallet_top_n=0,
            rotating_sample_n=500,
            discovery_pool_target=500,
            discovery_pool_min=500,
            discovery_pool_max=700,
        )
        outside = outside_pool_eligible_wallets(universe, config=config)
        state, shard = claim_next_refresh_shard(DiscoveryCycleState(), outside, shard_size=1_000)
        result = build_discovery_pool(
            universe,
            config=config,
            discovery_cycle_id=state.discovery_cycle_id,
            rotating_wallets=shard,
        )
        rotating = {entry.wallet for entry in result.entries if ROTATING_SAMPLE in entry.inclusion_reasons}
        self.assertEqual(len(shard), 1_000)
        self.assertEqual(len(rotating), 500)
        self.assertTrue(rotating.issubset(set(outside)))

        # Supplying only an A--E member still produces an outside-pool F quota.
        backfilled = build_discovery_pool(
            universe,
            config=DiscoveryConfig(
                leaderboard_roi_top_n=1,
                leaderboard_pnl_top_n=1,
                leaderboard_turnover_top_n=1,
                prior_verified_top_n=0,
                new_wallet_top_n=0,
                rotating_sample_n=1,
                discovery_pool_target=4,
                discovery_pool_min=4,
                discovery_pool_max=10,
            ),
            discovery_cycle_id="backfill",
            rotating_wallets=[wallet(0)],
        )
        backfilled_rotating = {entry.wallet for entry in backfilled.entries if ROTATING_SAMPLE in entry.inclusion_reasons}
        self.assertEqual(len(backfilled_rotating), 1)
        self.assertNotIn(wallet(0), backfilled_rotating)


if __name__ == "__main__":
    unittest.main()
