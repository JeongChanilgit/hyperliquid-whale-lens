"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TradingChart, {
  type TradingChartCandle,
  type TradingChartMarker,
  type TradingChartMarkerKind,
} from "./components/TradingChart";
import CopyTradingPanel from "./components/CopyTradingPanel";
import TradeReturnAnalysis, { buildFlowNeutralPortfolioPerformance } from "./components/TradeReturnAnalysis";
import { useLiveCopySession } from "./hooks/use-live-copy-session";
import {
  loadCandles,
  loadWalletBundle,
  type AccountValuePoint,
  type CandleData,
  type TradingEvent,
  type WalletBundle,
} from "./lib";
import type { CandleInterval } from "./lib/types";
import { tradingEventLabel } from "./lib/trading-labels";
import { SEED_WALLETS } from "./seed-wallets";

type WalletItem = {
  address: string;
  label: string;
  screenedReturnPct?: number;
  status: "ACTIVE" | "PASS" | "WATCH";
};

type ProductModule = "analysis" | "paper" | "live";

const WALLET_STORAGE_KEY = "whale-lens-wallets-v3-compounded-top50";
const LEGACY_WALLET_STORAGE_KEYS = ["whale-lens-wallets-v2-cashflow-top30"] as const;
const LOG_PAGE_SIZE = 250;
const CHART_INTERVALS: ReadonlyArray<{ value: CandleInterval; label: string; milliseconds: number }> = [
  { value: "15m", label: "15분", milliseconds: 15 * 60 * 1000 },
  { value: "1h", label: "1시간", milliseconds: 60 * 60 * 1000 },
  { value: "4h", label: "4시간", milliseconds: 4 * 60 * 60 * 1000 },
  { value: "1d", label: "1일", milliseconds: 24 * 60 * 60 * 1000 },
];

const shortAddress = (address: string) => `${address.slice(0, 8)}…${address.slice(-6)}`;
const formatUsd = (value: number, digits = 0) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  }).format(Number.isFinite(value) ? value : 0);
const formatNumber = (value: number, digits = 2) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(
    Number.isFinite(value) ? value : 0,
  );
const formatTime = (time: number) =>
  new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(time));
const cacheText = (cacheHit: boolean, fetchedAt: number) =>
  `${cacheHit ? "저장 데이터" : "방금 수신"} · ${formatTime(fetchedAt)}`;

function estimatedExposure(event: TradingEvent, points: AccountValuePoint[]) {
  let accountValueUsd: number | undefined;
  for (const point of points) {
    if (point.time > event.time) break;
    if (point.value > 0) accountValueUsd = point.value;
  }
  const price = Number(event.fill.px);
  if (!accountValueUsd || !Number.isFinite(price) || price <= 0) return null;
  const positionNotionalUsd = Math.abs(event.endPosition * price);
  return {
    accountValueUsd,
    positionNotionalUsd,
    exposurePct: positionNotionalUsd / accountValueUsd * 100,
  };
}

function eventMarkerKind(event: TradingEvent): TradingChartMarkerKind {
  if (event.isLossClose || event.isTriggerStop) return "loss-close";
  if (event.actions.some((action) => action.endsWith("_CLOSE"))) return "close";
  if (event.actions.some((action) => action.endsWith("_REDUCE"))) return "reduce";
  if (event.actions.some((action) => action.endsWith("_ADD"))) return "add";
  if (event.actions.includes("SHORT_ENTRY")) return "short";
  return "long";
}

function markerLabel(event: TradingEvent): string {
  const hasClose = event.actions.some((action) => action.endsWith("_CLOSE"));
  return tradingEventLabel(event, hasClose ? formatUsd(event.closedPnl, 0) : undefined);
}

