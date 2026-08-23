"""Five-stage, resumable Hyperliquid perp TWR screening orchestration."""

from __future__ import annotations

import hashlib
import json
import time
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from .api import HyperliquidApiClient, RetryPolicy, StageRequestBudget, WeightedTokenBucket
from .cache import (
    CheckpointStore,
    RawResponseCache,
    ResumeIdentity,
    atomic_write_json,
    make_raw_cache_key,
    read_json,
)
from .candidate import CandidateVerificationStateMachine, validate_candidates_until_finalists
from .discovery import (
    DiscoveryConfig,
    DiscoveryCycleState,
    DiscoveryPoolEntry,
    build_discovery_pool,
    claim_next_refresh_shard,
    detect_outside_pool_threshold_breach,
    load_leaderboard_universe,
    outside_pool_eligible_wallets,
    record_outside_pool_sample,
)
from .episodes import FILL_AVAILABILITY_LIMIT, reconstruct_completed_episodes
from .evidence_registry import EvidenceRegistry
from .ledger import LedgerCoverageTracker, classify_non_funding_ledger, count_ledger_delta_types, dedupe_ledger_events
from .portfolio import normalize_perp_month
from .report import (
    METRIC_NAME,
    METRIC_VERSION,
    build_canonical_state,
    build_run_report,
    report_sha256,
    to_jsonable,
    write_canonical_state_if_complete,
    write_json_atomic,
    write_report_bundle,
    write_text_atomic,
)
from .rescue import build_rescue_markdown, build_rescue_report
from .twr import calculate_provisional_perp_twr, calculate_verified_perp_twr


DAY_MS = 86_400_000
LEDGER_PAGE_CAP = 500
FILL_PAGE_CAP = 2_000
WINDOW_EDGE_REQUEST_SKEW_MS = 10_000


