import json
import sys
import tempfile
import unittest
from dataclasses import replace
from decimal import Decimal
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from whale_lens.api import StageRequestBudget  # noqa: E402
from whale_lens.discovery import (  # noqa: E402
    DiscoveryConfig,
    DiscoveryCycleState,
    build_discovery_pool,
    claim_next_refresh_shard,
    load_leaderboard_universe,
    outside_pool_eligible_wallets,
)
from whale_lens.pipeline import ScreenConfig, ScreenPaths, WhaleScreenPipeline  # noqa: E402
from whale_lens.report import report_sha256  # noqa: E402


class FakeApi:
    def __init__(self, as_of_ms, wallets):
        self.as_of_ms = as_of_ms
        self.wallets = wallets
        self.budgets = StageRequestBudget({"leaderboard": 10, "portfolio": 100, "ledger": 100, "fills": 100})

    def get_leaderboard(self):
        return {
            "leaderboardRows": [
                {
                    "ethAddress": wallet,
                    "accountValue": "10000",
                    "windowPerformances": [["month", {"roi": str(20 - index), "pnl": str(1000 - index), "vlm": str(100000 - index)}]],
                }
                for index, wallet in enumerate(self.wallets)
            ]
        }

    def fetch_portfolio(self, wallet):
        index = self.wallets.index(wallet)
        profit = Decimal(600 - index * 50)
        start = self.as_of_ms - 30 * 86_400_000
        return [["perpMonth", {
            "accountValueHistory": [[start, "10000"], [self.as_of_ms, str(Decimal("10000") + profit)]],
            "pnlHistory": [[start, "0"], [self.as_of_ms, str(profit)]],
        }]]

    def fetch_non_funding_ledger_updates(self, wallet, start_time_ms, end_time_ms):
        return []

    def fetch_fills_by_time(self, wallet, start_time_ms, end_time_ms, *, aggregate_by_time=False):
        return [
            {"time": start_time_ms + 100, "coin": "BTC", "startPosition": "0", "side": "B", "sz": "1", "px": "100", "closedPnl": "0", "fee": "0", "feeToken": "USDC", "tid": 1, "oid": 1, "hash": f"{wallet}-1"},
            {"time": start_time_ms + 200, "coin": "BTC", "startPosition": "1", "side": "A", "sz": "1", "px": "110", "closedPnl": "10", "fee": "0", "feeToken": "USDC", "tid": 2, "oid": 2, "hash": f"{wallet}-2"},
        ]


class OneUnscorablePortfolioApi(FakeApi):
    def fetch_portfolio(self, wallet):
        if wallet == self.wallets[-1]:
            return [["perpMonth", {
                "accountValueHistory": [[self.as_of_ms, "10000"]],
                "pnlHistory": [[self.as_of_ms, "0"]],
            }]]
        return super().fetch_portfolio(wallet)


class OneTransientPortfolioFailureApi(FakeApi):
    def __init__(self, as_of_ms, wallets):
        super().__init__(as_of_ms, wallets)
        self.failed_once = False

    def fetch_portfolio(self, wallet):
        if wallet == self.wallets[-1] and not self.failed_once:
            self.failed_once = True
            raise RuntimeError("one transient portfolio failure")
        return super().fetch_portfolio(wallet)


class HighOutsideShardApi(FakeApi):
    def __init__(self, as_of_ms, wallets, high_wallet):
        super().__init__(as_of_ms, wallets)
        self.high_wallet = high_wallet

    def fetch_portfolio(self, wallet):
        if wallet != self.high_wallet:
            return super().fetch_portfolio(wallet)
        start = self.as_of_ms - 30 * 86_400_000
        return [["perpMonth", {
            "accountValueHistory": [[start, "10000"], [self.as_of_ms, "30000"]],
            "pnlHistory": [[start, "0"], [self.as_of_ms, "20000"]],
        }]]


class FailedOutsideShardApi(FakeApi):
    def __init__(self, as_of_ms, wallets, failed_wallet):
        super().__init__(as_of_ms, wallets)
        self.failed_wallet = failed_wallet

    def fetch_portfolio(self, wallet):
        if wallet == self.failed_wallet:
            raise RuntimeError("persistent outside shard portfolio failure")
        return super().fetch_portfolio(wallet)


