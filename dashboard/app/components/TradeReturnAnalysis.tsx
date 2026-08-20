"use client";

import { useEffect, useMemo, useRef } from "react";
import type { AccountValuePoint, TradingEpisode } from "../lib/types";

export interface EpisodeReturnRow {
  id: string;
  coin: string;
  direction: "LONG" | "SHORT";
  entryTime: number;
  exitTime: number;
  capitalBeforeUsd: number;
  netPnlUsd: number;
  returnPct: number;
  cumulativeContributionPct: number;
  drawdownPct: number;
}

export interface TradeReturnSummary {
  rows: EpisodeReturnRow[];
  averageReturnPct: number;
  medianReturnPct: number;
  cumulativeContributionPct: number;
  maxDrawdownPct: number;
  profitFactor: number | null;
  payoffRatio: number | null;
  winRatePct: number;
  bestReturnPct: number;
  worstReturnPct: number;
  longestLossStreak: number;
  coinContributions: Array<{ coin: string; contributionPct: number; netPnlUsd: number; count: number }>;
  directionContributions: Array<{ direction: "LONG" | "SHORT"; contributionPct: number; count: number }>;
}

export interface FlowNeutralPortfolioPerformance {
  points: AccountValuePoint[];
  returnPct: number;
  inferredNetFlowUsd: number;
}

const formatPct = (value: number, digits = 2) =>
  `${value >= 0 ? "+" : ""}${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: digits }).format(value)}%`;

const formatUsd = (value: number, digits = 0) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  }).format(Number.isFinite(value) ? value : 0);

const formatTime = (time: number) =>
  new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(time));

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function accountValueAt(points: AccountValuePoint[], time: number) {
  let previous: number | undefined;
  for (const point of points) {
    if (point.time > time) return previous ?? (point.value > 0 ? point.value : undefined);
    if (point.value > 0 && Number.isFinite(point.value)) previous = point.value;
  }
  return previous;
}

function capitalBasisAt(
  accountValuePoints: AccountValuePoint[],
  pnlPoints: AccountValuePoint[],
  time: number,
) {
  const pnlByTime = new Map(
    pnlPoints.filter((point) => Number.isFinite(point.value)).map((point) => [point.time, point.value]),
  );
  const samples = accountValuePoints
    .filter((point) => point.value > 0 && Number.isFinite(point.value) && pnlByTime.has(point.time))
    .map((point) => ({ time: point.time, accountValue: point.value, pnl: pnlByTime.get(point.time)! }));
  if (samples.length < 2) return accountValueAt(accountValuePoints, time);
  if (time <= samples[0].time) return samples[0].accountValue;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (time > current.time) continue;
    const inferredFlow = current.accountValue - previous.accountValue - (current.pnl - previous.pnl);
    // The public portfolio series is coarse. When a deposit and an entry both
    // occur between two observations, using the pre-deposit dust balance creates
    // absurd returns. Positive inferred flow belongs in the available capital base.
    return inferredFlow > 0 ? previous.accountValue + inferredFlow : previous.accountValue;
  }
  return samples.at(-1)!.accountValue;
}

export function buildFlowNeutralPortfolioPerformance(
  accountValuePoints: AccountValuePoint[],
  pnlPoints: AccountValuePoint[],
): FlowNeutralPortfolioPerformance {
  const pnlByTime = new Map(
    pnlPoints.filter((point) => Number.isFinite(point.value)).map((point) => [point.time, point.value]),
  );
  const samples = [...accountValuePoints]
    .filter((point) => point.value >= 0 && Number.isFinite(point.value) && pnlByTime.has(point.time))
    .sort((left, right) => left.time - right.time)
    .map((point) => ({ time: point.time, accountValue: point.value, pnl: pnlByTime.get(point.time)! }));
  const firstPositiveIndex = samples.findIndex((sample) => sample.accountValue > 0);
  const measuredSamples = firstPositiveIndex >= 0 ? samples.slice(firstPositiveIndex) : [];
  if (measuredSamples.length < 2) return { points: [], returnPct: 0, inferredNetFlowUsd: 0 };

  let curve = 1;
  let inferredNetFlowUsd = 0;
  const points: AccountValuePoint[] = [{ time: measuredSamples[0].time, value: 100 }];
  for (let index = 1; index < measuredSamples.length; index += 1) {
    const previous = measuredSamples[index - 1];
    const current = measuredSamples[index];
    const pnlChange = current.pnl - previous.pnl;
    const inferredFlow = current.accountValue - previous.accountValue - pnlChange;
    inferredNetFlowUsd += inferredFlow;
    if (inferredFlow < 0 && -inferredFlow > previous.accountValue && pnlChange > 0) {
      return { points: [], returnPct: 0, inferredNetFlowUsd };
    }
    const capitalBase = inferredFlow > 0 ? previous.accountValue + inferredFlow : previous.accountValue;
    if (capitalBase <= 0) {
      if (Math.abs(pnlChange) > 1e-9) return { points: [], returnPct: 0, inferredNetFlowUsd };
      points.push({ time: current.time, value: curve * 100 });
      continue;
    }
    const intervalReturn = pnlChange / capitalBase;
    curve = intervalReturn <= -1 ? 0 : curve * (1 + intervalReturn);
    points.push({ time: current.time, value: curve * 100 });
    if (curve === 0) break;
  }
  return { points, returnPct: (curve - 1) * 100, inferredNetFlowUsd };
}

