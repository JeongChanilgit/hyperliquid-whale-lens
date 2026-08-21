import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from whale_lens.api import (  # noqa: E402
    HyperliquidApiClient,
    RequestBudgetExhausted,
    RetryPolicy,
    StageRequestBudget,
    WeightedTokenBucket,
)
import whale_lens.cache as cache_module  # noqa: E402
from whale_lens.cache import (  # noqa: E402
    CheckpointStore,
    RawResponseCache,
    ResumeIdentity,
    ResumeValidationError,
    atomic_write_json,
    make_raw_cache_key,
)


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError("unexpected non-retryable response")

    def json(self):
        return self.payload


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.posts = []

    def post(self, endpoint, *, json, timeout):
        self.posts.append((endpoint, json, timeout))
        return self.responses.pop(0)


class RecordingLimiter:
    def __init__(self):
        self.weights = []

    def acquire(self, weight):
        self.weights.append(weight)


class CacheAndResumeTests(unittest.TestCase):
    def test_atomic_write_retries_a_brief_windows_destination_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "checkpoint.json"
            real_replace = cache_module.os.replace
            attempts = [0]

            def briefly_locked(source, destination):
                attempts[0] += 1
                if attempts[0] < 3:
                    raise PermissionError(5, "destination is temporarily locked")
                return real_replace(source, destination)

            with patch("whale_lens.cache.os.replace", side_effect=briefly_locked), patch(
                "whale_lens.cache.time.sleep", return_value=None
            ):
                atomic_write_json(target, {"complete": True})

            self.assertEqual(attempts[0], 3)
            self.assertIn('"complete":true', target.read_text(encoding="utf-8"))

    def test_token_bucket_can_warm_start_without_a_full_burst(self):
        now = [0.0]

        def sleep(seconds):
            now[0] += seconds

        bucket = WeightedTokenBucket(
            capacity=1200,
            refill_per_second=20,
            initial_tokens=0,
            clock=lambda: now[0],
            sleeper=sleep,
        )
        bucket.acquire(20)
        self.assertEqual(now[0], 1.0)

    def test_raw_cache_key_contains_fixed_window_asof_metric_schema_and_mode(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache = RawResponseCache(temporary)
            key = make_raw_cache_key(
                wallet="0x" + "a" * 40,
                endpoint="portfolio",
                window_start_ms=10,
                window_end_ms=20,
                as_of_ms=20,
                metric_version="1",
                raw_payload_schema_version="portfolio-v2",
                coverage_mode="FAST_INCREMENTAL",
            )
            cache.put(key, {"perpMonth": {"accountValueHistory": []}}, stored_at_ms=100)
            self.assertEqual(cache.get(key, now_ms=101), {"perpMonth": {"accountValueHistory": []}})
            different_asof = make_raw_cache_key(
                wallet="0x" + "a" * 40,
                endpoint="portfolio",
                window_start_ms=10,
                window_end_ms=21,
                as_of_ms=21,
                metric_version="1",
                raw_payload_schema_version="portfolio-v2",
                coverage_mode="FAST_INCREMENTAL",
            )
            self.assertNotEqual(key.digest, different_asof.digest)
            self.assertIsNone(cache.get(different_asof))
            self.assertIsNone(cache.get(key, max_age_ms=1, now_ms=102))

    def test_atomic_checkpoint_resume_requires_pool_hash_and_fixed_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = CheckpointStore(temporary)
            identity = ResumeIdentity("run-a", 100, "1", "pool-abc", "FAST_INCREMENTAL")
            checkpoint = {
                **identity.to_dict(),
                "eligible_wallets": ["0x" + "1" * 40],
                "portfolio_scanned_wallets": [],
                "ledger_verification_cursor": 0,
            }
            saved = store.save(checkpoint)
            self.assertTrue(saved.exists())
            self.assertEqual(store.load("run-a", expected=identity)["run_id"], "run-a")
            with self.assertRaises(ResumeValidationError):
                store.load("run-a", expected=ResumeIdentity("run-a", 100, "1", "different-pool", "FAST_INCREMENTAL"))

    def test_api_retries_are_bounded_and_budgeted_with_observable_hooks(self):
        attempts = []
        retries = []
        session = FakeSession([FakeResponse({"message": "slow"}, 429), FakeResponse({"ok": True})])
        budget = StageRequestBudget({"portfolio": 2})
        client = HyperliquidApiClient(
            session=session,
            budgets=budget,
            limiter=WeightedTokenBucket(capacity=100, refill_per_second=100),
            retry_policy=RetryPolicy(max_retries=1, base_delay_seconds=0, jitter_fraction=0),
            sleeper=lambda _delay: None,
            random_value=lambda: 0.5,
            on_attempt=attempts.append,
            on_retry=retries.append,
        )
        self.assertEqual(client.fetch_portfolio("0x" + "b" * 40), {"ok": True})
        self.assertEqual(budget.used["portfolio"], 2)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(len(retries), 1)

    def test_api_does_not_call_after_stage_budget_exhaustion(self):
        session = FakeSession([FakeResponse({"ok": True})])
        client = HyperliquidApiClient(
            session=session,
            budgets=StageRequestBudget({"portfolio": 1}),
            limiter=WeightedTokenBucket(capacity=100, refill_per_second=100),
        )
        client.fetch_portfolio("0x" + "c" * 40)
        with self.assertRaises(RequestBudgetExhausted) as caught:
            client.fetch_portfolio("0x" + "c" * 40)
        self.assertEqual(caught.exception.reason_code, "REQUEST_BUDGET_EXHAUSTED")
        self.assertEqual(len(session.posts), 1)

    def test_raw_fills_charge_base_weight_plus_one_per_twenty_returned_rows(self):
        limiter = RecordingLimiter()
        client = HyperliquidApiClient(
            session=FakeSession([FakeResponse([{"tid": index} for index in range(41)])]),
            limiter=limiter,
            budgets=StageRequestBudget({"fills": 1}),
        )
        fills = client.fetch_fills_by_time("0x" + "d" * 40, 1, 2, aggregate_by_time=False)
        self.assertEqual(len(fills), 41)
        self.assertEqual(limiter.weights, [20.0, 3.0])


if __name__ == "__main__":
    unittest.main()
