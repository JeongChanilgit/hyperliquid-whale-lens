"use client";

import { useMemo, useState } from "react";
import type { CopyAccountEquityPoint } from "../lib/copy-types";

export type CopyTradingMode = "paper" | "live";

export type WhaleConnectionStatus =
  | "connected"
  | "connecting"
  | "delayed"
  | "offline";

export type CopyTradingWhale = {
  id: string;
  label: string;
  enabled: boolean;
  connectionStatus: WhaleConnectionStatus;
  latencyMs?: number | null;
  roi30d?: number | null;
  pnl?: number | null;
  openOrderCount?: number;
  lastActivityAt?: string | null;
  accountValueUsd?: number | null;
  followerAccountValueUsd?: number | null;
  sizingCoin?: string | null;
  sourcePositionNotionalUsd?: number | null;
  sourceExposurePct?: number | null;
  targetNotionalUsd?: number | null;
  requestedTargetNotionalUsd?: number | null;
  allocatedCapitalUsd?: number | null;
  sizingStateFresh?: boolean;
  followerLeverage?: number | null;
  leverageCapped?: boolean;
  syncedPositionCount?: number;
  waitingForNewPosition?: boolean;
  ignoredExistingPositionCount?: number;
  closeAll?: boolean;
  startupSnapshot?: boolean;
};

export type CopyTradingOrderStatus =
  | "pending"
  | "open"
  | "filled"
  | "rejected"
  | "cancelled";

export type CopyTradingOrder = {
  id: string;
  whaleId: string;
  symbol: string;
  side: "long" | "short";
  status: CopyTradingOrderStatus;
  size: number;
  remainingSize?: number | null;
  sourceSize?: number | null;
  price?: number | null;
  createdAt: string;
  segment?: "ENTRY" | "ADD" | "REDUCE" | "CLOSE";
  orderAction?: "PLACED" | "MODIFIED" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "REJECTED" | "TRIGGERED" | "IGNORED";
  orderType?: string;
  tif?: string;
  reduceOnly?: boolean;
  metadataComplete?: boolean;
  leverageCapped?: boolean;
  closeAll?: boolean;
  /** True when the order was observed in the source startup snapshot. */
  startupSnapshot?: boolean;
};

export type CopyTradingFailureLog = {
  id: string;
  occurredAt: string;
  whaleId?: string | null;
  severity: "warning" | "error";
  code: string;
  message: string;
};

export type CopyTradingSafetyGate = {
  serverConnected: boolean;
  environmentValidated: boolean;
  executionApproved: boolean;
  message?: string | null;
};

export type CopyTradingPanelProps = {
  mode: CopyTradingMode;
  sessionMode?: "SIMULATION" | "HYPERLIQUID" | null;
  isRunning: boolean;
  whales: CopyTradingWhale[];
  totalPnl: number;
  orders: CopyTradingOrder[];
  equityHistory?: CopyAccountEquityPoint[];
  failureLogs: CopyTradingFailureLog[];
  safetyGate: CopyTradingSafetyGate;
  connectionDelayMs?: number | null;
  currency?: string;
  loading?: boolean;
  marginPerWhaleUsd?: number | null;
  onModeChange?: (mode: CopyTradingMode) => void;
  onWhaleEnabledChange?: (whaleId: string, enabled: boolean) => void;
  onStart?: () => void;
  onStop?: () => void;
  onSizingApply?: (marginPerWhaleUsd: number) => void;
};

const statusLabel: Record<WhaleConnectionStatus, string> = {
  connected: "연결됨",
  connecting: "연결 중",
  delayed: "지연됨",
  offline: "오프라인",
};

const orderStatusLabel: Record<CopyTradingOrderStatus, string> = {
  pending: "대기",
  open: "진행 중",
  filled: "체결",
  rejected: "거절됨",
  cancelled: "취소됨",
};

const segmentLabel = {
  ENTRY: "진입",
  ADD: "추가진입",
  REDUCE: "부분청산",
  CLOSE: "청산",
} as const;

const mirrorActionLabel = {
  PLACED: "지정가 등록",
  MODIFIED: "주문 수정",
  PARTIALLY_FILLED: "부분체결",
  FILLED: "전체체결",
  CANCELED: "주문 취소",
  REJECTED: "주문 거절",
  TRIGGERED: "조건 발동",
  IGNORED: "상태 확인",
} as const;

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatSignedCurrency(value: number, currency: string): string {
  return `${value > 0 ? "+" : ""}${formatCurrency(value, currency)}`;
}

function formatCompactCurrency(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 8 }).format(value);
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "기록 없음";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatChartTime(value: number): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function accountReturn(value: number, initial: number): number {
  return initial > 0 ? (value - initial) / initial * 100 : 0;
}

function orderActionText(order: CopyTradingOrder): string {
  if (order.startupSnapshot && order.orderAction === "PLACED") return "시작 시 승계 주문";
  if (order.orderAction) return mirrorActionLabel[order.orderAction];
  if (order.segment) return segmentLabel[order.segment];
  return order.side === "long" ? "롱 주문" : "숏 주문";
}

function AccountEquityChart({
  points,
  currency,
}: {
  points: Array<{ time: number; value: number }>;
  currency: string;
}) {
  if (points.length === 0) {
    return (
      <div className="copy-trading-panel__curve-empty">
        <strong>계좌 기록을 기다리는 중</strong>
        <span>runner가 다음 상태를 저장하면 곡선이 시작됩니다.</span>
      </div>
    );
  }

  const plotted = points.length === 1
    ? [points[0], { time: points[0].time + 1, value: points[0].value }]
    : points;
  const width = 760;
  const height = 238;
  const padX = 16;
  const padY = 18;
  const values = plotted.map((point) => point.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const spread = Math.max(rawMax - rawMin, Math.max(Math.abs(rawMax), 1) * 0.012);
  const min = rawMin - spread * 0.22;
  const max = rawMax + spread * 0.22;
  const firstTime = plotted[0].time;
  const lastTime = plotted.at(-1)?.time ?? firstTime + 1;
  const timeSpan = Math.max(lastTime - firstTime, 1);
  const x = (time: number) => padX + (time - firstTime) / timeSpan * (width - padX * 2);
  const y = (value: number) => padY + (max - value) / Math.max(max - min, 1) * (height - padY * 2);
  const line = plotted.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.time).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
  const area = `${line} L${x(lastTime).toFixed(2)},${height - padY} L${x(firstTime).toFixed(2)},${height - padY} Z`;
  const rising = plotted.at(-1)!.value >= plotted[0].value;
  const last = plotted.at(-1)!;

  return (
    <div className={`copy-trading-panel__curve ${rising ? "is-rising" : "is-falling"}`}>
      <div className="copy-trading-panel__curve-axis" aria-hidden="true">
        <span>{formatCompactCurrency(max, currency)}</span>
        <span>{formatCompactCurrency((max + min) / 2, currency)}</span>
        <span>{formatCompactCurrency(min, currency)}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`계좌가치 변화, 현재 ${formatCurrency(last.value, currency)}`} preserveAspectRatio="none">
        {[0.16, 0.5, 0.84].map((ratio) => (
          <line key={ratio} x1={padX} x2={width - padX} y1={height * ratio} y2={height * ratio} />
        ))}
        <path className="copy-trading-panel__curve-area" d={area} />
        <path className="copy-trading-panel__curve-line" d={line} />
        <circle cx={x(last.time)} cy={y(last.value)} r="4.5" />
      </svg>
      <div className="copy-trading-panel__curve-time">
        <span>{formatChartTime(firstTime)}</span>
        <span>{formatChartTime(lastTime)}</span>
      </div>
    </div>
  );
}