export function buildTradeReturnSummary(
  episodes: TradingEpisode[],
  accountValuePoints: AccountValuePoint[],
  pnlPoints: AccountValuePoint[] = [],
): TradeReturnSummary {
  const sortedPoints = [...accountValuePoints].sort((left, right) => left.time - right.time);
  const completed = episodes
    .filter(
      (episode) =>
        episode.status === "COMPLETED" &&
        episode.entryTime !== undefined &&
        episode.exitTime !== undefined,
    )
    .sort((left, right) => left.exitTime! - right.exitTime!);

  let cumulativeContributionPct = 0;
  let peakContributionPct = 0;
  const rows: EpisodeReturnRow[] = [];
  for (const episode of completed) {
    const capitalBeforeUsd = capitalBasisAt(sortedPoints, pnlPoints, episode.entryTime!);
    if (!capitalBeforeUsd || capitalBeforeUsd <= 0) continue;
    const returnPct = episode.netPnl / capitalBeforeUsd * 100;
    if (!Number.isFinite(returnPct)) continue;
    cumulativeContributionPct += returnPct;
    peakContributionPct = Math.max(peakContributionPct, cumulativeContributionPct);
    rows.push({
      id: episode.id,
      coin: episode.coin,
      direction: episode.direction,
      entryTime: episode.entryTime!,
      exitTime: episode.exitTime!,
      capitalBeforeUsd,
      netPnlUsd: episode.netPnl,
      returnPct,
      cumulativeContributionPct,
      drawdownPct: cumulativeContributionPct - peakContributionPct,
    });
  }

  const returns = rows.map((row) => row.returnPct);
  const wins = rows.filter((row) => row.returnPct > 0);
  const losses = rows.filter((row) => row.returnPct < 0);
  const grossProfit = rows.reduce((sum, row) => sum + Math.max(row.netPnlUsd, 0), 0);
  const grossLoss = Math.abs(rows.reduce((sum, row) => sum + Math.min(row.netPnlUsd, 0), 0));
  const averageWin = wins.length > 0 ? wins.reduce((sum, row) => sum + row.returnPct, 0) / wins.length : 0;
  const averageLoss = losses.length > 0 ? Math.abs(losses.reduce((sum, row) => sum + row.returnPct, 0) / losses.length) : 0;
  let currentLossStreak = 0;
  let longestLossStreak = 0;
  for (const row of rows) {
    currentLossStreak = row.returnPct < 0 ? currentLossStreak + 1 : 0;
    longestLossStreak = Math.max(longestLossStreak, currentLossStreak);
  }

  const byCoin = new Map<string, { contributionPct: number; netPnlUsd: number; count: number }>();
  const byDirection = new Map<"LONG" | "SHORT", { contributionPct: number; count: number }>();
  for (const row of rows) {
    const coin = byCoin.get(row.coin) ?? { contributionPct: 0, netPnlUsd: 0, count: 0 };
    coin.contributionPct += row.returnPct;
    coin.netPnlUsd += row.netPnlUsd;
    coin.count += 1;
    byCoin.set(row.coin, coin);
    const direction = byDirection.get(row.direction) ?? { contributionPct: 0, count: 0 };
    direction.contributionPct += row.returnPct;
    direction.count += 1;
    byDirection.set(row.direction, direction);
  }

  return {
    rows,
    averageReturnPct: rows.length > 0 ? returns.reduce((sum, value) => sum + value, 0) / rows.length : 0,
    medianReturnPct: median(returns),
    cumulativeContributionPct,
    maxDrawdownPct: Math.abs(Math.min(0, ...rows.map((row) => row.drawdownPct))),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    payoffRatio: averageLoss > 0 ? averageWin / averageLoss : averageWin > 0 ? null : 0,
    winRatePct: rows.length > 0 ? wins.length / rows.length * 100 : 0,
    bestReturnPct: rows.length > 0 ? Math.max(...returns) : 0,
    worstReturnPct: rows.length > 0 ? Math.min(...returns) : 0,
    longestLossStreak,
    coinContributions: [...byCoin.entries()]
      .map(([coin, value]) => ({ coin, ...value }))
      .sort((left, right) => Math.abs(right.contributionPct) - Math.abs(left.contributionPct)),
    directionContributions: (["LONG", "SHORT"] as const).map((direction) => ({
      direction,
      contributionPct: byDirection.get(direction)?.contributionPct ?? 0,
      count: byDirection.get(direction)?.count ?? 0,
    })),
  };
}

