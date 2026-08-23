"""Research-only, cache-first ``portfolio.perpMonth`` ranking.

This module deliberately does *not* participate in the canonical TWR runner.
It is a small, auditable alternative for exploratory paper-trading research:
only the native ``perpMonth`` histories are used, timestamps must match
exactly, and no ledger/cash-flow inference is performed.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

from .cache import atomic_write_json
from .models import decimal_value
from .portfolio import extract_perp_month
from .report import write_text_atomic


SIMPLE_PERP_MONTH_METRIC = "perp_month_simple_twr_30d"
SIMPLE_PERP_MONTH_VERSION = "1"
RANKING_METRIC = "perp_month_pnl_over_previous_equity_compounded_30d"
SELECTION_TYPE = "PORTFOLIO_PERP_MONTH_SIMPLE_TWR_RESEARCH"
DATA_QUALITY = "PORTFOLIO_ONLY_ESTIMATE"
ACTIVITY_EVIDENCE = "PERP_MONTH_VLM_POSITIVE"
MINIMUM_ACCOUNT_VALUE_USD = Decimal("10000")
ZERO = Decimal("0")
ONE = Decimal("1")

REASON_VALID = "VALID"
REASON_MISSING_RAW_PORTFOLIO = "MISSING_RAW_PORTFOLIO"
REASON_BACKFILL_FAILED = "BACKFILL_FAILED"
REASON_MISSING_PERP_MONTH = "MISSING_PERP_MONTH"
REASON_INVALID_HISTORY = "INVALID_HISTORY"
REASON_INVALID_VLM = "INVALID_VLM"
REASON_INSUFFICIENT_ALIGNED_SAMPLES = "INSUFFICIENT_ALIGNED_SAMPLES"
REASON_VLM_NOT_POSITIVE = "VLM_NOT_POSITIVE"
REASON_LATEST_ACCOUNT_VALUE_BELOW_MINIMUM = "LATEST_ACCOUNT_VALUE_BELOW_10000"
REASON_PNL_INTERVAL_CAPITAL_BELOW_MINIMUM = "PNL_INTERVAL_CAPITAL_BELOW_10000"
REASON_PNL_INTERVAL_NONPOSITIVE_CAPITAL = "PNL_INTERVAL_NONPOSITIVE_CAPITAL"
REASON_INTERVAL_RETURN_BELOW_MINUS_100 = "INTERVAL_RETURN_BELOW_MINUS_100"


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_json(value: Any) -> str:
    return _sha256_bytes(_canonical_json(value).encode("utf-8"))


def _decimal_text(value: Decimal | None) -> str | None:
    return None if value is None else str(value)


@dataclass(frozen=True)
class PreservedUniverse:
    """The exact saved account universe used by one research run."""

    wallets: tuple[str, ...]
    window_start_ms: int
    window_end_ms: int
    source_path: str
    source_file_sha256: str
    wallet_set_sha256: str
    source_run_id: str | None
    source_report_sha256: str | None

    @property
    def as_of_ms(self) -> int:
        """The source reports use the fixed window end as their as-of time."""

        return self.window_end_ms

    def to_provenance(self) -> dict[str, Any]:
        return {
            "source_path": self.source_path,
            "source_file_sha256": self.source_file_sha256,
            "source_run_id": self.source_run_id,
            "source_report_sha256": self.source_report_sha256,
            "preserved_account_count": len(self.wallets),
            "wallet_set_sha256": self.wallet_set_sha256,
            "window_start_ms": self.window_start_ms,
            "window_end_ms": self.window_end_ms,
        }


@dataclass(frozen=True)
class SimplePerpMonthScore:
    """One wallet's deterministic simple-perpMonth result."""

    wallet: str
    status: str
    reason_code: str
    reason_message: str | None
    twr: Decimal | None = None
    latest_account_value: Decimal | None = None
    volume: Decimal | None = None
    aligned_sample_count: int = 0
    account_observation_count: int = 0
    pnl_observation_count: int = 0
    pnl_changing_interval_count: int = 0
    minimum_pnl_changing_previous_equity: Decimal | None = None
    implied_flow_nonzero_interval_count: int = 0
    implied_flow_max_abs_usd: Decimal | None = None
    implied_flow_max_relative_to_previous_equity: Decimal | None = None

    @property
    def eligible(self) -> bool:
        return self.status == "ELIGIBLE"

    def to_dict(self) -> dict[str, Any]:
        return {
            "wallet": self.wallet,
            "selection_type": SELECTION_TYPE,
            "ranking_metric": RANKING_METRIC,
            "data_quality": DATA_QUALITY,
            "activity_evidence": ACTIVITY_EVIDENCE,
            "exact_trade_count_30d": None,
            "cashflow_neutral_verified": False,
            "status": self.status,
            "reason_code": self.reason_code,
            "reason_message": self.reason_message,
            SIMPLE_PERP_MONTH_METRIC: _decimal_text(self.twr),
            "latest_account_value_usd": _decimal_text(self.latest_account_value),
            "perp_month_vlm": _decimal_text(self.volume),
            "aligned_sample_count": self.aligned_sample_count,
            "account_observation_count": self.account_observation_count,
            "pnl_observation_count": self.pnl_observation_count,
            "pnl_changing_interval_count": self.pnl_changing_interval_count,
            "minimum_pnl_changing_previous_equity_usd": _decimal_text(self.minimum_pnl_changing_previous_equity),
            "implied_flow_nonzero_interval_count": self.implied_flow_nonzero_interval_count,
            "implied_flow_max_abs_usd": _decimal_text(self.implied_flow_max_abs_usd),
            "implied_flow_max_relative_to_previous_equity": _decimal_text(
                self.implied_flow_max_relative_to_previous_equity
            ),
        }