class PipelineIntegrationTests(unittest.TestCase):
    @staticmethod
    def _save_resume_budget_checkpoint(paths, config, *, as_of_ms, run_id, pool_hash):
        pipeline = WhaleScreenPipeline(
            config,
            paths,
            as_of_ms=as_of_ms,
            run_id=run_id,
            progress=lambda _message: None,
        )
        pipeline._save_checkpoint(pool_hash, stage="PORTFOLIO", provisional_rows=[])

    def test_resume_allows_only_monotonic_collection_budget_increases(self):
        as_of_ms = 1_800_000_000_000
        pool_hash = "budget-resume-pool"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = ScreenPaths(root / "reports", root / "state", root / "cache")
            original = ScreenConfig(portfolio_request_budget=8, ledger_request_budget=9, fill_request_budget=10)
            resumed_config = replace(original, portfolio_request_budget=12, fill_request_budget=14)
            self._save_resume_budget_checkpoint(
                paths, original, as_of_ms=as_of_ms, run_id="resume-budget-increase", pool_hash=pool_hash
            )

            resumed = WhaleScreenPipeline(
                resumed_config,
                paths,
                as_of_ms=as_of_ms,
                run_id="resume-budget-increase",
                resume=True,
                progress=lambda _message: None,
            )
            self.assertIsNotNone(resumed._load_checkpoint(pool_hash))
            resumed._save_checkpoint(pool_hash, stage="PORTFOLIO", provisional_rows=[])

            checkpoint = json.loads((paths.checkpoints / "resume-budget-increase.checkpoint.json").read_text(encoding="utf-8"))
            self.assertEqual(checkpoint["config_hash"], resumed_config.config_hash)
            self.assertEqual(checkpoint["request_budgets"]["portfolio"]["limit"], 12)
            self.assertEqual(checkpoint["request_budgets"]["ledger"]["limit"], 9)
            self.assertEqual(checkpoint["request_budgets"]["fills"]["limit"], 14)

    def test_resume_rejects_collection_budget_decreases(self):
        as_of_ms = 1_800_000_000_000
        pool_hash = "budget-resume-pool"
        original = ScreenConfig(portfolio_request_budget=8, ledger_request_budget=9, fill_request_budget=10)
        for field_name in ("portfolio_request_budget", "ledger_request_budget", "fill_request_budget"):
            with self.subTest(field_name=field_name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                paths = ScreenPaths(root / "reports", root / "state", root / "cache")
                self._save_resume_budget_checkpoint(
                    paths, original, as_of_ms=as_of_ms, run_id="resume-budget-decrease", pool_hash=pool_hash
                )
                resumed = WhaleScreenPipeline(
                    replace(original, **{field_name: getattr(original, field_name) - 1}),
                    paths,
                    as_of_ms=as_of_ms,
                    run_id="resume-budget-decrease",
                    resume=True,
                    progress=lambda _message: None,
                )
                with self.assertRaisesRegex(ValueError, "resume config_hash mismatch"):
                    resumed._load_checkpoint(pool_hash)

    def test_resume_rejects_non_budget_config_drift_despite_budget_increase(self):
        as_of_ms = 1_800_000_000_000
        pool_hash = "budget-resume-pool"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = ScreenPaths(root / "reports", root / "state", root / "cache")
            original = ScreenConfig(portfolio_request_budget=8, ledger_request_budget=9, fill_request_budget=10)
            self._save_resume_budget_checkpoint(
                paths, original, as_of_ms=as_of_ms, run_id="resume-budget-drift", pool_hash=pool_hash
            )
            resumed = WhaleScreenPipeline(
                replace(
                    original,
                    portfolio_request_budget=12,
                    minimum_completed_episodes=original.minimum_completed_episodes + 1,
                ),
                paths,
                as_of_ms=as_of_ms,
                run_id="resume-budget-drift",
                resume=True,
                progress=lambda _message: None,
            )
            with self.assertRaisesRegex(ValueError, "resume config_hash mismatch"):
                resumed._load_checkpoint(pool_hash)

    def test_small_complete_run_writes_cross_checked_lists_and_canonical(self):
        as_of_ms = 1_800_000_000_000
        wallets = [f"0x{index:040x}" for index in range(1, 7)]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = ScreenPaths(root / "reports", root / "state", root / "cache")
            config = ScreenConfig(
                discovery_pool_target=6,
                discovery_pool_min=6,
                discovery_pool_max=6,
                leaderboard_roi_top_n=6,
                leaderboard_pnl_top_n=6,
                leaderboard_turnover_top_n=6,
                prior_verified_top_n=2,
                new_wallet_top_n=1,
                rotating_sample_n=1,
                ledger_verification_initial_n=4,
                ledger_verification_expand_step=1,
                boundary_probe_n=1,
                candidate_count=2,
                final_active_count=2,
                minimum_completed_episodes=1,
            )
            report = WhaleScreenPipeline(
                config,
                paths,
                api=FakeApi(as_of_ms, wallets),
                as_of_ms=as_of_ms,
                run_id="integration-run",
                progress=lambda _message: None,
            ).run()
            self.assertEqual(report["run_status"], "COMPLETE")
            self.assertEqual(len(report["finalists"]), 2)
            self.assertTrue((paths.candidate_reports / "latest-top2000.json").exists())
            canonical = json.loads(paths.canonical_state.read_text(encoding="utf-8"))
            saved_report = json.loads((paths.discovery_reports / "latest.json").read_text(encoding="utf-8"))
            self.assertEqual(canonical["wallets"], wallets[:2])
            self.assertEqual(canonical["candidate_pool_hash"], report["candidate_pool_hash"])
            self.assertEqual(canonical["report_sha256"], report_sha256(saved_report))

    def test_audited_wallet_exclusion_is_not_a_pool_transport_coverage_hole(self):
        as_of_ms = 1_800_000_000_000
        wallets = [f"0x{index:040x}" for index in range(1, 7)]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = ScreenPaths(root / "reports", root / "state", root / "cache")
            config = ScreenConfig(
                discovery_pool_target=6,
                discovery_pool_min=6,
                discovery_pool_max=6,
                leaderboard_roi_top_n=6,
                leaderboard_pnl_top_n=6,
                leaderboard_turnover_top_n=6,
                prior_verified_top_n=2,
                new_wallet_top_n=1,
                rotating_sample_n=1,
                ledger_verification_initial_n=4,
                ledger_verification_expand_step=1,
                boundary_probe_n=1,
                candidate_count=2,
                final_active_count=2,
                minimum_completed_episodes=1,
            )
            report = WhaleScreenPipeline(
                config,
                paths,
                api=OneUnscorablePortfolioApi(as_of_ms, wallets),
                as_of_ms=as_of_ms,
                run_id="evaluated-exclusion-run",
                progress=lambda _message: None,
            ).run()
            self.assertTrue(report["provisional_coverage_complete"])
            self.assertEqual(report["provisional_scored_count"], 5)
            self.assertEqual(report["run_status"], "COMPLETE")

    def test_bounded_recovery_sweep_closes_a_transient_portfolio_hole(self):
        as_of_ms = 1_800_000_000_000
        wallets = [f"0x{index:040x}" for index in range(1, 7)]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = ScreenPaths(root / "reports", root / "state", root / "cache")
            config = ScreenConfig(
                discovery_pool_target=6, discovery_pool_min=6, discovery_pool_max=6,
                leaderboard_roi_top_n=6, leaderboard_pnl_top_n=6, leaderboard_turnover_top_n=6,
                prior_verified_top_n=2, new_wallet_top_n=1, rotating_sample_n=1,
                ledger_verification_initial_n=4, ledger_verification_expand_step=1,
                boundary_probe_n=1, candidate_count=2, final_active_count=2,
                minimum_completed_episodes=1,
            )
            api = OneTransientPortfolioFailureApi(as_of_ms, wallets)
            report = WhaleScreenPipeline(
                config, paths, api=api, as_of_ms=as_of_ms,
                run_id="transient-recovery-run", progress=lambda _message: None,
            ).run()
            self.assertTrue(api.failed_once)
            self.assertTrue(report["provisional_coverage_complete"])
            self.assertEqual(report["run_status"], "COMPLETE")

    def test_resume_uses_checkpointed_previous_snapshot_for_the_same_discovery_pool(self):
        as_of_ms = 1_800_000_000_000
        wallets = [f"0x{index:040x}" for index in range(1, 7)]
        prior_snapshot = wallets[:-1]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = ScreenPaths(root / "reports", root / "state", root / "cache")
            config = ScreenConfig(
                discovery_pool_target=6, discovery_pool_min=6, discovery_pool_max=6,
                leaderboard_roi_top_n=1, leaderboard_pnl_top_n=1, leaderboard_turnover_top_n=1,
                prior_verified_top_n=1, new_wallet_top_n=1, rotating_sample_n=1,
                ledger_verification_initial_n=2, ledger_verification_expand_step=1,
                boundary_probe_n=1, candidate_count=2, final_active_count=2,
                minimum_completed_episodes=1,
            )
            api = FakeApi(as_of_ms, wallets)
            universe = load_leaderboard_universe(api.get_leaderboard())
            discovery_config = DiscoveryConfig(
                leaderboard_roi_top_n=1, leaderboard_pnl_top_n=1, leaderboard_turnover_top_n=1,
                prior_verified_top_n=1, new_wallet_top_n=1, rotating_sample_n=1,
                discovery_pool_target=6, discovery_pool_min=6, discovery_pool_max=6,
            )
            outside = outside_pool_eligible_wallets(
                universe, config=discovery_config, previous_leaderboard_addresses=prior_snapshot
            )
            cycle, shard = claim_next_refresh_shard(DiscoveryCycleState(), outside, shard_size=config.outside_shard_size)
            pool = build_discovery_pool(
                universe,
                config=discovery_config,
                previous_leaderboard_addresses=prior_snapshot,
                discovery_cycle_id=cycle.discovery_cycle_id,
                rotating_wallets=shard,
            )
            interrupted = WhaleScreenPipeline(config, paths, api=api, as_of_ms=as_of_ms, run_id="resume-same-pool", progress=lambda _message: None)
            interrupted.discovery_cycle_state = cycle
            interrupted.discovery_cycle_id = cycle.discovery_cycle_id
            interrupted.rotating_shard = shard
            interrupted.previous_leaderboard_wallets = tuple(prior_snapshot)
            interrupted._save_checkpoint(pool.pool_hash, stage="PORTFOLIO", provisional_rows=[])
            paths.discovery_state.mkdir(parents=True, exist_ok=True)
            (paths.discovery_state / "prior-leaderboard-addresses.json").write_text(
                json.dumps({"as_of_ms": as_of_ms, "wallets": wallets}), encoding="utf-8"
            )

            report = WhaleScreenPipeline(
                config, paths, api=api, as_of_ms=as_of_ms, run_id="resume-same-pool", resume=True, progress=lambda _message: None
            ).run()
            self.assertEqual(report["run_status"], "COMPLETE")
            checkpoint = json.loads((paths.checkpoints / "resume-same-pool.checkpoint.json").read_text(encoding="utf-8"))
            self.assertEqual(checkpoint["discovery_pool_hash"], pool.pool_hash)

    def test_high_score_in_persistent_outside_shard_blocks_canonical_promotion(self):
        as_of_ms = 1_800_000_000_000
        wallets = [f"0x{index:040x}" for index in range(1, 10)]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = ScreenPaths(root / "reports", root / "state", root / "cache")
            config = ScreenConfig(
                discovery_pool_target=4, discovery_pool_min=4, discovery_pool_max=4,
                leaderboard_roi_top_n=1, leaderboard_pnl_top_n=1, leaderboard_turnover_top_n=1,
                prior_verified_top_n=1, new_wallet_top_n=1, rotating_sample_n=1,
                ledger_verification_initial_n=2, ledger_verification_expand_step=1,
                boundary_probe_n=1, candidate_count=2, final_active_count=2,
                minimum_completed_episodes=1,
            )
            planning_api = FakeApi(as_of_ms, wallets)
            universe = load_leaderboard_universe(planning_api.get_leaderboard())
            discovery_config = DiscoveryConfig(
                leaderboard_roi_top_n=1, leaderboard_pnl_top_n=1, leaderboard_turnover_top_n=1,
                prior_verified_top_n=1, new_wallet_top_n=1, rotating_sample_n=1,
                discovery_pool_target=4, discovery_pool_min=4, discovery_pool_max=4,
            )
            outside = outside_pool_eligible_wallets(universe, config=discovery_config)
            cycle, shard = claim_next_refresh_shard(DiscoveryCycleState(), outside, shard_size=config.outside_shard_size)
            pool = build_discovery_pool(universe, config=discovery_config, discovery_cycle_id=cycle.discovery_cycle_id, rotating_wallets=shard)
            high_wallet = next(wallet for wallet in shard if wallet not in set(pool.wallets))
            report = WhaleScreenPipeline(
                config, paths, api=HighOutsideShardApi(as_of_ms, wallets, high_wallet), as_of_ms=as_of_ms,
                run_id="outside-shard-breach", progress=lambda _message: None,
            ).run()
            self.assertEqual(report["run_status"], "PARTIAL")
            self.assertGreater(report["outside_pool_threshold_breach_count"], 0)
            self.assertFalse(paths.canonical_state.exists())

    def test_unevaluated_persistent_outside_shard_blocks_canonical_promotion(self):
        as_of_ms = 1_800_000_000_000
        wallets = [f"0x{index:040x}" for index in range(1, 10)]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = ScreenPaths(root / "reports", root / "state", root / "cache")
            config = ScreenConfig(
                discovery_pool_target=4, discovery_pool_min=4, discovery_pool_max=4,
                leaderboard_roi_top_n=1, leaderboard_pnl_top_n=1, leaderboard_turnover_top_n=1,
                prior_verified_top_n=1, new_wallet_top_n=1, rotating_sample_n=1,
                ledger_verification_initial_n=2, ledger_verification_expand_step=1,
                boundary_probe_n=1, candidate_count=2, final_active_count=2,
                minimum_completed_episodes=1,
            )
            planning_api = FakeApi(as_of_ms, wallets)
            universe = load_leaderboard_universe(planning_api.get_leaderboard())
            discovery_config = DiscoveryConfig(
                leaderboard_roi_top_n=1, leaderboard_pnl_top_n=1, leaderboard_turnover_top_n=1,
                prior_verified_top_n=1, new_wallet_top_n=1, rotating_sample_n=1,
                discovery_pool_target=4, discovery_pool_min=4, discovery_pool_max=4,
            )
            outside = outside_pool_eligible_wallets(universe, config=discovery_config)
            cycle, shard = claim_next_refresh_shard(DiscoveryCycleState(), outside, shard_size=config.outside_shard_size)
            pool = build_discovery_pool(universe, config=discovery_config, discovery_cycle_id=cycle.discovery_cycle_id, rotating_wallets=shard)
            failed_wallet = next(wallet for wallet in shard if wallet not in set(pool.wallets))
            report = WhaleScreenPipeline(
                config, paths, api=FailedOutsideShardApi(as_of_ms, wallets, failed_wallet), as_of_ms=as_of_ms,
                run_id="outside-shard-coverage", progress=lambda _message: None,
            ).run()
            self.assertEqual(report["run_status"], "PARTIAL")
            self.assertEqual(report["reason_code"], "OUTSIDE_SHARD_COVERAGE_INCOMPLETE")
            self.assertFalse(report["outside_shard_coverage_complete"])
            self.assertEqual(report["outside_shard_expected_count"], len(shard))
            self.assertEqual(report["outside_shard_evaluated_count"], len(shard) - 1)
            self.assertFalse(paths.canonical_state.exists())


if __name__ == "__main__":
    unittest.main()
