"""Bounded, budget-aware access to Hyperliquid's public HTTP endpoints.

The screening pipeline deliberately shares one limiter across portfolio, ledger,
and fill stages.  This module does not decide a wallet's eligibility or score;
it makes each request attributable to a stage and fails with a stable reason
code when the run can no longer make safe progress.
"""

from __future__ import annotations

import json
import math
import random
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

import requests


LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"
INFO_URL = "https://api.hyperliquid.xyz/info"

REASON_HTTP_RETRY_EXHAUSTED = "HTTP_RETRY_EXHAUSTED"
REASON_REQUEST_BUDGET_EXHAUSTED = "REQUEST_BUDGET_EXHAUSTED"

EndpointWeight = float
RetryHook = Callable[[dict[str, Any]], None]


class ApiRequestError(RuntimeError):
    """Base error carrying a reason code suitable for a wallet/run report."""

    reason_code: str

    def __init__(self, message: str, reason_code: str) -> None:
        super().__init__(message)
        self.reason_code = reason_code


class RequestBudgetExhausted(ApiRequestError):
    def __init__(self, stage: str, limit: int) -> None:
        super().__init__(f"request budget exhausted for stage {stage!r} (limit {limit})", REASON_REQUEST_BUDGET_EXHAUSTED)
        self.stage = stage
        self.limit = limit


class RetryExhausted(ApiRequestError):
    def __init__(self, endpoint: str, attempts: int, last_error: BaseException | None) -> None:
        super().__init__(
            f"request to {endpoint} failed after {attempts} attempt(s): {last_error}",
            REASON_HTTP_RETRY_EXHAUSTED,
        )
        self.endpoint = endpoint
        self.attempts = attempts
        self.last_error = last_error


@dataclass(frozen=True)
class RetryPolicy:
    """A deliberately finite retry policy for public endpoints."""

    max_retries: int = 3
    base_delay_seconds: float = 0.5
    max_delay_seconds: float = 12.0
    jitter_fraction: float = 0.15

    def __post_init__(self) -> None:
        if self.max_retries < 0:
            raise ValueError("max_retries must be non-negative")
        if self.base_delay_seconds < 0 or self.max_delay_seconds < 0:
            raise ValueError("retry delays must be non-negative")
        if not 0 <= self.jitter_fraction <= 1:
            raise ValueError("jitter_fraction must be between 0 and 1")

    def delay_for_retry(self, retry_number: int, random_value: float = 0.5) -> float:
        """Return the delay before retry ``retry_number`` (starting at one)."""

        if retry_number <= 0:
            raise ValueError("retry_number must be positive")
        capped = min(self.max_delay_seconds, self.base_delay_seconds * (2 ** (retry_number - 1)))
        # Keep jitter symmetrical so tests can set random_value=0.5 for no jitter.
        factor = 1 + ((max(0.0, min(1.0, random_value)) * 2 - 1) * self.jitter_fraction)
        return max(0.0, capped * factor)


@dataclass
class StageRequestBudget:
    """Per-stage request limits; retries count because they consume real quota."""

    limits: Mapping[str, int] = field(default_factory=dict)
    used: dict[str, int] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False, compare=False)

    def consume(self, stage: str) -> int:
        with self._lock:
            limit = self.limits.get(stage)
            current = self.used.get(stage, 0)
            if limit is not None and current >= limit:
                raise RequestBudgetExhausted(stage, limit)
            current += 1
            self.used[stage] = current
            return current

    def remaining(self, stage: str) -> int | None:
        with self._lock:
            limit = self.limits.get(stage)
            if limit is None:
                return None
            return max(0, limit - self.used.get(stage, 0))

    def snapshot(self) -> dict[str, dict[str, int | None]]:
        with self._lock:
            stages = sorted(set(self.limits) | set(self.used))
            return {
                stage: {
                    "limit": self.limits.get(stage),
                    "used": self.used.get(stage, 0),
                    "remaining": None
                    if self.limits.get(stage) is None
                    else max(0, self.limits[stage] - self.used.get(stage, 0)),
                }
                for stage in stages
            }