def _failure(
    wallet: str,
    reason_code: str,
    message: str,
    *,
    volume: Decimal | None = None,
    latest_account_value: Decimal | None = None,
    aligned_sample_count: int = 0,
    account_observation_count: int = 0,
    pnl_observation_count: int = 0,
    pnl_changing_interval_count: int = 0,
    minimum_pnl_changing_previous_equity: Decimal | None = None,
    implied_flow_nonzero_interval_count: int = 0,
    implied_flow_max_abs_usd: Decimal | None = None,
    implied_flow_max_relative_to_previous_equity: Decimal | None = None,
) -> SimplePerpMonthScore:
    return SimplePerpMonthScore(
        wallet=wallet,
        status="EXCLUDED",
        reason_code=reason_code,
        reason_message=message,
        volume=volume,
        latest_account_value=latest_account_value,
        aligned_sample_count=aligned_sample_count,
        account_observation_count=account_observation_count,
        pnl_observation_count=pnl_observation_count,
        pnl_changing_interval_count=pnl_changing_interval_count,
        minimum_pnl_changing_previous_equity=minimum_pnl_changing_previous_equity,
        implied_flow_nonzero_interval_count=implied_flow_nonzero_interval_count,
        implied_flow_max_abs_usd=implied_flow_max_abs_usd,
        implied_flow_max_relative_to_previous_equity=implied_flow_max_relative_to_previous_equity,
    )


def _parse_history(history: Any, *, label: str) -> dict[int, Decimal]:
    """Return a timestamp map, refusing conflicting duplicate observations."""

    if not isinstance(history, Sequence) or isinstance(history, (str, bytes, bytearray)):
        raise ValueError(f"{label} must be a list")
    parsed: dict[int, Decimal] = {}
    for item in history:
        if isinstance(item, Mapping):
            raw_time = item.get("time", item.get("timeMs", item.get("timestamp")))
            raw_value = item.get("value", item.get("accountValue", item.get("pnl")))
        elif isinstance(item, Sequence) and not isinstance(item, (str, bytes, bytearray)) and len(item) >= 2:
            raw_time, raw_value = item[0], item[1]
        else:
            raise ValueError(f"{label} observation must contain a timestamp and value")
        if isinstance(raw_time, bool):
            raise ValueError(f"{label} observation timestamp is invalid")
        try:
            time_ms = int(raw_time)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{label} observation timestamp is invalid") from exc
        if time_ms < 0:
            raise ValueError(f"{label} observation timestamp cannot be negative")
        value = decimal_value(raw_value, field_name=f"{label} observation value")
        existing = parsed.get(time_ms)
        if existing is not None and existing != value:
            raise ValueError(f"{label} has conflicting duplicate timestamp {time_ms}")
        parsed[time_ms] = value
    return parsed


