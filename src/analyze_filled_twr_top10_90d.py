"""Build a saved 90-day activity report for the highest 30D-TWR wallets with fills."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

import websocket

from whale_lens.activity_analysis import (
    fill_identity,
    select_top_candidates_with_fills,
    summarize_current_positions,
    summarize_fill_history,
)
from whale_lens.api import ApiRequestError, HyperliquidApiClient, RetryPolicy, StageRequestBudget, WeightedTokenBucket
from whale_lens.cache import RawResponseCache, make_raw_cache_key
from whale_lens.report import write_json_atomic


DAY_MS = 86_400_000
FILL_PAGE_CAP = 2_000
FILL_LIMIT = 10_000


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _cache_key(wallet: str, endpoint: str, start_ms: int, end_ms: int, as_of_ms: int):
    return make_raw_cache_key(
        wallet=wallet,
        endpoint=endpoint,
        window_start_ms=start_ms,
        window_end_ms=end_ms,
        as_of_ms=as_of_ms,
        metric_version="1",
        raw_payload_schema_version="1",
        coverage_mode="ACTIVITY_90D_RESEARCH",
    )


def _cached(cache: RawResponseCache, key: Any, fetcher: Any) -> Any:
    payload = cache.get(key)
    if payload is not None:
        return payload
    payload = fetcher()
    cache.put(key, payload)
    return payload


def _fetch_fills(
    client: HyperliquidApiClient,
    cache: RawResponseCache,
    wallet: str,
    start_ms: int,
    end_ms: int,
    as_of_ms: int,
) -> tuple[list[dict[str, Any]], bool, bool, str | None, int]:
    cursor = start_ms
    seen: set[tuple[Any, ...]] = set()
    fills: list[dict[str, Any]] = []
    pages = 0
    for _ in range(30):
        endpoint = f"raw-fills-page-{cursor}"
        try:
            page = _cached(
                cache,
                _cache_key(wallet, endpoint, start_ms, end_ms, as_of_ms),
                lambda cursor=cursor: client.fetch_fills_by_time(wallet, cursor, end_ms, aggregate_by_time=False),
            )
        except ApiRequestError as exc:
            return fills, False, False, f"{exc.reason_code}: {exc}", pages
        pages += 1
        if not isinstance(page, list):
            return fills, False, False, "Hyperliquid returned a non-list fill page", pages
        ordered = sorted((dict(fill) for fill in page if isinstance(fill, Mapping)), key=lambda fill: int(fill.get("time", -1)))
        if len(ordered) != len(page):
            return fills, False, False, "Hyperliquid returned an invalid fill row", pages
        added = 0
        for fill in ordered:
            identity = fill_identity(fill)
            if identity in seen:
                continue
            seen.add(identity)
            fills.append(fill)
            added += 1
            if len(fills) >= FILL_LIMIT:
                fills.sort(key=lambda row: int(row["time"]))
                return fills, False, True, "The 10,000-fill API availability limit was reached", pages
        if len(page) < FILL_PAGE_CAP:
            fills.sort(key=lambda row: int(row["time"]))
            return fills, True, False, None, pages
        last_time = max(int(fill["time"]) for fill in ordered)
        if last_time < cursor or (last_time == cursor and added == 0):
            return fills, False, False, "Fill pagination stalled at an inclusive timestamp", pages
        cursor = last_time
    return fills, False, False, "Fill pagination exceeded 30 pages", pages


def _portfolio_account_value(payload: Any) -> tuple[str | None, int | None]:
    periods = dict(payload) if isinstance(payload, list) else payload if isinstance(payload, Mapping) else {}
    period = periods.get("perpAllTime") or periods.get("perpMonth")
    history = period.get("accountValueHistory") if isinstance(period, Mapping) else None
    if not isinstance(history, list) or not history:
        return None, None
    valid = [(int(row[0]), str(row[1])) for row in history if isinstance(row, list) and len(row) >= 2]
    if not valid:
        return None, None
    timestamp, value = max(valid, key=lambda row: row[0])
    return value, timestamp


def _all_dex_snapshots(wallets: list[str], timeout_seconds: float = 30.0) -> dict[str, Mapping[str, Any]]:
    snapshots: dict[str, Mapping[str, Any]] = {}
    socket = websocket.create_connection("wss://api.hyperliquid.xyz/ws", timeout=5)
    try:
        for wallet in wallets:
            socket.send(json.dumps({"method": "subscribe", "subscription": {"type": "allDexsClearinghouseState", "user": wallet}}))
        deadline = time.monotonic() + timeout_seconds
        while len(snapshots) < len(wallets) and time.monotonic() < deadline:
            socket.settimeout(max(0.25, min(2.0, deadline - time.monotonic())))
            try:
                message = json.loads(socket.recv())
            except (TimeoutError, websocket.WebSocketTimeoutException):
                continue
            if message.get("channel") != "allDexsClearinghouseState":
                continue
            data = message.get("data")
            if not isinstance(data, Mapping):
                continue
            wallet = str(data.get("user") or "").lower()
            if wallet in wallets:
                snapshots[wallet] = data
    finally:
        socket.close()
    return snapshots


def _fmt_pct(value: Any) -> str:
    return "—" if value is None else f"{float(value) * 100:+.2f}%"


def _fmt_money(value: Any) -> str:
    try:
        return f"${float(value):,.2f}"
    except (TypeError, ValueError):
        return "—"


def _fmt_time(value: Any) -> str:
    if value is None:
        return "—"
    return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc).isoformat()


def _render_markdown(report: Mapping[str, Any]) -> str:
    complete_wallets = sum(
        1 for row in report["wallets"] if row["fill_analysis_90d"]["coverage_complete"]
    )
    lines = [
        "# 30D TWR 상위 체결 보유 지갑 10명 — 90일 활동 분석",
        "",
        f"- 생성 시각: `{report['created_at_utc']}`",
        f"- 고정 90일 구간: `{_fmt_time(report['window_start_ms'])}` ~ `{_fmt_time(report['window_end_ms'])}`",
        "- 선정: VERIFIED 30D 입출금 중립 TWR 순서를 유지하고 최근 30일 raw fill이 1건 이상인 첫 10명",
        "- 완료 포지션: `aggregateByTime=false` 원본 체결의 0 → non-zero → 0만 집계; 10,000-fill 제한/불연속은 미확정",
        f"- 90일 체결 완전 수집: **{complete_wallets}/10명**; 나머지는 행별 제한 사유를 보존",
        "",
        "|활동순위|원 후보순위|지갑|30D TWR|현재 퍼프 계좌가치|90D fills|90D 완료 포지션|활성일|현재 포지션|상태|",
        "|---:|---:|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    for row in report["wallets"]:
        fills = row["fill_analysis_90d"]
        positions = row["current_positions"]
        episodes = fills["verified_completed_episodes_90d"]
        episode_text = str(episodes) if episodes is not None else "미확정"
        status = "완전" if fills["episode_validation_valid_90d"] else str(fills["episode_validation_reason_90d"] or "불완전")
        lines.append(
            f"|{row['activity_rank']}|{row['candidate_rank']}|`{row['wallet'][:8]}…{row['wallet'][-6:]}`|"
            f"{_fmt_pct(row['perp_cashflow_neutral_twr_30d'])}|{_fmt_money(positions.get('perp_account_value_usd'))}|"
            f"{fills['raw_fill_count_90d']:,}|{episode_text}|{fills['active_days_90d']}|"
            f"{positions.get('open_position_count', '—')}|{status}|"
        )
    for row in report["wallets"]:
        fills = row["fill_analysis_90d"]
        positions = row["current_positions"]
        top_coins = ", ".join(f"{item['coin']}({item['fill_count']})" for item in fills["top_coins_by_notional"][:3]) or "없음"
        position_text = ", ".join(
            f"{item['coin']} {item['side']} {item.get('leverage') or '—'}x"
            for item in positions.get("positions", [])[:5]
        ) or "없음"
        lines.extend([
            "",
            f"## {row['activity_rank']}. 후보 {row['candidate_rank']}위 — `{row['wallet']}`",
            "",
            f"- 30D 입출금 중립 TWR: **{_fmt_pct(row['perp_cashflow_neutral_twr_30d'])}**",
            f"- 선별시 총 계좌가치: **{_fmt_money(row['source_account_value_usd'])}**",
            f"- 현재 전체 DEX 퍼프 계좌가치: **{_fmt_money(positions.get('perp_account_value_usd'))}** (WebSocket 스냅샷)",
            f"- 90D raw fills/활성일: **{fills['raw_fill_count_90d']:,}건 / {fills['active_days_90d']}일**",
            f"- 90D 완료 포지션: **{fills['verified_completed_episodes_90d'] if fills['verified_completed_episodes_90d'] is not None else '미확정'}**",
            f"- 주 거래 코인: {top_coins}",
            f"- taker 체결 비율: {_fmt_pct(fills['taker_fill_ratio'])}",
            f"- 현재 포지션: {position_text}",
            f"- 마지막 체결: `{_fmt_time(fills['last_fill_ms'])}`",
        ])
        if not fills["episode_validation_valid_90d"]:
            lines.append(f"- 검증 제한: `{fills['episode_validation_reason_90d']}` — {fills['episode_validation_message_90d']}")
        if fills.get("coverage_message_90d"):
            lines.append(f"- 수집 제한: `{fills['coverage_message_90d']}`")
    lines.extend(["", "## 해석 주의", "", "높은 30D TWR는 90D 반복 매매 횟수와 같은 뜻이 아닙니다. 완료 포지션 미확정 지갑은 승률·에피소드 손익을 추정하지 않았습니다.", ""])
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-file", type=Path, required=True)
    parser.add_argument("--source-report", type=Path, required=True)
    parser.add_argument("--cache-root", type=Path, default=Path("state/perp-twr-cache"))
    parser.add_argument("--analysis-cache-root", type=Path, default=Path("state/perp-twr-activity-90d-cache"))
    parser.add_argument("--output-dir", type=Path, default=Path("reports/perp-twr-activity-90d"))
    parser.add_argument("--as-of-ms", type=int, default=None)
    args = parser.parse_args()

    source_report = _read_json(args.source_report)
    candidate_payload = _read_json(args.candidate_file)
    candidates = candidate_payload["candidates"]
    source_cache = RawResponseCache(args.cache_root)
    cached_results: dict[str, Mapping[str, Any]] = {}
    for row in candidates:
        key = make_raw_cache_key(
            wallet=row["wallet"], endpoint="fills-normalized-episodes",
            window_start_ms=source_report["window_start_ms"], window_end_ms=source_report["window_end_ms"],
            as_of_ms=source_report["as_of_ms"], metric_version=str(source_report["metric_version"]),
            coverage_mode=source_report["coverage_mode"],
        )
        payload = source_cache.get(key)
        if isinstance(payload, Mapping) and isinstance(payload.get("result"), Mapping):
            cached_results[str(row["wallet"]).lower()] = payload["result"]
    selected = select_top_candidates_with_fills(candidates, cached_results, target_count=10)

    as_of_ms = args.as_of_ms or int(time.time() * 1000)
    window_start_ms = as_of_ms - 90 * DAY_MS
    # This research job commonly shares an IP with the long-lived paper runner.
    # Reserve most of the published global allowance for that process and let
    # retry backoff absorb short server-side 429 windows.
    limiter = WeightedTokenBucket(capacity=1200, refill_per_second=1, initial_tokens=0)
    budgets = StageRequestBudget({"fills": 250})
    client = HyperliquidApiClient(
        limiter=limiter,
        budgets=budgets,
        retry_policy=RetryPolicy(max_retries=3, base_delay_seconds=5, max_delay_seconds=40),
    )
    analysis_cache = RawResponseCache(args.analysis_cache_root)
    snapshots = _all_dex_snapshots([str(row["wallet"]).lower() for row in selected])
    rows: list[dict[str, Any]] = []
    for activity_rank, candidate in enumerate(selected, 1):
        wallet = str(candidate["wallet"]).lower()
        print(f"[{activity_rank}/10] {wallet} candidate-rank={candidate['candidate_rank']}", flush=True)
        fills, complete, limit, coverage_message, pages = _fetch_fills(
            client, analysis_cache, wallet, window_start_ms, as_of_ms, as_of_ms
        )
        fill_summary = summarize_fill_history(
            fills,
            window_start_ms=window_start_ms,
            window_end_ms=as_of_ms,
            coverage_complete=complete,
            availability_limit_reached=limit,
        )
        fill_summary["coverage_message_90d"] = coverage_message
        fill_summary["pages_fetched"] = pages
        rows.append({
            "activity_rank": activity_rank,
            "candidate_rank": candidate["candidate_rank"],
            "wallet": wallet,
            "perp_cashflow_neutral_twr_30d": candidate["perp_cashflow_neutral_twr_30d"],
            "source_account_value_usd": candidate.get("current_account_value_usd"),
            "raw_fill_count_30d": candidate["raw_fill_count_30d"],
            "completed_episodes_30d": candidate.get("completed_episodes_30d"),
            "episode_validation_valid_30d": candidate.get("episode_validation_valid_30d"),
            "episode_validation_reason_30d": candidate.get("episode_validation_reason_30d"),
            "fill_analysis_90d": fill_summary,
            "current_positions": summarize_current_positions(snapshots.get(wallet)),
        })

    created_at = datetime.now(timezone.utc).isoformat()
    complete_fill_wallets = sum(1 for row in rows if row["fill_analysis_90d"]["coverage_complete"])
    report = {
        "run_id": f"twr-filled-top10-90d-{as_of_ms}",
        "created_at_utc": created_at,
        "selection_metric": "perp_cashflow_neutral_twr_30d",
        "selection_rule": "VERIFIED candidates in TWR order with raw_fill_count_30d > 0",
        "source_run_id": source_report["run_id"],
        "source_candidate_pool_hash": candidate_payload["candidate_pool_hash"],
        "source_candidate_count": len(candidates),
        "window_start_ms": window_start_ms,
        "window_end_ms": as_of_ms,
        "wallet_count": len(rows),
        "websocket_snapshot_count": len(snapshots),
        "fill_history_status": "COMPLETE" if complete_fill_wallets == len(rows) else "PARTIAL",
        "fill_history_complete_wallet_count": complete_fill_wallets,
        "fill_history_incomplete_wallet_count": len(rows) - complete_fill_wallets,
        "request_budget": budgets.snapshot(),
        "wallets": rows,
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.fromtimestamp(as_of_ms / 1000, tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    timestamped_json = args.output_dir / f"run-{stamp}.json"
    timestamped_md = args.output_dir / f"run-{stamp}.md"
    write_json_atomic(timestamped_json, report)
    write_json_atomic(args.output_dir / "latest.json", report)
    markdown = _render_markdown(report)
    timestamped_md.write_text(markdown, encoding="utf-8")
    (args.output_dir / "latest.md").write_text(markdown, encoding="utf-8")
    digest = hashlib.sha256(json.dumps(report, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    print(json.dumps({"report": str(timestamped_json), "sha256": digest, "wallets": len(rows)}, indent=2), flush=True)


if __name__ == "__main__":
    main()
