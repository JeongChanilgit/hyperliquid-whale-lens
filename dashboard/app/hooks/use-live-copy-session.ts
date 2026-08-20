"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CopyTradingFailureLog,
  CopyTradingOrder,
  CopyTradingWhale,
} from "../components/CopyTradingPanel";
import type { AuditReadResponse, AuditSyncInput } from "../lib/server/audit-contract";
import type { CopyEngineConfig, CopyEngineSnapshot, EngineLogEntry } from "../lib/copy-types";

const ALLOWED_SYMBOLS = ["*"];
const MAX_WALLETS = 50;
const DISPLAY_WALLETS = 10;

type LiveWalletInput = { address: string; label: string };
type StatusPayload = {
  running?: boolean;
  snapshot?: CopyEngineSnapshot | null;
  executionEnabled?: boolean;
  liveArmed?: boolean;
  liveArmExpiresAt?: number | null;
  testnet?: boolean;
  error?: string;
};

const readNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const sameIds = (left: Set<string>, right: Set<string>): boolean =>
  left.size === right.size && [...left].every((id) => right.has(id));

function toIso(time: number): string {
  return new Date(time).toISOString();
}

function mirrorStatusForUi(status: string): CopyTradingOrder["status"] {
  if (status === "OPEN") return "open";
  if (status === "FILLED") return "filled";
  if (status === "CANCELED") return "cancelled";
  if (status === "REJECTED") return "rejected";
  return "pending";
}

function severityForLog(entry: EngineLogEntry): "info" | "warning" | "error" {
  if (entry.kind === "ERROR") return "error";
  if (entry.kind === "RISK_BLOCK") return "warning";
  return "info";
}

function buildAuditSync(
  wallets: LiveWalletInput[],
  enabledIds: Set<string>,
  snapshot: CopyEngineSnapshot | null | undefined,
  executionEnabled: boolean,
  testnet: boolean,
): AuditSyncInput {
  const runId = snapshot ? `engine-${snapshot.startedAt ?? "unstarted"}` : null;
  const entries = snapshot?.logs ?? [];

  return {
    wallets: wallets.slice(0, MAX_WALLETS).map((wallet, sortOrder) => ({
      address: wallet.address,
      label: wallet.label,
      enabled: enabledIds.has(wallet.address.toLowerCase()),
      sortOrder,
    })),
    run: snapshot && runId
      ? {
          id: runId,
          mode: snapshot.mode,
          state: snapshot.state,
          startedAt: snapshot.startedAt ?? Date.now(),
          stoppedAt: ["STOPPED", "ERROR"].includes(snapshot.state) ? Date.now() : null,
          executionEnabled,
          testnet,
        }
      : null,
    orders: runId
      ? [
          ...(snapshot?.mirroredOrders ?? []).map((order) => ({
            id: `mirror-${order.id}`,
            sourceEventId: `mirror-${order.id}`,
            runId,
            whaleAddress: order.whale,
            symbol: order.symbol,
            side: order.side === "BUY" ? "long" as const : "short" as const,
            segment: null,
            status: mirrorStatusForUi(order.status),
            size: order.followerOriginalQuantity,
            price: order.price,
            createdAt: order.createdAt,
          })),
          ...entries
          .filter((entry) => entry.kind === "EXECUTION" && (entry.detail?.side === "BUY" || entry.detail?.side === "SELL"))
          .map((entry) => ({
            id: entry.id,
            sourceEventId: entry.id,
            runId,
            whaleAddress: entry.whale ?? "unknown",
            symbol: entry.symbol ?? entry.coin ?? "—",
            side: entry.detail?.side === "BUY" ? "long" as const : "short" as const,
            segment: typeof entry.detail?.segment === "string" ? entry.detail.segment : null,
            status: "filled",
            size: readNumber(entry.detail?.quantity) ?? 0,
            price: readNumber(entry.detail?.price),
            createdAt: entry.time,
          })),
        ].sort((a, b) => a.createdAt - b.createdAt).slice(-200)
      : [],
    logs: runId
      ? entries.slice(-500).map((entry) => ({
          id: entry.id,
          eventKey: entry.id,
          runId,
          kind: entry.kind,
          severity: severityForLog(entry),
          message: entry.message,
          whaleAddress: entry.whale ?? null,
          symbol: entry.symbol ?? entry.coin ?? null,
          latencyMs: entry.latencyMs ?? null,
          detail: entry.detail ?? null,
          occurredAt: entry.time,
        }))
      : [],
    performance: runId
      ? Object.entries(snapshot?.performanceByWhale ?? {}).slice(0, MAX_WALLETS).map(([whaleAddress, performance]) => ({
          runId,
          whaleAddress,
          realizedPnl: performance.realizedPnl,
          fees: performance.fees,
          executedNotionalUsd: performance.executedNotionalUsd,
          executions: performance.executions,
          blockedExecutions: performance.blockedExecutions,
          errors: performance.errors,
          updatedAt: Date.now(),
        }))
      : [],
  };
}