function AssetCurve({ points }: { points: AccountValuePoint[] }) {
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
      context.scale(ratio, ratio);
      context.clearRect(0, 0, rect.width, rect.height);
      if (points.length < 2) return;
      const values = points.map((point) => point.value).filter(Number.isFinite);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = Math.max(max - min, Math.abs(max) * 0.002, 1);
      const pad = 8;
      const width = Math.max(1, rect.width - pad * 2);
      const height = Math.max(1, rect.height - pad * 2);
      const coords = points.map((point, index) => ({
        x: pad + (index / Math.max(points.length - 1, 1)) * width,
        y: pad + (1 - (point.value - min) / range) * height,
      }));
      const gradient = context.createLinearGradient(0, 0, 0, rect.height);
      gradient.addColorStop(0, "rgba(181, 255, 92, 0.28)");
      gradient.addColorStop(1, "rgba(181, 255, 92, 0)");
      context.beginPath();
      context.moveTo(coords[0].x, rect.height - pad);
      coords.forEach((point) => context.lineTo(point.x, point.y));
      context.lineTo(coords.at(-1)!.x, rect.height - pad);
      context.closePath();
      context.fillStyle = gradient;
      context.fill();
      context.beginPath();
      coords.forEach((point, index) =>
        index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y),
      );
      context.strokeStyle = "#b5ff5c";
      context.lineWidth = 2;
      context.lineJoin = "round";
      context.stroke();
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [points]);

  return <canvas ref={canvasRef} className="asset-curve" aria-label="최근 30일 자산 변화 그래프" />;
}

function EmptyChartHint() {
  return (
    <div className="empty-chart-hint">
      <span className="empty-chart-hint__orb" />
      <strong>코인 차트를 선택하세요</strong>
      <p>오른쪽 거래 내역을 누르면 해당 코인의 최근 30일 캔들을 필요한 순간에만 불러옵니다.</p>
    </div>
  );
}

