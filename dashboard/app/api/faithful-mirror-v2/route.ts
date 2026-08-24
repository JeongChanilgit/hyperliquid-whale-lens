import type {
  FaithfulMirrorV2AccountView,
  FaithfulMirrorV2Event,
  FaithfulMirrorV2LiveGate,
  FaithfulMirrorV2Order,
  FaithfulMirrorV2PairView,
  FaithfulMirrorV2PolicyView,
  FaithfulMirrorV2Position,
  FaithfulMirrorV2ServiceView,
  FaithfulMirrorV2StatusResponse,
} from "../../lib/faithful-mirror-v2-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTROL_TIMEOUT_MS = 5_000;
const SNAPSHOT_STALE_AFTER_MS = 30_000;
const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 200;

type UnknownRecord = Record<string, unknown>;

const json = (body: FaithfulMirrorV2StatusResponse, status = 200): Response => Response.json(body, {
  status,
  headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
});

const asRecord = (value: unknown): UnknownRecord | null => value && typeof value === "object" && !Array.isArray(value)
  ? value as UnknownRecord
  : null;
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const asText = (value: unknown, maximum = 240): string | null => typeof value === "string"
  ? value
    .replace(/0x[a-f0-9]{64}\b/gi, "[REDACTED]")
    .replace(/0x[a-f0-9]{40}\b/gi, "[ADDRESS_REDACTED]")
    .replace(/\b(token|secret|password|authorization|api[_-]?key)\s*([:=])\s*\S+/gi, "$1$2[REDACTED]")
    .slice(0, maximum)
  : null;
const asNumber = (value: unknown): number | null => value == null || value === "" || typeof value === "boolean" || !Number.isFinite(Number(value)) ? null : Number(value);
const asBoolean = (value: unknown): boolean => value === true;
const asPublicSourceAddress = (value: unknown): string | null => typeof value === "string" && /^0x[a-f0-9]{40}$/i.test(value)
  ? value.toLowerCase()
  : null;
const maskedTargetAddress = (value: unknown): string | null => typeof value === "string" && /^0x[a-f0-9]{40}$/i.test(value)
  ? `${value.slice(0, 6).toLowerCase()}…${value.slice(-4).toLowerCase()}`
  : null;
const asTimestamp = (value: unknown): number | null => {
  const parsed = asNumber(value);
  return parsed == null || parsed < 0 ? null : Math.trunc(parsed);
};

const requireLocalRequest = (request: Request): Response | undefined => {
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)) return undefined;
  return disconnected("This personal Faithful Mirror V2 status route is available only on localhost", 403);
};

