import { sourceFillId } from "./simulation-ledger";
import type {
  HyperliquidAccountState,
  HyperliquidLeverage,
  HyperliquidRealtimeFill,
  HyperliquidRealtimeOrder,
  HyperliquidRealtimeOrderUpdate,
  RealtimeMonitorEvent,
} from "../copy-types";

const HYPERLIQUID_WS_URL = "wss://api.hyperliquid.xyz/ws";
const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

interface WebSocketMessageEvent { data: unknown; }

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: Event | WebSocketMessageEvent) => void): void;
}

export interface HyperliquidMonitorOptions {
  whales: string[];
  url?: string;
  heartbeatMs?: number;
  staleConnectionMs?: number;
  maxReconnectMs?: number;
  /** Snapshots are useful for observability but should not produce startup fills. */
  ignoreSnapshotFills?: boolean;
  /** Account-state-only consumers can disable the fill subscription. */
  includeFills?: boolean;
  /** One order-update socket is created per whale because the feed omits user. */
  includeOrderUpdates?: boolean;
  /** Source sizing uses the total portfolio value while positions stay WebSocket-driven. */
  includePortfolioAccountValue?: boolean;
  portfolioRefreshMs?: number;
  socketFactory?: (url: string, whale?: string) => WebSocketLike;
  fetchOpenOrders?: (whale: string, dex?: string) => Promise<HyperliquidRealtimeOrder[]>;
  fetchOrderDetails?: (whale: string, oid: string) => Promise<HyperliquidRealtimeOrder | undefined>;
  fetchActiveAssetLeverage?: (whale: string, coin: string) => Promise<HyperliquidLeverage>;
  fetchPortfolioAccountValue?: (whale: string) => Promise<number | undefined>;
}

interface HyperliquidWsMessage { channel?: string; data?: unknown; }

interface ConnectionState {
  whale: string;
  socket?: WebSocketLike;
  reconnectAttempt: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  lastMessageAt: number;
}

const normaliseAddress = (address: string): string => address.trim().toLowerCase();
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const toLeverage = (value: unknown): HyperliquidLeverage | undefined => {
  const raw = record(value);
  const type = raw?.type;
  const leverageValue = Number(raw?.value);
  if ((type !== "cross" && type !== "isolated") || !Number.isInteger(leverageValue) || leverageValue < 1) return undefined;
  const rawUsd = Number(raw?.rawUsd);
  return {
    type,
    value: leverageValue,
    ...(Number.isFinite(rawUsd) ? { rawUsd } : {}),
  };
};
const clearinghouseEntries = (value: unknown): Array<[string, unknown]> => {
  const states = record(value)?.clearinghouseStates;
  if (Array.isArray(states)) return states.flatMap((item) => Array.isArray(item) && item.length === 2 && typeof item[0] === "string" ? [[item[0], item[1]] as [string, unknown]] : []);
  const stateRecord = record(states);
  return stateRecord ? Object.entries(stateRecord) : [];
};

const toFill = (value: unknown): HyperliquidRealtimeFill | undefined => {
  const raw = record(value);
  if (!raw || typeof raw.coin !== "string" || (raw.side !== "B" && raw.side !== "A") || !Number.isFinite(Number(raw.time)) || raw.sz === undefined || raw.px === undefined || raw.startPosition === undefined) return undefined;
  return { ...raw, coin: raw.coin, side: raw.side, time: Number(raw.time), sz: String(raw.sz), px: String(raw.px), startPosition: String(raw.startPosition) } as HyperliquidRealtimeFill;
};

const toOrder = (value: unknown): HyperliquidRealtimeOrder | undefined => {
  const raw = record(value);
  if (!raw || typeof raw.coin !== "string" || (raw.side !== "B" && raw.side !== "A") || raw.limitPx === undefined || raw.sz === undefined || raw.oid === undefined) return undefined;
  const timestamp = Number(raw.timestamp);
  if (!Number.isFinite(timestamp)) return undefined;
  return {
    ...raw,
    coin: raw.coin,
    side: raw.side,
    limitPx: String(raw.limitPx),
    sz: String(raw.sz),
    origSz: String(raw.origSz ?? raw.sz),
    oid: typeof raw.oid === "number" || typeof raw.oid === "string" ? raw.oid : String(raw.oid),
    timestamp,
    ...(raw.cloid === null || typeof raw.cloid === "string" ? { cloid: raw.cloid } : {}),
    ...(typeof raw.reduceOnly === "boolean" ? { reduceOnly: raw.reduceOnly } : {}),
    ...(typeof raw.orderType === "string" ? { orderType: raw.orderType } : {}),
    ...(typeof raw.tif === "string" ? { tif: raw.tif } : {}),
    ...(typeof raw.isTrigger === "boolean" ? { isTrigger: raw.isTrigger } : {}),
    ...(raw.triggerPx !== undefined ? { triggerPx: String(raw.triggerPx) } : {}),
    ...(typeof raw.triggerCondition === "string" ? { triggerCondition: raw.triggerCondition } : {}),
    ...(typeof raw.isPositionTpsl === "boolean" ? { isPositionTpsl: raw.isPositionTpsl } : {}),
  } as HyperliquidRealtimeOrder;
};

