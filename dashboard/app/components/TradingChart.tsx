"use client";

import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type IChartApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CandleInterval } from "../lib/types";

export type TradingChartTime =
  | number
  | string
  | { year: number; month: number; day: number };

export type TradingChartCandle = {
  time: TradingChartTime;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type TradingChartMarkerKind =
  | "long"
  | "short"
  | "add"
  | "reduce"
  | "close"
  | "loss-close";

export type TradingChartMarker = {
  id: string;
  time: TradingChartTime;
  kind: TradingChartMarkerKind;
  label: string;
  price?: number;
};

export type TradingChartProps = {
  candles: TradingChartCandle[];
  markers: TradingChartMarker[];
  selectedTradeId?: string | null;
  loading?: boolean;
  error?: string | null;
  cacheLabel?: string | null;
  interval?: CandleInterval;
  onIntervalChange?: (interval: CandleInterval) => void;
  onMarkerSelect?: (marker: TradingChartMarker) => void;
};

const intervalChoices: ReadonlyArray<{ value: CandleInterval; label: string }> = [
  { value: "15m", label: "15분" },
  { value: "1h", label: "1시간" },
  { value: "4h", label: "4시간" },
  { value: "1d", label: "1일" },
];

type ChartSeriesRef = {
  setData: (data: CandlestickData<Time>[]) => void;
  priceToCoordinate: (price: number) => number | null;
};

type MarkerPrimitiveRef = {
  setMarkers: (markers: SeriesMarker<Time>[]) => void;
};

type SelectedPoint = {
  left: number;
  top: number;
};

type ChartState = {
  candles: CandlestickData<Time>[];
  markers: TradingChartMarker[];
  selectedTradeId?: string | null;
};

type MarkerStyle = {
  color: string;
  position: "aboveBar" | "belowBar" | "inBar";
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
};

const markerStyles: Record<TradingChartMarkerKind, MarkerStyle> = {
  long: { color: "#4ade80", position: "belowBar", shape: "arrowUp" },
  short: { color: "#fb7185", position: "aboveBar", shape: "arrowDown" },
  add: { color: "#60a5fa", position: "belowBar", shape: "circle" },
  reduce: { color: "#fbbf24", position: "aboveBar", shape: "circle" },
  close: { color: "#a8b4c7", position: "inBar", shape: "square" },
  "loss-close": { color: "#f43f5e", position: "aboveBar", shape: "square" },
};

function normalizeTime(time: TradingChartTime): Time {
  if (typeof time === "number" && time > 100_000_000_000) {
    return Math.floor(time / 1000) as Time;
  }

  return time as Time;
}

function timeKey(time: TradingChartTime | Time): number {
  if (typeof time === "number") {
    return time > 100_000_000_000 ? Math.floor(time / 1000) : time;
  }

  if (typeof time === "string") {
    const parsed = Date.parse(time);
    return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
  }

  return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
}

function toMarkerLabel(marker: TradingChartMarker, selected: boolean): string {
  const label = marker.label.trim() || marker.kind;
  return selected ? `● ${label}` : label;
}

function toSeriesMarker(
  marker: TradingChartMarker,
  selected: boolean,
): SeriesMarker<Time> {
  const style = markerStyles[marker.kind];

  return {
    id: marker.id,
    time: normalizeTime(marker.time),
    ...style,
    ...(marker.price !== undefined && Number.isFinite(marker.price)
      ? { price: marker.price }
      : {}),
    text: toMarkerLabel(marker, selected),
  } as SeriesMarker<Time>;
}

export default function TradingChart({
  candles,
  markers,
  selectedTradeId,
  loading = false,
  error = null,
  cacheLabel = null,
  interval = "1h",
  onIntervalChange,
  onMarkerSelect,
}: TradingChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ChartSeriesRef | null>(null);
  const markerPrimitiveRef = useRef<MarkerPrimitiveRef | null>(null);
  const onMarkerSelectRef = useRef(onMarkerSelect);
  const stateRef = useRef<ChartState>({
    candles: [],
    markers: [],
    selectedTradeId: null,
  });
  const [selectedPoint, setSelectedPoint] = useState<SelectedPoint | null>(
    null,
  );

  const chartCandles = useMemo<CandlestickData<Time>[]>(
    () =>
      candles
        .filter((candle) =>
          [candle.open, candle.high, candle.low, candle.close].every(
            Number.isFinite,
          ),
        )
        .map((candle) => {
          const high = Math.max(candle.high, candle.open, candle.close);
          const low = Math.min(candle.low, candle.open, candle.close);

          return {
            time: normalizeTime(candle.time),
            open: candle.open,
            high,
            low,
            close: candle.close,
          };
        })
        .sort((left, right) => timeKey(left.time) - timeKey(right.time)),
    [candles],
  );

  const sortedMarkers = useMemo(
    () =>
      [...markers].sort(
        (left, right) => timeKey(left.time) - timeKey(right.time),
      ),
    [markers],
  );

  const refreshSelectedIndicator = useCallback(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const state = stateRef.current;

    if (!chart || !series || !state.selectedTradeId) {
      setSelectedPoint(null);
      return;
    }

    const marker = state.markers.find(
      (entry) => entry.id === state.selectedTradeId,
    );

    if (!marker) {
      setSelectedPoint(null);
      return;
    }

    const markerTime = normalizeTime(marker.time);
    const candle = state.candles.find(
      (entry) => timeKey(entry.time) === timeKey(markerTime),
    );
    const price = marker.price ?? candle?.close;

    if (price === undefined || !Number.isFinite(price)) {
      setSelectedPoint(null);
      return;
    }

    const left = chart.timeScale().timeToCoordinate(markerTime);
    const top = series.priceToCoordinate(price);

    if (left === null || top === null) {
      setSelectedPoint(null);
      return;
    }

    setSelectedPoint({ left, top });
  }, []);

  useEffect(() => {
    stateRef.current = {
      candles: chartCandles,
      markers: sortedMarkers,
      selectedTradeId,
    };
  }, [chartCandles, selectedTradeId, sortedMarkers]);

  useEffect(() => {
    onMarkerSelectRef.current = onMarkerSelect;
  }, [onMarkerSelect]);

  const zoomTimeScale = useCallback((spanMultiplier: number) => {
    const chart = chartRef.current;
    if (!chart || chartCandles.length === 0) return;
    const range = chart.timeScale().getVisibleLogicalRange();
    if (!range) return;
    const center = (range.from + range.to) / 2;
    const currentSpan = Math.max(range.to - range.from, 1);
    const nextSpan = Math.min(
      Math.max(currentSpan * spanMultiplier, 8),
      Math.max(chartCandles.length * 1.15, 8),
    );
    chart.timeScale().setVisibleLogicalRange({
      from: center - nextSpan / 2,
      to: center + nextSpan / 2,
    });
    window.requestAnimationFrame(refreshSelectedIndicator);
  }, [chartCandles.length, refreshSelectedIndicator]);

  const fitChart = useCallback(() => {
    chartRef.current?.timeScale().fitContent();
    window.requestAnimationFrame(refreshSelectedIndicator);
  }, [refreshSelectedIndicator]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const chart = createChart(host, {
      width: Math.max(host.clientWidth, 1),
      height: Math.max(host.clientHeight, 280),
      layout: {
        background: { type: ColorType.Solid, color: "#080b08" },
        textColor: "#9fb0c6",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      },
      grid: {
        vertLines: { color: "rgba(148, 163, 184, 0.10)" },
        horzLines: { color: "rgba(148, 163, 184, 0.10)" },
      },
      rightPriceScale: {
        borderColor: "rgba(148, 163, 184, 0.24)",
        minimumWidth: 68,
      },
      timeScale: {
        borderColor: "rgba(148, 163, 184, 0.24)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
      },
      crosshair: {
        vertLine: { color: "rgba(191, 219, 254, 0.42)", labelBackgroundColor: "#1d4ed8" },
        horzLine: { color: "rgba(191, 219, 254, 0.42)", labelBackgroundColor: "#1d4ed8" },
      },
      handleScroll: true,
      handleScale: true,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#34d399",
      downColor: "#fb7185",
      borderVisible: false,
      wickUpColor: "#34d399",
      wickDownColor: "#fb7185",
      priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
    });
    const markerPrimitive = createSeriesMarkers(series, []);

    chartRef.current = chart;
    seriesRef.current = series;
    markerPrimitiveRef.current = markerPrimitive;

    const resize = () => {
      chart.applyOptions({
        width: Math.max(host.clientWidth, 1),
        height: Math.max(host.clientHeight, 280),
      });
      refreshSelectedIndicator();
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    if (resizeObserver) {
      resizeObserver.observe(host);
    } else {
      window.addEventListener("resize", resize);
    }

    const rangeChangeHandler = () => refreshSelectedIndicator();
    const clickHandler = ({ time }: { time?: Time }) => {
      if (!time) {
        return;
      }

      const marker = stateRef.current.markers.find(
        (entry) => timeKey(entry.time) === timeKey(time),
      );
      if (marker) {
        onMarkerSelectRef.current?.(marker);
      }
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(rangeChangeHandler);
    chart.subscribeClick(clickHandler);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", resize);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(rangeChangeHandler);
      chart.unsubscribeClick(clickHandler);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markerPrimitiveRef.current = null;
    };
  }, [refreshSelectedIndicator]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const markerPrimitive = markerPrimitiveRef.current;
    if (!chart || !series || !markerPrimitive) {
      return;
    }

    series.setData(chartCandles);
    markerPrimitive.setMarkers(
      sortedMarkers.map((marker) =>
        toSeriesMarker(marker, marker.id === selectedTradeId),
      ),
    );

    const selectedIndex = selectedTradeId
      ? sortedMarkers.findIndex((marker) => marker.id === selectedTradeId)
      : -1;
    const selectedMarker =
      selectedIndex === -1 ? undefined : sortedMarkers[selectedIndex];

    if (selectedMarker) {
      const selectedTime = timeKey(selectedMarker.time);
      const candleIndex = chartCandles.findIndex(
        (candle) => timeKey(candle.time) === selectedTime,
      );

      if (candleIndex !== -1) {
        const visibleBars = Math.min(Math.max(chartCandles.length, 1), 40);
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(-0.5, candleIndex - visibleBars / 2),
          to: Math.min(chartCandles.length - 0.5, candleIndex + visibleBars / 2),
        });
      } else {
        chart.timeScale().fitContent();
      }
    } else {
      chart.timeScale().fitContent();
    }

    const frame = window.requestAnimationFrame(refreshSelectedIndicator);
    return () => window.cancelAnimationFrame(frame);
  }, [chartCandles, refreshSelectedIndicator, selectedTradeId, sortedMarkers]);

  const selectedMarker = selectedTradeId
    ? sortedMarkers.find((marker) => marker.id === selectedTradeId)
    : undefined;
  const statusText = error
    ? `Chart error: ${error}`
    : loading
      ? "Loading 30-day candles…"
      : chartCandles.length === 0
        ? "No 30-day candle data is available."
        : `${chartCandles.length} candles and ${sortedMarkers.length} trade markers loaded.`;

  return (
    <section className="trading-chart" aria-label="30-day trading chart">
      <div className="trading-chart__topline">
        <span>30-day price action</span>
        <div className="trading-chart__controls">
          <label className="trading-chart__interval-control">
            <span>캔들 주기</span>
            <select
              aria-label="캔들 주기"
              value={interval}
              disabled={!onIntervalChange || loading}
              onChange={(event) => onIntervalChange?.(event.target.value as CandleInterval)}
            >
              {intervalChoices.map((choice) => (
                <option key={choice.value} value={choice.value}>{choice.label}</option>
              ))}
            </select>
          </label>
          <div className="trading-chart__zoom" role="group" aria-label="차트 확대 축소">
            <button type="button" onClick={() => zoomTimeScale(1.35)} disabled={chartCandles.length === 0} aria-label="차트 축소">−</button>
            <button type="button" onClick={fitChart} disabled={chartCandles.length === 0}>전체</button>
            <button type="button" onClick={() => zoomTimeScale(0.72)} disabled={chartCandles.length === 0} aria-label="차트 확대">+</button>
          </div>
          {cacheLabel ? <span className="trading-chart__cache">{cacheLabel}</span> : null}
        </div>
      </div>

      <div className="trading-chart__plot-wrap">
        <div
          ref={hostRef}
          className="trading-chart__plot"
          role="img"
          aria-label={statusText}
        />
        {selectedPoint && selectedMarker ? (
          <span
            className={`trading-chart__selected-marker trading-chart__selected-marker--${selectedMarker.kind}`}
            style={{ left: selectedPoint.left, top: selectedPoint.top }}
            aria-hidden="true"
          />
        ) : null}
        {loading ? (
          <div className="trading-chart__overlay" role="status">
            Loading candles…
          </div>
        ) : null}
        {error ? (
          <div className="trading-chart__overlay trading-chart__overlay--error" role="alert">
            {error}
          </div>
        ) : null}
        {!loading && !error && chartCandles.length === 0 ? (
          <div className="trading-chart__overlay">No chart data for this period.</div>
        ) : null}
      </div>

      <p className="trading-chart__sr-status" aria-live="polite">
        {statusText}
      </p>

      {sortedMarkers.length > 0 ? (
        <details className="trading-chart__marker-list">
          <summary>Trade markers ({sortedMarkers.length})</summary>
          <div className="trading-chart__marker-actions">
            {sortedMarkers.map((marker) => (
              <button
                type="button"
                key={marker.id}
                className={marker.id === selectedTradeId ? "is-selected" : undefined}
                onClick={() => onMarkerSelect?.(marker)}
                aria-pressed={marker.id === selectedTradeId}
              >
                {marker.kind}: {marker.label || marker.id}
              </button>
            ))}
          </div>
        </details>
      ) : null}

      <style>{`
        .trading-chart {
          color: #dce7f7;
          background: #08111f;
          border: 1px solid rgba(148, 163, 184, 0.2);
          border-radius: 14px;
          overflow: hidden;
        }
        .trading-chart__topline {
          align-items: center;
          display: flex;
          font-size: 0.825rem;
          font-weight: 650;
          justify-content: space-between;
          letter-spacing: 0.01em;
          padding: 0.7rem 0.9rem;
        }
        .trading-chart__controls {
          align-items: center;
          display: flex;
          gap: 0.55rem;
        }
        .trading-chart__interval-control {
          align-items: center;
          color: #9fb0c6;
          display: flex;
          font-size: 0.72rem;
          gap: 0.35rem;
        }
        .trading-chart__interval-control select,
        .trading-chart__zoom button {
          background: #101d30;
          border: 1px solid rgba(148, 163, 184, 0.3);
          border-radius: 7px;
          color: #dce7f7;
          font: inherit;
          min-height: 30px;
        }
        .trading-chart__interval-control select {
          cursor: pointer;
          padding: 0 1.6rem 0 0.5rem;
        }
        .trading-chart__zoom {
          display: flex;
          gap: 0.25rem;
        }
        .trading-chart__zoom button {
          cursor: pointer;
          min-width: 30px;
          padding: 0 0.45rem;
        }
        .trading-chart__zoom button:hover:not(:disabled),
        .trading-chart__zoom button:focus-visible,
        .trading-chart__interval-control select:focus-visible {
          border-color: #60a5fa;
          outline: none;
        }
        .trading-chart__zoom button:disabled,
        .trading-chart__interval-control select:disabled {
          cursor: not-allowed;
          opacity: 0.45;
        }
        .trading-chart__cache {
          color: #9fb0c6;
          font-size: 0.75rem;
          font-weight: 500;
        }
        .trading-chart__plot-wrap {
          min-height: 280px;
          position: relative;
        }
        .trading-chart__plot {
          height: clamp(280px, 48vw, 430px);
          width: 100%;
        }
        .trading-chart__selected-marker {
          background: #f8fafc;
          border: 2px solid #08111f;
          border-radius: 999px;
          box-shadow: 0 0 0 4px rgba(248, 250, 252, 0.45), 0 0 22px 6px rgba(96, 165, 250, 0.9);
          height: 12px;
          pointer-events: none;
          position: absolute;
          transform: translate(-50%, -50%);
          width: 12px;
          z-index: 2;
        }
        .trading-chart__selected-marker::after {
          animation: trading-chart-pulse 1.4s ease-out infinite;
          border: 2px solid #93c5fd;
          border-radius: inherit;
          content: "";
          inset: -7px;
          position: absolute;
        }
        .trading-chart__selected-marker--loss-close,
        .trading-chart__selected-marker--short {
          box-shadow: 0 0 0 4px rgba(255, 241, 242, 0.46), 0 0 22px 6px rgba(251, 113, 133, 0.92);
        }
        .trading-chart__overlay {
          align-items: center;
          background: rgba(8, 17, 31, 0.76);
          color: #c5d3e7;
          display: flex;
          inset: 0;
          justify-content: center;
          padding: 1rem;
          position: absolute;
          text-align: center;
          z-index: 3;
        }
        .trading-chart__overlay--error { color: #fda4af; }
        .trading-chart__sr-status {
          height: 1px;
          margin: -1px;
          overflow: hidden;
          position: absolute;
          width: 1px;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
        }
        .trading-chart__marker-list {
          border-top: 1px solid rgba(148, 163, 184, 0.16);
          color: #9fb0c6;
          font-size: 0.78rem;
          padding: 0.6rem 0.9rem;
        }
        .trading-chart__marker-list summary { cursor: pointer; }
        .trading-chart__marker-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 0.4rem;
          margin-top: 0.65rem;
        }
        .trading-chart__marker-actions button {
          background: #101d30;
          border: 1px solid rgba(148, 163, 184, 0.3);
          border-radius: 999px;
          color: #dce7f7;
          cursor: pointer;
          font: inherit;
          padding: 0.3rem 0.55rem;
        }
        .trading-chart__marker-actions button:hover,
        .trading-chart__marker-actions button:focus-visible,
        .trading-chart__marker-actions button.is-selected {
          border-color: #60a5fa;
          outline: none;
        }
        @keyframes trading-chart-pulse {
          from { opacity: 0.95; transform: scale(0.55); }
          to { opacity: 0; transform: scale(1.35); }
        }
        @media (max-width: 640px) {
          .trading-chart__plot { height: 300px; }
          .trading-chart__topline { align-items: flex-start; flex-direction: column; padding: 0.65rem 0.75rem; }
          .trading-chart__controls { flex-wrap: wrap; width: 100%; }
          .trading-chart__cache { margin-left: auto; }
        }
        @media (prefers-reduced-motion: reduce) {
          .trading-chart__selected-marker::after { animation: none; }
        }
      `}</style>
    </section>
  );
}