def exact_perp_month_samples(payload: Any) -> tuple[tuple[int, Decimal, Decimal], ...]:
    """Extract strictly exact ``(timestamp, account_value, pnl)`` observations.

    This intentionally does not call the canonical normalizer because its
    tolerated near-timestamp matching and fixed-window boundary handling are
    inappropriate for this simple research method.
    """

    period = extract_perp_month(payload)
    if period is None:
        raise KeyError(REASON_MISSING_PERP_MONTH)
    accounts = _parse_history(period.get("accountValueHistory"), label="accountValueHistory")
    pnls = _parse_history(period.get("pnlHistory"), label="pnlHistory")
    return tuple((time_ms, accounts[time_ms], pnls[time_ms]) for time_ms in sorted(accounts.keys() & pnls.keys()))


def _interval_diagnostics(
    samples: Sequence[tuple[int, Decimal, Decimal]],
) -> tuple[Decimal | None, int, int, Decimal | None, Decimal | None]:
    """Report unadjusted account/PnL residuals without using them for scoring."""

    minimum_previous_equity: Decimal | None = None
    pnl_changing_interval_count = 0
    implied_flow_nonzero_count = 0
    maximum_abs_flow: Decimal | None = None
    maximum_relative_flow: Decimal | None = None
    for previous, current in zip(samples, samples[1:]):
        previous_equity = previous[1]
        delta_pnl = current[2] - previous[2]
        if delta_pnl != ZERO:
            pnl_changing_interval_count += 1
            if minimum_previous_equity is None or previous_equity < minimum_previous_equity:
                minimum_previous_equity = previous_equity
        implied_flow = current[1] - previous_equity - delta_pnl
        absolute_flow = abs(implied_flow)
        if implied_flow != ZERO:
            implied_flow_nonzero_count += 1
        if maximum_abs_flow is None or absolute_flow > maximum_abs_flow:
            maximum_abs_flow = absolute_flow
        if previous_equity != ZERO:
            relative_flow = absolute_flow / abs(previous_equity)
            if maximum_relative_flow is None or relative_flow > maximum_relative_flow:
                maximum_relative_flow = relative_flow
    return (
        minimum_previous_equity,
        pnl_changing_interval_count,
        implied_flow_nonzero_count,
        maximum_abs_flow,
        maximum_relative_flow,
    )


