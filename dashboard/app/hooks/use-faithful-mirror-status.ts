"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type UnknownRecord = Record<string, unknown>;

export type FaithfulMirrorMode = "PAPER" | "LIVE" | "UNKNOWN";

export type FaithfulMirrorAccount = {
  equityUsd: number | null;
  receivedAt: number | null;
  positions: UnknownRecord[];
  orders: UnknownRecord[];
  /** Allowlisted account facts forwarded by the local read-only endpoint. */
  facts: UnknownRecord;
};

export type FaithfulMirrorPair = {
  pairId: string;
  sourceAddress: string | null;
  /** Server-provided masked label only; never a target-account mapping. */
  targetAccountLabel: string | null;
  /** Server-provided display-safe mask, for example 0x1234…abcd. */
  targetAddressDisplay: string | null;
  state: string;
  initialized: boolean;
  blocked: boolean;
  killed: boolean;
  killReason: string | null;
  lastError: string | null;
  source: FaithfulMirrorAccount;
  target: FaithfulMirrorAccount;
  trackingDebt: UnknownRecord;
  metrics: UnknownRecord;
  stats: UnknownRecord;
};

export type FaithfulMirrorEvent = {
  at: number | null;
  type: string;
  pairId: string | null;
  coin: string | null;
  side: string | null;
  message: string | null;
  details: UnknownRecord;
};

export type FaithfulMirrorSnapshot = {
  ok: boolean;
  connected: boolean;
  observedAt: number | null;
  stale: boolean;
  staleReason: string | null;
  service: {
    mode: FaithfulMirrorMode;
    state: string;
    running: boolean;
    killed: boolean;
    sessionId: string | null;
    recoveryAvailable: boolean;
    liveGate: {
      state: string;
      configured: boolean;
      armed: boolean;
      armExpiresAt: number | null;
      canStart: false;
      reason: string | null;
    };
  };
  pairs: FaithfulMirrorPair[];
  events: FaithfulMirrorEvent[];
};

export type FaithfulMirrorStatus = {
  snapshot: FaithfulMirrorSnapshot | null;
  equitySamples: Array<{ at: number; sourceEquityUsd: number | null; followerEquityUsd: number | null }>;
  loading: boolean;
  error: string | null;
  lastCheckedAt: number | null;
  refresh: () => Promise<void>;
};

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
);

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const asString = (value: unknown, fallback = ""): string => (
  typeof value === "string" && value.trim() ? value.trim() : fallback
);

const asBoolean = (value: unknown): boolean => value === true;

const asFiniteNumber = (value: unknown): number | null => {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) ? numeric : null;
};

