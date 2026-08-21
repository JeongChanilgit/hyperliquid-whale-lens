"use client";

import { useEffect, useMemo, useState } from "react";

type RescueAccount = {
  wallet: string;
  data_quality_status: string;
  activity_status: string;
  selection_status: string;
  source_reason_codes: string[];
  reason_codes: string[];
  latest_scores: {
    provisional_twr: string | null;
    exact_twr: string | null;
    estimated_twr: string | null;
    twr_lower_bound: string | null;
    twr_upper_bound: string | null;
  };
  account_value_usd: string | null;
  raw_fill_count_30d: number;
  completed_episodes_30d: number | null;
  rescue_priority_score: string;
  next_actions?: string[];
};

type RescuePayload = {
  source_run_id: string;
  discovered_accounts: number;
  quality_counts: Record<string, number>;
  rescue_queue_count: number;
  accounts: RescueAccount[];
};

type View = "exact" | "rescued" | "bounded" | "unresolved" | "all";

const EXACT = new Set(["VERIFIED_EXACT"]);
const RESCUED = new Set(["VERIFIED_INTERVAL", "VERIFIED_INTERVAL_WITH_GUARD", "VERIFIED_BLOCK_RECONCILED", "VERIFIED_DERIVED_VALUE"]);
const BOUNDED = new Set(["ESTIMATED_MODIFIED_DIETZ", "BOUNDED"]);
const UNRESOLVED = new Set(["RESCUE_PENDING", "UNRESOLVED", "PROVISIONAL"]);

const short = (wallet: string) => `${wallet.slice(0, 8)}…${wallet.slice(-6)}`;
const pct = (value: string | null | undefined) => value == null ? "—" : `${(Number(value) * 100).toLocaleString("ko-KR", { maximumFractionDigits: 2, signDisplay: "always" })}%`;
const usd = (value: string | null) => value == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value));

export default function RescueAnalysisPanel() {
  const [payload, setPayload] = useState<RescuePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("exact");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(100);

  useEffect(() => {
    let active = true;
    fetch("/preloaded/rescue/latest.json", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`rescue report HTTP ${response.status}`);
        return response.json() as Promise<RescuePayload>;
      })
      .then((value) => active && setPayload(value))
      .catch((cause) => active && setError(cause instanceof Error ? cause.message : "구제 보고서를 불러오지 못했습니다."));
    return () => { active = false; };
  }, []);

  const rows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (payload?.accounts ?? []).filter((row) => {
      const visible = view === "all"
        || (view === "exact" && EXACT.has(row.data_quality_status))
        || (view === "rescued" && RESCUED.has(row.data_quality_status))
        || (view === "bounded" && BOUNDED.has(row.data_quality_status))
        || (view === "unresolved" && UNRESOLVED.has(row.data_quality_status));
      return visible && (!normalized || row.wallet.includes(normalized) || row.reason_codes.some((reason) => reason.toLowerCase().includes(normalized)));
    }).sort((left, right) => {
      const score = (row: RescueAccount) => Number(row.latest_scores.exact_twr ?? row.latest_scores.twr_lower_bound ?? row.latest_scores.estimated_twr ?? row.latest_scores.provisional_twr ?? Number.NEGATIVE_INFINITY);
      return score(right) - score(left) || left.wallet.localeCompare(right.wallet);
    });
  }, [payload, query, view]);

  if (error) return <section className="rescue-shell"><div className="notice notice--error">{error}</div></section>;
  if (!payload) return <section className="rescue-shell"><div className="rescue-loading">계좌 증거 레지스트리를 불러오는 중…</div></section>;

  const counts = payload.quality_counts;
  const exactCount = [...EXACT].reduce((sum, key) => sum + (counts[key] ?? 0), 0);
  const rescuedCount = [...RESCUED].reduce((sum, key) => sum + (counts[key] ?? 0), 0);
  const boundedCount = [...BOUNDED].reduce((sum, key) => sum + (counts[key] ?? 0), 0);
  const unresolvedCount = [...UNRESOLVED].reduce((sum, key) => sum + (counts[key] ?? 0), 0);

  return (
    <section className="rescue-shell">
      <header className="rescue-hero">
        <div><span className="eyebrow">ACCOUNT EVIDENCE REGISTRY</span><h1>계좌 구조보존 · 구제 분석</h1><p>정확값과 추정·상하한을 분리하고, 실패 계좌도 다음 실행에서 다시 평가합니다.</p></div>
        <span className="rescue-run">{payload.source_run_id}</span>
      </header>
      <div className="rescue-summary">
        <div><span>전체 보존</span><strong>{payload.discovered_accounts.toLocaleString()}</strong></div>
        <div><span>정확 검증</span><strong>{exactCount.toLocaleString()}</strong></div>
        <div><span>구제 검증</span><strong>{rescuedCount.toLocaleString()}</strong></div>
        <div><span>추정·상하한</span><strong>{boundedCount.toLocaleString()}</strong></div>
        <div><span>미해결</span><strong>{unresolvedCount.toLocaleString()}</strong></div>
        <div><span>구제 큐</span><strong>{payload.rescue_queue_count.toLocaleString()}</strong></div>
      </div>
      <div className="rescue-controls">
        <div className="rescue-tabs" role="tablist">
          {([['exact','정확 검증'],['rescued','구제 검증'],['bounded','상하한 후보'],['unresolved','미해결 고가능성'],['all','전체 계좌']] as const).map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? "is-active" : ""} onClick={() => { setView(key); setLimit(100); }}>{label}</button>
          ))}
        </div>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="주소 또는 reason code 검색" aria-label="구제 계좌 검색" />
      </div>
      <div className="rescue-table" role="table" aria-label="계좌 구조보존 결과">
        <div className="rescue-row rescue-row--head" role="row"><span>계좌</span><span>품질 / 활동</span><span>수익률</span><span>범위</span><span>증거·다음 작업</span></div>
        {rows.slice(0, limit).map((row) => (
          <div className="rescue-row" role="row" key={row.wallet}>
            <span><strong>{short(row.wallet)}</strong><small>{usd(row.account_value_usd)} · fills {row.raw_fill_count_30d.toLocaleString()}</small></span>
            <span><i className={`rescue-quality rescue-quality--${row.data_quality_status.toLowerCase()}`}>{row.data_quality_status}</i><small>{row.activity_status}</small></span>
            <span><strong>{pct(row.latest_scores.exact_twr ?? row.latest_scores.estimated_twr ?? row.latest_scores.provisional_twr)}</strong><small>{row.latest_scores.exact_twr ? "exact" : row.latest_scores.estimated_twr ? "estimate" : "provisional"}</small></span>
            <span><strong>{pct(row.latest_scores.twr_lower_bound)} → {pct(row.latest_scores.twr_upper_bound)}</strong><small>priority {Number(row.rescue_priority_score).toFixed(3)}</small></span>
            <span><strong>{row.source_reason_codes.slice(0, 2).join(" · ") || "VALID"}</strong><small>{(row.next_actions ?? row.reason_codes).slice(0, 2).join(" · ")}</small></span>
          </div>
        ))}
        {rows.length === 0 ? <div className="rescue-empty">해당 품질의 계좌가 없습니다.</div> : null}
      </div>
      {limit < rows.length ? <button className="rescue-more" type="button" onClick={() => setLimit((value) => value + 250)}>다음 {Math.min(250, rows.length - limit)}명 보기</button> : null}
    </section>
  );
}
