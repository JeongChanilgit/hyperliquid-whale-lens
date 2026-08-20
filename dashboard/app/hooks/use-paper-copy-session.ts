"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CopyTradingFailureLog,
  CopyTradingOrder,
  CopyTradingWhale,
} from "../components/CopyTradingPanel";
import { HyperliquidUserFillsMonitor } from "../lib/realtime/hyperliquid-ws";
import { CopySimulationLedger } from "../lib/realtime/simulation-ledger";

const STORAGE_KEY = "whale-lens-paper-copy-v1";
const MAX_LOGS = 300;

export type PaperWalletInput = {
  address: string;
  label: string;
};

type PersistedSession = {
  pnlByWhale: Record<string, number>;
  orders: CopyTradingOrder[];
  failureLogs: CopyTradingFailureLog[];
};

const readPersistedSession = (): PersistedSession | null => {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as PersistedSession | null;
  } catch {
    return null;
  }
};

const idleWhale = (wallet: PaperWalletInput): CopyTradingWhale => ({
  id: wallet.address.toLowerCase(),
  label: wallet.label,
  enabled: true,
  connectionStatus: "offline",
  latencyMs: null,
  pnl: 0,
  openOrderCount: 0,
  lastActivityAt: null,
});

export function usePaperCopySession(wallets: PaperWalletInput[]) {
  const [initialSession] = useState(readPersistedSession);
  const [whales, setWhales] = useState<CopyTradingWhale[]>(() =>
    wallets.slice(0, 10).map(idleWhale),
  );
  const [orders, setOrders] = useState<CopyTradingOrder[]>(() => initialSession?.orders?.slice(0, MAX_LOGS) ?? []);
  const [failureLogs, setFailureLogs] = useState<CopyTradingFailureLog[]>(() => initialSession?.failureLogs?.slice(0, MAX_LOGS) ?? []);
  const [pnlByWhale, setPnlByWhale] = useState<Record<string, number>>(() => initialSession?.pnlByWhale ?? {});
  const [isRunning, setIsRunning] = useState(false);
  const monitorRef = useRef<HyperliquidUserFillsMonitor | null>(null);
  const ledgerRef = useRef(new CopySimulationLedger());

  useEffect(() => {
    if (isRunning) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync the external wallet list only while the monitor is stopped
    setWhales((current) => {
      const currentById = new Map(current.map((whale) => [whale.id, whale]));
      return wallets.slice(0, 10).map((wallet) => {
        const id = wallet.address.toLowerCase();
        const previous = currentById.get(id);
        return previous
          ? { ...previous, label: wallet.label, connectionStatus: "offline", latencyMs: null }
          : idleWhale(wallet);
      });
    });
  }, [isRunning, wallets]);

  useEffect(() => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ pnlByWhale, orders: orders.slice(0, MAX_LOGS), failureLogs: failureLogs.slice(0, MAX_LOGS) }),
    );
  }, [failureLogs, orders, pnlByWhale]);

  useEffect(() => () => monitorRef.current?.stop(), []);

  const addFailure = useCallback((entry: CopyTradingFailureLog) => {
    setFailureLogs((current) => [entry, ...current].slice(0, MAX_LOGS));
  }, []);

  const start = useCallback(() => {
    if (monitorRef.current) return;
    const enabled = whales.filter((whale) => whale.enabled).slice(0, 10);
    if (enabled.length === 0) return;
    ledgerRef.current = new CopySimulationLedger();
    setWhales((current) => current.map((whale) =>
      whale.enabled ? { ...whale, connectionStatus: "connecting" } : whale,
    ));
    const monitor = new HyperliquidUserFillsMonitor({ whales: enabled.map((whale) => whale.id) });
    monitor.subscribe((event) => {
      const now = Date.now();
      if (event.type === "error") {
        addFailure({
          id: `ws-${now}-${Math.random().toString(36).slice(2)}`,
          occurredAt: new Date(now).toISOString(),
          whaleId: event.whale ?? null,
          severity: "error",
          code: "SOURCE_STREAM",
          message: event.message ?? "Hyperliquid 실시간 연결 오류",
        });
        setWhales((current) => current.map((whale) =>
          !event.whale || whale.id === event.whale
            ? { ...whale, connectionStatus: "delayed" }
            : whale,
        ));
        return;
      }
      if (event.type === "status") {
        setWhales((current) => current.map((whale) => {
          if (!whale.enabled) return whale;
          if (event.whale && whale.id !== event.whale) return whale;
          return { ...whale, connectionStatus: event.message?.includes("stopped") ? "offline" : "connected" };
        }));
        return;
      }
      if (event.type !== "fill" || !event.whale || !event.fill) return;

      const whale = enabled.find((item) => item.id === event.whale);
      if (!whale) return;
      const ledgerEvent = ledgerRef.current.apply(
        { address: whale.id, copyRatio: 0.01 },
        event.fill,
      );
      const latencyMs = Math.max(0, now - event.fill.time);
      setWhales((current) => current.map((item) => item.id === whale.id
        ? {
            ...item,
            connectionStatus: latencyMs > 2_000 ? "delayed" : "connected",
            latencyMs,
            lastActivityAt: new Date(event.fill!.time).toISOString(),
            openOrderCount: (item.openOrderCount ?? 0) + ledgerEvent.fills.length,
            pnl: (item.pnl ?? 0) + ledgerEvent.realizedPnl - ledgerEvent.fills.reduce((sum, fill) => sum + fill.fee, 0),
          }
        : item));
      const pnlDelta = ledgerEvent.realizedPnl - ledgerEvent.fills.reduce((sum, fill) => sum + fill.fee, 0);
      if (pnlDelta !== 0) {
        setPnlByWhale((current) => ({ ...current, [whale.id]: (current[whale.id] ?? 0) + pnlDelta }));
      }
      if (ledgerEvent.fills.length > 0) {
        const nextOrders: CopyTradingOrder[] = ledgerEvent.fills.map((fill) => ({
          id: fill.id,
          whaleId: whale.id,
          symbol: fill.coin,
          side: fill.side === "BUY" ? "long" : "short",
          status: "filled",
          size: fill.quantity,
          price: fill.price,
          createdAt: new Date(fill.time).toISOString(),
          segment: fill.segment,
        }));
        setOrders((current) => [...nextOrders.reverse(), ...current].slice(0, MAX_LOGS));
      } else if (ledgerEvent.ignoredReason === "DESYNC") {
        addFailure({
          id: `desync-${ledgerEvent.sourceFillId}`,
          occurredAt: new Date(now).toISOString(),
          whaleId: whale.id,
          severity: "warning",
          code: "POSITION_DESYNC",
          message: "누락 체결 가능성이 있어 해당 포지션이 평탄화될 때까지 복사를 보류했습니다.",
        });
      }
    });
    monitorRef.current = monitor;
    monitor.start();
    setIsRunning(true);
  }, [addFailure, whales]);

  const stop = useCallback(() => {
    monitorRef.current?.stop();
    monitorRef.current = null;
    setIsRunning(false);
    setWhales((current) => current.map((whale) => ({
      ...whale,
      connectionStatus: "offline",
      latencyMs: null,
    })));
  }, []);

  const setWhaleEnabled = useCallback((id: string, enabled: boolean) => {
    if (isRunning) return;
    setWhales((current) => current.map((whale) => whale.id === id ? { ...whale, enabled } : whale));
  }, [isRunning]);

  const totalPnl = Object.values(pnlByWhale).reduce((sum, value) => sum + value, 0);
  const observedLatencies = whales.map((whale) => whale.latencyMs).filter((value): value is number => value !== null && value !== undefined);
  const connectionDelayMs = observedLatencies.length > 0
    ? Math.round(observedLatencies.reduce((sum, value) => sum + value, 0) / observedLatencies.length)
    : null;

  return {
    whales: whales.map((whale) => ({ ...whale, pnl: pnlByWhale[whale.id] ?? whale.pnl ?? 0 })),
    orders,
    failureLogs,
    totalPnl,
    connectionDelayMs,
    isRunning,
    start,
    stop,
    setWhaleEnabled,
  };
}