export default function Home() {
  const [productModule, setProductModule] = useState<ProductModule>("analysis");
  const [wallets, setWallets] = useState<WalletItem[]>(SEED_WALLETS);
  const [activeAddress, setActiveAddress] = useState(SEED_WALLETS[0].address);
  const [addressInput, setAddressInput] = useState("");
  const [walletBundle, setWalletBundle] = useState<WalletBundle | null>(null);
  const [walletLoading, setWalletLoading] = useState(true);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [selectedCoin, setSelectedCoin] = useState<string | null>(null);
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null);
  const [candleData, setCandleData] = useState<CandleData | null>(null);
  const [candleInterval, setCandleInterval] = useState<CandleInterval>("1h");
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const [showAllCoins, setShowAllCoins] = useState(false);
  const [visibleLogCount, setVisibleLogCount] = useState(LOG_PAGE_SIZE);
  const [toast, setToast] = useState<string | null>(null);
  const walletRequestRef = useRef(0);
  const chartRequestRef = useRef(0);

  useEffect(() => {
    const seedAddresses = new Set(SEED_WALLETS.map((wallet) => wallet.address.toLowerCase()));
    let customWallets: WalletItem[] = [];
    try {
      const stored = window.localStorage.getItem(WALLET_STORAGE_KEY)
        ?? LEGACY_WALLET_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)).find(Boolean);
      if (stored) {
        const parsed = JSON.parse(stored) as WalletItem[];
        if (Array.isArray(parsed)) {
          // Screened ranks are versioned source data, not user preferences.
          // Retain only addresses the user explicitly added as WATCH entries.
          customWallets = parsed.filter((wallet) => (
            wallet.status === "WATCH" &&
            /^0x[a-fA-F0-9]{40}$/.test(wallet.address) &&
            !seedAddresses.has(wallet.address.toLowerCase())
          ));
        }
      }
    } catch {
      // A malformed preference must never block public data loading.
    }
    const refreshed: WalletItem[] = [...SEED_WALLETS, ...customWallets];
    queueMicrotask(() => {
      setWallets(refreshed);
      setActiveAddress((current) =>
        refreshed.some((wallet) => wallet.address.toLowerCase() === current.toLowerCase())
          ? current
          : refreshed[0].address,
      );
    });
  }, []);

  useEffect(() => {
    window.localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(wallets));
  }, [wallets]);

  const loadWallet = useCallback(async (force = false) => {
    const requestId = walletRequestRef.current + 1;
    walletRequestRef.current = requestId;
    setWalletLoading(true);
    setWalletError(null);
    setSelectedTradeId(null);
    try {
      const bundle = await loadWalletBundle(activeAddress, { force });
      if (walletRequestRef.current !== requestId || bundle.address.toLowerCase() !== activeAddress.toLowerCase()) return;
      setWalletBundle(bundle);
      const counts = new Map<string, number>();
      bundle.events.forEach((event) => counts.set(event.coin, (counts.get(event.coin) ?? 0) + 1));
      const topCoin = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
      setSelectedCoin((current) =>
        current && counts.has(current) ? current : topCoin,
      );
      if (force) setToast("투자 로그를 최신 데이터로 갱신했습니다.");
    } catch (error) {
      if (walletRequestRef.current !== requestId) return;
      setWalletError(error instanceof Error ? error.message : "투자 로그를 불러오지 못했습니다.");
    } finally {
      if (walletRequestRef.current === requestId) setWalletLoading(false);
    }
  }, [activeAddress]);

  useEffect(() => {
    queueMicrotask(() => {
      setWalletBundle(null);
      setSelectedCoin(null);
      setCandleData(null);
      setVisibleLogCount(LOG_PAGE_SIZE);
      void loadWallet(false);
    });
  }, [activeAddress, loadWallet]);

  const loadChart = useCallback(async (coin: string, force = false) => {
    const requestId = chartRequestRef.current + 1;
    chartRequestRef.current = requestId;
    setChartLoading(true);
    setChartError(null);
    try {
      // Candles must always use a rolling window ending now. Wallet replays may
      // come from an older preload and must not pin chart refreshes to that date.
      const data = await loadCandles(coin, { force, interval: candleInterval });
      if (chartRequestRef.current !== requestId) return;
      setCandleData(data);
      if (force) setToast(`${coin} 차트를 최신 데이터로 갱신했습니다.`);
    } catch (error) {
      if (chartRequestRef.current !== requestId) return;
      setChartError(error instanceof Error ? error.message : "차트 데이터를 불러오지 못했습니다.");
      setCandleData(null);
    } finally {
      if (chartRequestRef.current === requestId) setChartLoading(false);
    }
  }, [candleInterval]);

  useEffect(() => {
    if (!selectedCoin) return;
    if (candleData?.coin === selectedCoin && candleData.interval === candleInterval) {
      return;
    }
    queueMicrotask(() => void loadChart(selectedCoin, false));
  }, [candleData, candleInterval, loadChart, selectedCoin]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const activeWallet = wallets.find((wallet) => wallet.address === activeAddress) ?? wallets[0];
  const copyWalletInputs = useMemo(
    () => wallets.map((wallet) => ({ address: wallet.address, label: wallet.label })),
    [wallets],
  );
  const liveSession = useLiveCopySession(copyWalletInputs, productModule !== "analysis");
  const requestedSessionMode = productModule === "paper" ? "SIMULATION" : "HYPERLIQUID";
  const activeSessionMatches = liveSession.sessionMode === requestedSessionMode;
  const coinCounts = useMemo(() => {
    const counts = new Map<string, number>();
    walletBundle?.events.forEach((event) => counts.set(event.coin, (counts.get(event.coin) ?? 0) + 1));
    return [...counts.entries()].sort((left, right) => right[1] - left[1]);
  }, [walletBundle]);
  const visibleCoins = showAllCoins ? coinCounts : coinCounts.slice(0, 8);
  // Older preloaded bundles used a transaction hash as the event id, but one
  // transaction can contain several fills. Add the stable source index at the
  // view boundary so cached legacy bundles cannot collide in React or selection.
  const walletEvents = useMemo(
    () => (walletBundle?.events ?? []).map((event, sourceIndex) => ({
      ...event,
      id: `${event.id}:${sourceIndex}`,
    })),
    [walletBundle],
  );
  const displayedEvents = useMemo(
    () => [...walletEvents].sort((left, right) => right.time - left.time),
    [walletEvents],
  );
  const visibleEvents = useMemo(
    () => displayedEvents.slice(0, visibleLogCount),
    [displayedEvents, visibleLogCount],
  );
  const selectedEvent = displayedEvents.find((event) => event.id === selectedTradeId) ?? null;
  const monthPoints = useMemo(
    () => walletBundle?.portfolio.month?.accountValueHistory ?? [],
    [walletBundle],
  );
  const monthPnlPoints = useMemo(
    () => walletBundle?.portfolio.month?.pnlHistory ?? [],
    [walletBundle],
  );
  const flowNeutralPerformance = useMemo(
    () => buildFlowNeutralPortfolioPerformance(monthPoints, monthPnlPoints),
    [monthPnlPoints, monthPoints],
  );
  const exposureByEvent = useMemo(
    () => new Map(displayedEvents.map((event) => [event.id, estimatedExposure(event, monthPoints)])),
    [displayedEvents, monthPoints],
  );
  const selectedExposure = selectedEvent ? exposureByEvent.get(selectedEvent.id) ?? null : null;
  const currentValue = monthPoints.at(-1)?.value ?? 0;
  const assetChange = flowNeutralPerformance.returnPct;
  const completedEpisodes = walletBundle?.episodes.filter((episode) => episode.status === "COMPLETED") ?? [];
  const netPnl = completedEpisodes.reduce((sum, episode) => sum + episode.netPnl, 0);
  const wins = completedEpisodes.filter((episode) => episode.netPnl > 0).length;
  const winRate = completedEpisodes.length > 0 ? (wins / completedEpisodes.length) * 100 : 0;

  const chartCandles = useMemo<TradingChartCandle[]>(
    () =>
      (candleData?.candles ?? []).map((candle) => ({
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
    [candleData],
  );
  const chartMarkers = useMemo<TradingChartMarker[]>(
    () => {
      const intervalMilliseconds = CHART_INTERVALS.find((item) => item.value === candleInterval)?.milliseconds ?? 60 * 60 * 1000;
      return (
      walletEvents
        .filter((event) => event.coin === selectedCoin)
        .map((event) => ({
          id: event.id,
          time: Math.floor(event.time / intervalMilliseconds) * intervalMilliseconds,
          kind: eventMarkerKind(event),
          label: markerLabel(event),
          price: Number(event.fill.px),
        }))
      );
    },
    [candleInterval, selectedCoin, walletEvents],
  );
  const candleIntervalLabel = CHART_INTERVALS.find((item) => item.value === candleInterval)?.label ?? candleInterval;
  const latestCandleTime = useMemo(
    () => candleData?.candles.reduce((latest, candle) => Math.max(latest, candle.endTime), 0) ?? 0,
    [candleData],
  );
  const candleCacheLabel = candleData
    ? `${cacheText(candleData.cacheHit, candleData.fetchedAt)}${latestCandleTime > 0 ? ` · 마지막 캔들 ${formatTime(latestCandleTime)}` : ""}`
    : "필요할 때 로드";
  const liveFailureLogs = useMemo(
    () => liveSession.error
      ? [{
          id: "live-runtime-status",
          occurredAt: new Date().toISOString(),
          severity: "warning" as const,
          code: "LIVE_RUNTIME",
          message: liveSession.error,
        }, ...liveSession.failureLogs]
      : liveSession.failureLogs,
    [liveSession.error, liveSession.failureLogs],
  );

  const selectEvent = (event: TradingEvent) => {
    setSelectedTradeId(event.id);
    if (event.coin !== selectedCoin) {
      setSelectedCoin(event.coin);
      setCandleData(null);
    }
  };

  const addWallet = () => {
    const address = addressInput.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      setToast("올바른 42자 Hyperliquid 주소를 입력하세요.");
      return;
    }
    const canonical = address.toLowerCase();
    const existing = wallets.find((wallet) => wallet.address.toLowerCase() === canonical);
    if (existing) {
      setActiveAddress(existing.address);
      setToast("이미 등록된 주소로 이동했습니다.");
      return;
    }
    const next: WalletItem = {
      address,
      label: `Watch ${wallets.length + 1}`,
      status: "WATCH",
    };
    setWallets((current) => [next, ...current]);
    setActiveAddress(address);
    setAddressInput("");
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark">WL</span>
          <div>
            <strong>Whale Lens</strong>
            <span>Hyperliquid trader replay</span>
          </div>
        </div>

        <nav className="mode-nav" aria-label="제품 모듈">
          <button
            className={`mode-nav__item ${productModule === "analysis" ? "is-active" : ""}`}
            type="button"
            onClick={() => setProductModule("analysis")}
          >
            트레이딩 분석
          </button>
          <button
            className={`mode-nav__item ${productModule === "paper" ? "is-active" : ""}`}
            type="button"
            onClick={() => setProductModule("paper")}
          >
            모의투자 <small>LIVE</small>
          </button>
          <button
            className={`mode-nav__item ${productModule === "live" ? "is-active" : ""}`}
            type="button"
            onClick={() => setProductModule("live")}
          >
            Hyperliquid 실투자 <small>{liveSession.executionEnabled ? (liveSession.testnet ? "TESTNET" : "ARMED") : "LOCKED"}</small>
          </button>
        </nav>

        <div className="refresh-actions">
          <button
            className="ghost-button"
            type="button"
            disabled={productModule !== "analysis" || !selectedCoin || chartLoading}
            onClick={() => selectedCoin && void loadChart(selectedCoin, true)}
          >
            <span aria-hidden="true">↻</span> 차트 새로고침
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={productModule !== "analysis" || walletLoading}
            onClick={() => void loadWallet(true)}
          >
            <span aria-hidden="true">↻</span> 투자로그 새로고침
          </button>
        </div>
      </header>

      <section className="address-bar" aria-label="지갑 관리">
        <label className="wallet-select-wrap">
          <span>관찰 지갑</span>
          <select value={activeAddress} onChange={(event) => setActiveAddress(event.target.value)}>
            {wallets.map((wallet) => (
              <option key={wallet.address} value={wallet.address}>
                {wallet.label}{wallet.screenedReturnPct === undefined ? "" : ` · 선별 +${formatNumber(wallet.screenedReturnPct, 2)}%`} · {shortAddress(wallet.address)}
              </option>
            ))}
          </select>
        </label>
        <div className="address-input-wrap">
          <input
            value={addressInput}
            onChange={(event) => setAddressInput(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && addWallet()}
            placeholder="0x… 새 지갑 주소"
            aria-label="새 Hyperliquid 지갑 주소"
          />
          <button type="button" onClick={addWallet}>주소 추가</button>
        </div>
        <div className="sync-state" aria-live="polite">
          <span className={`sync-dot ${walletLoading ? "is-loading" : ""}`} />
          {walletLoading
            ? "30일 로그 동기화 중"
            : walletBundle
              ? cacheText(walletBundle.cacheHit, walletBundle.fetchedAt)
              : "연결 대기"}
        </div>
      </section>

      {productModule === "analysis" ? (
      <section className="workspace-grid">
        <article className="chart-pane">
          <div className="pane-heading">
            <div>
              <span className="eyebrow">30D EXECUTION MAP</span>
              <h1>{selectedCoin ?? "거래 코인 선택"}</h1>
              <p>{selectedCoin ? `${candleIntervalLabel} 캔들 · 진입과 청산 타임라인` : "거래 내역에서 코인을 선택하세요"}</p>
            </div>
            <div className="legend" aria-label="차트 마커 범례">
              <span><i className="legend-dot is-long" /> 롱</span>
              <span><i className="legend-dot is-short" /> 숏</span>
              <span><i className="legend-dot is-reduce" /> 부분청산</span>
              <span><i className="legend-dot is-stop" /> 손실/손절</span>
            </div>
          </div>

          <div className="coin-strip" aria-label="거래 코인">
            {visibleCoins.map(([coin, count]) => (
              <button
                type="button"
                key={coin}
                className={coin === selectedCoin ? "is-selected" : undefined}
                onClick={() => {
                  setSelectedCoin(coin);
                  setSelectedTradeId(null);
                  if (coin !== candleData?.coin) setCandleData(null);
                }}
              >
                {coin}<small>{count}</small>
              </button>
            ))}
            {coinCounts.length > 8 ? (
              <button className="coin-more" type="button" onClick={() => setShowAllCoins((value) => !value)}>
                {showAllCoins ? "접기" : `+${coinCounts.length - 8}`}
              </button>
            ) : null}
          </div>

          <div className="chart-stage">
            {selectedCoin ? (
              <TradingChart
                candles={chartCandles}
                markers={chartMarkers}
                selectedTradeId={selectedTradeId}
                loading={chartLoading}
                error={chartError}
                cacheLabel={candleCacheLabel}
                interval={candleInterval}
                onIntervalChange={(interval) => {
                  setCandleInterval(interval);
                  setCandleData(null);
                }}
                onMarkerSelect={(marker) => {
                  const event = walletBundle?.events.find((item) => item.id === marker.id);
                  if (event) selectEvent(event);
                }}
              />
            ) : (
              <EmptyChartHint />
            )}
          </div>

          {selectedEvent ? (
            <div className="selected-trade-callout" role="status">
              <span className={`trade-action trade-action--${eventMarkerKind(selectedEvent)}`}>
                {markerLabel(selectedEvent)}
              </span>
              <strong>{selectedEvent.coin} @ {formatNumber(Number(selectedEvent.fill.px), 6)}</strong>
              <span>{formatTime(selectedEvent.time)} · {formatNumber(Number(selectedEvent.fill.sz), 6)}개</span>
              {selectedExposure ? (
                <span title="30일 계좌가치 시계열의 직전 관측값으로 계산한 추정치">
                  체결 후 포지션 약 {formatNumber(selectedExposure.exposurePct, 1)}% · {formatUsd(selectedExposure.positionNotionalUsd, 0)}
                </span>
              ) : null}
              <span className={selectedEvent.closedPnl >= 0 ? "pnl-positive" : "pnl-negative"}>
                실현 {formatUsd(selectedEvent.closedPnl, 2)}
              </span>
            </div>
          ) : (
            <p className="chart-footnote">거래 행을 누르면 차트가 해당 시점으로 이동하고 선택 마커가 빛납니다.</p>
          )}
        </article>

        <aside className="profile-pane">
          <section className="profile-card">
            <div className="profile-card__identity">
              <div className="avatar-orbit"><span>{activeWallet?.label.slice(-2) ?? "01"}</span></div>
              <div>
                <div className="profile-name-line">
                  <h2>{activeWallet?.label ?? "Wallet"}</h2>
                  <span className={`status-chip status-chip--${(activeWallet?.status ?? "WATCH").toLowerCase()}`}>
                    {activeWallet?.status ?? "WATCH"}
                  </span>
                </div>
                {activeWallet?.screenedReturnPct !== undefined ? (
                  <span className="profile-rank-snapshot">선별 시점 30일 복리 +{formatNumber(activeWallet.screenedReturnPct, 2)}% · 상단 곡선은 현재값</span>
                ) : null}
                <button
                  className="copy-address"
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(activeAddress);
                    setToast("주소를 복사했습니다.");
                  }}
                >
                  {shortAddress(activeAddress)} <span aria-hidden="true">□</span>
                </button>
              </div>
            </div>
            <div className="coverage-badge">
              <span className={walletBundle?.coverage.complete ? "is-complete" : "is-partial"} />
              {walletBundle?.coverage.complete ? "30일 데이터 완전" : "범위 확인 필요"}
            </div>
          </section>

          {walletError ? <div className="notice notice--error" role="alert">{walletError}</div> : null}
          {walletBundle?.warnings.map((warning) => (
            <div className="notice" key={warning}>{warning}</div>
          ))}

          <section className="asset-card">
            <div className="section-title-row">
              <div>
                <span className="eyebrow">30D CASH-FLOW-NEUTRAL COMPOUNDED GROWTH</span>
                <h3>{formatUsd(currentValue, 0)}</h3>
              </div>
              <span className={assetChange >= 0 ? "metric-positive" : "metric-negative"}>
                {assetChange >= 0 ? "+" : ""}{formatNumber(assetChange, 2)}%
              </span>
            </div>
            <AssetCurve points={flowNeutralPerformance.points} />
            <div className="asset-axis">
              <span>30일 전 · 복리지수 100</span>
              <span title="공개 계좌/PnL 표본으로 구간 수익률을 연결한 추정치">표본 추정 · 입출금 {formatUsd(flowNeutralPerformance.inferredNetFlowUsd, 0)} 제외</span>
              <span>현재</span>
            </div>
          </section>

          <section className="metric-grid" aria-label="지갑 거래 성과">
            <div><span>완료 Episodes</span><strong>{completedEpisodes.length}</strong></div>
            <div><span>Episode Net PnL</span><strong className={netPnl >= 0 ? "pnl-positive" : "pnl-negative"}>{formatUsd(netPnl, 0)}</strong></div>
            <div><span>승률</span><strong>{formatNumber(winRate, 1)}%</strong></div>
            <div><span>30일 Fills</span><strong>{walletBundle?.coverage.fillCount ?? walletBundle?.fills.length ?? 0}</strong></div>
          </section>

          <TradeReturnAnalysis
            episodes={walletBundle?.episodes ?? []}
            accountValuePoints={monthPoints}
            pnlPoints={monthPnlPoints}
          />

          <section className="trade-log-card">
            <div className="trade-log-header">
              <div>
                <span className="eyebrow">INVESTMENT LOG</span>
                <h3>거래 내역</h3>
              </div>
              <span>
                {displayedEvents.length} fills
                {visibleEvents.length < displayedEvents.length ? ` · 최근 ${visibleEvents.length}건 표시` : ""}
              </span>
            </div>

            <div className="trade-table" role="table" aria-label="최근 30일 거래 내역">
              <div className="trade-row trade-row--head" role="row">
                <span>시각</span><span>코인 / 동작</span><span>가격 · 수량</span><span>PnL</span>
              </div>
              <div className="trade-table__body">
                {walletLoading && displayedEvents.length === 0 ? (
                  <div className="log-loading" role="status">투자 로그를 불러오는 중…</div>
                ) : null}
                {!walletLoading && displayedEvents.length === 0 ? (
                  <div className="log-loading">최근 30일 거래가 없습니다.</div>
                ) : null}
                {visibleEvents.map((event) => {
                  const kind = eventMarkerKind(event);
                  const exposure = exposureByEvent.get(event.id);
                  return (
                    <button
                      type="button"
                      className={`trade-row ${event.id === selectedTradeId ? "is-selected" : ""}`}
                      key={event.id}
                      onClick={() => selectEvent(event)}
                      aria-pressed={event.id === selectedTradeId}
                    >
                      <span>{formatTime(event.time)}</span>
                      <span>
                        <strong>{event.coin}</strong>
                        <i className={`trade-action trade-action--${kind}`}>{markerLabel(event)}</i>
                      </span>
                      <span>
                        <strong>{formatNumber(Number(event.fill.px), 6)}</strong>
                        <small>{formatNumber(Number(event.fill.sz), 6)}개</small>
                        {exposure ? <small title="직전 계좌가치 관측값 기준 추정">포지션 약 {formatNumber(exposure.exposurePct, 1)}%</small> : null}
                      </span>
                      <span className={event.closedPnl >= 0 ? "pnl-positive" : "pnl-negative"}>
                        {formatUsd(event.closedPnl, 2)}
                      </span>
                    </button>
                  );
                })}
                {visibleEvents.length < displayedEvents.length ? (
                  <button
                    className="trade-log-more"
                    type="button"
                    onClick={() => setVisibleLogCount((count) => count + LOG_PAGE_SIZE)}
                  >
                    다음 {Math.min(LOG_PAGE_SIZE, displayedEvents.length - visibleEvents.length)}건 보기
                  </button>
                ) : null}
              </div>
            </div>
          </section>

          <section className="future-rail" aria-label="카피 투자 모듈">
            <div><span>SIM</span><p><strong>모의투자</strong>고래 자본 대비 포지션 비율을 동일하게 추적</p><em>READY</em></div>
            <div><span>HL</span><p><strong>Hyperliquid 실투자</strong>동일 거래소 주문·레버리지 복제</p><em>{liveSession.executionEnabled ? "READY" : "LOCKED"}</em></div>
          </section>
        </aside>
      </section>
      ) : (
        <section className="copy-workspace">
          <div className="copy-workspace__intro">
            <div>
              <span className="eyebrow">{liveSession.whales.length}-WHALE REALTIME FOLLOW</span>
              <h1>{productModule === "paper" ? "모의투자 트래킹" : "Hyperliquid 실전 카피"}</h1>
              <p>
                {productModule === "paper"
                  ? liveSession.entryPolicy === "NEW_POSITIONS_ONLY"
                    ? `세션 시작 전 보유분과 그 청산 주문은 제외합니다. 이후 기존 포지션에 추가 진입한 수량과 새로 여는 포지션은 복제하고, 후속 축소·청산은 우리가 복제한 수량까지만 따릅니다. 지갑별 시작 증거금은 ${formatUsd(liveSession.sizing?.allocationPerWhaleUsd ?? 100, 0)}이며 레버리지와 cross/isolated는 고래 설정을 그대로 따릅니다.`
                    : `고래 주문수량 × (우리 현재자산 ÷ 고래 현재자산)으로 서로 독립된 모의지갑을 운용합니다. 지갑별 시작 증거금은 ${formatUsd(liveSession.sizing?.allocationPerWhaleUsd ?? 100, 0)}이며, 레버리지와 cross/isolated는 고래 설정을 그대로 복제합니다.`
                  : `고래의 지정가·수정·취소·TP/SL과 레버리지를 같은 Hyperliquid로 전달하도록 준비합니다. 웹소켓 수신 뒤 비동기로 제출하며, 고래 전량체결 1초 뒤 미체결 잔량은 취소 후 시장가로 보정하고 전 과정을 기록합니다. 실제 target 체결·수수료·손익 확인값은 별도로 구분합니다.`}
              </p>
            </div>
            <div className="copy-workspace__runtime">
              <span className={liveSession.serverConnected ? "is-ready" : ""} />
              {productModule === "paper"
                ? liveSession.serverConnected ? "로컬 상시 runner 연결됨" : "로컬 runner 연결 필요"
                : liveSession.serverConnected
                  ? liveSession.sessionMode === "SIMULATION"
                    ? "현재 runner는 모의 세션 · 실전 데이터 없음"
                    : liveSession.executionEnabled ? "실행 서버와 Hyperliquid 환경 확인됨" : "실행 서버 연결 · Hyperliquid 환경 미설정"
                  : "실행 서버 연결 필요"}
            </div>
          </div>

          {productModule === "live" ? (
            <div className="live-approval">
              <div>
                <strong>실전 실행 승인</strong>
                <span>서버에서 60초 동안만 유효하며, 실전 시작 성공 시 즉시 소모됩니다.</span>
              </div>
              <button
                type="button"
                className={liveSession.liveArmed ? "is-approved" : ""}
                aria-pressed={liveSession.liveArmed}
                disabled={!liveSession.serverConnected || !liveSession.executionEnabled || (liveSession.isRunning && liveSession.sessionMode === "HYPERLIQUID") || liveSession.loading}
                onClick={() => void liveSession.armLive()}
              >
                {liveSession.liveArmed ? "서버 승인됨 (60초)" : "60초 실전 승인"}
              </button>
            </div>
          ) : null}

          <CopyTradingPanel
            key={`copy-sizing-${liveSession.sizing?.allocationPerWhaleUsd ?? 100}`}
            mode={productModule === "paper" ? "paper" : "live"}
            sessionMode={liveSession.sessionMode}
            isRunning={activeSessionMatches && liveSession.isRunning}
            whales={liveSession.whales}
            totalPnl={activeSessionMatches ? liveSession.totalPnl : 0}
            orders={activeSessionMatches ? liveSession.orders : []}
            equityHistory={activeSessionMatches ? liveSession.equityHistory : []}
            failureLogs={activeSessionMatches ? liveFailureLogs : []}
            safetyGate={productModule === "paper"
              ? {
                  serverConnected: liveSession.serverConnected,
                  environmentValidated: false,
                  executionApproved: false,
                  message: liveSession.error ?? "모의 주문과 고래별 로그는 로컬 SQLite에 저장되며, 브라우저를 닫아도 runner는 계속 감시합니다.",
                }
              : {
                  serverConnected: liveSession.serverConnected,
                  environmentValidated: liveSession.executionEnabled,
                  executionApproved: liveSession.liveArmed,
                  message: liveSession.error ?? (liveSession.sessionMode === "SIMULATION"
                    ? "현재 로컬 runner는 모의투자 전용입니다. 실전 주문은 전송되지 않습니다."
                    : liveSession.testnet
                      ? "Hyperliquid 테스트넷 환경입니다. 서버 승인은 60초 후 만료됩니다."
                      : "실제 Hyperliquid 주문 환경입니다. 대상 계정과 키를 다시 확인하세요."),
                }}
            connectionDelayMs={liveSession.connectionDelayMs}
            loading={liveSession.loading}
            marginPerWhaleUsd={liveSession.sizing?.allocationPerWhaleUsd ?? 100}
            onModeChange={(mode) => setProductModule(mode === "paper" ? "paper" : "live")}
            onWhaleEnabledChange={liveSession.setWhaleEnabled}
            onStart={() => liveSession.start(productModule === "paper" ? "SIMULATION" : "HYPERLIQUID")}
            onStop={liveSession.stop}
            onSizingApply={liveSession.configureSimulationSizing}
          />
        </section>
      )}

      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </main>
  );
}
