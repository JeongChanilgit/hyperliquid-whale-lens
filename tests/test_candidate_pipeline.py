import json
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from whale_lens.candidate import (  # noqa: E402
    METRIC_NAME,
    CandidateVerificationStateMachine,
    detect_outside_pool_threshold_breach,
    freeze_candidate_top2000,
    validate_candidates_until_finalists,
)
from whale_lens.report import (  # noqa: E402
    build_canonical_state,
    build_report_metadata,
    build_run_report,
    write_canonical_state_if_complete,
)


def verified(wallet, score, *, observations=4, account="10000"):
    return {
        "wallet": wallet,
        "quality": "VERIFIED",
        METRIC_NAME: Decimal(str(score)),
        "portfolio_observation_count": observations,
        "current_account_value_usd": Decimal(str(account)),
    }


def provisional(wallet, score):
    return {"wallet": wallet, "provisional_perp_twr_30d": Decimal(str(score)), "quality": "PROVISIONAL"}


class CandidateFreezeTests(unittest.TestCase):
    def test_freeze_is_deterministic_and_only_uses_verified(self):
        rows = [
            verified("0xB", "0.10", observations=2, account="20"),
            verified("0xa", "0.10", observations=2, account="20"),
            verified("0xc", "0.30"),
            {"wallet": "0xignored", "quality": "APPROXIMATE", METRIC_NAME: Decimal("9")},
        ]
        first = freeze_candidate_top2000(rows, candidate_count=3, source_run_id="run")
        second = freeze_candidate_top2000(reversed(rows), candidate_count=3, source_run_id="run")
        self.assertTrue(first.candidate_pool_complete)
        self.assertEqual([row["wallet"] for row in first.candidates], ["0xc", "0xa", "0xB"])
        self.assertEqual(first.candidate_pool_hash, second.candidate_pool_hash)

    def test_initial_expand_probe_state_machine_detects_boundary_breach(self):
        machine = CandidateVerificationStateMachine(
            [provisional("0xa", 10), provisional("0xb", 9), provisional("0xc", 8), provisional("0xd", 7), provisional("0xe", 6)],
            candidate_count=2,
            initial_count=3,
            expand_step=2,
            boundary_probe_count=1,
            run_seed="cycle-1",
        )
        initial = machine.next_action()
        self.assertEqual(initial.kind, "VERIFY")
        self.assertEqual(initial.wallets, ("0xa", "0xb", "0xc"))
        machine.record_verifications([verified("0xa", 10), verified("0xb", 9), verified("0xc", 8)])
        probe = machine.next_action()
        self.assertEqual(probe.kind, "PROBE")
        self.assertEqual(len(probe.wallets), 1)
        # Whatever deterministic wallet was selected, make it exceed the
        # cutoff that existed before probing (9).  It must force expansion.
        machine.record_verifications([verified(probe.wallets[0], 11)])
        expansion = machine.next_action()
        self.assertEqual(expansion.kind, "VERIFY")
        self.assertEqual(expansion.reason_code, "BOUNDARY_BREACH")
        machine.record_verifications([verified(wallet, 1) for wallet in expansion.wallets])
        terminal = machine.next_action()
        self.assertEqual(terminal.kind, "COMPLETE")
        self.assertEqual(machine.boundary_breach_count, 1)
        self.assertTrue(machine.freeze().candidate_pool_complete)

    def test_outside_pool_fixture_breach_blocks_candidate_publication(self):
        freeze = freeze_candidate_top2000([verified("0xa", 1), verified("0xb", "0.5")], candidate_count=2)
        breach = detect_outside_pool_threshold_breach([provisional("0xoutside", "0.6")], freeze)
        self.assertTrue(breach.blocks_canonical_update)
        self.assertEqual(breach.breached_wallets, ("0xoutside",))
        self.assertEqual(breach.reason_code, "OUTSIDE_POOL_THRESHOLD_BREACH")


class FinalistAndCanonicalTests(unittest.TestCase):
    def test_until_10_stops_after_first_qualifying_finalists_in_candidate_rank_order(self):
        candidates = [
            {**verified("0xa", 3), "candidate_rank": 1},
            {**verified("0xb", 2), "candidate_rank": 2},
            {**verified("0xc", 1), "candidate_rank": 3},
            {**verified("0xd", 0), "candidate_rank": 4},
        ]
        outcomes = {
            "0xa": {"valid": True, "completed_episodes": 10, "raw_fill_count": 4},
            "0xb": {"valid": True, "completed_episodes": 9, "raw_fill_count": 4},
            "0xc": {"valid": True, "completed_episodes": 11, "raw_fill_count": 4},
            "0xd": {"valid": True, "completed_episodes": 12, "raw_fill_count": 4},
        }
        result = validate_candidates_until_finalists(candidates, lambda row: outcomes[row["wallet"]], target_count=2)
        self.assertTrue(result.complete)
        self.assertEqual([row["wallet"] for row in result.finalists], ["0xa", "0xc"])
        self.assertEqual(result.fills_scanned_candidate_count, 3)
        self.assertTrue(all(row["status"] == "ACTIVE" for row in result.finalists))

    def test_partial_or_outside_breach_cannot_replace_canonical_state(self):
        finalists = [verified("0xa", 2), verified("0xb", 1)]
        freeze = freeze_candidate_top2000(finalists, candidate_count=2)
        metadata = build_report_metadata(
            run_id="run-1",
            as_of_ms=100,
            window_start_ms=1,
            window_end_ms=100,
            candidate_count_requested=2,
            candidate_count_actual=2,
            candidate_pool_complete=True,
            candidate_pool_hash=freeze.candidate_pool_hash,
            run_status="COMPLETE",
            target_count=2,
        )
        report = build_run_report(metadata, finalists, candidate_rows=freeze.candidates, finalist_rows=finalists)
        state = build_canonical_state(report, finalists, config_hash="config")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "latest_active_top10.json"
            path.write_text(json.dumps({"wallets": ["0xold"]}), encoding="utf-8")
            allowed = write_canonical_state_if_complete(state, path, report=report)
            self.assertTrue(allowed.written)
            previous = path.read_text(encoding="utf-8")

            breached_report = dict(report)
            breached_report["outside_pool_threshold_breach_count"] = 1
            breached_state = build_canonical_state(breached_report, finalists, config_hash="config")
            blocked = write_canonical_state_if_complete(breached_state, path, report=breached_report)
            self.assertFalse(blocked.written)
            self.assertEqual(blocked.reason_code, "CANONICAL_UPDATE_BLOCKED")
            self.assertIn("OUTSIDE_POOL_THRESHOLD_BREACH", blocked.block_reasons)
            self.assertEqual(path.read_text(encoding="utf-8"), previous)


if __name__ == "__main__":
    unittest.main()