async function readAudit(): Promise<AuditReadResponse> {
  const response = await fetch("/api/audit?ordersLimit=100&logsLimit=100", { cache: "no-store" });
  const payload = await response.json() as AuditReadResponse & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `감사 로그 조회 실패 (${response.status})`);
  return payload;
}

async function syncAudit(audit: AuditSyncInput): Promise<void> {
  const response = await fetch("/api/audit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "sync", audit }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? `감사 로그 저장 실패 (${response.status})`);
  }
}

export function useLiveCopySession(wallets: LiveWalletInput[], active: boolean) {
  const [enabledIds, setEnabledIds] = useState<Set<string>>(
    () => new Set(wallets.slice(0, DISPLAY_WALLETS).map((wallet) => wallet.address.toLowerCase())),
  );
  const [snapshot, setSnapshot] = useState<CopyEngineSnapshot | null>(null);
  const [audit, setAudit] = useState<AuditReadResponse | null>(null);
  const [serverConnected, setServerConnected] = useState(false);
  const [executionEnabled, setExecutionEnabled] = useState(false);
  const [liveArmed, setLiveArmed] = useState(false);
  const [liveArmExpiresAt, setLiveArmExpiresAt] = useState<number | null>(null);
  const [testnet, setTestnet] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reloadAudit = useCallback(async () => {
    const nextAudit = await readAudit();
    setAudit(nextAudit);
    if (nextAudit.wallets.length > 0) {
      const nextIds = new Set(nextAudit.wallets.filter((wallet) => wallet.enabled).map((wallet) => wallet.address.toLowerCase()));
      setEnabledIds((current) => sameIds(current, nextIds) ? current : nextIds);
    }
    return nextAudit;
  }, []);

  const persistSnapshot = useCallback(async (
    nextSnapshot: CopyEngineSnapshot | null | undefined,
    nextExecutionEnabled: boolean,
    nextTestnet: boolean,
    selectedIds = enabledIds,
  ) => {
    await syncAudit(buildAuditSync(wallets, selectedIds, nextSnapshot, nextExecutionEnabled, nextTestnet));
  }, [enabledIds, wallets]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/copy-engine", { cache: "no-store" });
      const payload = await response.json() as StatusPayload;
      if (!response.ok) throw new Error(payload.error ?? `실행 서버 상태 확인 실패 (${response.status})`);
      const nextExecutionEnabled = Boolean(payload.executionEnabled);
      const nextTestnet = payload.testnet !== false;
      const nextSnapshot = payload.snapshot ?? null;
      const runtimeIds = new Set((nextSnapshot?.watchedWhales ?? []).map((address) => address.toLowerCase()));
      const selectedIds = runtimeIds.size > 0 ? runtimeIds : enabledIds;
      setServerConnected(true);
      setExecutionEnabled(nextExecutionEnabled);
      setLiveArmed(payload.liveArmed === true);
      setLiveArmExpiresAt(typeof payload.liveArmExpiresAt === "number" ? payload.liveArmExpiresAt : null);
      setTestnet(nextTestnet);
      setSnapshot(nextSnapshot);
      setEnabledIds((current) => sameIds(current, selectedIds) ? current : selectedIds);
      await persistSnapshot(nextSnapshot, nextExecutionEnabled, nextTestnet, selectedIds);
      await reloadAudit();
      setError(null);
    } catch (requestError) {
      setServerConnected(false);
      setExecutionEnabled(false);
      setLiveArmed(false);
      setLiveArmExpiresAt(null);
      setError(requestError instanceof Error ? requestError.message : "실행 서버 또는 감사 로그에 연결하지 못했습니다.");
      try {
        await reloadAudit();
      } catch {
        // The UI intentionally has no browser-persisted audit fallback.
      }
    }
  }, [enabledIds, persistSnapshot, reloadAudit]);

  useEffect(() => {
    if (!active) return;
    queueMicrotask(() => void refresh());
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  const start = useCallback(async (requestedMode: "SIMULATION" | "HYPERLIQUID" = "HYPERLIQUID") => {
    setLoading(true);
    try {
      if (requestedMode === "HYPERLIQUID" && !liveArmed) throw new Error("서버 측 실전 승인이 없거나 만료되었습니다.");
      const selected = wallets
        .filter((wallet) => enabledIds.has(wallet.address.toLowerCase()))
        .slice(0, DISPLAY_WALLETS);
      const config: CopyEngineConfig = {
        mode: requestedMode,
        whales: selected.map((wallet) => ({ address: wallet.address, copyRatio: 0.01 })),
        sizing: {
          mode: "SOURCE_EQUITY_RATIO",
          followerCapitalUsd: 1_000,
          maxAccountStateAgeMs: 60_000,
          minSourceAccountValueUsd: 10_000,
        },
        risk: {
          allowedWhales: selected.map((wallet) => wallet.address),
          allowedSymbols: ALLOWED_SYMBOLS,
          maxNotionalUsd: 1_000_000_000,
          maxSlippageProxyBps: 30,
          maxDailyLossUsd: 50,
          killSwitch: false,
        },
      };
      const response = await fetch("/api/copy-engine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start", config }),
      });
      const payload = await response.json() as StatusPayload;
      if (!response.ok) throw new Error(payload.error ?? `복사 시작 실패 (${response.status})`);
      if (payload.snapshot?.mode !== requestedMode) {
        throw new Error(`현재 runner는 ${payload.snapshot?.mode ?? "알 수 없는"} 모드이며 ${requestedMode} 세션을 시작하지 않았습니다.`);
      }
      setSnapshot(payload.snapshot ?? null);
      setExecutionEnabled(Boolean(payload.executionEnabled));
      setTestnet(payload.testnet !== false);
      await persistSnapshot(payload.snapshot ?? null, Boolean(payload.executionEnabled), payload.testnet !== false);
      await reloadAudit();
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "복사를 시작하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [enabledIds, liveArmed, persistSnapshot, reloadAudit, wallets]);

  const armLive = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/copy-engine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "arm-live",
          confirmation: "I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS",
        }),
      });
      const payload = await response.json() as StatusPayload;
      if (!response.ok) throw new Error(payload.error ?? `실전 승인 실패 (${response.status})`);
      setLiveArmed(payload.liveArmed === true);
      setLiveArmExpiresAt(typeof payload.liveArmExpiresAt === "number" ? payload.liveArmExpiresAt : null);
      setExecutionEnabled(Boolean(payload.executionEnabled));
      setError(null);
    } catch (requestError) {
      setLiveArmed(false);
      setLiveArmExpiresAt(null);
      setError(requestError instanceof Error ? requestError.message : "서버 측 실전 승인을 완료하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  const stop = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/copy-engine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      const payload = await response.json() as StatusPayload;
      if (!response.ok) throw new Error(payload.error ?? `실전 복사 중지 실패 (${response.status})`);
      setSnapshot(payload.snapshot ?? null);
      await persistSnapshot(payload.snapshot ?? null, executionEnabled, testnet);
      await reloadAudit();
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "실전 복사를 중지하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [executionEnabled, persistSnapshot, reloadAudit, testnet]);

  const configureSimulationSizing = useCallback(async (marginPerWhaleUsd: number) => {
    setLoading(true);
    try {
      const response = await fetch("/api/copy-engine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "configure-simulation", marginPerWhaleUsd }),
      });
      const payload = await response.json() as StatusPayload;
      if (!response.ok) throw new Error(payload.error ?? `모의 증거금 설정 실패 (${response.status})`);
      setSnapshot(payload.snapshot ?? null);
      await persistSnapshot(payload.snapshot ?? null, Boolean(payload.executionEnabled), payload.testnet !== false);
      await reloadAudit();
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "모의 증거금 설정을 적용하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [persistSnapshot, reloadAudit]);

  const setWhaleEnabled = useCallback((id: string, enabled: boolean) => {
    if (snapshot?.state === "RUNNING" || snapshot?.state === "STARTING") return;
    const next = new Set(enabledIds);
    if (enabled) next.add(id); else next.delete(id);
    setEnabledIds(next);
    void persistSnapshot(snapshot, executionEnabled, testnet, next)
      .then(reloadAudit)
      .catch((requestError: unknown) => {
        setError(requestError instanceof Error ? requestError.message : "고래 설정을 저장하지 못했습니다.");
      });
  }, [enabledIds, executionEnabled, persistSnapshot, reloadAudit, snapshot, testnet]);

  const isRunning = snapshot?.state === "RUNNING" || snapshot?.state === "STARTING";
  const auditPerformanceByWhale = useMemo(
    () => new Map((audit?.performance ?? []).map((item) => [item.whaleAddress, item])),
    [audit],
  );
  const auditWalletByAddress = useMemo(
    () => new Map((audit?.wallets ?? []).map((wallet) => [wallet.address.toLowerCase(), wallet])),
    [audit],
  );
  const walletByAddress = useMemo(
    () => new Map(wallets.map((wallet) => [wallet.address.toLowerCase(), wallet])),
    [wallets],
  );
  const runtimeWhaleIds = useMemo(
    () => (snapshot?.watchedWhales ?? []).map((address) => address.toLowerCase()),
    [snapshot?.watchedWhales],
  );
  const runtimeWhaleLabels = useMemo(
    () => new Map(Object.entries(snapshot?.whaleLabels ?? {}).map(([address, label]) => [address.toLowerCase(), label])),
    [snapshot?.whaleLabels],
  );
  const displayedWallets = useMemo(() => {
    const addresses = runtimeWhaleIds.length > 0
      ? runtimeWhaleIds
      : wallets.filter((wallet) => enabledIds.has(wallet.address.toLowerCase())).slice(0, DISPLAY_WALLETS).map((wallet) => wallet.address.toLowerCase());
    return addresses.map((address, index) => walletByAddress.get(address) ?? {
      address,
      label: runtimeWhaleLabels.get(address) ?? `Whale ${String(index + 1).padStart(2, "0")}`,
    });
  }, [enabledIds, runtimeWhaleIds, runtimeWhaleLabels, walletByAddress, wallets]);
  const runtimeWhaleSet = useMemo(() => new Set(runtimeWhaleIds), [runtimeWhaleIds]);
  const whales: CopyTradingWhale[] = displayedWallets.map((wallet) => {
    const id = wallet.address.toLowerCase();
    const persistedWallet = auditWalletByAddress.get(id);
    const performance = auditPerformanceByWhale.get(id);
    const livePerformance = snapshot?.performanceByWhale[id];
    const latest = (audit?.logs ?? []).find((entry) => entry.whaleAddress?.toLowerCase() === id);
    return {
      id,
      label: runtimeWhaleLabels.get(id) || persistedWallet?.label || wallet.label,
      enabled: runtimeWhaleSet.size > 0 ? runtimeWhaleSet.has(id) : persistedWallet?.enabled ?? enabledIds.has(id),
      connectionStatus: isRunning ? "connected" : serverConnected ? "connecting" : "offline",
      latencyMs: latest?.latencyMs ?? null,
      roi30d: performance?.roi30d ?? null,
      pnl: livePerformance?.realizedPnl ?? performance?.realizedPnl ?? 0,
      openOrderCount: snapshot?.mirroredOrders.filter((order) => order.whale === id && order.status === "OPEN").length ?? 0,
      lastActivityAt: latest ? toIso(latest.occurredAt) : null,
      accountValueUsd: snapshot?.sizingByWhale[id]?.accountValueUsd ?? null,
      followerAccountValueUsd: snapshot?.sizingByWhale[id]?.followerAccountValueUsd ?? null,
      sizingCoin: snapshot?.sizingByWhale[id]?.lastCoin ?? null,
      sourcePositionNotionalUsd: snapshot?.sizingByWhale[id]?.sourcePositionNotionalUsd ?? null,
      sourceExposurePct: snapshot?.sizingByWhale[id]?.sourceExposurePct ?? null,
      targetNotionalUsd: snapshot?.sizingByWhale[id]?.targetFollowerNotionalUsd ?? null,
      requestedTargetNotionalUsd: snapshot?.sizingByWhale[id]?.requestedTargetFollowerNotionalUsd ?? null,
      followerLeverage: snapshot?.sizingByWhale[id]?.followerLeverage ?? null,
      leverageCapped: snapshot?.sizingByWhale[id]?.leverageCapped ?? false,
      syncedPositionCount: snapshot?.sizingByWhale[id]?.syncedPositionCount ?? 0,
      waitingForNewPosition: snapshot?.sizingByWhale[id]?.waitingForNewPosition ?? false,
      ignoredExistingPositionCount: snapshot?.sizingByWhale[id]?.ignoredExistingPositionCount ?? 0,
      allocatedCapitalUsd: snapshot?.sizing.allocationPerWhaleUsd ?? null,
      sizingStateFresh: snapshot?.sizingByWhale[id]?.sizingReady ?? false,
    };
  });
  const persistedOrders: CopyTradingOrder[] = (audit?.orders ?? []).map((order) => ({
    id: order.id,
    whaleId: order.whaleAddress,
    symbol: order.symbol,
    side: order.side,
    status: ["pending", "open", "filled", "rejected", "cancelled"].includes(order.status)
      ? order.status as CopyTradingOrder["status"]
      : "filled",
    size: order.size,
    price: order.price,
    createdAt: toIso(order.createdAt),
    segment: ["ENTRY", "ADD", "REDUCE", "CLOSE"].includes(order.segment ?? "")
      ? order.segment as CopyTradingOrder["segment"]
      : undefined,
  }));
  const mirroredOrders: CopyTradingOrder[] = (snapshot?.mirroredOrders ?? []).map((order) => ({
    id: order.id,
    whaleId: order.whale,
    symbol: order.symbol,
    side: order.side === "BUY" ? "long" : "short",
    status: mirrorStatusForUi(order.status),
    size: order.followerOriginalQuantity,
    remainingSize: order.followerRemainingQuantity,
    sourceSize: order.sourceOriginalQuantity,
    price: order.price,
    createdAt: toIso(order.createdAt),
    orderAction: order.lastAction,
    orderType: order.orderType ?? (order.isTrigger ? "Trigger" : "Limit"),
    tif: order.tif,
    reduceOnly: order.reduceOnly,
    metadataComplete: order.metadataComplete,
    leverageCapped: order.leverageCapped,
    closeAll: order.closeAll,
    startupSnapshot: order.startupSnapshot,
  }));
  const orders = mirroredOrders.length > 0 ? mirroredOrders : persistedOrders;
  const failureLogs: CopyTradingFailureLog[] = (audit?.logs ?? [])
    .filter((entry) => entry.severity === "warning" || entry.severity === "error")
    .map((entry) => ({
      id: entry.id,
      occurredAt: toIso(entry.occurredAt),
      whaleId: entry.whaleAddress ?? null,
      severity: entry.severity === "error" ? "error" as const : "warning" as const,
      code: entry.kind,
      message: entry.message,
    }));
  const averageLatency = whales
    .map((whale) => whale.latencyMs)
    .filter((value): value is number => value !== null && value !== undefined);

  return {
    whales,
    orders,
    equityHistory: snapshot?.equityHistory ?? [],
    failureLogs,
    totalPnl: snapshot?.performance.realizedPnl
      ?? (audit?.performance ?? []).reduce((sum, item) => sum + item.realizedPnl, 0),
    connectionDelayMs: averageLatency.length
      ? Math.round(averageLatency.reduce((sum, value) => sum + value, 0) / averageLatency.length)
      : null,
    isRunning,
    serverConnected,
    executionEnabled,
    liveArmed,
    liveArmExpiresAt,
    testnet,
    sessionMode: snapshot?.mode ?? null,
    entryPolicy: snapshot?.entryPolicy ?? null,
    sizing: snapshot?.sizing ?? null,
    error,
    loading,
    start,
    armLive,
    stop,
    configureSimulationSizing,
    refresh,
    setWhaleEnabled,
    labelById: useMemo(
      () => new Map(whales.map((whale) => [whale.id, whale.label])),
      [whales],
    ),
  };
}
