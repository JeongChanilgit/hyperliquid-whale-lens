import unittest

from whale_lens.activity_census import (
    HAS_FILL,
    ZERO_FILLS,
    build_activity_census_report,
    select_exact_twr_top10_with_fills,
    summarize_fill_presence,
    summarize_positive_month_volume,
)


def _wallet(number: int) -> str:
    return f"0x{number:040x}"


class ActivityCensusTests(unittest.TestCase):
    def setUp(self) -> None:
        self.summary = {
            "discovered_accounts": 3,
            "accounts": [
                {"wallet": _wallet(1), "data_quality_status": "VERIFIED_EXACT", "latest_scores": {"exact_twr": "2"}},
                {"wallet": _wallet(2), "data_quality_status": "VERIFIED_EXACT", "latest_scores": {"exact_twr": "5"}},
                {"wallet": _wallet(3), "data_quality_status": "BOUNDED", "latest_scores": {"exact_twr": "999"}},
            ],
        }
        self.source = {"run_id": "run-1", "as_of_ms": 200, "window_start_ms": 100, "window_end_ms": 200}

    def test_presence_is_deduped_and_never_claims_complete_fill_count(self) -> None:
        fill = {"time": 150, "tid": 1, "coin": "BTC", "side": "B", "sz": "1", "px": "100"}
        result = summarize_fill_presence([fill, dict(fill)], window_start_ms=100, window_end_ms=200)
        self.assertEqual(result["status"], HAS_FILL)
        self.assertEqual(result["minimum_proven_fill_count_30d"], 1)
        self.assertEqual(result["observed_unique_fill_count_30d"], 1)

    def test_out_of_window_fill_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "outside"):
            summarize_fill_presence([{"time": 99}], window_start_ms=100, window_end_ms=200)

    def test_positive_month_volume_proves_activity_but_zero_does_not(self) -> None:
        payload = {"leaderboardRows": [
            {"ethAddress": _wallet(1), "windowPerformances": [["month", {"vlm": "1.25"}]]},
            {"ethAddress": _wallet(2), "windowPerformances": [["month", {"vlm": "0"}]]},
        ]}
        self.assertEqual(summarize_positive_month_volume(payload, (_wallet(1), _wallet(2))), {_wallet(1): "1.25"})

    def test_partial_census_cannot_select_top10(self) -> None:
        census = build_activity_census_report(self.summary, self.source, {_wallet(1): {"status": HAS_FILL, "has_fill_30d": True}})
        self.assertEqual(census["run_status"], "PARTIAL")
        with self.assertRaisesRegex(ValueError, "not complete"):
            select_exact_twr_top10_with_fills(self.summary, census, count=1)

    def test_complete_census_ranks_exact_twr_only(self) -> None:
        census = build_activity_census_report(
            self.summary,
            self.source,
            {
                _wallet(1): {"status": HAS_FILL, "has_fill_30d": True, "observed_unique_fill_count_30d": 1},
                _wallet(2): {"status": HAS_FILL, "has_fill_30d": True, "observed_unique_fill_count_30d": 3},
                _wallet(3): {"status": ZERO_FILLS, "has_fill_30d": False, "observed_unique_fill_count_30d": 0},
            },
        )
        self.assertEqual(census["fill_positive_twr_calculation_attempted_count"], 2)
        self.assertEqual(census["fill_positive_exact_twr_count"], 2)
        selected = select_exact_twr_top10_with_fills(self.summary, census, count=2)
        self.assertEqual([row["wallet"] for row in selected], [_wallet(2), _wallet(1)])


if __name__ == "__main__":
    unittest.main()
