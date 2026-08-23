"""Pure, research-only 3D dataset projection for simple ``perpMonth`` TWR.

The source report deliberately contains only portfolio-only score summaries.
It does not prove cash-flow-neutral returns, MDD, or fill/trade counts. This
module preserves qualifying return records for research and requires an
explicit observed raw-fill count for the third axis; incomplete coverage is
retained as a lower-bound label rather than presented as exact.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal, InvalidOperation
from math import log10
from typing import Any


SIMPLE_TWR_METRIC = "perp_month_simple_twr_30d"
MINIMUM_RETURN_FRACTION = Decimal("3")
RESEARCH_SELECTION_TYPE = "PORTFOLIO_PERP_MONTH_SIMPLE_TWR_RESEARCH"
RESEARCH_DATA_QUALITY = "PORTFOLIO_ONLY_ESTIMATE"
RESEARCH_ACTIVITY_EVIDENCE = "PERP_MONTH_VLM_POSITIVE"

MDD_MISSING_NO_EXACT_SAMPLES = "MISSING_EXACT_ALIGNED_ACCOUNT_PNL_SAMPLES"
MDD_MISSING_INVALID_SAMPLES = "INVALID_EXACT_ALIGNED_ACCOUNT_PNL_SAMPLES"
TRADE_COUNT_MISSING = "MISSING_EXACT_TRADE_COUNT_30D"
PLOT_EXCLUSION_MDD = "MDD_UNAVAILABLE"
PLOT_EXCLUSION_TRADE_COUNT = "EXACT_TRADE_COUNT_UNAVAILABLE"


def _decimal(value: Any, *, field: str) -> Decimal:
    """Parse a finite decimal value without accepting booleans."""

    if isinstance(value, bool) or value is None:
        raise ValueError(f"{field} must be a decimal value")
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"{field} must be a decimal value") from exc
    if not parsed.is_finite():
        raise ValueError(f"{field} must be finite")
    return parsed


def _optional_nonnegative_integer(value: Any, *, field: str) -> int | None:
    """Return an exact non-negative integer or ``None`` when not reported."""

    if value is None:
        return None
    parsed = _decimal(value, field=field)
    if parsed < 0 or parsed != parsed.to_integral_value():
        raise ValueError(f"{field} must be a non-negative integer")
    return int(parsed)


def _optional_float_decimal(value: Any, *, field: str) -> float | None:
    if value is None:
        return None
    return float(_decimal(value, field=field))


def _optional_source_rank(row: Mapping[str, Any]) -> int | None:
    """Preserve a report-supplied rank when one is explicitly available."""

    for field in ("source_rank", "rank", "ranking_rank"):
        if field in row:
            return _optional_nonnegative_integer(row[field], field=field)
    return None


def _mdd_from_exact_samples(row: Mapping[str, Any]) -> tuple[float | None, str, str | None]:
    """Derive simple-TWR-curve MDD from explicitly supplied aligned samples.

    ``simple_perp_month`` does not write these samples today.  An enriched
    research row may supply ``exact_aligned_account_pnl_samples`` with
    ``timestamp_ms``, ``account_value_usd``, and ``cumulative_pnl_usd``.
    The PnL field is required so the row cannot silently pass a merely
    account-value-only series off as an aligned account/PnL series.
    """

    samples = row.get("exact_aligned_account_pnl_samples")
    if samples is None:
        return None, "MISSING", MDD_MISSING_NO_EXACT_SAMPLES
    if not isinstance(samples, Sequence) or isinstance(samples, (str, bytes)) or len(samples) < 2:
        return None, "MISSING", MDD_MISSING_INVALID_SAMPLES

    previous_timestamp: int | None = None
    parsed_samples: list[tuple[int, Decimal, Decimal]] = []
    peak = Decimal("1")
    growth = Decimal("1")
    maximum_drawdown = Decimal("0")
    try:
        for sample in samples:
            if not isinstance(sample, Mapping):
                raise ValueError("sample must be a mapping")
            timestamp = _optional_nonnegative_integer(sample.get("timestamp_ms"), field="timestamp_ms")
            if timestamp is None or (previous_timestamp is not None and timestamp <= previous_timestamp):
                raise ValueError("timestamps must be strictly increasing")
            account_value = _decimal(sample.get("account_value_usd"), field="account_value_usd")
            cumulative_pnl = _decimal(sample.get("cumulative_pnl_usd"), field="cumulative_pnl_usd")
            parsed_samples.append((timestamp, account_value, cumulative_pnl))
            previous_timestamp = timestamp
        for previous, current in zip(parsed_samples, parsed_samples[1:]):
            delta_pnl = current[2] - previous[2]
            if delta_pnl != 0:
                if previous[1] <= 0:
                    raise ValueError("PnL-changing interval has non-positive previous equity")
                interval_return = delta_pnl / previous[1]
                if interval_return < -1:
                    raise ValueError("simple TWR interval return is below -100%")
                growth *= 1 + interval_return
            if growth > peak:
                peak = growth
            drawdown = (peak - growth) / peak
            if drawdown > maximum_drawdown:
                maximum_drawdown = drawdown
    except ValueError:
        return None, "MISSING", MDD_MISSING_INVALID_SAMPLES

    return float(maximum_drawdown * Decimal("100")), "AVAILABLE", None


def _proxy_trade_count(row: Mapping[str, Any]) -> tuple[int | None, float | None, str, str | None]:
    """Expose the PnL-changing interval diagnostic as a non-trade proxy only."""

    try:
        count = _optional_nonnegative_integer(
            row.get("pnl_changing_interval_count"), field="pnl_changing_interval_count"
        )
    except ValueError:
        return None, None, "MISSING", "INVALID_PNL_CHANGING_INTERVAL_COUNT"
    if count is None:
        return None, None, "MISSING", "MISSING_PNL_CHANGING_INTERVAL_COUNT"
    return (
        count,
        log10(max(1, count)),
        "AVAILABLE_PROXY_NOT_EXACT_TRADE_COUNT",
        "Counts exact timestamp-aligned PnL-changing intervals, not fills or trades.",
    )


def _require_research_source(report: Mapping[str, Any]) -> None:
    """Reject source documents that could be mistaken for canonical inputs."""

    if report.get("research_only") is not True:
        raise ValueError("source report must explicitly be research_only")
    if report.get("selection_type") != RESEARCH_SELECTION_TYPE:
        raise ValueError("source report has an unsupported selection_type")
    if report.get("data_quality") != RESEARCH_DATA_QUALITY:
        raise ValueError("source report has an unsupported data_quality")
    if report.get("metric_name") != SIMPLE_TWR_METRIC:
        raise ValueError("source report has an unsupported metric_name")
    if not isinstance(report.get("report_sha256"), str) or not report["report_sha256"].strip():
        raise ValueError("source report must include report_sha256")
    if not isinstance(report.get("wallets"), Sequence) or isinstance(report["wallets"], (str, bytes)):
        raise ValueError("source report must include a wallets sequence")


def _source_as_of_ms(report: Mapping[str, Any]) -> int | None:
    """Use a direct as-of value, otherwise the saved fixed-window end."""

    source = report.get("source_universe")
    direct = report.get("as_of_ms")
    if direct is None and isinstance(source, Mapping):
        direct = source.get("window_end_ms")
    if direct is None:
        return None
    return _optional_nonnegative_integer(direct, field="source_as_of_ms")


def build_twr_3d_dataset(report: Mapping[str, Any]) -> dict[str, Any]:
    """Project a simple-TWR report into a fail-closed 3D research dataset.

    Every source row that is ``ELIGIBLE`` and has a simple TWR of at least
    3.0 (300%) is retained in ``records``.  ``plot_eligible`` remains false
    unless the row has an exact trade count and MDD derived from an explicitly
    supplied exact-aligned account/PnL series.  The interval count diagnostic
    is included only as a labelled proxy and cannot satisfy that gate.
    """

    _require_research_source(report)
    wallets = report["wallets"]

    ranked: list[tuple[Decimal, str, Mapping[str, Any]]] = []
    for row in wallets:
        if not isinstance(row, Mapping) or row.get("status") != "ELIGIBLE":
            continue
        wallet = row.get("wallet")
        if not isinstance(wallet, str) or not wallet.strip():
            continue
        try:
            return_fraction = _decimal(row.get(SIMPLE_TWR_METRIC), field=SIMPLE_TWR_METRIC)
        except ValueError:
            continue
        ranked.append((return_fraction, wallet.strip().lower(), row))
    ranked.sort(key=lambda item: (-item[0], item[1]))
    computed_ranks = {wallet: index for index, (_, wallet, _) in enumerate(ranked, start=1)}

    records: list[dict[str, Any]] = []
    for return_fraction, wallet, row in ranked:
        if return_fraction < MINIMUM_RETURN_FRACTION:
            continue
        exact_trade_count = _optional_nonnegative_integer(
            row.get("exact_trade_count_30d"), field="exact_trade_count_30d"
        )
        trade_coverage_status = row.get("trade_count_coverage_status")
        mdd_pct, mdd_status, mdd_missing_reason = _mdd_from_exact_samples(row)
        proxy_count, proxy_plot_value, proxy_status, proxy_caveat = _proxy_trade_count(row)
        missing_axes: list[str] = []
        if mdd_pct is None:
            missing_axes.append(PLOT_EXCLUSION_MDD)
        if exact_trade_count is None:
            missing_axes.append(PLOT_EXCLUSION_TRADE_COUNT)
        trade_plot_value = None if exact_trade_count is None else log10(max(1, exact_trade_count))
        record = {
            "wallet": wallet,
            "rank": computed_ranks[wallet],
            "source_rank": _optional_source_rank(row),
            "return_fraction": str(return_fraction),
            "return_pct": float(return_fraction * Decimal("100")),
            "mdd_pct": mdd_pct,
            "mdd_status": mdd_status,
            "mdd_basis": (
                "maximum drawdown of the simple-TWR index built from exact aligned account/PnL samples; "
                "portfolio-only and not ledger cash-flow-neutral verified"
                if mdd_pct is not None
                else None
            ),
            "mdd_missing_reason": mdd_missing_reason,
            "trade_count_raw": exact_trade_count,
            "trade_count_status": (
                "AVAILABLE_EXACT"
                if exact_trade_count is not None and trade_coverage_status == "COMPLETE"
                else "AVAILABLE_OBSERVED_LOWER_BOUND"
                if exact_trade_count is not None
                else "MISSING"
            ),
            "trade_count_basis": row.get("exact_trade_count_basis", "source exact_trade_count_30d") if exact_trade_count is not None else None,
            "trade_count_missing_reason": None if exact_trade_count is not None else TRADE_COUNT_MISSING,
            "trade_count_plot_log10": trade_plot_value,
            "trade_count_proxy_raw": proxy_count,
            "trade_count_proxy_status": proxy_status,
            "trade_count_proxy_basis": "pnl_changing_interval_count",
            "trade_count_proxy_caveat": proxy_caveat,
            "trade_count_proxy_plot_log10": proxy_plot_value,
            "raw_perpetual_fill_count_30d": _optional_nonnegative_integer(
                row.get("raw_perpetual_fill_count_30d"), field="raw_perpetual_fill_count_30d"
            ),
            "trade_count_coverage_status": trade_coverage_status,
            "latest_account_value_usd": _optional_float_decimal(
                row.get("latest_account_value_usd"), field="latest_account_value_usd"
            ),
            "perp_month_vlm_usd": _optional_float_decimal(row.get("perp_month_vlm"), field="perp_month_vlm"),
            "aligned_sample_count": _optional_nonnegative_integer(
                row.get("aligned_sample_count"), field="aligned_sample_count"
            ),
            "implied_flow_max_relative": (
                None
                if row.get("implied_flow_max_relative_to_previous_equity") is None
                else _optional_float_decimal(
                    row.get("implied_flow_max_relative_to_previous_equity"),
                    field="implied_flow_max_relative_to_previous_equity",
                )
            ),
            "plot_eligible": not missing_axes,
            "plot_exclusion_reasons": missing_axes,
            "research_only": True,
            "data_quality": report["data_quality"],
            "activity_evidence": row.get("activity_evidence", report.get("activity_evidence")),
            "cashflow_neutral_verified": False,
        }
        records.append(record)

    source_universe = report.get("source_universe")
    source_window = source_universe if isinstance(source_universe, Mapping) else {}
    plot_record_count = sum(record["plot_eligible"] for record in records)
    return {
        "schema_version": 1,
        "dataset_type": "TWR_3D_RESEARCH_ONLY",
        "research_only": True,
        "canonical_or_runner_eligible": False,
        "source": {
            "report_sha256": report["report_sha256"],
            "run_id": report.get("run_id"),
            "as_of_ms": _source_as_of_ms(report),
            "window_start_ms": source_window.get("window_start_ms"),
            "window_end_ms": source_window.get("window_end_ms"),
            "selection_type": report["selection_type"],
            "data_quality": report["data_quality"],
            "metric_name": report["metric_name"],
            "metric_version": report.get("metric_version"),
            "activity_evidence": report.get("activity_evidence"),
            "cashflow_neutral_verified": bool(report.get("cashflow_neutral_verified", False)),
        },
        "selection": {
            "eligible_status": "ELIGIBLE",
            "minimum_return_fraction": str(MINIMUM_RETURN_FRACTION),
            "minimum_return_pct": float(MINIMUM_RETURN_FRACTION * Decimal("100")),
        },
        "axis_policy": {
            "return_axis": "return_pct",
            "mdd_axis": "mdd_pct",
            "trade_count_axis": "trade_count_plot_log10",
            "trade_count_transform": "log10(max(1, observed aggregateByTime:false perpetual fill rows))",
            "proxy_is_not_a_trade_axis_substitute": True,
            "plot_gate": "requires available MDD and a positive observed raw perpetual fill count; partial coverage is plotted as a lower bound",
        },
        "record_count": len(records),
        "plot_record_count": plot_record_count,
        "records": records,
    }