export default function CopyTradingPanel({
  mode,
  sessionMode = null,
  isRunning,
  whales,
  totalPnl,
  orders,
  equityHistory = [],
  failureLogs,
  safetyGate,
  connectionDelayMs = null,
  currency = "USD",
  loading = false,
  marginPerWhaleUsd = null,
  onModeChange,
  onWhaleEnabledChange,
  onStart,
  onStop,
  onSizingApply,
}: CopyTradingPanelProps) {
  const [marginDraft, setMarginDraft] = useState(String(marginPerWhaleUsd ?? 100));
  const parsedMargin = Number(marginDraft);
  const sizingDraftValid = Number.isFinite(parsedMargin) && parsedMargin >= 1;
  const liveUnlocked =
    safetyGate.serverConnected &&
    safetyGate.environmentValidated &&
    safetyGate.executionApproved;
  const sessionMatchesMode = sessionMode === null || sessionMode === (mode === "paper" ? "SIMULATION" : "HYPERLIQUID");
  const enabledWhales = whales.filter((whale) => whale.enabled);
  const readyWhales = enabledWhales.filter(
    (whale) => whale.connectionStatus === "connected",
  );
  const startBlocked =
    loading ||
    enabledWhales.length === 0 ||
    (mode === "live" && !liveUnlocked);
  const startBlockReason =
    mode === "live" && !liveUnlocked
      ? safetyGate.message || "서버 연결과 환경 검증이 완료되어야 실전 실행을 시작할 수 있습니다."
      : enabledWhales.length === 0
        ? "활성 고래가 없어 시작할 수 없습니다."
        : null;

  const whaleNameById = useMemo(
    () => new Map(whales.map((whale) => [whale.id, whale.label])),
    [whales],
  );
  const [selectedWhaleId, setSelectedWhaleId] = useState("all");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const effectiveWhaleId = selectedWhaleId === "all" || whales.some((whale) => whale.id === selectedWhaleId)
    ? selectedWhaleId
    : "all";
  const focusedWhales = effectiveWhaleId === "all"
    ? whales
    : whales.filter((whale) => whale.id === effectiveWhaleId);
  const focusedWhaleIds = new Set(focusedWhales.map((whale) => whale.id));
  const initialCapital = focusedWhales.reduce((sum, whale) => sum + (whale.allocatedCapitalUsd ?? 0), 0);
  const currentAccountValue = focusedWhales.reduce(
    (sum, whale) => sum + (whale.followerAccountValueUsd ?? whale.allocatedCapitalUsd ?? 0),
    0,
  );
  const focusedRealizedPnl = focusedWhales.reduce((sum, whale) => sum + (whale.pnl ?? 0), 0);
  const equityPnl = currentAccountValue - initialCapital;
  const equityReturn = accountReturn(currentAccountValue, initialCapital);
  const accountSeries = (() => {
    const byTime = new Map<number, number>();
    for (const point of equityHistory) {
      const whale = point.whale.toLowerCase();
      if (!focusedWhaleIds.has(whale) || !Number.isFinite(point.accountValueUsd)) continue;
      byTime.set(point.time, (byTime.get(point.time) ?? 0) + point.accountValueUsd);
    }
    const latestHistoryTime = Math.max(0, ...byTime.keys());
    if (latestHistoryTime > 0 && Number.isFinite(currentAccountValue) && currentAccountValue > 0) {
      byTime.set(latestHistoryTime + 1, currentAccountValue);
    }
    return [...byTime.entries()]
      .sort(([left], [right]) => left - right)
      .map(([time, value]) => ({ time, value }));
  })();
  const filteredOrders = orders
    .filter((order) => effectiveWhaleId === "all" || order.whaleId === effectiveWhaleId)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  const selectedOrder = filteredOrders.find((order) => order.id === selectedOrderId) ?? filteredOrders[0] ?? null;

  return (
    <section className="copy-trading-panel" aria-label="카피 트레이딩 제어 패널">
      <header className="copy-trading-panel__header">
        <div>
          <p className="copy-trading-panel__eyebrow">COPY TRADING</p>
          <h2>고래 추적 실행 패널</h2>
          <p className="copy-trading-panel__subcopy" aria-live="polite">
            {isRunning
              ? `${mode === "paper" ? "모의" : "실전"} 복사가 실행 중입니다.`
              : "실행 대기 중입니다."}
          </p>
        </div>
        <div className="copy-trading-panel__mode" role="group" aria-label="거래 모드">
          <button
            type="button"
            className={mode === "paper" ? "is-active" : undefined}
            aria-pressed={mode === "paper"}
            disabled={loading || !onModeChange}
            onClick={() => onModeChange?.("paper")}
          >
            모의투자
          </button>
          <button
            type="button"
            className={mode === "live" ? "is-active is-live" : "is-live"}
            aria-pressed={mode === "live"}
            aria-describedby={!liveUnlocked ? "copy-trading-live-lock" : undefined}
            disabled={loading || !onModeChange || (!liveUnlocked && mode !== "live")}
            onClick={() => onModeChange?.("live")}
          >
            실전투자
          </button>
        </div>
      </header>

      {!sessionMatchesMode ? (
        <p className="copy-trading-panel__live-lock" role="status">
          현재 {sessionMode === "SIMULATION" ? "모의" : "실전"} 세션 데이터는 이 탭에 표시하지 않습니다.
        </p>
      ) : null}

      {mode === "live" ? (
        <p className="copy-trading-panel__live-notice">
          이 탭의 주문·수량·손익은 소스 이벤트로 계산한 예정/추정값입니다. 실제 target 주문 상태·체결·수수료·펀딩·PnL과 동일하다고 간주하지 않습니다.
        </p>
      ) : null}

      {mode === "live" && !liveUnlocked ? (
        <p id="copy-trading-live-lock" className="copy-trading-panel__live-lock" role="status">
          실전투자는 안전 게이트가 열릴 때까지 비활성화됩니다. 브라우저에 거래 키를 입력하거나 저장하지 않습니다.
        </p>
      ) : null}

      {mode === "paper" ? (
        <div className="copy-trading-panel__sizing">
          <label>
            <span>고래당 증거금</span>
            <div><b>$</b><input aria-label="고래당 모의 증거금" type="number" min="1" step="100" value={marginDraft} onChange={(event) => setMarginDraft(event.target.value)} /></div>
          </label>
          <p>고래 주문수량 × (우리 현재자산 ÷ 고래 현재자산)으로 주문을 복제하고, cross/isolated와 레버리지도 고래의 현재 설정을 그대로 사용합니다.</p>
          <button type="button" disabled={loading || !sizingDraftValid || !onSizingApply} onClick={() => onSizingApply?.(parsedMargin)}>
            설정 적용
          </button>
        </div>
      ) : null}

      <div className="copy-trading-panel__metrics">
        <article className="copy-trading-panel__metric">
          <span>{mode === "paper" ? "총 PnL" : "추정 PnL"}</span>
          <strong className={totalPnl >= 0 ? "is-positive" : "is-negative"}>
            {formatSignedCurrency(totalPnl, currency)}
          </strong>
          <small>{mode === "paper" ? "모의 체결 기준" : "소스 체결 기준 · 실제 target PnL 아님"}</small>
        </article>
        <article className="copy-trading-panel__metric">
          <span>활성 고래</span>
          <strong>{enabledWhales.length} / {whales.length}</strong>
          <small>{readyWhales.length}개 실시간 연결</small>
        </article>
        <article className="copy-trading-panel__metric">
          <span>연결 지연</span>
          <strong>{connectionDelayMs === null ? "—" : `${connectionDelayMs}ms`}</strong>
          <small>{connectionDelayMs !== null && connectionDelayMs > 2_000 ? "확인 필요" : "최근 동기화"}</small>
        </article>
        <article className="copy-trading-panel__metric">
          <span>주문 / 실패</span>
          <strong>{orders.length} / {failureLogs.length}</strong>
          <small>현재 세션 기록</small>
        </article>
      </div>

      <div className="copy-trading-panel__analysis">
        <section className="copy-trading-panel__account" aria-labelledby="copy-trading-account-heading">
          <div className="copy-trading-panel__section-heading copy-trading-panel__section-heading--stacked">
            <div>
              <p className="copy-trading-panel__eyebrow">ACCOUNT CURVE</p>
              <h3 id="copy-trading-account-heading">{mode === "paper" ? "계좌 변화" : "추정 계좌 변화"}</h3>
            </div>
            <div className="copy-trading-panel__account-filter" role="group" aria-label="계좌 곡선 고래 선택">
              <button type="button" className={effectiveWhaleId === "all" ? "is-active" : ""} onClick={() => setSelectedWhaleId("all")}>전체</button>
              {whales.map((whale) => (
                <button type="button" key={whale.id} className={effectiveWhaleId === whale.id ? "is-active" : ""} onClick={() => setSelectedWhaleId(whale.id)}>
                  {whale.label}
                </button>
              ))}
            </div>
          </div>

          <div className="copy-trading-panel__account-headline">
            <div>
              <span>{effectiveWhaleId === "all" ? (mode === "paper" ? "전체 모의지갑 합계" : "전체 추정 계정 합계") : whaleNameById.get(effectiveWhaleId)}</span>
              <strong>{formatCurrency(currentAccountValue, currency)}</strong>
            </div>
            <em className={equityPnl >= 0 ? "is-positive" : "is-negative"}>
              {equityPnl >= 0 ? "+" : ""}{equityReturn.toFixed(2)}%
            </em>
          </div>

          <AccountEquityChart points={accountSeries} currency={currency} />

          <dl className="copy-trading-panel__account-stats">
            <div><dt>시작 자산</dt><dd>{formatCurrency(initialCapital, currency)}</dd></div>
            <div><dt>계좌 손익</dt><dd className={equityPnl >= 0 ? "is-positive" : "is-negative"}>{formatSignedCurrency(equityPnl, currency)}</dd></div>
            <div><dt>실현 손익</dt><dd className={focusedRealizedPnl >= 0 ? "is-positive" : "is-negative"}>{formatSignedCurrency(focusedRealizedPnl, currency)}</dd></div>
            <div><dt>데이터 포인트</dt><dd>{accountSeries.length.toLocaleString("ko-KR")}개</dd></div>
          </dl>
        </section>

        <section className="copy-trading-panel__ledger" aria-labelledby="copy-trading-ledger-heading">
          <div className="copy-trading-panel__section-heading">
            <div>
              <p className="copy-trading-panel__eyebrow">TRADE HISTORY</p>
              <h3 id="copy-trading-ledger-heading">거래내역</h3>
            </div>
            <span>{filteredOrders.length}건</span>
          </div>

          {selectedOrder ? (
            <article className={`copy-trading-panel__selected-order is-${selectedOrder.side}`}>
              <div>
                <span>{whaleNameById.get(selectedOrder.whaleId) || selectedOrder.whaleId}</span>
                <strong>{selectedOrder.symbol}</strong>
                <small>{orderActionText(selectedOrder)} · {formatDateTime(selectedOrder.createdAt)}</small>
              </div>
              <dl>
                <div><dt>가격</dt><dd>{selectedOrder.price == null ? "시장가" : formatCurrency(selectedOrder.price, currency)}</dd></div>
                <div><dt>{mode === "paper" ? "모의 복제수량" : "예정 복제수량"}</dt><dd>{selectedOrder.closeAll ? "전체 포지션" : formatQuantity(selectedOrder.size)}</dd></div>
                <div><dt>고래 원본</dt><dd>{formatQuantity(selectedOrder.sourceSize)}</dd></div>
                <div><dt>소스 기준 잔량</dt><dd>{formatQuantity(selectedOrder.remainingSize)}</dd></div>
              </dl>
              <div className="copy-trading-panel__selected-tags">
                <span className={selectedOrder.side === "long" ? "is-positive" : "is-negative"}>{selectedOrder.side === "long" ? "LONG / BUY" : "SHORT / SELL"}</span>
                <span>{selectedOrder.orderType || "주문"}{selectedOrder.tif ? ` / ${selectedOrder.tif}` : ""}</span>
                {selectedOrder.reduceOnly ? <span>Reduce Only</span> : null}
                {selectedOrder.startupSnapshot ? <span>세션 전 승계</span> : null}
                <span className={`copy-trading-panel__order-status is-${selectedOrder.status}`}>{orderStatusLabel[selectedOrder.status]}</span>
              </div>
            </article>
          ) : (
            <div className="copy-trading-panel__selected-order copy-trading-panel__selected-order--empty">아직 선택할 거래가 없습니다.</div>
          )}

          <div className="copy-trading-panel__ledger-list" aria-label="복사 거래 목록">
            {filteredOrders.length === 0 ? (
              <p className="copy-trading-panel__empty">첫 복사 주문이 발생하면 여기에 거래 흐름이 기록됩니다.</p>
            ) : filteredOrders.map((order) => (
              <button
                type="button"
                key={order.id}
                className={`copy-trading-panel__ledger-row ${selectedOrder?.id === order.id ? "is-selected" : ""}`}
                onClick={() => setSelectedOrderId(order.id)}
              >
                <span>{formatDateTime(order.createdAt)}</span>
                <span><strong>{order.symbol}</strong><small>{whaleNameById.get(order.whaleId) || order.whaleId}</small></span>
                <span className={order.side === "long" ? "is-positive" : "is-negative"}><strong>{orderActionText(order)}</strong><small>{formatQuantity(order.size)}개</small></span>
                <span className={`copy-trading-panel__order-status is-${order.status}`}>{orderStatusLabel[order.status]}</span>
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className="copy-trading-panel__body">
        <section className="copy-trading-panel__whales" aria-labelledby="copy-trading-whales-heading">
          <div className="copy-trading-panel__section-heading">
            <div>
              <p className="copy-trading-panel__eyebrow">WATCHLIST</p>
              <h3 id="copy-trading-whales-heading">추적 고래</h3>
            </div>
            <span>{whales.length}개 지갑</span>
          </div>

          <div className="copy-trading-panel__whale-list">
            {whales.length === 0 ? (
              <p className="copy-trading-panel__empty">표시할 고래 지갑이 없습니다.</p>
            ) : (
              whales.map((whale) => (
                <article className="copy-trading-panel__whale" key={whale.id}>
                  <div className="copy-trading-panel__whale-main">
                    <span
                      className={`copy-trading-panel__connection copy-trading-panel__connection--${whale.connectionStatus}`}
                      aria-label={`연결 상태: ${statusLabel[whale.connectionStatus]}`}
                    />
                    <div>
                      <strong>{whale.label}</strong>
                      <p>
                        {statusLabel[whale.connectionStatus]}
                        {whale.latencyMs !== null && whale.latencyMs !== undefined
                          ? ` · ${whale.latencyMs}ms`
                          : ""}
                        {whale.lastActivityAt ? ` · ${formatDateTime(whale.lastActivityAt)}` : ""}
                      </p>
                    </div>
                  </div>
                  <dl className="copy-trading-panel__whale-stats">
                    <div>
                      <dt>고래 자산</dt>
                      <dd>{formatCompactCurrency(whale.accountValueUsd, currency)}</dd>
                    </div>
                    <div>
                      <dt>{whale.sizingCoin ? `${whale.sizingCoin} 포지션` : "포지션 비중"}</dt>
                      <dd className={whale.sizingStateFresh ? "is-positive" : "is-warning"}>
                        {whale.sourceExposurePct === 0 && whale.sourcePositionNotionalUsd === 0
                          ? "포지션 없음"
                          : whale.sourceExposurePct === null || whale.sourceExposurePct === undefined
                            ? "대기"
                            : `${whale.sourceExposurePct.toFixed(1)}%`}
                        {whale.sourcePositionNotionalUsd !== null && whale.sourcePositionNotionalUsd !== undefined
                          && !(whale.sourceExposurePct === 0 && whale.sourcePositionNotionalUsd === 0)
                          ? <small>{formatCompactCurrency(whale.sourcePositionNotionalUsd, currency)}</small>
                          : null}
                      </dd>
                    </div>
                    <div>
                      <dt>우리 목표</dt>
                      <dd>
                        {whale.waitingForNewPosition
                          ? "신규·추가 진입 대기"
                          : formatCompactCurrency(whale.targetNotionalUsd, currency)}
                        {!whale.waitingForNewPosition && whale.followerLeverage !== null && whale.followerLeverage !== undefined
                          ? <small>{whale.followerLeverage.toFixed(2)}x{whale.leverageCapped ? " · 상한 적용" : ""}</small>
                          : null}
                        {whale.waitingForNewPosition && (whale.ignoredExistingPositionCount ?? 0) > 0
                          ? <small>기존 포지션 {whale.ignoredExistingPositionCount}개 제외</small>
                          : null}
                        {whale.syncedPositionCount
                          ? <small>기존 포지션 {whale.syncedPositionCount}개 동기화</small>
                          : null}
                        {whale.leverageCapped && whale.requestedTargetNotionalUsd
                          ? <small>고래 목표 {formatCompactCurrency(whale.requestedTargetNotionalUsd, currency)}</small>
                          : null}
                      </dd>
                    </div>
                    <div>
                      <dt>우리 현재자산</dt>
                      <dd>
                        {formatCompactCurrency(whale.followerAccountValueUsd ?? whale.allocatedCapitalUsd, currency)}
                        {whale.allocatedCapitalUsd !== null && whale.allocatedCapitalUsd !== undefined
                          ? <small>시작 {formatCompactCurrency(whale.allocatedCapitalUsd, currency)}</small>
                          : null}
                      </dd>
                    </div>
                    <div>
                      <dt>모의 PnL</dt>
                      <dd className={(whale.pnl ?? 0) >= 0 ? "is-positive" : "is-negative"}>
                        {whale.pnl === null || whale.pnl === undefined ? "—" : formatSignedCurrency(whale.pnl, currency)}
                      </dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    className={`copy-trading-panel__switch ${whale.enabled ? "is-on" : ""}`}
                    role="switch"
                    aria-checked={whale.enabled}
                    aria-label={`${whale.label} 추적 ${whale.enabled ? "중지" : "시작"}`}
                    disabled={loading || !onWhaleEnabledChange}
                    onClick={() => onWhaleEnabledChange?.(whale.id, !whale.enabled)}
                  >
                    <span />
                  </button>
                </article>
              ))
            )}
          </div>
        </section>

        <aside className="copy-trading-panel__safety" aria-labelledby="copy-trading-safety-heading">
          <div className="copy-trading-panel__section-heading">
            <div>
              <p className="copy-trading-panel__eyebrow">SAFETY GATE</p>
              <h3 id="copy-trading-safety-heading">실전 실행 조건</h3>
            </div>
            <span className={liveUnlocked ? "is-positive" : "is-warning"}>
              {liveUnlocked ? "준비됨" : "잠김"}
            </span>
          </div>
          <ul className="copy-trading-panel__gate-list">
            <li className={safetyGate.serverConnected ? "is-passed" : "is-blocked"}>
              <span aria-hidden="true" />서버 연결
              <b>{safetyGate.serverConnected ? "통과" : "대기"}</b>
            </li>
            <li className={safetyGate.environmentValidated ? "is-passed" : "is-blocked"}>
              <span aria-hidden="true" />환경 검증
              <b>{safetyGate.environmentValidated ? "통과" : "대기"}</b>
            </li>
            <li className={safetyGate.executionApproved ? "is-passed" : "is-blocked"}>
              <span aria-hidden="true" />명시적 실행 승인
              <b>{safetyGate.executionApproved ? "통과" : "대기"}</b>
            </li>
          </ul>
          <p className="copy-trading-panel__safety-note">
            {safetyGate.message || "실전 주문은 서버 측 서명과 검증을 통과한 경우에만 전송됩니다."}
          </p>
        </aside>
      </div>

      <div className="copy-trading-panel__activity">
        <section aria-labelledby="copy-trading-orders-heading">
          <div className="copy-trading-panel__section-heading">
            <div>
              <p className="copy-trading-panel__eyebrow">ORDERS</p>
              <h3 id="copy-trading-orders-heading">전체 주문 기록</h3>
            </div>
            <span>{orders.length}건</span>
          </div>
          <div className="copy-trading-panel__table-wrap">
            <table>
              <thead>
                <tr><th>고래</th><th>자산</th><th>주문 행동</th><th>{mode === "paper" ? "모의 주문" : "예정 주문"}</th><th>가격</th><th>상태</th></tr>
              </thead>
              <tbody>
                {orders.length === 0 ? (
                  <tr><td colSpan={6} className="copy-trading-panel__empty">아직 주문 기록이 없습니다.</td></tr>
                ) : orders.map((order) => (
                  <tr key={order.id}>
                    <td>{whaleNameById.get(order.whaleId) || order.whaleId}</td>
                    <td>{order.symbol}</td>
                    <td className={order.side === "long" ? "is-positive" : "is-negative"}>
                      {order.orderAction ? mirrorActionLabel[order.orderAction] : order.segment ? segmentLabel[order.segment] : order.side === "long" ? "LONG" : "SHORT"}
                      <small> · {order.side === "long" ? "BUY" : "SELL"}</small>
                      {order.orderType ? <small> · {order.orderType}{order.tif ? `/${order.tif}` : ""}{order.reduceOnly ? " · Reduce" : ""}</small> : null}
                    </td>
                    <td>
                      {order.closeAll ? "전체 포지션" : formatQuantity(order.size)}
                      {order.remainingSize !== null && order.remainingSize !== undefined
                        ? <small> · 잔량 {formatQuantity(order.remainingSize)}</small>
                        : null}
                      {order.leverageCapped ? <small className="is-warning"> · 상한 적용</small> : null}
                    </td>
                    <td>{order.price === null || order.price === undefined ? "시장가" : formatCurrency(order.price, currency)}</td>
                    <td><span className={`copy-trading-panel__order-status is-${order.status}`}>{orderStatusLabel[order.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section aria-labelledby="copy-trading-failures-heading">
          <div className="copy-trading-panel__section-heading">
            <div>
              <p className="copy-trading-panel__eyebrow">EVENT LOG</p>
              <h3 id="copy-trading-failures-heading">실패 / 경고 로그</h3>
            </div>
            <span>{failureLogs.length}건</span>
          </div>
          <ol className="copy-trading-panel__failure-list">
            {failureLogs.length === 0 ? (
              <li className="copy-trading-panel__empty">기록된 실패 또는 경고가 없습니다.</li>
            ) : failureLogs.map((failure) => (
              <li key={failure.id} className={`is-${failure.severity}`}>
                <div>
                  <strong>{failure.code}</strong>
                  <p>{failure.message}</p>
                </div>
                <small>{formatDateTime(failure.occurredAt)}{failure.whaleId ? ` · ${whaleNameById.get(failure.whaleId) || failure.whaleId}` : ""}</small>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <footer className="copy-trading-panel__footer">
        <p role="status">{startBlockReason || "시작하면 활성 고래의 신규 주문만 추적합니다."}</p>
        {isRunning ? (
          <button type="button" className="copy-trading-panel__stop" disabled={loading || !onStop} onClick={onStop}>복사 중지</button>
        ) : (
          <button type="button" className="copy-trading-panel__start" disabled={startBlocked || !onStart} onClick={onStart}>
            {mode === "paper" ? "모의 복사 시작" : "실전 복사 시작"}
          </button>
        )}
      </footer>

      <style>{`
        .copy-trading-panel {
          background: #080b08;
          border: 1px solid rgba(148, 163, 184, 0.22);
          border-radius: 16px;
          color: #dce7f7;
          overflow: hidden;
        }
        .copy-trading-panel * { box-sizing: border-box; }
        .copy-trading-panel__header, .copy-trading-panel__footer, .copy-trading-panel__section-heading {
          align-items: center;
          display: flex;
          justify-content: space-between;
          gap: 1rem;
        }
        .copy-trading-panel__header { padding: 1.2rem 1.25rem 1rem; }
        .copy-trading-panel h2, .copy-trading-panel h3, .copy-trading-panel p { margin: 0; }
        .copy-trading-panel h2 { font-size: clamp(1.1rem, 2vw, 1.35rem); letter-spacing: -0.02em; }
        .copy-trading-panel h3 { font-size: 0.93rem; }
        .copy-trading-panel__eyebrow { color: #b5ff5c; font-size: 0.68rem; font-weight: 750; letter-spacing: 0.11em; margin-bottom: 0.32rem; }
        .copy-trading-panel__subcopy { color: #9fb0c6; font-size: 0.82rem; margin-top: 0.38rem !important; }
        .copy-trading-panel__mode { background: #111711; border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 10px; display: flex; padding: 0.2rem; }
        .copy-trading-panel__mode button { background: transparent; border: 0; border-radius: 7px; color: #9fb0c6; cursor: pointer; font: 650 0.78rem/1.15 inherit; padding: 0.48rem 0.6rem; }
        .copy-trading-panel__mode button.is-active { background: #b5ff5c; color: #0a1008; }
        .copy-trading-panel__mode button.is-live:not(.is-active) { color: #fda4af; }
        .copy-trading-panel__mode button:disabled { cursor: not-allowed; opacity: 0.48; }
        .copy-trading-panel__live-lock { background: rgba(127, 29, 29, 0.22); border-block: 1px solid rgba(251, 113, 133, 0.25); color: #fecdd3; font-size: 0.78rem; padding: 0.68rem 1.25rem; }
        .copy-trading-panel__live-notice { background: rgba(180, 83, 9, 0.14); border-bottom: 1px solid rgba(251, 191, 36, 0.22); color: #fde68a; font-size: 0.75rem; padding: 0.68rem 1.25rem; }
        .copy-trading-panel__sizing { align-items: end; background: rgba(181, 255, 92, 0.045); border-bottom: 1px solid rgba(181, 255, 92, 0.16); display: grid; gap: 0.75rem; grid-template-columns: 160px 140px 1fr auto; padding: 0.8rem 1.25rem; }
        .copy-trading-panel__sizing label > span { color: #91a4ba; display: block; font-size: 0.64rem; margin-bottom: 0.3rem; }
        .copy-trading-panel__sizing label > div { align-items: center; background: #070a08; border: 1px solid rgba(148, 163, 184, 0.24); border-radius: 7px; display: flex; padding: 0 0.55rem; }
        .copy-trading-panel__sizing input { background: transparent; border: 0; color: #eff8eb; font: inherit; min-width: 0; outline: 0; padding: 0.45rem 0.25rem; width: 100%; }
        .copy-trading-panel__sizing b { color: #b5ff5c; font-size: 0.72rem; }
        .copy-trading-panel__sizing p { color: #91a4ba; font-size: 0.68rem; line-height: 1.45; margin: 0; }
        .copy-trading-panel__sizing button { background: #b5ff5c; border: 0; border-radius: 7px; color: #0a1208; cursor: pointer; font-size: 0.7rem; font-weight: 900; padding: 0.58rem 0.8rem; }
        .copy-trading-panel__sizing button:disabled { cursor: not-allowed; opacity: 0.45; }
        .copy-trading-panel__metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-bottom: 1px solid rgba(148, 163, 184, 0.16); }
        .copy-trading-panel__metric { border-right: 1px solid rgba(148, 163, 184, 0.16); padding: 1rem 1.25rem; }
        .copy-trading-panel__metric:last-child { border-right: 0; }
        .copy-trading-panel__metric span, .copy-trading-panel__metric small { color: #9fb0c6; display: block; font-size: 0.72rem; }
        .copy-trading-panel__metric strong { display: block; font-size: 1.08rem; margin: 0.27rem 0; }
        .copy-trading-panel__analysis { border-bottom: 1px solid rgba(148, 163, 184, 0.16); display: grid; grid-template-columns: minmax(0, 1.18fr) minmax(360px, 0.82fr); }
        .copy-trading-panel__account, .copy-trading-panel__ledger { min-width: 0; padding: 1.15rem 1.25rem 1.2rem; }
        .copy-trading-panel__ledger { border-left: 1px solid rgba(148, 163, 184, 0.16); }
        .copy-trading-panel__section-heading--stacked { align-items: flex-start; flex-direction: column; }
        .copy-trading-panel__account-filter { display: flex; flex-wrap: wrap; gap: 0.3rem; }
        .copy-trading-panel__account-filter button { background: #111711; border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 999px; color: #8fa1b8; cursor: pointer; font-size: 0.64rem; font-weight: 750; padding: 0.3rem 0.5rem; }
        .copy-trading-panel__account-filter button.is-active { background: rgba(181, 255, 92, 0.13); border-color: rgba(181, 255, 92, 0.55); color: #caff91; }
        .copy-trading-panel__account-headline { align-items: flex-end; display: flex; justify-content: space-between; margin: 1.05rem 0 0.25rem; }
        .copy-trading-panel__account-headline span { color: #8396ad; display: block; font-size: 0.68rem; margin-bottom: 0.24rem; }
        .copy-trading-panel__account-headline strong { font-size: clamp(1.35rem, 2.4vw, 2rem); font-variant-numeric: tabular-nums; letter-spacing: -0.04em; }
        .copy-trading-panel__account-headline em { border-radius: 999px; font-size: 0.78rem; font-style: normal; font-weight: 850; padding: 0.33rem 0.5rem; }
        .copy-trading-panel__account-headline em.is-positive { background: rgba(74, 222, 128, 0.09); }
        .copy-trading-panel__account-headline em.is-negative { background: rgba(251, 113, 133, 0.09); }
        .copy-trading-panel__curve { height: 278px; margin-top: 0.2rem; padding: 0 3.5rem 1.45rem 0; position: relative; }
        .copy-trading-panel__curve svg { display: block; height: 100%; overflow: visible; width: 100%; }
        .copy-trading-panel__curve line { stroke: rgba(148, 163, 184, 0.13); stroke-dasharray: 4 7; stroke-width: 1; vector-effect: non-scaling-stroke; }
        .copy-trading-panel__curve-area { fill: rgba(181, 255, 92, 0.075); }
        .copy-trading-panel__curve-line { fill: none; stroke: #b5ff5c; stroke-linecap: round; stroke-linejoin: round; stroke-width: 2; vector-effect: non-scaling-stroke; }
        .copy-trading-panel__curve circle { fill: #b5ff5c; filter: drop-shadow(0 0 5px rgba(181, 255, 92, 0.8)); stroke: #071006; stroke-width: 2; vector-effect: non-scaling-stroke; }
        .copy-trading-panel__curve.is-falling .copy-trading-panel__curve-area { fill: rgba(251, 113, 133, 0.07); }
        .copy-trading-panel__curve.is-falling .copy-trading-panel__curve-line { stroke: #fb7185; }
        .copy-trading-panel__curve.is-falling circle { fill: #fb7185; filter: drop-shadow(0 0 5px rgba(251, 113, 133, 0.7)); }
        .copy-trading-panel__curve-axis { bottom: 1.45rem; color: #6f8298; display: flex; flex-direction: column; font-size: 0.59rem; justify-content: space-between; position: absolute; right: 0; text-align: right; top: 0; }
        .copy-trading-panel__curve-time { bottom: 0; color: #6f8298; display: flex; font-size: 0.59rem; justify-content: space-between; left: 0; position: absolute; right: 3.5rem; }
        .copy-trading-panel__curve-empty { align-items: center; background: linear-gradient(180deg, rgba(181,255,92,.025), transparent); border: 1px dashed rgba(148, 163, 184, 0.18); border-radius: 10px; color: #7e91a7; display: flex; flex-direction: column; height: 278px; justify-content: center; text-align: center; }
        .copy-trading-panel__curve-empty strong { color: #b7c4d4; font-size: 0.8rem; }
        .copy-trading-panel__curve-empty span { font-size: 0.67rem; margin-top: 0.35rem; }
        .copy-trading-panel__account-stats { border-top: 1px solid rgba(148, 163, 184, 0.13); display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0.4rem 0 0; padding-top: 0.8rem; }
        .copy-trading-panel__account-stats > div + div { border-left: 1px solid rgba(148, 163, 184, 0.13); padding-left: 0.65rem; }
        .copy-trading-panel__account-stats dt { color: #71849b; font-size: 0.61rem; }
        .copy-trading-panel__account-stats dd { font-size: 0.73rem; font-variant-numeric: tabular-nums; font-weight: 750; margin: 0.2rem 0 0; }
        .copy-trading-panel__selected-order { background: linear-gradient(135deg, rgba(181,255,92,.065), rgba(17,23,17,.75)); border: 1px solid rgba(181, 255, 92, 0.22); border-radius: 11px; margin-bottom: 0.65rem; padding: 0.78rem; }
        .copy-trading-panel__selected-order.is-short { background: linear-gradient(135deg, rgba(251,113,133,.06), rgba(17,23,17,.75)); border-color: rgba(251, 113, 133, 0.2); }
        .copy-trading-panel__selected-order > div:first-child span, .copy-trading-panel__selected-order > div:first-child small { color: #8497ad; display: block; font-size: 0.61rem; }
        .copy-trading-panel__selected-order > div:first-child strong { display: block; font-size: 1rem; margin: 0.16rem 0; }
        .copy-trading-panel__selected-order dl { display: grid; gap: 0.45rem; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0.72rem 0; }
        .copy-trading-panel__selected-order dt { color: #71849b; font-size: 0.58rem; }
        .copy-trading-panel__selected-order dd { font-size: 0.69rem; font-variant-numeric: tabular-nums; margin: 0.17rem 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .copy-trading-panel__selected-tags { display: flex; flex-wrap: wrap; gap: 0.3rem; }
        .copy-trading-panel__selected-tags > span { background: rgba(148, 163, 184, 0.08); border: 1px solid rgba(148, 163, 184, 0.14); border-radius: 999px; color: #a7b6c9; font-size: 0.58rem; padding: 0.2rem 0.34rem; }
        .copy-trading-panel__selected-order--empty { color: #7890ab; font-size: 0.73rem; min-height: 134px; place-content: center; text-align: center; }
        .copy-trading-panel__ledger-list { border: 1px solid rgba(148, 163, 184, 0.12); border-radius: 9px; max-height: 295px; overflow-y: auto; scrollbar-color: #354238 transparent; scrollbar-width: thin; }
        .copy-trading-panel__ledger-row { align-items: center; background: transparent; border: 0; border-bottom: 1px solid rgba(148, 163, 184, 0.09); color: #c9d5e4; cursor: pointer; display: grid; gap: 0.42rem; grid-template-columns: 80px minmax(80px, 1fr) minmax(100px, 1.1fr) auto; padding: 0.6rem 0.65rem; text-align: left; width: 100%; }
        .copy-trading-panel__ledger-row:last-child { border-bottom: 0; }
        .copy-trading-panel__ledger-row:hover { background: rgba(181, 255, 92, 0.035); }
        .copy-trading-panel__ledger-row.is-selected { animation: copy-row-glow 1.6s ease-in-out infinite alternate; background: rgba(181, 255, 92, 0.07); box-shadow: inset 3px 0 #b5ff5c; }
        .copy-trading-panel__ledger-row > span:first-child { color: #71849b; font-size: 0.58rem; }
        .copy-trading-panel__ledger-row > span:nth-child(2) strong, .copy-trading-panel__ledger-row > span:nth-child(2) small, .copy-trading-panel__ledger-row > span:nth-child(3) strong, .copy-trading-panel__ledger-row > span:nth-child(3) small { display: block; }
        .copy-trading-panel__ledger-row strong { font-size: 0.69rem; }
        .copy-trading-panel__ledger-row small { color: #71849b; font-size: 0.58rem; margin-top: 0.12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        @keyframes copy-row-glow { from { box-shadow: inset 3px 0 #b5ff5c, 0 0 0 rgba(181,255,92,0); } to { box-shadow: inset 3px 0 #b5ff5c, 0 0 16px rgba(181,255,92,.08); } }
        .copy-trading-panel__body, .copy-trading-panel__activity { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(270px, 0.9fr); }
        .copy-trading-panel__whales, .copy-trading-panel__safety, .copy-trading-panel__activity > section { padding: 1.1rem 1.25rem; }
        .copy-trading-panel__safety, .copy-trading-panel__activity > section + section { border-left: 1px solid rgba(148, 163, 184, 0.16); }
        .copy-trading-panel__activity { border-top: 1px solid rgba(148, 163, 184, 0.16); }
        .copy-trading-panel__section-heading { color: #9fb0c6; font-size: 0.75rem; margin-bottom: 0.8rem; }
        .copy-trading-panel__whale-list { display: grid; gap: 0.42rem; }
        .copy-trading-panel__whale { align-items: center; background: rgba(17, 23, 17, 0.72); border: 1px solid rgba(148, 163, 184, 0.14); border-radius: 10px; display: grid; gap: 0.65rem; grid-template-columns: minmax(126px, 1.1fr) minmax(250px, 1.4fr) auto; padding: 0.66rem 0.72rem; }
        .copy-trading-panel__whale-main { align-items: center; display: flex; gap: 0.55rem; min-width: 0; }
        .copy-trading-panel__whale-main strong { display: block; font-size: 0.82rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .copy-trading-panel__whale-main p { color: #9fb0c6; font-size: 0.69rem; margin-top: 0.18rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .copy-trading-panel__connection { background: #64748b; border-radius: 50%; box-shadow: 0 0 0 3px rgba(100, 116, 139, 0.14); flex: 0 0 auto; height: 7px; width: 7px; }
        .copy-trading-panel__connection--connected { background: #4ade80; box-shadow: 0 0 0 3px rgba(74, 222, 128, 0.16); }
        .copy-trading-panel__connection--connecting { background: #b5ff5c; box-shadow: 0 0 0 3px rgba(181, 255, 92, 0.16); }
        .copy-trading-panel__connection--delayed { background: #fbbf24; box-shadow: 0 0 0 3px rgba(251, 191, 36, 0.16); }
        .copy-trading-panel__whale-stats { display: grid; gap: 0.4rem; grid-template-columns: repeat(5, minmax(0, 1fr)); margin: 0; }
        .copy-trading-panel__whale-stats dt { color: #7890ab; font-size: 0.61rem; }
        .copy-trading-panel__whale-stats dd { font-size: 0.72rem; font-variant-numeric: tabular-nums; margin: 0.16rem 0 0; }
        .copy-trading-panel__whale-stats dd small { color: #7890ab; display: block; font-size: 0.58rem; margin-top: 0.08rem; }
        .copy-trading-panel__switch { background: #334155; border: 0; border-radius: 999px; cursor: pointer; height: 20px; padding: 2px; transition: background 150ms ease; width: 36px; }
        .copy-trading-panel__switch span { background: #e2e8f0; border-radius: inherit; display: block; height: 16px; transform: translateX(0); transition: transform 150ms ease; width: 16px; }
        .copy-trading-panel__switch.is-on { background: #b5ff5c; }
        .copy-trading-panel__switch.is-on span { transform: translateX(16px); }
        .copy-trading-panel__switch:focus-visible, .copy-trading-panel button:focus-visible { outline: 2px solid #b5ff5c; outline-offset: 2px; }
        .copy-trading-panel__switch:disabled { cursor: not-allowed; opacity: 0.45; }
        .copy-trading-panel__gate-list { display: grid; gap: 0.52rem; list-style: none; margin: 0; padding: 0; }
        .copy-trading-panel__gate-list li { align-items: center; color: #b8c7d9; display: flex; font-size: 0.76rem; gap: 0.48rem; }
        .copy-trading-panel__gate-list li > span { border-radius: 50%; height: 8px; width: 8px; }
        .copy-trading-panel__gate-list li.is-passed > span { background: #4ade80; box-shadow: 0 0 10px rgba(74, 222, 128, 0.7); }
        .copy-trading-panel__gate-list li.is-blocked > span { background: #fb7185; }
        .copy-trading-panel__gate-list b { color: #9fb0c6; font-size: 0.7rem; font-weight: 600; margin-left: auto; }
        .copy-trading-panel__safety-note { color: #9fb0c6; font-size: 0.73rem; line-height: 1.5; margin-top: 0.85rem !important; }
        .copy-trading-panel__table-wrap { overflow-x: auto; }
        .copy-trading-panel table { border-collapse: collapse; font-size: 0.73rem; min-width: 420px; width: 100%; }
        .copy-trading-panel th { color: #7890ab; font-size: 0.64rem; font-weight: 650; letter-spacing: 0.04em; text-align: left; }
        .copy-trading-panel td, .copy-trading-panel th { border-bottom: 1px solid rgba(148, 163, 184, 0.1); padding: 0.47rem 0.3rem; white-space: nowrap; }
        .copy-trading-panel td:first-child, .copy-trading-panel th:first-child { padding-left: 0; }
        .copy-trading-panel__order-status { border: 1px solid rgba(148, 163, 184, 0.3); border-radius: 999px; color: #b8c7d9; font-size: 0.64rem; padding: 0.12rem 0.32rem; }
        .copy-trading-panel__order-status.is-filled { border-color: rgba(74, 222, 128, 0.5); color: #86efac; }
        .copy-trading-panel__order-status.is-rejected { border-color: rgba(251, 113, 133, 0.5); color: #fda4af; }
        .copy-trading-panel__failure-list { display: grid; gap: 0.38rem; list-style: none; margin: 0; padding: 0; }
        .copy-trading-panel__failure-list li { align-items: flex-start; border-left: 2px solid #fbbf24; display: flex; gap: 0.65rem; justify-content: space-between; padding: 0.28rem 0 0.28rem 0.55rem; }
        .copy-trading-panel__failure-list li.is-error { border-left-color: #fb7185; }
        .copy-trading-panel__failure-list strong { font-size: 0.72rem; }
        .copy-trading-panel__failure-list p, .copy-trading-panel__failure-list small { color: #9fb0c6; font-size: 0.69rem; }
        .copy-trading-panel__failure-list p { line-height: 1.35; margin-top: 0.16rem; }
        .copy-trading-panel__failure-list small { flex: 0 0 auto; text-align: right; }
        .copy-trading-panel__empty { color: #7890ab; font-size: 0.76rem; padding: 0.6rem 0 !important; text-align: left; }
        .copy-trading-panel__footer { border-top: 1px solid rgba(148, 163, 184, 0.16); padding: 0.85rem 1.25rem; }
        .copy-trading-panel__footer p { color: #9fb0c6; font-size: 0.74rem; }
        .copy-trading-panel__start, .copy-trading-panel__stop { border: 0; border-radius: 8px; color: white; cursor: pointer; font: 700 0.78rem/1 inherit; padding: 0.64rem 0.8rem; white-space: nowrap; }
        .copy-trading-panel__start { background: #b5ff5c; color: #0a1008; }
        .copy-trading-panel__stop { background: #be123c; }
        .copy-trading-panel__start:disabled, .copy-trading-panel__stop:disabled { cursor: not-allowed; opacity: 0.42; }
        .copy-trading-panel .is-positive { color: #86efac; }
        .copy-trading-panel .is-negative { color: #fda4af; }
        .copy-trading-panel .is-warning { color: #fcd34d; }
        @media (max-width: 820px) {
          .copy-trading-panel__sizing { grid-template-columns: 1fr 1fr; }
          .copy-trading-panel__sizing p { grid-column: 1 / -1; }
          .copy-trading-panel__metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .copy-trading-panel__metric:nth-child(2) { border-right: 0; }
          .copy-trading-panel__metric:nth-child(-n+2) { border-bottom: 1px solid rgba(148, 163, 184, 0.16); }
          .copy-trading-panel__analysis, .copy-trading-panel__body, .copy-trading-panel__activity { grid-template-columns: 1fr; }
          .copy-trading-panel__ledger { border-left: 0; border-top: 1px solid rgba(148, 163, 184, 0.16); }
          .copy-trading-panel__safety, .copy-trading-panel__activity > section + section { border-left: 0; border-top: 1px solid rgba(148, 163, 184, 0.16); }
        }
        @media (max-width: 560px) {
          .copy-trading-panel__header, .copy-trading-panel__footer { align-items: flex-start; flex-direction: column; }
          .copy-trading-panel__header, .copy-trading-panel__whales, .copy-trading-panel__safety, .copy-trading-panel__activity > section, .copy-trading-panel__footer { padding-inline: 0.9rem; }
          .copy-trading-panel__account, .copy-trading-panel__ledger { padding-inline: 0.9rem; }
          .copy-trading-panel__live-lock, .copy-trading-panel__live-notice { padding-inline: 0.9rem; }
          .copy-trading-panel__metrics { grid-template-columns: 1fr 1fr; }
          .copy-trading-panel__metric { padding: 0.82rem 0.9rem; }
          .copy-trading-panel__whale { grid-template-columns: minmax(0, 1fr) auto; }
          .copy-trading-panel__whale-stats { grid-column: 1 / -1; }
          .copy-trading-panel__account-stats, .copy-trading-panel__selected-order dl { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 0.65rem; }
          .copy-trading-panel__account-stats > div:nth-child(3) { border-left: 0; padding-left: 0; }
          .copy-trading-panel__ledger-row { grid-template-columns: 66px minmax(70px, 1fr) minmax(88px, 1fr); }
          .copy-trading-panel__ledger-row > span:last-child { display: none; }
          .copy-trading-panel__footer p { line-height: 1.45; }
        }
      `}</style>
    </section>
  );
}