const asTime = (value: unknown): number | null => {
  const numeric = asFiniteNumber(value);
  if (numeric != null) return numeric;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeAccount = (value: unknown): FaithfulMirrorAccount => {
  const account = asRecord(value);
  return {
    equityUsd: asFiniteNumber(account.equityUsd),
    receivedAt: asTime(account.receivedAt),
    positions: asArray(account.positions).map(asRecord),
    orders: asArray(account.orders).map(asRecord),
    facts: account,
  };
};

const normalizePair = (value: unknown, index: number): FaithfulMirrorPair => {
  const pair = asRecord(value);
  return {
    pairId: asString(pair.pairId, `pair-${index + 1}`),
    sourceAddress: asString(pair.sourceAddress) || null,
    targetAccountLabel: asString(pair.targetAccountLabel) || null,
    targetAddressDisplay: asString(pair.targetAddressDisplay) || null,
    state: asString(pair.state, "UNKNOWN").toUpperCase(),
    initialized: asBoolean(pair.initialized),
    blocked: asBoolean(pair.blocked),
    killed: asBoolean(pair.killed),
    killReason: asString(pair.killReason) || null,
    lastError: asString(pair.lastError) || null,
    source: normalizeAccount(pair.source),
    target: normalizeAccount(pair.target),
    trackingDebt: asRecord(pair.trackingDebt),
    metrics: asRecord(pair.metrics),
    stats: asRecord(pair.stats),
  };
};

const normalizeEvent = (value: unknown): FaithfulMirrorEvent => {
  const event = asRecord(value);
  return {
    at: asTime(event.at),
    type: asString(event.type, "EVENT").toUpperCase(),
    pairId: asString(event.pairId) || null,
    coin: asString(event.coin) || null,
    side: asString(event.side) || null,
    message: asString(event.message) || null,
    details: asRecord(event.details),
  };
};

/**
 * Converts a localhost response into a display-safe shape.  The UI must keep
 * rendering useful safety context while a local service/backend is upgraded,
 * so missing optional fields become explicit unknowns instead of assumptions.
 */
export const normalizeFaithfulMirrorSnapshot = (value: unknown): FaithfulMirrorSnapshot => {
  const payload = asRecord(value);
  const service = asRecord(payload.service);
  const liveGate = asRecord(service.liveGate);
  const rawMode = asString(service.mode).toUpperCase();
  const mode: FaithfulMirrorMode = rawMode === "PAPER" || rawMode === "LIVE" ? rawMode : "UNKNOWN";
  return {
    ok: payload.ok !== false,
    connected: asBoolean(payload.connected),
    observedAt: asTime(payload.observedAt),
    stale: asBoolean(payload.stale),
    staleReason: asString(payload.staleReason) || null,
    service: {
      mode,
      state: asString(service.state, "UNKNOWN").toUpperCase(),
      running: asBoolean(service.running),
      killed: asBoolean(service.killed),
      sessionId: asString(service.sessionId) || null,
      recoveryAvailable: asBoolean(service.recoveryAvailable),
      liveGate: {
        state: asString(liveGate.state, mode === "LIVE" ? "LOCKED" : "PAPER_NOT_APPLICABLE").toUpperCase(),
        configured: asBoolean(liveGate.configured),
        armed: asBoolean(liveGate.armed),
        armExpiresAt: asTime(liveGate.armExpiresAt),
        // The endpoint is deliberately read-only. Never allow a server response
        // to turn this dashboard into an arm/start/order control surface.
        canStart: false,
        reason: asString(liveGate.reason) || null,
      },
    },
    pairs: asArray(payload.pairs).map(normalizePair),
    events: asArray(payload.events).map(normalizeEvent),
  };
};

export function useFaithfulMirrorStatus({ enabled, pollMs = 1_000 }: { enabled: boolean; pollMs?: number }): FaithfulMirrorStatus {
  const [snapshot, setSnapshot] = useState<FaithfulMirrorSnapshot | null>(null);
  const [equitySamples, setEquitySamples] = useState<Array<{ at: number; sourceEquityUsd: number | null; followerEquityUsd: number | null }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const id = requestId.current + 1;
    requestId.current = id;
    setLoading(true);
    try {
      const response = await fetch("/api/faithful-mirror-v2", {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`로컬 상태 API가 ${response.status} 응답을 반환했습니다.`);
      if (requestId.current !== id) return;
      const next = normalizeFaithfulMirrorSnapshot(payload);
      setSnapshot(next);
      const sourceValues = next.pairs.map((pair) => pair.source.equityUsd).filter((item): item is number => item != null);
      const followerValues = next.pairs.map((pair) => pair.target.equityUsd).filter((item): item is number => item != null);
      const sourceEquityUsd = sourceValues.length ? sourceValues.reduce((total, item) => total + item, 0) : null;
      const followerEquityUsd = followerValues.length ? followerValues.reduce((total, item) => total + item, 0) : null;
      setEquitySamples((current) => [
        ...current,
        { at: Date.now(), sourceEquityUsd, followerEquityUsd },
      ].slice(-180));
      setError(next.ok ? null : "Faithful Mirror 상태를 확인하지 못했습니다.");
    } catch (cause) {
      if (requestId.current !== id) return;
      setError(cause instanceof Error ? cause.message : "Faithful Mirror 상태를 불러오지 못했습니다.");
    } finally {
      if (requestId.current === id) {
        setLoading(false);
        setLastCheckedAt(Date.now());
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    // Schedule the first poll after mounting rather than synchronously setting
    // state from the effect body.  It also makes status changes cancellable.
    const initialTimer = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), Math.max(500, pollMs));
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [enabled, pollMs, refresh]);

  return { snapshot, equitySamples, loading, error, lastCheckedAt, refresh };
}