class WeightedTokenBucket:
    """Thread-safe global token bucket using endpoint request weights."""

    def __init__(
        self,
        *,
        capacity: float = 1200.0,
        refill_per_second: float = 20.0,
        initial_tokens: float | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        if capacity <= 0 or refill_per_second <= 0:
            raise ValueError("capacity and refill_per_second must be positive")
        self.capacity = float(capacity)
        self.refill_per_second = float(refill_per_second)
        self._clock = clock
        self._sleeper = sleeper
        starting_tokens = float(capacity if initial_tokens is None else initial_tokens)
        if starting_tokens < 0 or starting_tokens > self.capacity:
            raise ValueError("initial_tokens must be between zero and capacity")
        self._tokens = starting_tokens
        self._last_refill = clock()
        self._lock = threading.Lock()

    @property
    def tokens(self) -> float:
        with self._lock:
            self._refill_locked(self._clock())
            return self._tokens

    def _refill_locked(self, now: float) -> None:
        elapsed = max(0.0, now - self._last_refill)
        self._tokens = min(self.capacity, self._tokens + elapsed * self.refill_per_second)
        self._last_refill = now

    def acquire(self, weight: EndpointWeight = 1.0) -> None:
        """Block only until a bounded-size request has global capacity."""

        weight = float(weight)
        if weight <= 0:
            raise ValueError("request weight must be positive")
        if weight > self.capacity:
            raise ValueError("request weight cannot exceed token bucket capacity")
        while True:
            with self._lock:
                now = self._clock()
                self._refill_locked(now)
                if self._tokens >= weight:
                    self._tokens -= weight
                    return
                wait_seconds = (weight - self._tokens) / self.refill_per_second
            self._sleeper(wait_seconds)


DEFAULT_ENDPOINT_WEIGHTS: dict[str, EndpointWeight] = {
    "leaderboard": 1.0,
    "portfolio": 20.0,
    "ledger": 20.0,
    "fills": 20.0,
    "funding": 20.0,
}
USER_FILLS_RETURNED_PER_ADDITIONAL_WEIGHT = 20


class HyperliquidApiClient:
    """Public API client with shared rate limiting, retry, and stage accounting."""

    def __init__(
        self,
        *,
        session: Any | None = None,
        timeout_seconds: float = 45.0,
        limiter: WeightedTokenBucket | None = None,
        budgets: StageRequestBudget | None = None,
        retry_policy: RetryPolicy | None = None,
        endpoint_weights: Mapping[str, EndpointWeight] | None = None,
        sleeper: Callable[[float], None] = time.sleep,
        random_value: Callable[[], float] = random.random,
        on_attempt: RetryHook | None = None,
        on_retry: RetryHook | None = None,
    ) -> None:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        self.session = session or requests.Session()
        self.timeout_seconds = timeout_seconds
        self.limiter = limiter or WeightedTokenBucket()
        self.budgets = budgets or StageRequestBudget()
        self.retry_policy = retry_policy or RetryPolicy()
        self.endpoint_weights = {**DEFAULT_ENDPOINT_WEIGHTS, **dict(endpoint_weights or {})}
        self._sleeper = sleeper
        self._random_value = random_value
        self.on_attempt = on_attempt
        self.on_retry = on_retry

    def _weight_for(self, stage: str, weight: EndpointWeight | None) -> EndpointWeight:
        return float(weight if weight is not None else self.endpoint_weights.get(stage, 1.0))

    @staticmethod
    def _retryable_status(response: Any) -> bool:
        status_code = getattr(response, "status_code", None)
        return status_code == 429 or (isinstance(status_code, int) and status_code >= 500)

    @staticmethod
    def _retryable_error(error: BaseException) -> bool:
        if isinstance(error, requests.HTTPError):
            return HyperliquidApiClient._retryable_status(getattr(error, "response", None))
        return isinstance(error, (requests.ConnectionError, requests.Timeout, json.JSONDecodeError, ValueError))

    @staticmethod
    def _user_fills_response_extra_weight(payload: dict[str, Any] | None, response: Any) -> EndpointWeight:
        """Official ``userFillsByTime`` variable charge: one extra weight/20 fills."""

        if payload is None or payload.get("type") != "userFillsByTime" or not isinstance(response, list):
            return 0.0
        return float(math.ceil(len(response) / USER_FILLS_RETURNED_PER_ADDITIONAL_WEIGHT))

    def _request_json(
        self,
        *,
        method: str,
        endpoint: str,
        stage: str,
        weight: EndpointWeight | None,
        payload: dict[str, Any] | None,
        hooks: tuple[RetryHook | None, RetryHook | None] | None = None,
    ) -> Any:
        attempt_hook, retry_hook = hooks or (self.on_attempt, self.on_retry)
        last_error: BaseException | None = None
        attempts = self.retry_policy.max_retries + 1
        for attempt in range(1, attempts + 1):
            self.budgets.consume(stage)
            request_weight = self._weight_for(stage, weight)
            self.limiter.acquire(request_weight)
            context = {
                "attempt": attempt,
                "attempts_allowed": attempts,
                "endpoint": endpoint,
                "stage": stage,
                "weight": request_weight,
                "payload": payload,
            }
            if attempt_hook:
                attempt_hook(dict(context))
            try:
                if method == "GET":
                    response = self.session.get(endpoint, timeout=self.timeout_seconds)
                else:
                    response = self.session.post(endpoint, json=payload, timeout=self.timeout_seconds)
                if self._retryable_status(response):
                    raise requests.HTTPError(f"retryable HTTP {getattr(response, 'status_code', '?')}", response=response)
                response.raise_for_status()
                response_payload = response.json()
                extra_weight = self._user_fills_response_extra_weight(payload, response_payload)
                if extra_weight:
                    # The API determines this charge only after returning the
                    # page.  Charge the same global bucket before another stage
                    # can burst past the advertised 1200-weight/minute limit.
                    self.limiter.acquire(extra_weight)
                return response_payload
            except (requests.RequestException, ValueError, json.JSONDecodeError) as exc:
                last_error = exc
                if not self._retryable_error(exc):
                    raise
                if attempt >= attempts:
                    break
                delay = self.retry_policy.delay_for_retry(attempt, self._random_value())
                retry_context = {**context, "error": str(exc), "delay_seconds": delay}
                if retry_hook:
                    retry_hook(retry_context)
                self._sleeper(delay)
        raise RetryExhausted(endpoint, attempts, last_error) from last_error

    def get_leaderboard(self, *, stage: str = "leaderboard", on_attempt: RetryHook | None = None, on_retry: RetryHook | None = None) -> Any:
        return self._request_json(
            method="GET",
            endpoint=LEADERBOARD_URL,
            stage=stage,
            weight=None,
            payload=None,
            hooks=(on_attempt or self.on_attempt, on_retry or self.on_retry),
        )

    def post_info(
        self,
        payload: dict[str, Any],
        *,
        stage: str,
        weight: EndpointWeight | None = None,
        on_attempt: RetryHook | None = None,
        on_retry: RetryHook | None = None,
    ) -> Any:
        return self._request_json(
            method="POST",
            endpoint=INFO_URL,
            stage=stage,
            weight=weight,
            payload=payload,
            hooks=(on_attempt or self.on_attempt, on_retry or self.on_retry),
        )

    def fetch_portfolio(self, wallet: str) -> Any:
        return self.post_info({"type": "portfolio", "user": wallet}, stage="portfolio")

    def fetch_non_funding_ledger_updates(self, wallet: str, start_time_ms: int, end_time_ms: int) -> Any:
        return self.post_info(
            {"type": "userNonFundingLedgerUpdates", "user": wallet, "startTime": start_time_ms, "endTime": end_time_ms},
            stage="ledger",
        )

    def fetch_fills_by_time(self, wallet: str, start_time_ms: int, end_time_ms: int, *, aggregate_by_time: bool = False) -> Any:
        return self.post_info(
            {
                "type": "userFillsByTime",
                "user": wallet,
                "startTime": start_time_ms,
                "endTime": end_time_ms,
                "aggregateByTime": aggregate_by_time,
            },
            stage="fills",
        )

    def fetch_user_funding(self, wallet: str, start_time_ms: int, end_time_ms: int) -> Any:
        return self.post_info(
            {"type": "userFunding", "user": wallet, "startTime": start_time_ms, "endTime": end_time_ms},
            stage="funding",
        )