function EpisodeReturnChart({ rows }: { rows: EpisodeReturnRow[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      if (rows.length === 0) return;

      const padX = 12;
      const top = 12;
      const lineBottom = rect.height * 0.58;
      const barTop = rect.height * 0.7;
      const barBottom = rect.height - 12;
      const width = Math.max(1, rect.width - padX * 2);
      const cumulativeValues = [0, ...rows.map((row) => row.cumulativeContributionPct)];
      const cumulativeMin = Math.min(...cumulativeValues);
      const cumulativeMax = Math.max(...cumulativeValues);
      const cumulativeRange = Math.max(cumulativeMax - cumulativeMin, 0.01);
      const xAt = (index: number) => padX + index / Math.max(rows.length - 1, 1) * width;
      const lineY = (value: number) => top + (1 - (value - cumulativeMin) / cumulativeRange) * (lineBottom - top);

      context.strokeStyle = "rgba(229,255,220,.08)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(padX, lineBottom + 8);
      context.lineTo(rect.width - padX, lineBottom + 8);
      context.stroke();

      const fill = context.createLinearGradient(0, top, 0, lineBottom);
      fill.addColorStop(0, "rgba(181,255,92,.22)");
      fill.addColorStop(1, "rgba(181,255,92,0)");
      context.beginPath();
      rows.forEach((row, index) => {
        const x = xAt(index);
        const y = lineY(row.cumulativeContributionPct);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.lineTo(xAt(rows.length - 1), lineBottom);
      context.lineTo(xAt(0), lineBottom);
      context.closePath();
      context.fillStyle = fill;
      context.fill();

      context.beginPath();
      rows.forEach((row, index) => {
        const x = xAt(index);
        const y = lineY(row.cumulativeContributionPct);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.strokeStyle = "#b5ff5c";
      context.lineWidth = 1.75;
      context.lineJoin = "round";
      context.stroke();

      const maxAbsoluteReturn = Math.max(...rows.map((row) => Math.abs(row.returnPct)), 0.01);
      const barWidth = Math.max(1, Math.min(8, width / Math.max(rows.length, 1) * 0.72));
      const zeroY = (barTop + barBottom) / 2;
      context.strokeStyle = "rgba(229,255,220,.12)";
      context.beginPath();
      context.moveTo(padX, zeroY);
      context.lineTo(rect.width - padX, zeroY);
      context.stroke();
      rows.forEach((row, index) => {
        const magnitude = Math.abs(row.returnPct) / maxAbsoluteReturn * (barBottom - barTop) / 2;
        const x = xAt(index) - barWidth / 2;
        const y = row.returnPct >= 0 ? zeroY - magnitude : zeroY;
        context.fillStyle = row.returnPct >= 0 ? "rgba(181,255,92,.82)" : "rgba(255,111,135,.82)";
        context.fillRect(x, y, barWidth, Math.max(1, magnitude));
      });
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [rows]);

  return <canvas ref={canvasRef} className="episode-return-chart" aria-label="거래별 수익률 막대와 누적 자본 기여율 그래프" />;
}

export default function TradeReturnAnalysis({
  episodes,
  accountValuePoints,
  pnlPoints,
}: {
  episodes: TradingEpisode[];
  accountValuePoints: AccountValuePoint[];
  pnlPoints: AccountValuePoint[];
}) {
  const summary = useMemo(
    () => buildTradeReturnSummary(episodes, accountValuePoints, pnlPoints),
    [accountValuePoints, episodes, pnlPoints],
  );
  const contributionScale = Math.max(
    ...summary.coinContributions.slice(0, 6).map((row) => Math.abs(row.contributionPct)),
    0.01,
  );

  return (
    <section className="return-analysis-card" aria-label="입출금 제외 거래별 자본 수익률 분석">
      <div className="return-analysis-header">
        <div>
          <span className="eyebrow">FLOW-NEUTRAL TRADE RETURNS</span>
          <h3>거래당 자본 상승률</h3>
          <p>완료 포지션 1회 기준 · 순손익(수수료 포함) ÷ 입출금 보정 진입 자본</p>
        </div>
        <strong className={summary.cumulativeContributionPct >= 0 ? "pnl-positive" : "pnl-negative"}>
          {formatPct(summary.cumulativeContributionPct)}
          <small>누적 거래 기여도</small>
        </strong>
      </div>

      {summary.rows.length === 0 ? (
        <div className="return-analysis-empty">계좌가치와 연결할 수 있는 완료 포지션이 없습니다.</div>
      ) : (
        <>
          <EpisodeReturnChart rows={summary.rows} />
          <div className="return-chart-legend">
            <span><i className="is-line" />누적 기여도</span>
            <span><i className="is-win" />거래 이익률</span>
            <span><i className="is-loss" />거래 손실률</span>
          </div>

          <div className="return-metric-grid">
            <div><span>평균 / 중앙값</span><strong>{formatPct(summary.averageReturnPct)} / {formatPct(summary.medianReturnPct)}</strong></div>
            <div><span>승률 / 손익비</span><strong>{formatPct(summary.winRatePct, 1)} / {summary.payoffRatio === null ? "∞" : summary.payoffRatio.toFixed(2)}</strong></div>
            <div><span>Profit Factor</span><strong>{summary.profitFactor === null ? "∞" : summary.profitFactor.toFixed(2)}</strong></div>
            <div><span>거래곡선 MDD</span><strong className="pnl-negative">-{summary.maxDrawdownPct.toFixed(2)}%</strong></div>
            <div><span>최고 / 최저</span><strong>{formatPct(summary.bestReturnPct)} / {formatPct(summary.worstReturnPct)}</strong></div>
            <div><span>최장 연속손실</span><strong>{summary.longestLossStreak}회</strong></div>
          </div>

          <div className="return-breakdowns">
            <div>
              <h4>코인별 자본 기여도</h4>
              {summary.coinContributions.slice(0, 6).map((row) => (
                <div className="contribution-row" key={row.coin}>
                  <span>{row.coin}<small>{row.count}회</small></span>
                  <i><b className={row.contributionPct >= 0 ? "is-positive" : "is-negative"} style={{ width: `${Math.max(3, Math.abs(row.contributionPct) / contributionScale * 100)}%` }} /></i>
                  <strong className={row.contributionPct >= 0 ? "pnl-positive" : "pnl-negative"}>{formatPct(row.contributionPct)}</strong>
                </div>
              ))}
            </div>
            <div>
              <h4>방향별 분석</h4>
              {summary.directionContributions.map((row) => (
                <div className="direction-stat" key={row.direction}>
                  <span>{row.direction}</span><strong className={row.contributionPct >= 0 ? "pnl-positive" : "pnl-negative"}>{formatPct(row.contributionPct)}</strong><small>{row.count}회</small>
                </div>
              ))}
            </div>
          </div>

          <div className="episode-return-table" role="table" aria-label="완료 거래별 자본 수익률 목록">
            <div className="episode-return-row episode-return-row--head" role="row">
              <span>청산 시각</span><span>포지션</span><span>진입 자본</span><span>순손익</span><span>자본 상승률</span><span>누적</span>
            </div>
            <div className="episode-return-table__body">
              {[...summary.rows].reverse().map((row) => (
                <div className="episode-return-row" role="row" key={row.id}>
                  <span>{formatTime(row.exitTime)}</span>
                  <span><strong>{row.coin}</strong><small>{row.direction}</small></span>
                  <span>{formatUsd(row.capitalBeforeUsd, 0)}</span>
                  <span className={row.netPnlUsd >= 0 ? "pnl-positive" : "pnl-negative"}>{formatUsd(row.netPnlUsd, 2)}</span>
                  <span className={row.returnPct >= 0 ? "pnl-positive" : "pnl-negative"}>{formatPct(row.returnPct)}</span>
                  <span>{formatPct(row.cumulativeContributionPct)}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="return-analysis-note">입출금은 순손익에 포함되지 않습니다. 여러 포지션이 겹칠 수 있어 아래 누적값은 복리 수익률이 아닌 거래별 자본 기여율의 단순 합이며, 상단 계좌곡선의 복리 성장률과는 별도 지표입니다.</p>
        </>
      )}
    </section>
  );
}