const isLoopbackControlUrl = (baseUrl: string): boolean => {
  try {
    const parsed = new URL(baseUrl);
    return parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
};

const emptyGate = (reason: string): FaithfulMirrorV2LiveGate => ({
  state: "NOT_CONFIGURED",
  configured: false,
  armed: false,
  armExpiresAt: null,
  canStart: false,
  reason,
});

const disconnected = (reason: string, status = 503): Response => json({
  ok: false,
  connected: false,
  observedAt: Date.now(),
  stale: true,
  staleReason: reason,
  service: {
    mode: null,
    state: "DISCONNECTED",
    running: false,
    killed: false,
    sessionId: null,
    recoveryAvailable: false,
    liveGate: emptyGate(reason),
    policy: {
      verificationDelayMs: null,
      terminalVerificationDelayMs: null,
      targetToleranceBps: null,
      maxCatchUpSlippageBps: null,
      immediateResidualNotionalUsd: null,
      killOnTerminalResidual: null,
      paperMakerFeeRate: null,
      paperTakerFeeRate: null,
    },
  },
  pairs: [],
  events: [],
}, status);

const eventLimit = (request: Request): number => {
  const value = Number(new URL(request.url).searchParams.get("eventLimit"));
  if (!Number.isInteger(value)) return DEFAULT_EVENT_LIMIT;
  return Math.min(MAX_EVENT_LIMIT, Math.max(1, value));
};

const bridgeConfig = (): { baseUrl: string; token: string } | null => {
  const baseUrl = process.env.FMV2_BASE_URL?.trim().replace(/\/$/, "") ?? "";
  const token = process.env.FMV2_CONTROL_TOKEN?.trim() ?? "";
  if (!baseUrl || token.length < 16 || !isLoopbackControlUrl(baseUrl)) return null;
  return { baseUrl, token };
};

const controlFetch = async (config: { baseUrl: string; token: string }, path: string): Promise<UnknownRecord> => {
  const response = await fetch(`${config.baseUrl}${path}`, {
    headers: {
      accept: "application/json",
      "x-fmv2-control-token": config.token,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("control service rejected the observability request");
  const body = asRecord(await response.json());
  if (!body || body.ok !== true) throw new Error("control service returned an invalid response");
  return body;
};

const normalizePosition = (value: unknown): FaithfulMirrorV2Position | null => {
  const position = asRecord(value);
  const coin = asText(position?.coin, 80);
  if (!position || !coin) return null;
  return {
    coin,
    signedSize: asNumber(position.signedSize),
    entryPriceUsd: asNumber(position.entryPriceUsd),
    markPriceUsd: asNumber(position.markPriceUsd),
    positionValueUsd: asNumber(position.positionValueUsd),
    unrealizedPnlUsd: asNumber(position.unrealizedPnlUsd),
    liquidationPriceUsd: asNumber(position.liquidationPriceUsd),
    marginUsedUsd: asNumber(position.marginUsedUsd),
    leverage: normalizeLeverage(position.leverage),
    poolId: asText(position.poolId, 120),
  };
};

const normalizeLeverage = (value: unknown): unknown | null => {
  const leverage = asRecord(value);
  if (!leverage) return null;
  return {
    type: asText(leverage.type, 40),
    value: asNumber(leverage.value),
  };
};

const aggregateMarginPoolField = (snapshot: UnknownRecord | null, field: string): number | null => {
  const pools = asRecord(snapshot?.marginPools);
  if (!pools) return null;
  let found = false;
  let total = 0;
  for (const pool of Object.values(pools)) {
    const value = asNumber(asRecord(pool)?.[field]);
    if (value == null) continue;
    found = true;
    total += value;
  }
  return found ? total : null;
};

const normalizeOrder = (value: unknown): FaithfulMirrorV2Order | null => {
  const order = asRecord(value);
  if (!order) return null;
  const id = asText(order.id ?? order.oid ?? order.targetOrderId ?? order.sourceOrderId, 160);
  const coin = asText(order.coin, 80);
  if (!id && !coin) return null;
  return {
    id,
    sourceOrderId: asText(order.sourceOrderId ?? order.id ?? order.oid, 160),
    targetOrderId: asText(order.targetOrderId ?? order.id ?? order.oid, 160),
    coin,
    side: asText(order.side, 32),
    price: asNumber(order.price ?? order.limitPrice ?? order.limitPx),
    size: asNumber(order.size ?? order.sz),
    remainingSize: asNumber(order.remainingSize ?? order.remaining ?? order.sz),
    reduceOnly: typeof order.reduceOnly === "boolean" ? order.reduceOnly : null,
    status: asText(order.status, 80),
    orderType: asText(order.orderType, 80),
    tif: asText(order.tif, 32),
    triggerPrice: asNumber(order.triggerPrice),
  };
};

const compactDebt = (value: unknown): Array<Record<string, unknown>> => asArray(value).slice(0, 100).flatMap((entry) => {
  const record = asRecord(entry);
  if (!record) return [];
  const safe: Record<string, unknown> = {};
  for (const key of ["coin", "reason", "state", "sourceOrderId", "targetOrderId", "desiredSize", "actualSize", "deltaSize", "notionalUsd", "residualBps", "at"]) {
    const item = record[key];
    const text = asText(item, 240);
    if (text != null) safe[key] = text;
    else if (typeof item === "boolean" || (item != null && item !== "" && Number.isFinite(Number(item)))) safe[key] = typeof item === "boolean" ? item : Number(item);
  }
  return [safe];
});

const accountView = (snapshot: unknown, orders: unknown, observedAt: number): FaithfulMirrorV2AccountView => {
  const account = asRecord(snapshot);
  const receivedAt = asTimestamp(account?.receivedAt);
  const positions = asArray(account?.positions).slice(0, 200).flatMap((value) => {
    const normalized = normalizePosition(value);
    return normalized ? [normalized] : [];
  });
  const marginState = asRecord(account?.marginState);
  const positionMargins = positions.map((position) => position.marginUsedUsd).filter((value): value is number => value != null);
  const aggregatePositionMarginUsd = positionMargins.length > 0 ? positionMargins.reduce((total, value) => total + Math.max(0, value), 0) : null;
  return {
    equityUsd: asNumber(account?.accountEquityUsd),
    receivedAt,
    snapshotAgeMs: receivedAt == null ? null : Math.max(0, observedAt - receivedAt),
    accountMode: asText(account?.accountMode, 80),
    marginUsedUsd: asNumber(account?.marginUsedUsd) ?? aggregateMarginPoolField(account, "marginUsedUsd") ?? aggregatePositionMarginUsd,
    maintenanceMarginUsd: asNumber(account?.maintenanceMarginUsd) ?? asNumber(marginState?.maintenanceMarginUsd) ?? aggregateMarginPoolField(account, "maintenanceMarginUsedUsd"),
    withdrawableUsd: asNumber(account?.withdrawableUsd) ?? aggregateMarginPoolField(account, "withdrawableUsd"),
    marginStatus: asText(account?.marginStatus ?? marginState?.status, 120),
    approximateLiquidationRisk: typeof (account?.approximateLiquidationRisk ?? marginState?.approximateLiquidationRisk) === "boolean"
      ? Boolean(account?.approximateLiquidationRisk ?? marginState?.approximateLiquidationRisk)
      : null,
    positions,
    orders: asArray(orders).slice(0, 200).flatMap((value) => {
      const normalized = normalizeOrder(value);
      return normalized ? [normalized] : [];
    }),
  };
};

const numericRecord = (value: unknown): Record<string, number | null> => {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).slice(0, 80).map(([key, item]) => [key, asNumber(item)]));
};

const serviceLiveGate = (status: UnknownRecord): FaithfulMirrorV2LiveGate => {
  const mode = asText(status.mode, 16);
  const state = asText(status.state, 120) ?? "UNKNOWN";
  const armed = status.armed === true;
  if (mode === "PAPER") return {
    state: "PAPER_NOT_APPLICABLE",
    configured: true,
    armed: false,
    armExpiresAt: null,
    canStart: false,
    reason: "PAPER mode has no LIVE arm and this dashboard is read-only.",
  };
  if (state === "KILLED" || status.killed === true) return {
    state: "KILLED",
    configured: true,
    armed: false,
    armExpiresAt: null,
    canStart: false,
    reason: "The LIVE service is killed. Only a server-side operator can create a new process.",
  };
  if (armed) return {
    state: "ARMED",
    configured: true,
    armed: true,
    armExpiresAt: asTimestamp(status.armExpiresAt),
    canStart: false,
    reason: "A server-side LIVE arm is present. This read-only dashboard cannot start or re-arm it.",
  };
  return {
    state: state === "STOPPED_UNARMED" ? "UNARMED" : "LOCKED",
    configured: true,
    armed: false,
    armExpiresAt: null,
    canStart: false,
    reason: "LIVE stays locked until a server-side operator performs the explicit arm/start flow.",
  };
};

const normalizePair = (configuredPair: unknown, snapshot: unknown, observedAt: number, mode: string | null): FaithfulMirrorV2PairView | null => {
  const config = asRecord(configuredPair);
  const pair = asRecord(snapshot);
  const pairId = asText(pair?.pairId ?? config?.pairId, 120);
  if (!pairId) return null;
  const source = accountView(pair?.sourceSnapshot, pair?.sourceOrders, observedAt);
  const target = accountView(pair?.targetSnapshot, pair?.targetOrderState, observedAt);
  const lastError = asText(pair?.lastError, 400);
  const blocked = asBoolean(pair?.blocked);
  const killed = asBoolean(pair?.killed);
  const state = asText(pair?.state, 120);
  const snapshotAges = [source.snapshotAgeMs, target.snapshotAgeMs].filter((value): value is number => value != null);
  const snapshotAgeMs = snapshotAges.length > 0 ? Math.max(...snapshotAges) : null;
  return {
    pairId,
    startingCapitalUsd: asNumber(config?.capitalUsd),
    sourceAddress: asPublicSourceAddress(pair?.sourceAddress ?? config?.sourceAddress),
    targetAccountLabel: `Follower ${pairId}`,
    // PAPER targets are deterministic synthetic followers. LIVE target account
    // mappings stay server-only, including their masked address form.
    targetAddressDisplay: mode === "PAPER" ? maskedTargetAddress(pair?.targetAddress ?? config?.targetAddress) : null,
    state,
    initialized: asBoolean(pair?.initialized),
    blocked,
    killed,
    killReason: killed || blocked ? (lastError ?? (killed ? "PAIR_KILLED" : "PAIR_BLOCKED")) : null,
    lastError,
    snapshotAgeMs,
    snapshotFresh: snapshotAges.length === 2 ? snapshotAges.every((value) => value <= SNAPSHOT_STALE_AFTER_MS) : null,
    source,
    target,
    trackingDebt: {
      positions: compactDebt(asRecord(pair?.trackingDebt)?.positions),
      orders: compactDebt(asRecord(pair?.trackingDebt)?.orders),
    },
    metrics: numericRecord(pair?.metrics),
    stats: numericRecord(pair?.stats),
  };
};

const normalizePairs = (status: UnknownRecord, observedAt: number): FaithfulMirrorV2PairView[] => {
  const config = asRecord(status.config);
  const mode = asText(status.mode, 16);
  const configuredPairs = asArray(config?.pairs);
  const snapshotPairs = asRecord(asRecord(status.snapshot)?.pairs) ?? {};
  const configuredById = new Map(configuredPairs.map((pair) => [asText(asRecord(pair)?.pairId, 120), pair]));
  const ids = new Set([...configuredById.keys(), ...Object.keys(snapshotPairs)]);
  return [...ids].flatMap((pairId) => {
    if (!pairId) return [];
    const pair = normalizePair(configuredById.get(pairId), snapshotPairs[pairId], observedAt, mode);
    return pair ? [pair] : [];
  });
};

const normalizeEvent = (value: unknown): FaithfulMirrorV2Event | null => {
  const event = asRecord(value);
  const type = asText(event?.type, 120);
  if (!event || !type) return null;
  const details = asRecord(event.details) ?? {};
  const normalizedDetails: FaithfulMirrorV2Event["details"] = {};
  const allowedDetailKeys = new Set([
    "reason", "status", "phase", "sourceOrderId", "targetOrderId", "desiredSize", "actualSize", "deltaSize",
    "notionalUsd", "residualBps", "sourceOpenOrderCount", "accountMode", "mode", "state", "armExpiresAt",
    "recoveredCheckpoint", "killSwitchRequested", "accepted", "count", "reasons",
  ]);
  for (const [key, item] of Object.entries(details).slice(0, 24)) {
    if (!allowedDetailKeys.has(key)) continue;
    if (typeof item === "string") normalizedDetails[key] = item.slice(0, 240);
    else if (typeof item === "boolean") normalizedDetails[key] = item;
    else if (item != null && item !== "" && Number.isFinite(Number(item))) normalizedDetails[key] = Number(item);
    else if (Array.isArray(item)) normalizedDetails[key] = item.slice(0, 12).map((entry) => String(entry).slice(0, 120));
  }
  return {
    at: asTimestamp(event.at),
    type,
    pairId: asText(event.pairId, 120),
    coin: asText(event.coin, 80),
    side: asText(event.side, 24),
    message: asText(event.message, 400),
    details: normalizedDetails,
  };
};

const staleness = (service: FaithfulMirrorV2ServiceView, pairs: FaithfulMirrorV2PairView[]): { stale: boolean; staleReason: string | null } => {
  if (["DEGRADED", "PAIR_RECOVERY_BLOCKED"].includes(service.state)) {
    return { stale: true, staleReason: `Service state is ${service.state}.` };
  }
  if (!service.running) return { stale: false, staleReason: null };
  for (const pair of pairs.filter((candidate) => candidate.state === "RUNNING" && !candidate.killed && !candidate.blocked)) {
    if (pair.snapshotFresh == null) return { stale: true, staleReason: `Active pair ${pair.pairId} has no complete source/target snapshot.` };
    if (!pair.snapshotFresh) {
      return { stale: true, staleReason: `Pair ${pair.pairId} snapshot is older than ${SNAPSHOT_STALE_AFTER_MS / 1_000} seconds.` };
    }
  }
  return { stale: false, staleReason: null };
};

const policyView = (status: UnknownRecord): FaithfulMirrorV2PolicyView => {
  const config = asRecord(status.config);
  const actor = asRecord(config?.actorConfig);
  const paper = asRecord(config?.paper);
  return {
    verificationDelayMs: asNumber(actor?.verificationDelayMs),
    terminalVerificationDelayMs: asNumber(actor?.terminalVerificationDelayMs),
    targetToleranceBps: asNumber(actor?.targetPositionToleranceBps),
    maxCatchUpSlippageBps: asNumber(actor?.maxCatchUpSlippageBps),
    immediateResidualNotionalUsd: asNumber(actor?.immediateResidualNotionalUsd),
    killOnTerminalResidual: typeof actor?.killOnTerminalResidual === "boolean" ? actor.killOnTerminalResidual : null,
    paperMakerFeeRate: asNumber(paper?.makerFeeRate),
    paperTakerFeeRate: asNumber(paper?.takerFeeRate),
  };
};

const projectStatus = (status: UnknownRecord, events: unknown[], observedAt: number): FaithfulMirrorV2StatusResponse => {
  const service: FaithfulMirrorV2ServiceView = {
    mode: asText(status.mode, 16) === "PAPER" ? "PAPER" : asText(status.mode, 16) === "LIVE" ? "LIVE" : null,
    state: asText(status.state, 120) ?? "UNKNOWN",
    running: status.running === true,
    killed: status.killed === true,
    sessionId: asText(status.sessionId, 160),
    recoveryAvailable: status.recoveryAvailable === true,
    liveGate: serviceLiveGate(status),
    policy: policyView(status),
  };
  const pairs = normalizePairs(status, observedAt);
  const current = staleness(service, pairs);
  return {
    ok: true,
    connected: true,
    observedAt,
    stale: current.stale,
    staleReason: current.staleReason,
    service,
    pairs,
    events: events.slice(-MAX_EVENT_LIMIT).flatMap((event) => {
      const normalized = normalizeEvent(event);
      return normalized ? [normalized] : [];
    }),
  };
};

/**
 * Local GET-only observability bridge. The browser never sees or submits the
 * loopback control token; it is attached only by this server-side route.
 */
export async function GET(request: Request): Promise<Response> {
  const localDenial = requireLocalRequest(request);
  if (localDenial) return localDenial;
  const config = bridgeConfig();
  if (!config) return disconnected("Faithful Mirror V2 loopback observability is not configured.");
  try {
    const statusEnvelope = await controlFetch(config, "/status");
    const status = asRecord(statusEnvelope.status);
    if (!status) return disconnected("Faithful Mirror V2 returned no usable status.");
    let events: unknown[] = [];
    let eventsUnavailable = false;
    try {
      const eventsEnvelope = await controlFetch(config, `/events?limit=${eventLimit(request)}`);
      events = asArray(eventsEnvelope.events);
    } catch {
      eventsUnavailable = true;
    }
    const response = projectStatus(status, events, Date.now());
    if (eventsUnavailable) {
      response.stale = true;
      response.staleReason = "Faithful Mirror V2 event history is unavailable; status may be incomplete.";
    }
    return json(response);
  } catch {
    return disconnected("Faithful Mirror V2 is unavailable or rejected the server-side loopback bridge.");
  }
}
