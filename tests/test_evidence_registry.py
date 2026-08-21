import tempfile
import unittest
from pathlib import Path

from whale_lens.evidence_registry import (
    ActivityStatus,
    DataQualityStatus,
    EvidenceRegistry,
    SelectionStatus,
)


WALLET = "0x" + "ab" * 20


class EvidenceRegistryTests(unittest.TestCase):
    def test_raw_artifact_is_content_addressed_and_account_history_is_append_only(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            registry = EvidenceRegistry(Path(temp))
            ref1 = registry.preserve_raw_artifact(
                endpoint="portfolio", run_id="r1", captured_at_ms=1, wallet=WALLET, payload={"x": 1}
            )
            ref2 = registry.preserve_raw_artifact(
                endpoint="portfolio", run_id="r1", captured_at_ms=1, wallet=WALLET, payload={"x": 1}
            )
            self.assertEqual(ref1.sha256, ref2.sha256)
            registry.record_account(
                wallet=WALLET, seen_at_ms=1, run_id="r1",
                discovery={"rank": 1}, evaluation={"outcome": "PROVISIONAL"}, raw_artifact_refs=[ref1],
                data_quality_status=DataQualityStatus.RESCUE_PENDING,
                activity_status=ActivityStatus.NOT_YET_SCANNED,
                selection_status=SelectionStatus.WATCHLIST,
                reason_codes=["A", "B"],
            )
            registry.record_account(
                wallet=WALLET, seen_at_ms=2, run_id="r2",
                evaluation={"outcome": "VERIFIED_INTERVAL"}, raw_artifact_refs=[ref1],
                data_quality_status=DataQualityStatus.VERIFIED_INTERVAL,
                activity_status=ActivityStatus.QUALIFIED,
                selection_status=SelectionStatus.STANDBY,
                reason_codes=["B", "C"],
            )
            record = registry.load_account(WALLET)
            self.assertEqual(len(record["evaluation_history"]), 2)
            self.assertEqual(len(record["raw_artifact_refs"]), 1)
            self.assertEqual(record["reason_codes"], ["A", "B", "C"])
            self.assertEqual(record["data_quality_status"], "VERIFIED_INTERVAL")

    def test_unresolved_can_remain_on_watchlist_without_status_conflict(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            registry = EvidenceRegistry(Path(temp))
            record = registry.record_account(
                wallet=WALLET, seen_at_ms=1, run_id="r1",
                data_quality_status="UNRESOLVED", activity_status="ACTIVITY_UNVERIFIABLE",
                selection_status="HIGH_POTENTIAL_WATCHLIST",
            )
            self.assertEqual(record["selection_status"], "HIGH_POTENTIAL_WATCHLIST")


if __name__ == "__main__":
    unittest.main()
