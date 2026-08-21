from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from whale_lens.research import SELECTION_MODE, activate_partial_research_top10


class PartialResearchActivationTests(unittest.TestCase):
    def _fixtures(self, root: Path, *, reason: str = "INSUFFICIENT_VERIFIED_CANDIDATES") -> tuple[Path, Path]:
        report_path = root / "source-report.json"
        candidate_path = root / "source-candidates.json"
        report = {
            "run_id": "source-run",
            "as_of_ms": 1_700_000_000_000,
            "window_start_ms": 1_697_408_000_000,
            "window_end_ms": 1_700_000_000_000,
            "metric_name": "perp_cashflow_neutral_twr_30d",
            "metric_version": "1",
            "coverage_mode": "FAST_INCREMENTAL",
            "ranking_scope": "DISCOVERY_POOL_EXACT",
            "config_hash": "a" * 64,
            "candidate_pool_hash": "b" * 64,
            "run_status": "PARTIAL",
            "reason_code": reason,
            "candidate_count_requested": 2000,
            "candidate_count_actual": 12,
            "outside_shard_coverage_complete": True,
            "outside_pool_threshold_breach_count": 0,
        }
        candidates = [
            {
                "wallet": f"0x{rank:040x}",
                "candidate_rank": rank,
                "quality": "VERIFIED",
                "perp_cashflow_neutral_twr_30d": str(2 - rank / 100),
                "current_account_value_usd": "10000",
            }
            for rank in range(1, 13)
        ]
        candidate = {
            "run_id": "source-run",
            "candidate_pool_hash": "b" * 64,
            "candidate_count_requested": 2000,
            "candidate_count_actual": 12,
            "candidate_pool_complete": False,
            "candidates": candidates,
        }
        report_path.write_text(json.dumps(report), encoding="utf-8")
        candidate_path.write_text(json.dumps(candidate), encoding="utf-8")
        return report_path, candidate_path

    def test_writes_explicit_research_artifacts_without_canonical_promotion(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            report_path, candidate_path = self._fixtures(root)
            result = activate_partial_research_top10(
                source_report_path=report_path,
                source_candidate_path=candidate_path,
                research_report_path=root / "research-report.json",
                research_candidate_path=root / "research-candidates.json",
                research_state_path=root / "research-state.json",
                fill_validator=lambda row: {"valid": True, "completed_episodes": 10, "raw_fill_count": 20},
                target_count=2,
                standby_count=2,
                authorized_at_utc="2026-08-21T03:00:00+00:00",
            )
            self.assertEqual(result["state"]["selection_mode"], SELECTION_MODE)
            self.assertFalse(result["state"]["canonical_state_updated"])
            self.assertTrue(result["state"]["research_override_authorized"])
            self.assertEqual(result["state"]["wallets"], [f"0x{1:040x}", f"0x{2:040x}"])
            self.assertEqual(len(result["candidate"]["candidates"]), 4)
            self.assertEqual(result["report"]["run_status"], "PARTIAL_RESEARCH_OVERRIDE")
            self.assertTrue((root / "research-state.json").is_file())

    def test_refuses_any_partial_reason_other_than_insufficient_verified(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            report_path, candidate_path = self._fixtures(root, reason="OUTSIDE_POOL_THRESHOLD_BREACH")
            with self.assertRaisesRegex(ValueError, "INSUFFICIENT_VERIFIED_CANDIDATES"):
                activate_partial_research_top10(
                    source_report_path=report_path,
                    source_candidate_path=candidate_path,
                    research_report_path=root / "research-report.json",
                    research_candidate_path=root / "research-candidates.json",
                    research_state_path=root / "research-state.json",
                    fill_validator=lambda row: {"valid": True, "completed_episodes": 10},
                    target_count=2,
                    standby_count=2,
                )


if __name__ == "__main__":
    unittest.main()