def score_simple_perp_month(wallet: str, payload: Any | None) -> SimplePerpMonthScore:
    """Score one raw portfolio response using the requested simplified rules."""

    normalized_wallet = str(wallet).strip().lower()
    if payload is None:
        return _failure(normalized_wallet, REASON_MISSING_RAW_PORTFOLIO, "no matching raw portfolio cache record")
    period = extract_perp_month(payload)
    if period is None:
        return _failure(normalized_wallet, REASON_MISSING_PERP_MONTH, "portfolio response has no perpMonth block")
    try:
        volume = decimal_value(period.get("vlm"), field_name="perpMonth.vlm")
    except ValueError as exc:
        return _failure(normalized_wallet, REASON_INVALID_VLM, str(exc))
    try:
        samples = exact_perp_month_samples(payload)
        accounts = _parse_history(period.get("accountValueHistory"), label="accountValueHistory")
        pnls = _parse_history(period.get("pnlHistory"), label="pnlHistory")
    except (KeyError, ValueError) as exc:
        return _failure(normalized_wallet, REASON_INVALID_HISTORY, str(exc), volume=volume)
    account_count = len(accounts)
    pnl_count = len(pnls)
    if len(samples) < 2:
        return _failure(
            normalized_wallet,
            REASON_INSUFFICIENT_ALIGNED_SAMPLES,
            "at least two exact timestamp-aligned perpMonth samples are required",
            volume=volume,
            aligned_sample_count=len(samples),
            account_observation_count=account_count,
            pnl_observation_count=pnl_count,
        )
    (
        minimum_previous_equity,
        pnl_changing_interval_count,
        implied_flow_nonzero_count,
        implied_flow_max_abs_usd,
        implied_flow_max_relative,
    ) = _interval_diagnostics(samples)
    diagnostic_fields = {
        "pnl_changing_interval_count": pnl_changing_interval_count,
        "minimum_pnl_changing_previous_equity": minimum_previous_equity,
        "implied_flow_nonzero_interval_count": implied_flow_nonzero_count,
        "implied_flow_max_abs_usd": implied_flow_max_abs_usd,
        "implied_flow_max_relative_to_previous_equity": implied_flow_max_relative,
    }
    latest_value = samples[-1][1]
    if volume <= ZERO:
        return _failure(
            normalized_wallet,
            REASON_VLM_NOT_POSITIVE,
            "perpMonth.vlm must be greater than zero",
            volume=volume,
            latest_account_value=latest_value,
            aligned_sample_count=len(samples),
            account_observation_count=account_count,
            pnl_observation_count=pnl_count,
            **diagnostic_fields,
        )
    if latest_value < MINIMUM_ACCOUNT_VALUE_USD:
        return _failure(
            normalized_wallet,
            REASON_LATEST_ACCOUNT_VALUE_BELOW_MINIMUM,
            "latest exact aligned account value is below $10,000",
            volume=volume,
            latest_account_value=latest_value,
            aligned_sample_count=len(samples),
            account_observation_count=account_count,
            pnl_observation_count=pnl_count,
            **diagnostic_fields,
        )

    growth = ONE
    for previous, current in zip(samples, samples[1:]):
        previous_equity = previous[1]
        delta_pnl = current[2] - previous[2]
        if delta_pnl == ZERO:
            # A zero PnL interval contributes a factor of one.  It does not
            # fabricate a return by dividing zero by a possibly empty account.
            continue
        if previous_equity <= ZERO:
            return _failure(
                normalized_wallet,
                REASON_PNL_INTERVAL_NONPOSITIVE_CAPITAL,
                "a PnL-changing interval has non-positive previous equity",
                volume=volume,
                latest_account_value=latest_value,
                aligned_sample_count=len(samples),
                account_observation_count=account_count,
                pnl_observation_count=pnl_count,
                **diagnostic_fields,
            )
        if previous_equity < MINIMUM_ACCOUNT_VALUE_USD:
            return _failure(
                normalized_wallet,
                REASON_PNL_INTERVAL_CAPITAL_BELOW_MINIMUM,
                "a PnL-changing interval has previous equity below $10,000",
                volume=volume,
                latest_account_value=latest_value,
                aligned_sample_count=len(samples),
                account_observation_count=account_count,
                pnl_observation_count=pnl_count,
                **diagnostic_fields,
            )
        interval_return = delta_pnl / previous_equity
        if interval_return < -ONE:
            return _failure(
                normalized_wallet,
                REASON_INTERVAL_RETURN_BELOW_MINUS_100,
                "a PnL-changing interval return is below -100%",
                volume=volume,
                latest_account_value=latest_value,
                aligned_sample_count=len(samples),
                account_observation_count=account_count,
                pnl_observation_count=pnl_count,
                **diagnostic_fields,
            )
        growth *= ONE + interval_return

    return SimplePerpMonthScore(
        wallet=normalized_wallet,
        status="ELIGIBLE",
        reason_code=REASON_VALID,
        reason_message=None,
        twr=growth - ONE,
        latest_account_value=latest_value,
        volume=volume,
        aligned_sample_count=len(samples),
        account_observation_count=account_count,
        pnl_observation_count=pnl_count,
        **diagnostic_fields,
    )


def rank_simple_scores(scores: Iterable[SimplePerpMonthScore], *, limit: int = 10) -> list[SimplePerpMonthScore]:
    """Return a reproducible descending TWR ranking with wallet tie-breaks."""

    if limit < 0:
        raise ValueError("limit cannot be negative")
    eligible = (score for score in scores if score.eligible and score.twr is not None)
    return sorted(eligible, key=lambda score: (-score.twr, score.wallet))[:limit]


