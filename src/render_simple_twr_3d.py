"""Render a standalone, offline 3D scatter for the +300% simple-TWR cohort."""

from __future__ import annotations

import argparse
import json
from copy import deepcopy
from pathlib import Path
from typing import Any, Mapping, Sequence

from whale_lens.simple_perp_month import exact_perp_month_samples
from whale_lens.twr_3d_data import build_twr_3d_dataset


DEFAULT_REPORT = Path("reports/perp-month-simple-twr/latest.json")
DEFAULT_CACHE_ROOT = Path("state/perp-twr-cache/portfolio")
DEFAULT_COUNTS = Path("state/perp-month-simple-twr/twr-3d-count-evidence.json")
DEFAULT_DATA = Path("reports/perp-month-simple-twr/twr-300-plus-3d-data.json")
DEFAULT_HTML = Path("reports/perp-month-simple-twr/twr-300-plus-3d.html")
DEFAULT_EXCLUDED_RANKS = (1,)


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _exact_cache_payloads(report: Mapping[str, Any], cache_dir: Path) -> dict[str, Any]:
    expected = report["cache_provenance"]["required_cache_identity"]
    selected: dict[str, tuple[int, str, Any]] = {}
    for path in sorted(cache_dir.glob("*.json")):
        try:
            record = _read_json(path)
            key = record["key"]
            wallet = str(key["wallet"]).strip().lower()
            matches = all(
                str(key.get(field)) == str(expected.get(field))
                for field in (
                    "endpoint",
                    "window_start_ms",
                    "window_end_ms",
                    "as_of_ms",
                    "metric_version",
                    "raw_payload_schema_version",
                    "coverage_mode",
                )
            )
            if not matches or "payload" not in record:
                continue
            candidate = (int(record.get("stored_at_ms", 0)), path.name, record["payload"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError, OSError):
            continue
        previous = selected.get(wallet)
        if previous is None or candidate[:2] > previous[:2]:
            selected[wallet] = candidate
    return {wallet: item[2] for wallet, item in selected.items()}


def _count_records(document: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    rows: Any = document.get("wallets", document.get("records", document.get("results")))
    if not isinstance(rows, Sequence) or isinstance(rows, (str, bytes)):
        raise ValueError("count evidence must contain wallets, records, or results")
    mapped: dict[str, Mapping[str, Any]] = {}
    for row in rows:
        if not isinstance(row, Mapping):
            continue
        wallet = str(row.get("wallet", row.get("address", ""))).strip().lower()
        if wallet:
            mapped[wallet] = row
    return mapped


def _count_value(row: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        if row.get(name) is not None:
            return row[name]
    return None


def enrich_report(
    report: Mapping[str, Any],
    *,
    cache_dir: Path,
    count_evidence: Mapping[str, Any],
) -> dict[str, Any]:
    enriched = deepcopy(report)
    payloads = _exact_cache_payloads(report, cache_dir)
    counts = _count_records(count_evidence)
    identity = report["cache_provenance"]["required_cache_identity"]
    window_start = int(identity["window_start_ms"])
    window_end = int(identity["window_end_ms"])
    retained = 0
    missing: list[str] = []
    for row in enriched["wallets"]:
        try:
            retained_row = row.get("status") == "ELIGIBLE" and float(row.get("perp_month_simple_twr_30d", 0)) >= 3
        except (TypeError, ValueError):
            retained_row = False
        if not retained_row:
            continue
        retained += 1
        wallet = str(row["wallet"]).lower()
        payload = payloads.get(wallet)
        count = counts.get(wallet)
        if payload is None or count is None:
            missing.append(wallet)
            continue
        samples = [
            {
                "timestamp_ms": timestamp,
                "account_value_usd": str(account_value),
                "cumulative_pnl_usd": str(cumulative_pnl),
            }
            for timestamp, account_value, cumulative_pnl in exact_perp_month_samples(payload)
            if window_start <= timestamp <= window_end
        ]
        status = str(count.get("status", count.get("coverage_status", ""))).upper()
        coverage = count.get("coverage")
        if isinstance(coverage, Mapping):
            status = str(coverage.get("status", status)).upper()
        count_values = count.get("counts") if isinstance(count.get("counts"), Mapping) else count
        exact_count = _count_value(
            count_values,
            "raw_perpetual_fill_count_30d",
            "perpetual_fill_count",
            "perpetual_fill_rows",
            "raw_fill_count",
            "exact_trade_count_30d",
            "trade_count",
        )
        observed_count = _count_value(
            count_values,
            "observed_perpetual_fill_rows",
            "observed_raw_fill_count",
        )
        plotted_count = exact_count if status == "COMPLETE" and exact_count is not None else observed_count
        if plotted_count is None:
            missing.append(wallet)
            continue
        row["exact_aligned_account_pnl_samples"] = samples
        row["exact_trade_count_30d"] = plotted_count
        row["exact_trade_count_basis"] = (
            "complete deduplicated aggregateByTime:false perpetual fill rows; one row equals one trade"
            if status == "COMPLETE"
            else "observed lower-bound deduplicated aggregateByTime:false perpetual fill rows; one row equals one trade"
        )
        row["raw_perpetual_fill_count_30d"] = plotted_count
        row["trade_count_coverage_status"] = status
    if retained == 0:
        raise ValueError("source report has no +300% eligible wallets")
    if missing:
        raise ValueError("three-axis enrichment is incomplete for: " + ", ".join(sorted(set(missing))))
    return enriched


def render_html(dataset: Mapping[str, Any]) -> str:
    data = json.dumps(dataset, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    template = r'''<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Whale Lens · +300% 3D Map</title>
<style>
:root{color-scheme:dark;--bg:#07100b;--panel:#0d1711;--line:#274333;--grid:#1a3325;--text:#ecf7ef;--muted:#8da395;--lime:#a8ff4f;--cyan:#50e4cf;--amber:#ffd35a;--red:#ff6b75}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 40% 10%,#11261a 0,var(--bg) 45%);color:var(--text);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh}
button,select{font:inherit}.shell{max-width:1500px;margin:0 auto;padding:22px}.top{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;margin-bottom:14px}.eyebrow{color:var(--lime);font:700 11px/1.2 ui-monospace,SFMono-Regular,Consolas;letter-spacing:.13em;text-transform:uppercase}h1{font-size:clamp(24px,4vw,44px);line-height:1.05;margin:7px 0 5px;letter-spacing:-.04em}.sub{color:var(--muted);max-width:760px}.tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.tools button,.tools select{border:1px solid var(--line);background:#101d15;color:var(--text);padding:9px 12px;border-radius:8px}.tools button:hover{border-color:var(--lime)}
.plot{position:relative;border:1px solid var(--line);background:linear-gradient(180deg,rgba(9,20,13,.72),rgba(6,13,9,.93));border-radius:14px;overflow:hidden;min-height:680px}.plot canvas{display:block;width:100%;height:680px;touch-action:none;cursor:grab}.plot canvas.dragging{cursor:grabbing}.legend{position:absolute;left:16px;top:14px;color:var(--muted);font-size:12px;pointer-events:none}.legend b{color:var(--text)}.tooltip{position:absolute;display:none;pointer-events:none;background:#101c15;border:1px solid var(--line);border-radius:8px;padding:9px 11px;box-shadow:0 12px 35px #0009;max-width:260px;z-index:4}.tooltip strong{display:block;color:var(--lime);margin-bottom:3px}
.detail{margin-top:12px;border-top:1px solid var(--line);display:grid;grid-template-columns:1.3fr repeat(5,minmax(110px,.6fr));gap:0;background:rgba(10,20,13,.65)}.detail>div{padding:14px 16px;border-right:1px solid var(--line)}.detail>div:last-child{border-right:0}.detail small{display:block;color:var(--muted);font-size:11px;margin-bottom:3px}.detail b{font-size:18px}.address{font-family:ui-monospace,SFMono-Regular,Consolas;word-break:break-all}.note{display:flex;justify-content:space-between;gap:20px;color:var(--muted);font-size:12px;padding:10px 2px}.warning{color:var(--amber)}
@media(max-width:900px){.top{align-items:flex-start;flex-direction:column}.plot,.plot canvas{min-height:560px;height:560px}.detail{grid-template-columns:repeat(2,1fr)}.detail>div{border-bottom:1px solid var(--line)}.detail .identity{grid-column:1/-1}.note{flex-direction:column;gap:4px}}
@media(max-width:520px){.shell{padding:12px}.plot,.plot canvas{min-height:480px;height:480px}.detail{grid-template-columns:1fr}.detail .identity{grid-column:auto}}
</style></head><body><main class="shell">
<header class="top"><div><div class="eyebrow">Whale Lens · Research only</div><h1>1위 제외 · 300%+ 계좌 3D 성과 지도</h1><div class="sub">보이는 23개 계좌 범위로 세 축을 다시 맞췄습니다. 드래그 회전 · 휠 확대 · X 수익률 · Y 단순 TWR MDD · Z 원시 체결 수(log10).</div></div><div class="tools"><select id="walletSelect" aria-label="계좌 선택"></select><button id="reset" type="button">뷰 초기화</button></div></header>
<section class="plot"><canvas id="scene" role="img" aria-label="수익률, 최대 낙폭, 로그 거래 횟수를 나타내는 3차원 산점도"></canvas><div class="legend"><b id="countLabel"></b> · 점을 선택하면 세부값 표시</div><div class="tooltip" id="tooltip" role="tooltip"></div></section>
<section class="detail" id="detail" aria-live="polite"></section>
<footer class="note"><span>수익률·MDD는 portfolio-only 단순 TWR 연구값이며 입출금 원장 검증값이 아닙니다.</span><span id="provenance"></span></footer>
</main><script id="data" type="application/json">__DATA__</script><script>
(()=>{'use strict';
const data=JSON.parse(document.getElementById('data').textContent),points=data.records;
const canvas=document.getElementById('scene'),ctx=canvas.getContext('2d'),tip=document.getElementById('tooltip'),detail=document.getElementById('detail'),select=document.getElementById('walletSelect');
if(!points.length)throw new Error('No plotted records');
const n=v=>Number(v),fmt=(v,d=1)=>Number.isFinite(n(v))?n(v).toLocaleString('ko-KR',{maximumFractionDigits:d}):'—',money=v=>Number.isFinite(n(v))?'$'+fmt(v,0):'—',short=a=>a.slice(0,7)+'…'+a.slice(-5);
const xs=points.map(p=>n(p.return_pct)),ys=points.map(p=>n(p.mdd_pct)),zs=points.map(p=>n(p.trade_count_plot_log10));
const extent=a=>{let lo=Math.min(...a),hi=Math.max(...a);if(lo===hi){const half=Math.max(1,Math.abs(lo)*.05);return[lo-half,hi+half]}const pad=(hi-lo)*.06;return[lo-pad,hi+pad]},xd=extent(xs),yd=extent(ys),zd=extent(zs),norm=(v,d)=>-1+2*(v-d[0])/(d[1]-d[0]);
points.forEach(p=>p.pos={x:norm(n(p.return_pct),xd),y:norm(n(p.mdd_pct),yd),z:norm(n(p.trade_count_plot_log10),zd)});
let yaw=-.68,pitch=.42,zoom=1,selected=points[0],hovered=null,drag=false,moved=false,lastX=0,lastY=0,projected=[];
function theme(name){return getComputedStyle(document.documentElement).getPropertyValue(name).trim()}
function project(p,w,h){const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch),x=p.x*cy+p.z*sy,z=-p.x*sy+p.z*cy,y=p.y*cp-z*sp,z2=p.y*sp+z*cp,depth=4.2+z2,scale=Math.min(w,h)*.62*zoom/depth;return{x:w/2+x*scale,y:h/2-y*scale,depth,scale}}
function line(a,b,color,width=1){ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke()}
function label(text,p,align='center'){ctx.fillStyle=theme('--muted');ctx.font='12px ui-monospace,Consolas';ctx.textAlign=align;ctx.fillText(text,p.x,p.y)}
function axes(w,h){const grid=theme('--grid'),axis=theme('--line'),corners=[];for(const x of[-1,1])for(const y of[-1,1])for(const z of[-1,1])corners.push({x,y,z});const q=corners.map(p=>project(p,w,h)),edges=[[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[3,7],[4,5],[4,6],[5,7],[6,7]];edges.forEach(([a,b])=>line(q[a],q[b],grid));
const origin=project({x:-1,y:-1,z:-1},w,h),xend=project({x:1,y:-1,z:-1},w,h),yend=project({x:-1,y:1,z:-1},w,h),zend=project({x:-1,y:-1,z:1},w,h);line(origin,xend,axis,1.5);line(origin,yend,axis,1.5);line(origin,zend,axis,1.5);
label('수익률 %',xend,'left');label('MDD %',{x:yend.x,y:yend.y-8},'center');label('거래 횟수 log10',zend,'right');
for(let i=0;i<=4;i++){const t=i/4,x=project({x:-1+2*t,y:-1,z:-1},w,h),y=project({x:-1,y:-1+2*t,z:-1},w,h),z=project({x:-1,y:-1,z:-1+2*t},w,h);label(fmt(xd[0]+t*(xd[1]-xd[0]),0),{x:x.x,y:x.y+17});label(fmt(yd[0]+t*(yd[1]-yd[0]),0),{x:y.x-8,y:y.y+4},'right');label(fmt(Math.pow(10,zd[0]+t*(zd[1]-zd[0])),0),{x:z.x+5,y:z.y+15},'left')}}
function draw(){const dpr=Math.min(devicePixelRatio||1,2),w=canvas.clientWidth,h=canvas.clientHeight;if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr)}ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);axes(w,h);projected=points.map(p=>({p,q:project(p.pos,w,h)})).sort((a,b)=>b.q.depth-a.q.depth);for(const item of projected){const active=item.p===selected,over=item.p===hovered,r=active?8:over?7:5.3;ctx.beginPath();ctx.arc(item.q.x,item.q.y,r,0,Math.PI*2);ctx.fillStyle=active?theme('--amber'):theme('--lime');ctx.globalAlpha=active?1:.78;ctx.fill();ctx.globalAlpha=1;if(active||over){ctx.beginPath();ctx.arc(item.q.x,item.q.y,r+5,0,Math.PI*2);ctx.strokeStyle=active?theme('--amber'):theme('--cyan');ctx.lineWidth=1.5;ctx.stroke()}}}
function detailView(p){const lower=p.trade_count_coverage_status!=='COMPLETE';detail.innerHTML=`<div class="identity"><small>계좌 · 성과 순위 ${p.rank}</small><b class="address">${p.wallet}</b></div><div><small>30D 수익률</small><b>${fmt(p.return_pct,2)}%</b></div><div><small>단순 TWR MDD</small><b>${fmt(p.mdd_pct,2)}%</b></div><div><small>${lower?'관측 체결 수 · 하한':'원시 체결 수'}</small><b>${lower?'≥ ':''}${fmt(p.trade_count_raw,0)}</b></div><div><small>API 30D 거래대금</small><b>${money(p.perp_month_vlm_usd)}</b></div><div><small>현재 계좌가치</small><b>${money(p.latest_account_value_usd)}</b></div>`;select.value=p.wallet}
function nearest(x,y){let best=null,dist=Infinity;for(const item of projected){const d=Math.hypot(item.q.x-x,item.q.y-y);if(d<dist){dist=d;best=item.p}}return dist<=18?best:null}
function pointerPos(e){const r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}
function showTip(p,x,y){if(!p){tip.style.display='none';return}const lower=p.trade_count_coverage_status!=='COMPLETE';tip.innerHTML=`<strong>Rank ${p.rank} · ${short(p.wallet)}</strong>수익률 ${fmt(p.return_pct,2)}%<br>MDD ${fmt(p.mdd_pct,2)}%<br>체결 ${lower?'≥ ':''}${fmt(p.trade_count_raw,0)}건`;tip.style.display='block';tip.style.left=Math.min(canvas.clientWidth-270,x+14)+'px';tip.style.top=Math.max(10,y-20)+'px'}
canvas.addEventListener('pointerdown',e=>{drag=true;moved=false;lastX=e.clientX;lastY=e.clientY;canvas.setPointerCapture(e.pointerId);canvas.classList.add('dragging')});
canvas.addEventListener('pointermove',e=>{const p=pointerPos(e);if(drag){const dx=e.clientX-lastX,dy=e.clientY-lastY;if(Math.abs(dx)+Math.abs(dy)>2)moved=true;yaw+=dx*.007;pitch=Math.max(-1.35,Math.min(1.35,pitch+dy*.007));lastX=e.clientX;lastY=e.clientY;tip.style.display='none';draw()}else{hovered=nearest(p.x,p.y);showTip(hovered,p.x,p.y);draw()}});
canvas.addEventListener('pointerup',e=>{if(!moved){const p=pointerPos(e),hit=nearest(p.x,p.y);if(hit){selected=hit;detailView(hit)}}drag=false;canvas.classList.remove('dragging');draw()});canvas.addEventListener('pointercancel',()=>{drag=false;canvas.classList.remove('dragging')});canvas.addEventListener('pointerleave',()=>{if(!drag){hovered=null;tip.style.display='none';draw()}});
canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(.55,Math.min(2.6,zoom*Math.exp(-e.deltaY*.001)));draw()},{passive:false});
document.getElementById('reset').onclick=()=>{yaw=-.68;pitch=.42;zoom=1;draw()};select.innerHTML=points.map(p=>`<option value="${p.wallet}">Rank ${p.rank} · ${short(p.wallet)}</option>`).join('');select.onchange=()=>{selected=points.find(p=>p.wallet===select.value)||points[0];detailView(selected);draw()};
document.getElementById('countLabel').textContent=`${points.length}개 계좌`;const s=data.source;document.getElementById('provenance').textContent=`고정 기준 ${new Date(s.window_end_ms).toLocaleString('ko-KR')} · research only`;detailView(selected);new ResizeObserver(draw).observe(canvas);draw();
})();
</script></body></html>'''
    return template.replace("__DATA__", data)


def apply_presentation_filter(
    dataset: Mapping[str, Any], excluded_ranks: Sequence[int]
) -> dict[str, Any]:
    """Remove display-only outliers while preserving their source ranks."""

    filtered = deepcopy(dataset)
    excluded = {int(rank) for rank in excluded_ranks}
    if any(rank <= 0 for rank in excluded):
        raise ValueError("excluded ranks must be positive integers")
    source_records = list(filtered["records"])
    removed = [row for row in source_records if int(row["rank"]) in excluded]
    missing_ranks = excluded - {int(row["rank"]) for row in removed}
    if missing_ranks:
        raise ValueError("excluded ranks were absent: " + ", ".join(map(str, sorted(missing_ranks))))
    filtered["records"] = [row for row in source_records if int(row["rank"]) not in excluded]
    filtered["record_count"] = len(filtered["records"])
    filtered["plot_record_count"] = sum(bool(row["plot_eligible"]) for row in filtered["records"])
    filtered["presentation_filter"] = {
        "source_qualifying_record_count": len(source_records),
        "excluded_ranks": sorted(excluded),
        "excluded_wallets": [row["wallet"] for row in removed],
        "excluded_returns_pct": [row["return_pct"] for row in removed],
        "axis_domains_recomputed_from_visible_records": True,
        "remaining_ranks_preserved": True,
    }
    if not filtered["records"]:
        raise ValueError("presentation filter removed every record")
    return filtered


def build(
    *,
    report_path: Path = DEFAULT_REPORT,
    cache_dir: Path = DEFAULT_CACHE_ROOT,
    count_path: Path = DEFAULT_COUNTS,
    data_path: Path = DEFAULT_DATA,
    html_path: Path = DEFAULT_HTML,
    excluded_ranks: Sequence[int] = DEFAULT_EXCLUDED_RANKS,
) -> dict[str, Any]:
    report = _read_json(report_path)
    counts = _read_json(count_path)
    enriched = enrich_report(report, cache_dir=cache_dir, count_evidence=counts)
    dataset = build_twr_3d_dataset(enriched)
    if dataset["record_count"] != dataset["plot_record_count"]:
        raise ValueError("not every retained +300% wallet has all three axes")
    dataset = apply_presentation_filter(dataset, excluded_ranks)
    data_path.parent.mkdir(parents=True, exist_ok=True)
    data_path.write_text(json.dumps(dataset, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    html = render_html(dataset)
    html_path.write_text(html, encoding="utf-8")
    return {
        "record_count": dataset["record_count"],
        "data_path": str(data_path),
        "html_path": str(html_path),
        "html_bytes": len(html.encode("utf-8")),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_ROOT)
    parser.add_argument("--counts", type=Path, default=DEFAULT_COUNTS)
    parser.add_argument("--data-output", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--html-output", type=Path, default=DEFAULT_HTML)
    parser.add_argument("--exclude-rank", type=int, action="append", default=list(DEFAULT_EXCLUDED_RANKS))
    args = parser.parse_args(argv)
    print(json.dumps(build(report_path=args.report, cache_dir=args.cache_dir, count_path=args.counts, data_path=args.data_output, html_path=args.html_output, excluded_ranks=args.exclude_rank), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