const metadataComplete = (order: HyperliquidRealtimeOrder): boolean => typeof order.reduceOnly === "boolean" && typeof order.orderType === "string";

const toOrderUpdate = (value: unknown, isSnapshot = false): HyperliquidRealtimeOrderUpdate | undefined => {
  const raw = record(value);
  if (!raw) return undefined;
  const order = toOrder(raw.order ?? raw);
  if (!order) return undefined;
  const status = typeof raw.status === "string" ? raw.status : "open";
  const statusTimestamp = Number(raw.statusTimestamp ?? order.timestamp);
  if (!Number.isFinite(statusTimestamp)) return undefined;
  return { order, status, statusTimestamp, isSnapshot, metadataComplete: metadataComplete(order) };
};

const toAccountState = (value: unknown): HyperliquidAccountState | undefined => {
  const raw = record(value);
  const marginSummary = record(raw?.marginSummary);
  if (!raw || !marginSummary) return undefined;
  const accountValueUsd = Number(marginSummary.accountValue);
  if (!Number.isFinite(accountValueUsd) || accountValueUsd < 0) return undefined;
  const positions = Array.isArray(raw.assetPositions)
    ? raw.assetPositions.flatMap((item) => {
        const position = record(record(item)?.position);
        if (!position) return [];
        const signedSize = Number(position.szi);
        if (typeof position.coin !== "string" || !Number.isFinite(signedSize)) return [];
        const positionValueUsd = Number(position.positionValue);
        const entryPriceUsd = Number(position.entryPx);
        const leverage = toLeverage(position.leverage);
        return [{
          coin: position.coin.toUpperCase(),
          signedSize,
          ...(Number.isFinite(positionValueUsd) ? { positionValueUsd: Math.abs(positionValueUsd) } : {}),
          ...(Number.isFinite(entryPriceUsd) && entryPriceUsd > 0 ? { entryPriceUsd } : {}),
          ...(leverage ? { leverage } : {}),
        }];
      })
    : [];
  return { accountValueUsd, positions, receivedAt: Date.now() };
};

const toAllDexsAccountState = (value: unknown): HyperliquidAccountState | undefined => {
  const raw = record(value);
  const entries = clearinghouseEntries(value);
  if (!raw || entries.length === 0) return undefined;
  let accountValueUsd = 0;
  const positions: HyperliquidAccountState["positions"] = [];
  let validStateCount = 0;
  for (const [dex, stateValue] of entries) {
    const parsed = toAccountState(stateValue);
    if (!parsed) continue;
    validStateCount += 1;
    accountValueUsd += parsed.accountValueUsd;
    for (const position of parsed.positions) {
      const coin = dex && !position.coin.includes(":") ? `${dex}:${position.coin}`.toUpperCase() : position.coin;
      positions.push({ ...position, coin });
    }
  }
  return validStateCount > 0 ? { accountValueUsd, positions, receivedAt: Date.now() } : undefined;
};