def load_preserved_universe(path: str | Path) -> PreservedUniverse:
    """Load one exact saved universe; malformed or duplicate inputs fail closed."""

    source = Path(path)
    raw = source.read_bytes()
    try:
        document = json.loads(raw)
        accounts = document["accounts"]
        window_start_ms = int(document["window_start_ms"])
        window_end_ms = int(document["window_end_ms"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid preserved universe {source}: {exc}") from exc
    if not isinstance(accounts, list) or window_end_ms < window_start_ms:
        raise ValueError("preserved universe must contain a valid accounts list and fixed window")
    wallets: list[str] = []
    for row in accounts:
        if not isinstance(row, Mapping) or not isinstance(row.get("wallet"), str) or not row["wallet"].strip():
            raise ValueError("every preserved universe account must include a wallet")
        wallets.append(row["wallet"].strip().lower())
    if len(wallets) != len(set(wallets)):
        raise ValueError("preserved universe contains duplicate wallets")
    expected_count = document.get("preserved_account_count", document.get("discovered_accounts"))
    if expected_count is not None and int(expected_count) != len(wallets):
        raise ValueError("preserved universe account count does not match its declared count")
    return PreservedUniverse(
        wallets=tuple(wallets),
        window_start_ms=window_start_ms,
        window_end_ms=window_end_ms,
        source_path=str(source),
        source_file_sha256=_sha256_bytes(raw),
        wallet_set_sha256=_sha256_json(sorted(wallets)),
        source_run_id=document.get("source_run_id", document.get("run_id")),
        source_report_sha256=document.get("source_report_sha256", document.get("report_sha256")),
    )


def load_matching_cached_portfolios(
    cache_root: str | Path,
    universe: PreservedUniverse,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Load one newest v4 raw cache record per wallet for the exact saved window.

    ``RawResponseCache`` is intentionally key-addressed, so this research tool
    scans its portfolio directory once to reuse existing raw records from the
    strict pipeline without altering that pipeline's cache identity.
    """

    root = Path(cache_root)
    portfolio_dir = root / "portfolio" if (root / "portfolio").is_dir() else root
    wanted = set(universe.wallets)
    selected: dict[str, tuple[int, str, Any]] = {}
    invalid_records = 0
    scanned_records = 0
    if not portfolio_dir.is_dir():
        return {}, {
            "cache_root": str(root),
            "portfolio_directory": str(portfolio_dir),
            "scanned_portfolio_record_count": 0,
            "matching_portfolio_record_count": 0,
            "invalid_portfolio_record_count": 0,
        }
    for path in sorted(portfolio_dir.glob("*.json")):
        scanned_records += 1
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            key = record["key"]
            wallet = str(key["wallet"]).strip().lower()
            if (
                key.get("endpoint") != "portfolio"
                or wallet not in wanted
                or int(key["window_start_ms"]) != universe.window_start_ms
                or int(key["window_end_ms"]) != universe.window_end_ms
                or int(key["as_of_ms"]) != universe.as_of_ms
                or str(key.get("metric_version")) != "1"
                or str(key.get("raw_payload_schema_version")) != "1"
                or key.get("coverage_mode") != "FAST_INCREMENTAL"
                or "payload" not in record
            ):
                continue
            stored_at_ms = int(record.get("stored_at_ms", 0))
        except (KeyError, TypeError, ValueError, json.JSONDecodeError, OSError):
            invalid_records += 1
            continue
        candidate = (stored_at_ms, path.name, record["payload"])
        previous = selected.get(wallet)
        if previous is None or candidate[:2] > previous[:2]:
            selected[wallet] = candidate
    payloads = {wallet: selected[wallet][2] for wallet in sorted(selected)}
    return payloads, {
        "cache_root": str(root),
        "portfolio_directory": str(portfolio_dir),
        "scanned_portfolio_record_count": scanned_records,
        "matching_portfolio_record_count": len(payloads),
        "invalid_portfolio_record_count": invalid_records,
        "cache_payload_wallet_sha256": _sha256_json(sorted(payloads)),
        "required_cache_identity": {
            "endpoint": "portfolio",
            "window_start_ms": universe.window_start_ms,
            "window_end_ms": universe.window_end_ms,
            "as_of_ms": universe.as_of_ms,
            "metric_version": "1",
            "raw_payload_schema_version": "1",
            "coverage_mode": "FAST_INCREMENTAL",
        },
    }


def _run_id(now: datetime | None = None) -> str:
    current = now or datetime.now(timezone.utc)
    return "perp-month-simple-twr-" + current.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def build_simple_perp_month_report(
    universe: PreservedUniverse,
    payloads: Mapping[str, Any],
    *,
    cache_provenance: Mapping[str, Any],
    run_id: str | None = None,
) -> dict[str, Any]:
    """Score the exact universe and return a self-contained research report."""

    scores: list[SimplePerpMonthScore] = []
    for wallet in sorted(universe.wallets):
        scores.append(score_simple_perp_month(wallet, payloads.get(wallet)))
    ranked = rank_simple_scores(scores)
    reason_counts = dict(sorted(Counter(score.reason_code for score in scores).items()))
    requested_count = len(universe.wallets)
    raw_payload_count = sum(1 for wallet in universe.wallets if wallet in payloads)
    missing_wallets = sorted(wallet for wallet in universe.wallets if wallet not in payloads)
    rows = [score.to_dict() for score in scores]
    report: dict[str, Any] = {
        "schema_version": 1,
        "run_id": run_id or _run_id(),
        "run_status": "COMPLETE" if not missing_wallets else "PARTIAL",
        "research_only": True,
        "canonical_state_updated": False,
        "selection_type": SELECTION_TYPE,
        "ranking_metric": RANKING_METRIC,
        "data_quality": DATA_QUALITY,
        "activity_evidence": ACTIVITY_EVIDENCE,
        "exact_trade_count_30d": None,
        "cashflow_neutral_verified": False,
        "metric_name": SIMPLE_PERP_MONTH_METRIC,
        "metric_version": SIMPLE_PERP_MONTH_VERSION,
        "method": {
            "period": "portfolio.perpMonth only",
            "timestamp_alignment": "exact timestamp intersection only; no interpolation or near-timestamp matching",
            "interval_return": "delta_pnl / previous_account_value",
            "compounding": "product(1 + interval_return) - 1",
            "filters": {
                "latest_account_value_usd": ">= 10000",
                "perp_month_vlm": "> 0",
                "pnl_changing_interval_previous_equity_usd": ">= 10000 and > 0",
                "pnl_changing_interval_return": ">= -1",
            },
        },
        "source_universe": universe.to_provenance(),
        "cache_provenance": dict(cache_provenance),
        "coverage": {
            "preserved_account_count": requested_count,
            "raw_payload_count": raw_payload_count,
            "missing_raw_payload_count": len(missing_wallets),
            "missing_raw_payload_wallet_sha256": _sha256_json(missing_wallets),
            "coverage_complete": not missing_wallets,
            "eligible_count": sum(score.eligible for score in scores),
            "excluded_count": sum(not score.eligible for score in scores),
            "reason_counts": reason_counts,
        },
        "ranking_input_sha256": _sha256_json(rows),
        "top10": [score.to_dict() for score in ranked],
        "wallets": rows,
    }
    report["report_sha256"] = _sha256_json(report)
    return report


def markdown_report(report: Mapping[str, Any]) -> str:
    """Create a compact human-readable companion for the research result."""

    coverage = report.get("coverage", {})
    source = report.get("source_universe", {})
    lines = [
        "# Research-only simple perpMonth TWR",
        "",
        f"- Run: `{report.get('run_id')}`",
        f"- Status: `{report.get('run_status')}`",
        f"- Preserved universe: {coverage.get('preserved_account_count', 0)} wallets",
        f"- Raw payload coverage: {coverage.get('raw_payload_count', 0)}/{coverage.get('preserved_account_count', 0)}",
        f"- Eligible wallets: {coverage.get('eligible_count', 0)}",
        f"- Source wallet-set SHA-256: `{source.get('wallet_set_sha256')}`",
        "- Method: exact timestamp-aligned `portfolio.perpMonth` only; this never updates canonical state or a copy runner.",
        "",
        "## Top 10",
        "",
    ]
    top10 = report.get("top10", [])
    if not top10:
        lines.append("- No eligible wallets.")
    else:
        for index, row in enumerate(top10, start=1):
            lines.append(f"{index}. `{row.get('wallet')}` — {row.get(SIMPLE_PERP_MONTH_METRIC)}")
    return "\n".join(lines) + "\n"


def write_simple_perp_month_artifacts(
    report: Mapping[str, Any],
    *,
    reports_dir: str | Path = "reports/perp-month-simple-twr",
    state_dir: str | Path = "state/perp-month-simple-twr",
) -> dict[str, str]:
    """Atomically write timestamped and latest report/state JSON and Markdown."""

    run_id = str(report.get("run_id") or "").strip()
    if not run_id or "/" in run_id or "\\" in run_id:
        raise ValueError("report run_id must be a safe non-empty filename component")
    report_root = Path(reports_dir)
    state_root = Path(state_dir)
    markdown = markdown_report(report)
    paths = {
        "report_json": report_root / f"{run_id}.json",
        "report_markdown": report_root / f"{run_id}.md",
        "report_latest_json": report_root / "latest.json",
        "report_latest_markdown": report_root / "latest.md",
        "state_json": state_root / f"{run_id}.json",
        "state_markdown": state_root / f"{run_id}.md",
        "state_latest_json": state_root / "latest.json",
        "state_latest_markdown": state_root / "latest.md",
    }
    for key in ("report_json", "report_latest_json", "state_json", "state_latest_json"):
        atomic_write_json(paths[key], dict(report))
    for key in ("report_markdown", "report_latest_markdown", "state_markdown", "state_latest_markdown"):
        write_text_atomic(paths[key], markdown)
    return {name: str(path) for name, path in paths.items()}


def run_simple_perp_month_research(
    *,
    universe_path: str | Path,
    cache_root: str | Path,
    reports_dir: str | Path = "reports/perp-month-simple-twr",
    state_dir: str | Path = "state/perp-month-simple-twr",
    run_id: str | None = None,
) -> tuple[dict[str, Any], dict[str, str]]:
    """Run the isolated research pipeline and write only its dedicated paths."""

    universe = load_preserved_universe(universe_path)
    payloads, cache_provenance = load_matching_cached_portfolios(cache_root, universe)
    cache_provenance = {
        **cache_provenance,
        "cache_hit_count": len(payloads),
        "api_backfill_disabled": True,
        "api_backfill_reason": "fixed snapshot requires exact v4 cache identity; missing payloads are reported instead of refetched",
    }
    report = build_simple_perp_month_report(
        universe,
        payloads,
        cache_provenance=cache_provenance,
        run_id=run_id,
    )
    return report, write_simple_perp_month_artifacts(report, reports_dir=reports_dir, state_dir=state_dir)


__all__ = [
    "MINIMUM_ACCOUNT_VALUE_USD",
    "RANKING_METRIC",
    "REASON_INSUFFICIENT_ALIGNED_SAMPLES",
    "REASON_INTERVAL_RETURN_BELOW_MINUS_100",
    "REASON_LATEST_ACCOUNT_VALUE_BELOW_MINIMUM",
    "REASON_MISSING_PERP_MONTH",
    "REASON_MISSING_RAW_PORTFOLIO",
    "REASON_PNL_INTERVAL_CAPITAL_BELOW_MINIMUM",
    "REASON_PNL_INTERVAL_NONPOSITIVE_CAPITAL",
    "REASON_VALID",
    "REASON_VLM_NOT_POSITIVE",
    "SIMPLE_PERP_MONTH_METRIC",
    "SIMPLE_PERP_MONTH_VERSION",
    "PreservedUniverse",
    "SimplePerpMonthScore",
    "build_simple_perp_month_report",
    "exact_perp_month_samples",
    "load_matching_cached_portfolios",
    "load_preserved_universe",
    "markdown_report",
    "rank_simple_scores",
    "run_simple_perp_month_research",
    "score_simple_perp_month",
    "write_simple_perp_month_artifacts",
]