@dataclass(frozen=True)
class ScreenConfig:
    days: int = 30
    coverage_mode: str = "FAST_INCREMENTAL"
    minimum_account_value_usd: Decimal = Decimal("10000")
    leaderboard_roi_top_n: int = 3000
    leaderboard_pnl_top_n: int = 2000
    leaderboard_turnover_top_n: int = 2000
    prior_verified_top_n: int = 2000
    new_wallet_top_n: int = 500
    rotating_sample_n: int = 500
    outside_shard_size: int = 1000
    discovery_pool_target: int = 6000
    discovery_pool_min: int = 5000
    discovery_pool_max: int = 7000
    ledger_verification_initial_n: int = 2500
    ledger_verification_expand_step: int = 500
    boundary_probe_n: int = 100
    candidate_count: int = 2000
    final_active_count: int = 10
    minimum_observed_raw_fills: int = 1
    # Legacy compatibility only.  Episode counts remain in diagnostics but
    # never influence candidate selection or publication.
    minimum_completed_episodes: int | None = None
    fill_validation_mode: str = "UNTIL_10"
    strict_cashflow_boundaries: bool = True
    portfolio_request_budget: int = 8000
    ledger_request_budget: int = 7000
    fill_request_budget: int = 4000
    timeout_seconds: float = 45.0
    retries: int = 3

    def __post_init__(self) -> None:
        if self.days <= 0:
            raise ValueError("days must be positive")
        if self.coverage_mode not in {"FAST_INCREMENTAL", "FULL_DISCOVERY_REFRESH"}:
            raise ValueError("coverage_mode must be FAST_INCREMENTAL or FULL_DISCOVERY_REFRESH")
        if self.fill_validation_mode not in {"UNTIL_10", "FULL_2000"}:
            raise ValueError("fill_validation_mode must be UNTIL_10 or FULL_2000")
        for value in (
            self.discovery_pool_target,
            self.discovery_pool_min,
            self.discovery_pool_max,
            self.ledger_verification_initial_n,
            self.ledger_verification_expand_step,
            self.boundary_probe_n,
            self.candidate_count,
            self.final_active_count,
            self.minimum_observed_raw_fills,
            self.outside_shard_size,
        ):
            if value <= 0:
                raise ValueError("screening counts must be positive")
        if not 1000 <= self.outside_shard_size <= 2000:
            raise ValueError("outside_shard_size must be between 1000 and 2000")

    def hash_payload(self) -> dict[str, Any]:
        payload = to_jsonable(asdict(self))
        # Treat historical episode thresholds as semantically inert so a
        # resume is not invalidated by an ignored compatibility setting.
        payload["minimum_completed_episodes"] = None
        return payload

    @property
    def config_hash(self) -> str:
        encoded = json.dumps(self.hash_payload(), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ScreenPaths:
    reports_root: Path = Path("reports")
    state_root: Path = Path("state")
    cache_root: Path = Path("state/perp-twr-cache")

    @property
    def discovery_reports(self) -> Path:
        return self.reports_root / "perp-twr-discovery"

    @property
    def candidate_reports(self) -> Path:
        return self.reports_root / "perp-twr-candidates"

    @property
    def canonical_state(self) -> Path:
        return self.state_root / "perp-twr-top10" / "latest_active_top10.json"

    @property
    def checkpoints(self) -> Path:
        return self.state_root / "perp-twr-runs"

    @property
    def discovery_state(self) -> Path:
        return self.state_root / "perp-twr-discovery"

    @property
    def rescue_reports(self) -> Path:
        return self.reports_root / "perp-twr-rescue"

    @property
    def evidence_registry(self) -> Path:
        return self.state_root / "account-evidence-registry"


def _json_hash(value: Any) -> str:
    encoded = json.dumps(to_jsonable(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _reason(value: Any) -> str:
    return getattr(value, "value", str(value))


def _twr_mdd(result: Any) -> Decimal | None:
    if not getattr(result, "intervals", None):
        return Decimal("0") if getattr(result, "twr", None) is not None else None
    peak = Decimal("1")
    mdd = Decimal("0")
    for interval in result.intervals:
        growth = interval.growth_index
        peak = max(peak, growth)
        if peak > 0:
            mdd = max(mdd, (peak - growth) / peak)
    return mdd


def _load_wallets(path: Path, limit: int | None = None) -> list[str]:
    payload = read_json(path)
    if not isinstance(payload, Mapping):
        return []
    rows = payload.get("candidates", payload.get("wallets", payload.get("finalists", [])))
    if not isinstance(rows, list):
        return []
    wallets: list[str] = []
    for row in rows:
        wallet = row if isinstance(row, str) else row.get("wallet", row.get("address")) if isinstance(row, Mapping) else None
        if isinstance(wallet, str) and wallet.lower() not in wallets:
            wallets.append(wallet.lower())
        if limit is not None and len(wallets) >= limit:
            break
    return wallets


def _resume_seed(paths: ScreenPaths, requested_run_id: str | None) -> tuple[str, int] | None:
    candidates = [paths.checkpoints / f"{requested_run_id}.checkpoint.json"] if requested_run_id else sorted(
        paths.checkpoints.glob("*.checkpoint.json"), key=lambda path: path.stat().st_mtime, reverse=True
    )
    for path in candidates:
        payload = read_json(path)
        if isinstance(payload, Mapping) and payload.get("run_id") and payload.get("as_of_ms"):
            return str(payload["run_id"]), int(payload["as_of_ms"])
    return None


class WhaleScreenPipeline:
    def __init__(
        self,
        config: ScreenConfig,
        paths: ScreenPaths = ScreenPaths(),
        *,
        api: HyperliquidApiClient | None = None,
        as_of_ms: int | None = None,
        run_id: str | None = None,
        resume: bool = False,
        progress: Callable[[str], None] = print,
    ) -> None:
        self.config = config
        self.paths = paths
        self.progress = progress
        self.resume = resume
        seed = _resume_seed(paths, run_id) if resume else None
        self.as_of_ms = int(seed[1] if seed else as_of_ms or (time.time_ns() // 1_000_000))
        self.run_id = seed[0] if seed else run_id or datetime.fromtimestamp(self.as_of_ms / 1000, timezone.utc).strftime("perp-twr-%Y%m%dT%H%M%SZ")
        self.window_start_ms = self.as_of_ms - config.days * DAY_MS
        self.window_end_ms = self.as_of_ms
        self.budgets = StageRequestBudget({
            "leaderboard": max(4, config.retries + 1),
            "portfolio": config.portfolio_request_budget,
            "ledger": config.ledger_request_budget,
            "fills": config.fill_request_budget,
        })
        self.api = api or HyperliquidApiClient(
            timeout_seconds=config.timeout_seconds,
            # A resumed/new process cannot know how much of Hyperliquid's
            # rolling global allowance another recent process consumed.  A
            # zero-token warm start prevents a local full-bucket burst from
            # creating deterministic 429 holes in canonical coverage.
            limiter=WeightedTokenBucket(capacity=1200, refill_per_second=20, initial_tokens=0),
            budgets=self.budgets,
            retry_policy=RetryPolicy(max_retries=config.retries),
        )
        if api is not None and hasattr(api, "budgets"):
            self.budgets = api.budgets
        self.cache = RawResponseCache(paths.cache_root)
        self.evidence_registry = EvidenceRegistry(paths.evidence_registry)
        self.raw_artifact_refs: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
        self.checkpoints = CheckpointStore(paths.checkpoints)
        self.errors: list[dict[str, Any]] = []
        self.delta_type_counts: Counter[str] = Counter()
        self.http_failures = 0
        self.discovery_cycle_state: DiscoveryCycleState | None = None
        self.discovery_cycle_id: str | None = None
        self.rotating_shard: tuple[str, ...] = ()
        self.previous_leaderboard_wallets: tuple[str, ...] = ()

    def _cache_key(self, wallet: str | None, endpoint: str):
        return make_raw_cache_key(
            wallet=wallet,
            endpoint=endpoint,
            window_start_ms=self.window_start_ms,
            window_end_ms=self.window_end_ms,
            as_of_ms=self.as_of_ms,
            metric_version=METRIC_VERSION,
            raw_payload_schema_version="1",
            coverage_mode=self.config.coverage_mode,
        )

    def _cached(self, wallet: str | None, endpoint: str, fetch: Callable[[], Any], *, metadata: Mapping[str, Any] | None = None) -> Any:
        key = self._cache_key(wallet, endpoint)
        cached = self.cache.get(key)
        if cached is None:
            value = fetch()
            self.cache.put(key, value, metadata=metadata)
        else:
            value = cached
        ref = self.evidence_registry.preserve_raw_artifact(
            endpoint=endpoint,
            run_id=self.run_id,
            captured_at_ms=self.as_of_ms,
            wallet=wallet,
            request_identity=key.to_dict(),
            coverage=metadata,
            payload=value,
        )
        self.raw_artifact_refs[wallet or "<RUN>"].append(ref.to_dict())
        return value

    def _error_row(self, wallet: str | None, stage: str, exc: BaseException) -> dict[str, Any]:
        self.http_failures += 1
        row = {
            "wallet": wallet,
            "stage": stage,
            "reason_code": getattr(exc, "reason_code", "HTTP_FAILURE"),
            "reason_message": str(exc),
        }
        self.errors.append(row)
        return row

    def _save_checkpoint(self, pool_hash: str, **stage_data: Any) -> None:
        payload = {
            **ResumeIdentity(self.run_id, self.as_of_ms, METRIC_VERSION, pool_hash, self.config.coverage_mode).to_dict(),
            "config_hash": self.config.config_hash,
            "window_start_ms": self.window_start_ms,
            "window_end_ms": self.window_end_ms,
            "request_budgets": self.budgets.snapshot(),
            "discovery_cycle_id": self.discovery_cycle_id,
            "rotating_shard": list(self.rotating_shard),
            "discovery_cycle_state": None if self.discovery_cycle_state is None else self.discovery_cycle_state.to_dict(),
            "previous_leaderboard_wallets": list(self.previous_leaderboard_wallets),
            **to_jsonable(stage_data),
        }
        self.checkpoints.save(payload)

    def _load_checkpoint(self, pool_hash: str) -> dict[str, Any] | None:
        if not self.resume:
            return None
        identity = ResumeIdentity(self.run_id, self.as_of_ms, METRIC_VERSION, pool_hash, self.config.coverage_mode)
        payload = self.checkpoints.load(self.run_id, expected=identity)
        if payload is not None and payload.get("config_hash") != self.config.config_hash:
            # Checkpoints predating a serialized config can still prove a
            # safe resume when only the three finite data-collection budgets
            # increased.  Rebuild the prior config from the persisted limits
            # and require its hash to match exactly; every scientific setting
            # remains part of that proof.
            request_budgets = payload.get("request_budgets")
            if not isinstance(request_budgets, Mapping):
                raise ValueError("resume config_hash mismatch")
            prior_limits: dict[str, int] = {}
            for stage, field_name in (
                ("portfolio", "portfolio_request_budget"),
                ("ledger", "ledger_request_budget"),
                ("fills", "fill_request_budget"),
            ):
                values = request_budgets.get(stage)
                limit = values.get("limit") if isinstance(values, Mapping) else None
                if isinstance(limit, bool) or not isinstance(limit, int) or limit < 0:
                    raise ValueError("resume config_hash mismatch")
                prior_limits[field_name] = limit
            prior_config = replace(self.config, **prior_limits)
            if (
                prior_config.config_hash != payload.get("config_hash")
                or self.config.portfolio_request_budget < prior_config.portfolio_request_budget
                or self.config.ledger_request_budget < prior_config.ledger_request_budget
                or self.config.fill_request_budget < prior_config.fill_request_budget
            ):
                raise ValueError("resume config_hash mismatch")
        if payload is not None:
            for stage, values in (payload.get("request_budgets") or {}).items():
                if isinstance(values, Mapping):
                    try:
                        self.budgets.used[str(stage)] = max(self.budgets.used.get(str(stage), 0), int(values.get("used", 0)))
                    except (TypeError, ValueError):
                        raise ValueError(f"resume request budget is invalid for {stage}")
        return payload

    def _portfolio_row(self, entry: Any) -> dict[str, Any]:
        base = entry.to_dict()
        wallet = entry.wallet
        try:
            raw = self._cached(wallet, "portfolio", lambda: self.api.fetch_portfolio(wallet))
            normalized = normalize_perp_month(
                raw, self.window_start_ms, self.window_end_ms,
                window_coverage_tolerance_ms=WINDOW_EDGE_REQUEST_SKEW_MS,
                require_window_coverage=False,
                allow_single_sided_boundary_tolerance=False,
            )
            score = calculate_provisional_perp_twr(normalized)
            result = {
                **base,
                **score.to_dict(),
                "portfolio_coverage_evaluated": True,
                "provisional_perp_twr_30d": None if score.twr is None else str(score.twr),
            }
            result["twr_curve_mdd"] = None if _twr_mdd(score) is None else str(_twr_mdd(score))
            self.cache.put(
                self._cache_key(wallet, "portfolio-normalized-provisional"),
                {"normalization": to_jsonable(normalized), "score": score.to_dict()},
            )
            return result
        except Exception as exc:
            return {
                **base,
                **self._error_row(wallet, "portfolio", exc),
                "portfolio_coverage_evaluated": False,
                "quality": "UNVERIFIABLE",
                "provisional_perp_twr_30d": None,
            }

    @staticmethod
    def _page_list(value: Any, stage: str) -> list[dict[str, Any]]:
        if not isinstance(value, list) or any(not isinstance(item, Mapping) for item in value):
            raise ValueError(f"{stage} response was not a list of objects")
        return [dict(item) for item in value]

    def _ledger(self, wallet: str) -> tuple[list[dict[str, Any]], Any]:
        cursor = self.window_start_ms
        tracker = LedgerCoverageTracker(self.window_start_ms, self.window_end_ms, response_cap=LEDGER_PAGE_CAP)
        events: list[dict[str, Any]] = []
        for page_number in range(40):
            endpoint = f"ledger-page-{cursor}"
            page = self._page_list(self._cached(
                wallet, endpoint,
                lambda cursor=cursor: self.api.fetch_non_funding_ledger_updates(wallet, cursor, self.window_end_ms),
            ), "ledger")
            observation = tracker.observe_page(cursor, page, response_capped=len(page) >= LEDGER_PAGE_CAP)
            events.extend(page)
            if len(page) < LEDGER_PAGE_CAP:
                break
            if observation.max_event_time_ms is None or observation.max_event_time_ms <= cursor:
                tracker.mark_failed("ledger pagination stalled at an inclusive timestamp")
                break
            cursor = observation.max_event_time_ms
        else:
            tracker.mark_failed("ledger pagination exceeded 40 pages")
        return list(dedupe_ledger_events(events)), tracker.finish()

    def _verified_row(self, provisional: Mapping[str, Any]) -> dict[str, Any]:
        wallet = str(provisional["wallet"])
        try:
            portfolio_raw = self._cached(wallet, "portfolio", lambda: self.api.fetch_portfolio(wallet))
            normalized = normalize_perp_month(
                portfolio_raw, self.window_start_ms, self.window_end_ms,
                window_coverage_tolerance_ms=WINDOW_EDGE_REQUEST_SKEW_MS,
                require_window_coverage=False,
                allow_single_sided_boundary_tolerance=False,
            )
            raw_events, coverage = self._ledger(wallet)
            self.delta_type_counts.update(count_ledger_delta_types(raw_events))
            classified = classify_non_funding_ledger(raw_events, wallet)
            result = calculate_verified_perp_twr(
                normalized,
                classified,
                ledger_coverage=coverage,
                strict=self.config.strict_cashflow_boundaries,
            )
            row = {**dict(provisional), **result.to_dict()}
            row["twr_curve_mdd"] = None if _twr_mdd(result) is None else str(_twr_mdd(result))
            row["ledger_raw_event_count"] = coverage.raw_event_count
            row["ledger_unique_event_count"] = coverage.unique_event_count
            row["ledger_coverage_complete"] = coverage.complete
            self.cache.put(
                self._cache_key(wallet, "ledger-normalized-verified"),
                {
                    "raw_events": raw_events,
                    "classified_cashflows": [event.to_dict() for event in classified],
                    "coverage": to_jsonable(coverage),
                    "score": result.to_dict(),
                },
            )
            return row
        except Exception as exc:
            return {
                **dict(provisional),
                **self._error_row(wallet, "ledger", exc),
                "quality": "UNVERIFIABLE",
                METRIC_NAME: None,
            }

    @staticmethod
    def _fill_identity(fill: Mapping[str, Any]) -> str:
        fields = ("time", "tid", "oid", "coin", "side", "sz", "px", "startPosition", "hash")
        return _json_hash([fill.get(field) for field in fields])

    def _fills(self, wallet: str) -> tuple[list[dict[str, Any]], bool, bool, str | None]:
        cursor = self.window_start_ms
        fills: list[dict[str, Any]] = []
        seen: set[str] = set()
        for page_number in range(30):
            endpoint = f"raw-fills-page-{cursor}"
            page = self._page_list(self._cached(
                wallet, endpoint,
                lambda cursor=cursor: self.api.fetch_fills_by_time(wallet, cursor, self.window_end_ms, aggregate_by_time=False),
            ), "fills")
            try:
                page.sort(key=lambda fill: int(fill["time"]))
            except (KeyError, TypeError, ValueError):
                return fills, False, False, "fill page had an invalid timestamp"
            added = 0
            for fill in page:
                identity = self._fill_identity(fill)
                if identity not in seen:
                    seen.add(identity)
                    fills.append(fill)
                    added += 1
            if len(fills) >= FILL_AVAILABILITY_LIMIT:
                return fills, False, True, "10,000-fill availability limit reached"
            if len(page) < FILL_PAGE_CAP:
                fills.sort(key=lambda fill: int(fill["time"]))
                return fills, True, False, None
            last_time = max(int(fill["time"]) for fill in page)
            if last_time < cursor or (last_time == cursor and added == 0):
                return fills, False, False, "fill pagination stalled at an inclusive timestamp"
            cursor = last_time
        return fills, False, False, "fill pagination exceeded 30 pages"

    def _validate_fills(self, candidate: Mapping[str, Any]) -> Any:
        wallet = str(candidate["wallet"])
        try:
            fills, complete, limit, message = self._fills(wallet)
            episode_payload: dict[str, Any]
            try:
                result = reconstruct_completed_episodes(
                    fills,
                    self.window_start_ms,
                    self.window_end_ms,
                    aggregate_by_time=False,
                    coverage_complete=complete,
                    availability_limit_reached=limit,
                )
                episode_payload = asdict(result)
            except Exception as exc:
                # Episode reconstruction is useful diagnostics, but a
                # reconstruction failure cannot override complete observed
                # raw-fill evidence.
                episode_payload = {
                    "completed_episodes": None,
                    "episode_diagnostic_valid": False,
                    "episode_diagnostic_reason_code": getattr(exc, "reason_code", "EPISODE_RECONSTRUCTION_ERROR"),
                    "episode_diagnostic_reason_message": str(exc),
                }
            raw_fill_count = len(fills)
            raw_fill_coverage_complete = complete and not limit
            raw_fill_activity_observed = raw_fill_count >= self.config.minimum_observed_raw_fills
            # Positive raw evidence is monotonic: a real unaggregated fill is
            # enough to prove activity even when later pages are truncated.
            # Coverage only governs whether zero/exact-count conclusions are
            # safe, never whether an already observed fill qualifies.
            raw_validation_valid = raw_fill_activity_observed or raw_fill_coverage_complete
            if raw_fill_activity_observed:
                raw_reason_code = None
                raw_reason_message = None
            elif not raw_fill_coverage_complete:
                raw_reason_code = "FILL_PAGINATION_INCOMPLETE"
                raw_reason_message = message or "raw-fill coverage is incomplete"
            else:
                raw_reason_code = "NO_OBSERVED_RAW_FILLS"
                raw_reason_message = f"fewer than {self.config.minimum_observed_raw_fills} observed raw fills"
            episode_valid = episode_payload.get("episode_diagnostic_valid", episode_payload.get("valid"))
            episode_reason_code = episode_payload.get("episode_diagnostic_reason_code", episode_payload.get("reason_code"))
            episode_reason_message = episode_payload.get("episode_diagnostic_reason_message", episode_payload.get("reason_message"))
            outcome = {
                **episode_payload,
                "valid": raw_validation_valid,
                "raw_fill_count": raw_fill_count,
                "observed_raw_fill_count": raw_fill_count,
                "raw_fill_count_is_lower_bound": not raw_fill_coverage_complete,
                "raw_fill_coverage_complete": raw_fill_coverage_complete,
                "raw_fill_aggregate_by_time": False,
                "raw_fill_activity_observed": raw_fill_activity_observed,
                "episode_diagnostic_valid": episode_valid,
                "episode_diagnostic_reason_code": episode_reason_code,
                "episode_diagnostic_reason_message": episode_reason_message,
                "reason_code": raw_reason_code,
                "reason_message": raw_reason_message,
            }
            self.cache.put(
                self._cache_key(wallet, "fills-normalized-episodes"),
                {
                    "raw_fills": fills,
                    "result": to_jsonable(episode_payload),
                    "raw_validation": to_jsonable(outcome),
                    "coverage_complete": complete,
                    "availability_limit_reached": limit,
                },
            )
            return outcome
        except Exception as exc:
            self._error_row(wallet, "fills", exc)
            return {
                "valid": False,
                "completed_episodes": None,
                "raw_fill_count": None,
                "observed_raw_fill_count": None,
                "raw_fill_count_is_lower_bound": None,
                "raw_fill_coverage_complete": False,
                "raw_fill_aggregate_by_time": False,
                "raw_fill_activity_observed": False,
                "reason_code": getattr(exc, "reason_code", "FILL_VALIDATION_ERROR"),
                "reason_message": str(exc),
            }

    def run(self) -> dict[str, Any]:
        self.progress(f"[{self.run_id}] fixed as_of={self.as_of_ms} window={self.window_start_ms}..{self.window_end_ms}")
        leaderboard = self._cached(None, "leaderboard", self.api.get_leaderboard)
        universe = load_leaderboard_universe(leaderboard, minimum_account_value_usd=self.config.minimum_account_value_usd)
        prior = _load_wallets(self.paths.candidate_reports / "latest-top2000.json", self.config.prior_verified_top_n)
        previous = read_json(self.paths.discovery_state / "prior-leaderboard-addresses.json")
        live_previous_wallets = previous.get("wallets", []) if isinstance(previous, Mapping) else []
        resume_preview = read_json(self.paths.checkpoints / f"{self.run_id}.checkpoint.json") if self.resume else None
        checkpoint_previous_wallets = (
            resume_preview.get("previous_leaderboard_wallets")
            if isinstance(resume_preview, Mapping)
            else None
        )
        previous_wallets = (
            checkpoint_previous_wallets
            if isinstance(checkpoint_previous_wallets, list)
            else live_previous_wallets
        )
        self.previous_leaderboard_wallets = tuple(str(wallet) for wallet in previous_wallets if isinstance(wallet, str))
        discovery_config = DiscoveryConfig(
            minimum_account_value_usd=self.config.minimum_account_value_usd,
            leaderboard_roi_top_n=self.config.leaderboard_roi_top_n,
            leaderboard_pnl_top_n=self.config.leaderboard_pnl_top_n,
            leaderboard_turnover_top_n=self.config.leaderboard_turnover_top_n,
            prior_verified_top_n=self.config.prior_verified_top_n,
            new_wallet_top_n=self.config.new_wallet_top_n,
            rotating_sample_n=self.config.rotating_sample_n,
            discovery_pool_target=(universe.eligible_count if self.config.coverage_mode == "FULL_DISCOVERY_REFRESH" else self.config.discovery_pool_target),
            discovery_pool_min=(universe.eligible_count if self.config.coverage_mode == "FULL_DISCOVERY_REFRESH" else self.config.discovery_pool_min),
            discovery_pool_max=(universe.eligible_count if self.config.coverage_mode == "FULL_DISCOVERY_REFRESH" else self.config.discovery_pool_max),
        )
        if isinstance(resume_preview, Mapping) and isinstance(resume_preview.get("discovery_cycle_state"), Mapping):
            cycle = DiscoveryCycleState.from_dict(resume_preview["discovery_cycle_state"])
            rotating_shard = tuple(str(wallet) for wallet in resume_preview.get("rotating_shard", []))
            discovery_cycle_id = str(resume_preview.get("discovery_cycle_id", cycle.discovery_cycle_id))
        else:
            cycle_payload = read_json(self.paths.discovery_state / "cycle-state.json")
            cycle = DiscoveryCycleState.from_dict(cycle_payload)
            shard_universe = outside_pool_eligible_wallets(
                universe,
                config=discovery_config,
                prior_verified_wallets=prior,
                previous_leaderboard_addresses=self.previous_leaderboard_wallets,
            )
            cycle, rotating_shard = claim_next_refresh_shard(
                cycle, shard_universe, shard_size=self.config.outside_shard_size, scored_at_ms=None
            )
            discovery_cycle_id = cycle.discovery_cycle_id
        self.discovery_cycle_state = cycle
        self.discovery_cycle_id = discovery_cycle_id
        self.rotating_shard = rotating_shard
        pool = build_discovery_pool(
            universe,
            config=discovery_config,
            prior_verified_wallets=prior,
            previous_leaderboard_addresses=previous_wallets,
            discovery_cycle_id=discovery_cycle_id,
            rotating_wallets=rotating_shard,
        )
        if not pool.complete:
            raise RuntimeError(f"discovery pool incomplete: {pool.reason_codes}")

        checkpoint = self._load_checkpoint(pool.pool_hash)
        provisional_by_wallet = {
            str(row["wallet"]).lower(): dict(row)
            for row in (checkpoint or {}).get("provisional_rows", [])
            if isinstance(row, Mapping) and row.get("wallet")
        }
        for index, entry in enumerate(pool.entries, 1):
            if (
                entry.wallet not in provisional_by_wallet
                or provisional_by_wallet[entry.wallet].get("portfolio_coverage_evaluated") is not True
            ):
                provisional_by_wallet[entry.wallet] = self._portfolio_row(entry)
            if index % 100 == 0 or index == len(pool.entries):
                scored = sum(1 for row in provisional_by_wallet.values() if row.get("provisional_perp_twr_30d") is not None)
                self.progress(f"[{self.run_id}] portfolio {index}/{len(pool.entries)}; provisional={scored}")
                self._save_checkpoint(pool.pool_hash, stage="PORTFOLIO", provisional_rows=list(provisional_by_wallet.values()))
        # A long public-data scan can outlive a transient endpoint incident.
        # Recover only audited transport/normalization holes, with a fixed
        # number of sweeps; every retry remains charged to the stage budget.
        entry_by_wallet = {entry.wallet: entry for entry in pool.entries}
        for recovery_round in range(1, 4):
            failed_wallets = [
                wallet for wallet, row in provisional_by_wallet.items()
                if row.get("portfolio_coverage_evaluated") is not True
            ]
            if not failed_wallets:
                break
            self.progress(
                f"[{self.run_id}] portfolio recovery {recovery_round}/3; missing={len(failed_wallets)}"
            )
            for wallet in failed_wallets:
                provisional_by_wallet[wallet] = self._portfolio_row(entry_by_wallet[wallet])
            self._save_checkpoint(
                pool.pool_hash,
                stage="PORTFOLIO_RECOVERY",
                provisional_rows=list(provisional_by_wallet.values()),
            )
        provisional_rows = [row for row in provisional_by_wallet.values() if row.get("provisional_perp_twr_30d") is not None]
        # A wallet with insufficient window samples is a valid evaluated
        # exclusion, not a transport-coverage hole.  Canonical publication is
        # blocked only when any discovery-pool portfolio request/normalization
        # could not be completed and audited at all.
        provisional_coverage_complete = all(
            row.get("portfolio_coverage_evaluated") is True
            for row in provisional_by_wallet.values()
        ) and len(provisional_by_wallet) == len(pool.entries)

        machine = CandidateVerificationStateMachine(
            provisional_rows,
            candidate_count=self.config.candidate_count,
            initial_count=self.config.ledger_verification_initial_n,
            expand_step=self.config.ledger_verification_expand_step,
            boundary_probe_count=self.config.boundary_probe_n,
            run_seed=self.run_id,
            source_run_id=self.run_id,
            frozen_at=datetime.now(timezone.utc).isoformat(),
        )
        restored_verified = {
            str(row["wallet"]).lower(): dict(row)
            for row in (checkpoint or {}).get("verified_rows", [])
            if isinstance(row, Mapping) and row.get("wallet")
        }
        terminal = None
        while True:
            action = machine.next_action()
            if action.kind in {"COMPLETE", "BLOCKED"}:
                terminal = action
                break
            if action.kind == "WAITING":
                raise RuntimeError("candidate verifier entered WAITING without a caller batch")
            provisional_index = {str(row["wallet"]).lower(): row for row in machine.provisional_rows}
            batch = []
            for wallet in action.wallets:
                row = restored_verified.get(wallet.lower()) or self._verified_row(provisional_index[wallet.lower()])
                restored_verified[wallet.lower()] = row
                batch.append(row)
            machine.record_verifications(batch)
            self.progress(f"[{self.run_id}] ledger verified={machine.verification_count}; valid={machine.verified_count}; action={action.kind}")
            self._save_checkpoint(
                pool.pool_hash,
                stage="LEDGER",
                provisional_rows=list(provisional_by_wallet.values()),
                verified_rows=list(restored_verified.values()),
                boundary_breach_count=machine.boundary_breach_count,
            )

        freeze = machine.freeze()
        pool_wallets = set(pool.wallets)
        # Every member of the persistent 1k--2k outside shard receives a
        # provisional evaluation this cycle.  The first 500 are normally in
        # the discovery pool as ROTATING_SAMPLE; the rest are explicit probes.
        shard_probe_rows: list[dict[str, Any]] = []
        universe_by_wallet = universe.by_wallet()
        for wallet in rotating_shard:
            existing = provisional_by_wallet.get(wallet)
            if existing is not None:
                shard_probe_rows.append(existing)
                continue
            source = universe_by_wallet[wallet]
            probe_entry = DiscoveryPoolEntry(
                wallet=wallet,
                current_account_value_usd=source.current_account_value_usd,
                inclusion_reasons=("OUTSIDE_POOL_SHARD",),
                signal_ranks={},
                fusion_score=Decimal("0"),
            )
            shard_probe_rows.append(self._portfolio_row(probe_entry))
        outside_scores = {
            str(row["wallet"]): row.get("provisional_perp_twr_30d")
            for row in shard_probe_rows
            if row.get("provisional_perp_twr_30d") is not None
        }
        # The persistent outside shard is a coverage control, not merely a
        # source of high-score probes.  A transport/normalization hole must
        # therefore block canonical publication even when its score is absent
        # from the threshold comparison.  Pool rows already receive the
        # bounded recovery sweep above; explicit outside probes fail closed so
        # a fixed run cannot silently expand its request budget indefinitely.
        outside_shard_evaluated_count = sum(
            row.get("portfolio_coverage_evaluated") is True
            for row in shard_probe_rows
        )
        outside_shard_coverage_complete = (
            len(shard_probe_rows) == len(rotating_shard)
            and outside_shard_evaluated_count == len(rotating_shard)
        )
        candidate_cutoff = freeze.candidates[-1].get(METRIC_NAME) if freeze.candidate_pool_complete else None
        outside_breaches = detect_outside_pool_threshold_breach(outside_scores, candidate_cutoff)
        candidate_payload = {
            "run_id": self.run_id,
            "as_of_ms": self.as_of_ms,
            "metric_name": METRIC_NAME,
            "metric_version": METRIC_VERSION,
            "coverage_mode": self.config.coverage_mode,
            "candidate_pool_hash": freeze.candidate_pool_hash,
            "minimum_completed_episodes": None,
            "minimum_observed_raw_fills": self.config.minimum_observed_raw_fills,
            **freeze.as_dict(),
        }
        self.paths.candidate_reports.mkdir(parents=True, exist_ok=True)
        candidate_run_path = self.paths.candidate_reports / f"run-{self.run_id}-top2000.json"
        write_json_atomic(candidate_run_path, candidate_payload)

        finalists = validate_candidates_until_finalists(
            freeze.candidates,
            self._validate_fills,
            target_count=self.config.final_active_count,
            minimum_raw_fills=self.config.minimum_observed_raw_fills,
            fill_validation_mode=self.config.fill_validation_mode,
        ) if freeze.candidate_pool_complete else None
        successful_shard_wallets = {
            str(row["wallet"])
            for row in shard_probe_rows
            if row.get("portfolio_coverage_evaluated") is True
        }
        cycle.last_scored_at_by_wallet.update({wallet: self.as_of_ms for wallet in successful_shard_wallets})
        cycle = record_outside_pool_sample(
            cycle, rotating_shard, as_of_ms=self.as_of_ms, threshold_breach_wallets=outside_breaches
        )
        self.discovery_cycle_state = cycle
        atomic_write_json(self.paths.discovery_state / "prior-leaderboard-addresses.json", {
            "as_of_ms": self.as_of_ms,
            "wallets": [row.wallet for row in universe.wallets],
        })
        atomic_write_json(self.paths.discovery_state / "cycle-state.json", cycle.to_dict())

        complete = bool(
            terminal and terminal.kind == "COMPLETE" and freeze.candidate_pool_complete
            and finalists and finalists.complete and len(finalists.finalists) == self.config.final_active_count
            and provisional_coverage_complete and outside_shard_coverage_complete and not outside_breaches
        )
        if not provisional_coverage_complete:
            run_reason_code = "PROVISIONAL_COVERAGE_INCOMPLETE"
        elif not outside_shard_coverage_complete:
            run_reason_code = "OUTSIDE_SHARD_COVERAGE_INCOMPLETE"
        elif outside_breaches:
            run_reason_code = "OUTSIDE_POOL_THRESHOLD_BREACH"
        elif terminal and terminal.kind == "BLOCKED":
            run_reason_code = terminal.reason_code
        elif finalists and not finalists.complete:
            run_reason_code = finalists.reason_code
        elif not freeze.candidate_pool_complete:
            run_reason_code = freeze.reason_code
        else:
            run_reason_code = None
        ranking_scope = "FULL_UNIVERSE_PROVISIONAL_THEN_EXACT" if self.config.coverage_mode == "FULL_DISCOVERY_REFRESH" else "DISCOVERY_POOL_EXACT"
        metadata = {
            "run_id": self.run_id,
            "as_of_ms": self.as_of_ms,
            "window_start_ms": self.window_start_ms,
            "window_end_ms": self.window_end_ms,
            "coverage_mode": self.config.coverage_mode,
            "ranking_scope": ranking_scope,
            "coverage_complete": self.config.coverage_mode == "FULL_DISCOVERY_REFRESH" and provisional_coverage_complete and outside_shard_coverage_complete and len(pool.entries) == universe.eligible_count,
            "eligible_universe_count": universe.eligible_count,
            "discovery_pool_target": discovery_config.discovery_pool_target,
            "discovery_pool_min": discovery_config.discovery_pool_min,
            "discovery_pool_max": discovery_config.discovery_pool_max,
            "discovery_pool_actual": pool.actual_count,
            "discovery_signal_quotas": {
                "month_roi": self.config.leaderboard_roi_top_n,
                "month_pnl": self.config.leaderboard_pnl_top_n,
                "turnover": self.config.leaderboard_turnover_top_n,
                "prior_verified": self.config.prior_verified_top_n,
                "new_wallets": self.config.new_wallet_top_n,
                "rotating_sample": self.config.rotating_sample_n,
            },
            "discovery_signal_actual_counts": dict(pool.bucket_actual_counts),
            "provisional_scored_count": len(provisional_rows),
            "ledger_verification_initial_count": self.config.ledger_verification_initial_n,
            "ledger_verification_actual_count": machine.verification_count,
            "verified_scored_count": machine.verified_count,
            "boundary_probe_count": self.config.boundary_probe_n,
            "boundary_breach_count": machine.boundary_breach_count,
            "candidate_count_requested": self.config.candidate_count,
            "candidate_count_actual": freeze.candidate_count_actual,
            "candidate_pool_complete": freeze.candidate_pool_complete,
            "candidate_pool_hash": freeze.candidate_pool_hash,
            "minimum_completed_episodes": None,
            "minimum_observed_raw_fills": self.config.minimum_observed_raw_fills,
            "target_count": self.config.final_active_count,
            "fill_validation_mode": self.config.fill_validation_mode,
            "fills_scanned_candidate_count": finalists.fills_scanned_candidate_count if finalists else 0,
            "outside_pool_sample_count": len(shard_probe_rows),
            "outside_shard_expected_count": len(rotating_shard),
            "outside_shard_evaluated_count": outside_shard_evaluated_count,
            "outside_shard_coverage_complete": outside_shard_coverage_complete,
            "outside_pool_threshold_breach_count": len(outside_breaches),
            "outside_pool_threshold_breach_wallets": list(outside_breaches),
            "outside_pool_probe": shard_probe_rows,
            "provisional_coverage_complete": provisional_coverage_complete,
            "discovery_cycle_id": cycle.discovery_cycle_id,
            "config_hash": self.config.config_hash,
            "request_budgets": self.budgets.snapshot(),
            "ledger_delta_type_counts": dict(self.delta_type_counts),
            "http_failures": self.http_failures,
            "run_status": "COMPLETE" if complete else "PARTIAL",
            "canonical_state_updated": complete,
            "canonical_block_reasons": [],
            "reason_code": None if complete else run_reason_code or "CANONICAL_UPDATE_BLOCKED",
        }
        reported_wallets = dict(provisional_by_wallet)
        reported_wallets.update(restored_verified)
        report = build_run_report(
            metadata,
            reported_wallets.values(),
            candidate_rows=freeze.candidates,
            finalist_rows=finalists.finalists if finalists else (),
            errors=self.errors,
        )
        # The rescue builder still accepts a historical integer threshold.
        # Feed it zero solely as a no-op compatibility shim; published
        # screening artifacts retain the explicit ``None`` policy.
        rescue_source_report = dict(report)
        rescue_source_report["minimum_completed_episodes"] = 0
        rescue_report = build_rescue_report(
            rescue_source_report,
            cache=self.cache,
            registry=self.evidence_registry,
        )
        rescue_report["minimum_completed_episodes"] = None
        rescue_run_json = self.paths.rescue_reports / f"run-{self.run_id}.json"
        rescue_run_md = self.paths.rescue_reports / f"run-{self.run_id}.md"
        write_json_atomic(rescue_run_json, rescue_report)
        write_json_atomic(self.paths.rescue_reports / "latest.json", rescue_report)
        rescue_markdown = build_rescue_markdown(rescue_report)
        write_text_atomic(rescue_run_md, rescue_markdown)
        write_text_atomic(self.paths.rescue_reports / "latest.md", rescue_markdown)
        report["account_preservation_rescue"] = {
            "schema_version": rescue_report["schema_version"],
            "rescue_engine_version": rescue_report["rescue_engine_version"],
            "discovered_accounts": rescue_report["discovered_accounts"],
            "quality_counts": rescue_report["quality_counts"],
            "reason_counts": rescue_report["reason_counts"],
            "rescue_queue_count": rescue_report["rescue_queue_count"],
        }
        digest = report_sha256(report)
        canonical = build_canonical_state(
            report,
            finalists.finalists if finalists else (),
            config_hash=self.config.config_hash,
            report_digest=digest,
        )
        discovery_run_json = self.paths.discovery_reports / f"run-{self.run_id}.json"
        discovery_run_md = self.paths.discovery_reports / f"run-{self.run_id}.md"
        write_report_bundle(
            report,
            run_json_path=discovery_run_json,
            latest_json_path=self.paths.discovery_reports / "latest.json",
            run_markdown_path=discovery_run_md,
            latest_markdown_path=self.paths.discovery_reports / "latest.md",
        )
        saved_candidate = read_json(candidate_run_path)
        saved_candidate_hash = saved_candidate.get("candidate_pool_hash") if isinstance(saved_candidate, Mapping) else None
        canonical_result = write_canonical_state_if_complete(
            canonical,
            self.paths.canonical_state,
            report=report,
            runner_candidate_pool_hash=str(saved_candidate_hash) if saved_candidate_hash is not None else "MISSING",
        )
        if canonical_result.written:
            write_json_atomic(self.paths.candidate_reports / "latest-top2000.json", candidate_payload)
        if not canonical_result.written:
            report["run_status"] = "PARTIAL"
            report["canonical_state_updated"] = False
            report["canonical_block_reasons"] = list(canonical_result.block_reasons)
            write_report_bundle(
                report,
                run_json_path=discovery_run_json,
                latest_json_path=self.paths.discovery_reports / "latest.json",
                run_markdown_path=discovery_run_md,
                latest_markdown_path=self.paths.discovery_reports / "latest.md",
            )
        self._save_checkpoint(
            pool.pool_hash,
            stage="COMPLETE" if canonical_result.written else "PARTIAL",
            provisional_rows=list(provisional_by_wallet.values()),
            verified_rows=list(restored_verified.values()),
            candidate_pool_hash=freeze.candidate_pool_hash,
            finalists=list(finalists.finalists if finalists else ()),
            canonical_state_updated=canonical_result.written,
            canonical_block_reasons=list(canonical_result.block_reasons),
        )
        self.progress(
            f"[{self.run_id}] status={report['run_status']} pool={pool.actual_count} provisional={len(provisional_rows)} "
            f"verified={machine.verified_count} candidates={freeze.candidate_count_actual} finalists={len(finalists.finalists) if finalists else 0} "
            f"canonical={canonical_result.written}"
        )
        return report


__all__ = ["ScreenConfig", "ScreenPaths", "WhaleScreenPipeline"]