const infoRequest = async (body: Record<string, unknown>): Promise<unknown> => {
  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Hyperliquid info request failed (${response.status})`);
  return response.json();
};

const defaultFetchPortfolioAccountValue = async (whale: string): Promise<number | undefined> => {
  const payload = await infoRequest({ type: "portfolio", user: whale });
  if (!Array.isArray(payload)) return undefined;
  for (const windowName of ["day", "week", "month", "allTime"]) {
    const window = payload.find((entry) => Array.isArray(entry) && entry[0] === windowName);
    const history = record(Array.isArray(window) ? window[1] : undefined)?.accountValueHistory;
    if (!Array.isArray(history)) continue;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const point = history[index];
      const value = Number(Array.isArray(point) ? point[1] : undefined);
      if (Number.isFinite(value) && value >= 0) return value;
    }
  }
  return undefined;
};

/** Public per-asset setting, available even before the source has an open position. */
export const fetchHyperliquidActiveAssetLeverage = async (whale: string, coin: string): Promise<HyperliquidLeverage> => {
  const payload = record(await infoRequest({ type: "activeAssetData", user: normaliseAddress(whale), coin }));
  const leverage = toLeverage(payload?.leverage);
  if (!leverage) throw new Error(`Hyperliquid did not return a valid leverage setting for ${coin}`);
  return leverage;
};

const defaultFetchOpenOrders = async (whale: string, dex = ""): Promise<HyperliquidRealtimeOrder[]> => {
  const payload = await infoRequest({ type: "frontendOpenOrders", user: whale, dex });
  return Array.isArray(payload) ? payload.flatMap((item) => {
    const order = toOrder(item);
    return order ? [order] : [];
  }) : [];
};

const defaultFetchOrderDetails = async (whale: string, oid: string): Promise<HyperliquidRealtimeOrder | undefined> => {
  const payload = record(await infoRequest({ type: "orderStatus", user: whale, oid: /^\d+$/.test(oid) ? Number(oid) : oid }));
  const wrapper = record(payload?.order);
  return toOrder(wrapper?.order);
};

/**
 * Long-lived public watcher for at most ten wallets. Hyperliquid orderUpdates do
 * not identify the user, so each whale receives an independent socket. This is
 * also what prevents an order from being attributed to the wrong account.
 */
export class HyperliquidUserFillsMonitor {
  private readonly whales: string[];
  private readonly url: string;
  private readonly heartbeatMs: number;
  private readonly staleConnectionMs: number;
  private readonly maxReconnectMs: number;
  private readonly ignoreSnapshotFills: boolean;
  private readonly includeFills: boolean;
  private readonly includeOrderUpdates: boolean;
  private readonly includePortfolioAccountValue: boolean;
  private readonly portfolioRefreshMs: number;
  private readonly socketFactory: (url: string, whale?: string) => WebSocketLike;
  private readonly fetchOpenOrders: (whale: string, dex?: string) => Promise<HyperliquidRealtimeOrder[]>;
  private readonly fetchOrderDetails: (whale: string, oid: string) => Promise<HyperliquidRealtimeOrder | undefined>;
  private readonly fetchActiveAssetLeverage: (whale: string, coin: string) => Promise<HyperliquidLeverage>;
  private readonly fetchPortfolioAccountValue: (whale: string) => Promise<number | undefined>;
  private readonly listeners = new Set<(event: RealtimeMonitorEvent) => void>();
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly connections = new Map<string, ConnectionState>();
  private readonly orderDetails = new Map<string, HyperliquidRealtimeOrder>();
  private readonly bootstrappedAt = new Map<string, number>();
  private readonly portfolioAccountValues = new Map<string, { accountValueUsd: number; receivedAt: number }>();
  private readonly latestClearinghouseStates = new Map<string, HyperliquidAccountState>();
  private readonly portfolioFetchedAt = new Map<string, number>();
  private readonly portfolioFetches = new Set<string>();
  private running = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: HyperliquidMonitorOptions) {
    const uniqueWhales = [...new Set(options.whales.map(normaliseAddress).filter(Boolean))];
    if (uniqueWhales.length === 0 || uniqueWhales.length > 10) throw new Error("Monitor requires between 1 and 10 unique Hyperliquid addresses");
    this.whales = uniqueWhales;
    this.url = options.url ?? HYPERLIQUID_WS_URL;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.staleConnectionMs = options.staleConnectionMs ?? 45_000;
    this.maxReconnectMs = options.maxReconnectMs ?? 30_000;
    this.ignoreSnapshotFills = options.ignoreSnapshotFills ?? true;
    this.includeFills = options.includeFills ?? true;
    this.includeOrderUpdates = options.includeOrderUpdates ?? true;
    this.includePortfolioAccountValue = options.includePortfolioAccountValue ?? true;
    this.portfolioRefreshMs = options.portfolioRefreshMs ?? 60_000;
    this.socketFactory = options.socketFactory ?? ((url) => {
      if (typeof WebSocket === "undefined") throw new Error("WebSocket is unavailable in this runtime");
      return new WebSocket(url) as unknown as WebSocketLike;
    });
    this.fetchOpenOrders = options.fetchOpenOrders ?? defaultFetchOpenOrders;
    this.fetchOrderDetails = options.fetchOrderDetails ?? defaultFetchOrderDetails;
    this.fetchActiveAssetLeverage = options.fetchActiveAssetLeverage ?? fetchHyperliquidActiveAssetLeverage;
    this.fetchPortfolioAccountValue = options.fetchPortfolioAccountValue ?? defaultFetchPortfolioAccountValue;
    for (const whale of this.whales) this.connections.set(whale, { whale, reconnectAttempt: 0, lastMessageAt: 0 });
  }

  subscribe(listener: (event: RealtimeMonitorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const whale of this.whales) this.connect(whale);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
  }

  stop(): void {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    for (const connection of this.connections.values()) {
      if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
      connection.reconnectTimer = undefined;
      const socket = connection.socket;
      connection.socket = undefined;
      if (socket) socket.close(1000, "copy engine stopped");
    }
    this.emit({ type: "status", message: "Hyperliquid monitor stopped", time: Date.now() });
  }

  private connect(whale: string): void {
    if (!this.running) return;
    const connection = this.connections.get(whale);
    if (!connection) return;
    try {
      const socket = this.socketFactory(this.url, whale);
      connection.socket = socket;
      socket.addEventListener("open", () => {
        if (connection.socket !== socket || !this.running) return;
        connection.lastMessageAt = Date.now();
        connection.reconnectAttempt = 0;
        socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "allDexsClearinghouseState", user: whale } }));
        // Establish the position/equity snapshot before accepting live fill deltas.
        if (this.includeFills) socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "userFills", user: whale, aggregateByTime: false } }));
        if (this.includeOrderUpdates) {
          socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "orderUpdates", user: whale } }));
          void this.bootstrapOpenOrders(whale, "");
        }
        if (this.includePortfolioAccountValue) void this.refreshPortfolioAccountValue(whale);
        this.emit({ type: "status", whale, message: "Hyperliquid fill/order stream connected", time: Date.now() });
      });
      socket.addEventListener("message", (event) => { void this.onMessage(whale, event as WebSocketMessageEvent); });
      socket.addEventListener("error", () => this.emit({ type: "error", whale, message: "Hyperliquid WebSocket error", time: Date.now() }));
      socket.addEventListener("close", () => {
        if (connection.socket !== socket) return;
        connection.socket = undefined;
        if (this.running) this.scheduleReconnect(whale);
      });
    } catch (error) {
      this.emit({ type: "error", whale, message: error instanceof Error ? error.message : "Unable to create Hyperliquid WebSocket", time: Date.now() });
      this.scheduleReconnect(whale);
    }
  }

  private scheduleReconnect(whale: string): void {
    const connection = this.connections.get(whale);
    if (!connection || !this.running || connection.reconnectTimer) return;
    const exponential = Math.min(this.maxReconnectMs, 1_000 * 2 ** connection.reconnectAttempt);
    const delay = Math.round(exponential * (0.8 + Math.random() * 0.4));
    connection.reconnectAttempt += 1;
    this.emit({ type: "status", whale, message: `Reconnecting Hyperliquid WebSocket in ${delay}ms`, time: Date.now() });
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = undefined;
      this.connect(whale);
    }, delay);
  }

  private heartbeat(): void {
    if (!this.running) return;
    const now = Date.now();
    for (const connection of this.connections.values()) {
      const socket = connection.socket;
      if (!socket) continue;
      if (now - connection.lastMessageAt > this.staleConnectionMs) {
        this.emit({ type: "error", whale: connection.whale, message: "Hyperliquid WebSocket became stale; reconnecting", time: now });
        socket.close(4000, "heartbeat timeout");
        continue;
      }
      try { socket.send(JSON.stringify({ method: "ping" })); }
      catch { socket.close(4001, "heartbeat send failed"); }
      if (this.includePortfolioAccountValue && now - (this.portfolioFetchedAt.get(connection.whale) ?? 0) >= this.portfolioRefreshMs) {
        void this.refreshPortfolioAccountValue(connection.whale);
      }
    }
    this.emit({ type: "heartbeat", message: "Hyperliquid heartbeats sent", time: now });
  }

  private async bootstrapOpenOrders(whale: string, dex: string): Promise<void> {
    const now = Date.now();
    const bootstrapKey = `${whale}|${dex}`;
    if (now - (this.bootstrappedAt.get(bootstrapKey) ?? 0) < 300_000) return;
    this.bootstrappedAt.set(bootstrapKey, now);
    try {
      const orders = await this.fetchOpenOrders(whale, dex);
      await Promise.all(orders.map(async (order) => {
        this.orderDetails.set(`${whale}|${String(order.oid)}`, order);
        let sourceLeverage: HyperliquidLeverage | undefined;
        try { sourceLeverage = await this.fetchActiveAssetLeverage(whale, order.coin); }
        catch (error) {
          this.emit({ type: "error", whale, message: error instanceof Error ? error.message : `Unable to load ${order.coin} leverage`, time: Date.now() });
        }
        this.emit({
          type: "order",
          whale,
          orderUpdate: { order, status: "open", statusTimestamp: now, isSnapshot: true, metadataComplete: metadataComplete(order), ...(sourceLeverage ? { sourceLeverage } : {}) },
          time: now,
        });
      }));
      this.emit({ type: "status", whale, message: `Loaded ${orders.length} existing open order(s)${dex ? ` on ${dex}` : ""}`, time: now });
    } catch (error) {
      this.emit({ type: "error", whale, message: error instanceof Error ? error.message : "Unable to load existing Hyperliquid orders", time: now });
    }
  }

  private async onMessage(whale: string, event: WebSocketMessageEvent): Promise<void> {
    const connection = this.connections.get(whale);
    if (connection) connection.lastMessageAt = Date.now();
    const message = await this.parseMessage(event.data, whale);
    if (!message) return;
    const data = record(message.data);
    const responseUser = typeof data?.user === "string" ? normaliseAddress(data.user) : undefined;
    if (responseUser && responseUser !== whale) {
      this.emit({ type: "error", whale, message: "Ignored a Hyperliquid message attributed to another wallet", time: Date.now() });
      return;
    }
    if (message.channel === "orderUpdates") {
      const values = Array.isArray(message.data) ? message.data : Array.isArray(data?.orderUpdates) ? data.orderUpdates : Array.isArray(data?.orders) ? data.orders : [];
      for (const value of values) {
        const basic = toOrderUpdate(value);
        if (!basic) {
          this.emit({ type: "error", whale, message: "Ignored malformed Hyperliquid order update", time: Date.now() });
          continue;
        }
        const enriched = await this.enrichOrderUpdate(whale, basic);
        this.emit({ type: "order", whale, orderUpdate: enriched, time: Date.now() });
      }
      return;
    }
    if (message.channel === "allDexsClearinghouseState") {
      const accountState = toAllDexsAccountState(message.data);
      if (!accountState) this.emit({ type: "error", whale, message: "Ignored malformed Hyperliquid all-DEX clearinghouse state", time: Date.now() });
      else {
        this.latestClearinghouseStates.set(whale, accountState);
        // Carry-in sizing must never use the all-DEX perpetual margin subtotal
        // as a stand-in for the source's total portfolio value. Until the first
        // portfolio fetch succeeds, retain this state without publishing it.
        if (this.includePortfolioAccountValue && !this.hasFreshPortfolioAccountValue(whale)) {
          void this.refreshPortfolioAccountValue(whale);
        } else {
          this.emitAccountState(whale, accountState);
        }
        for (const [dex, value] of clearinghouseEntries(message.data)) {
          if (!dex) continue;
          const parsed = toAccountState(value);
          if (parsed && (parsed.accountValueUsd > 0 || parsed.positions.length > 0)) void this.bootstrapOpenOrders(whale, dex);
        }
      }
      return;
    }
    if (message.channel === "clearinghouseState") {
      const accountState = toAccountState(data?.clearinghouseState ?? message.data);
      if (!accountState) this.emit({ type: "error", whale, message: "Ignored malformed Hyperliquid clearinghouse state", time: Date.now() });
      else {
        this.latestClearinghouseStates.set(whale, accountState);
        if (this.includePortfolioAccountValue && !this.hasFreshPortfolioAccountValue(whale)) {
          void this.refreshPortfolioAccountValue(whale);
        } else {
          this.emitAccountState(whale, accountState);
        }
      }
      return;
    }
    if (message.channel !== "userFills" || !data) return;
    const fills = Array.isArray(data.fills) ? data.fills : [];
    if (data.isSnapshot && this.ignoreSnapshotFills) {
      for (const rawFill of fills) {
        const fill = toFill(rawFill);
        if (fill) this.remember(sourceFillId(whale, fill));
      }
      this.emit({ type: "status", whale, message: `Ignored ${fills.length} startup snapshot fill(s)`, time: Date.now() });
      return;
    }
    for (const rawFill of fills) {
      const fill = toFill(rawFill);
      if (!fill) {
        this.emit({ type: "error", whale, message: "Ignored malformed Hyperliquid fill", time: Date.now() });
        continue;
      }
      const key = sourceFillId(whale, fill);
      if (this.remember(key)) continue;
      this.emit({ type: "fill", whale, fill, time: Date.now() });
    }
  }

  private async enrichOrderUpdate(whale: string, update: HyperliquidRealtimeOrderUpdate): Promise<HyperliquidRealtimeOrderUpdate> {
    const key = `${whale}|${String(update.order.oid)}`;
    let details = this.orderDetails.get(key);
    const detailsPromise = !details && !update.metadataComplete
      ? this.fetchOrderDetails(whale, String(update.order.oid)).catch((error) => {
          this.emit({ type: "error", whale, message: error instanceof Error ? error.message : "Unable to enrich Hyperliquid order", time: Date.now() });
          return undefined;
        })
      : Promise.resolve(details);
    const leveragePromise = this.fetchActiveAssetLeverage(whale, update.order.coin).catch((error) => {
      this.emit({ type: "error", whale, message: error instanceof Error ? error.message : "Unable to load exact source leverage", time: Date.now() });
      return undefined;
    });
    [details] = await Promise.all([detailsPromise, leveragePromise]);
    const sourceLeverage = await leveragePromise;
    const order = details ? { ...details, ...update.order } : update.order;
    if (metadataComplete(order)) this.orderDetails.set(key, order);
    return { ...update, order, metadataComplete: metadataComplete(order), ...(sourceLeverage ? { sourceLeverage } : {}) };
  }

  private async parseMessage(data: unknown, whale: string): Promise<HyperliquidWsMessage | undefined> {
    try {
      if (typeof data === "string") return JSON.parse(data) as HyperliquidWsMessage;
      if (data instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(data)) as HyperliquidWsMessage;
      if (data && typeof (data as Blob).text === "function") return JSON.parse(await (data as Blob).text()) as HyperliquidWsMessage;
    } catch {
      this.emit({ type: "error", whale, message: "Unable to parse Hyperliquid WebSocket message", time: Date.now() });
    }
    return undefined;
  }

  private remember(key: string): boolean {
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > 25_000) {
      const expired = this.seenOrder.shift();
      if (expired) this.seen.delete(expired);
    }
    return false;
  }

  private emit(event: RealtimeMonitorEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private withPortfolioAccountValue(whale: string, state: HyperliquidAccountState): HyperliquidAccountState {
    const portfolio = this.portfolioAccountValues.get(whale);
    return this.hasFreshPortfolioAccountValue(whale) && portfolio
      ? { ...state, accountValueUsd: portfolio.accountValueUsd }
      : state;
  }

  private hasFreshPortfolioAccountValue(whale: string): boolean {
    const portfolio = this.portfolioAccountValues.get(whale);
    return Boolean(portfolio && Date.now() - portfolio.receivedAt <= Math.max(120_000, this.portfolioRefreshMs * 2));
  }

  private emitAccountState(whale: string, state = this.latestClearinghouseStates.get(whale)): boolean {
    if (!state || (this.includePortfolioAccountValue && !this.hasFreshPortfolioAccountValue(whale))) return false;
    this.emit({ type: "accountState", whale, accountState: this.withPortfolioAccountValue(whale, { ...state, receivedAt: Date.now() }), time: Date.now() });
    return true;
  }

  private async refreshPortfolioAccountValue(whale: string): Promise<void> {
    if (this.portfolioFetches.has(whale)) return;
    this.portfolioFetches.add(whale);
    this.portfolioFetchedAt.set(whale, Date.now());
    try {
      const accountValueUsd = await this.fetchPortfolioAccountValue(whale);
      if (accountValueUsd === undefined || !Number.isFinite(accountValueUsd) || accountValueUsd < 0) return;
      this.portfolioAccountValues.set(whale, { accountValueUsd, receivedAt: Date.now() });
      this.emitAccountState(whale);
    } catch (error) {
      this.emit({ type: "error", whale, message: error instanceof Error ? error.message : "Unable to refresh Hyperliquid portfolio account value", time: Date.now() });
    } finally {
      this.portfolioFetches.delete(whale);
    }
  }
}
