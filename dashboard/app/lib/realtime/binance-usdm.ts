import { createHmac } from "node:crypto";
import type { BinanceExecutionResult, BinanceMarketOrderRequest, BinanceUsdMExecutionPort } from "../copy-types";

interface BinanceSymbolRule {
  minQty: number;
  stepSize: number;
}

export interface BinanceOrderStatus {
  orderId?: string;
  clientOrderId: string;
  status?: string;
  executedQty?: number;
}

interface BinanceAdapterOptions {
  apiKey?: string;
  apiSecret?: string;
  enabled?: boolean;
  testnet?: boolean;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

const TESTNET_URL = "https://demo-fapi.binance.com";
const PRODUCTION_URL = "https://fapi.binance.com";

const toNumber = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const clientOrderId = (key: string): string => {
  // A deterministic 32-bit FNV-1a hash stays below Binance's 36-char client-id cap.
  let value = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    value ^= key.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return `copy-${(value >>> 0).toString(36)}`;
};

const quantityFor = (quantity: number, rule: BinanceSymbolRule): string | undefined => {
  if (!Number.isFinite(quantity) || quantity < rule.minQty) return undefined;
  const steps = quantity / rule.stepSize;
  if (Math.abs(steps - Math.round(steps)) > 1e-8) return undefined;
  const decimals = Math.min(12, Math.max(0, Math.ceil(-Math.log10(rule.stepSize) - 1e-10)));
  return quantity.toFixed(decimals);
};

export class DisabledBinanceUsdMAdapter implements BinanceUsdMExecutionPort {
  readonly enabled = false;
  readonly testnet = true;

  async getPrice(): Promise<number> {
    throw new Error("Binance USD-M execution is disabled");
  }

  async marketOrder(request: BinanceMarketOrderRequest): Promise<BinanceExecutionResult> {
    return { accepted: false, clientOrderId: clientOrderId(request.idempotencyKey), error: "Binance USD-M execution is disabled" };
  }
}

/** Server-only USD-M adapter. It reads credentials exclusively from server environment variables. */
export class BinanceUsdMAdapter implements BinanceUsdMExecutionPort {
  readonly enabled: boolean;
  readonly testnet: boolean;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly rules = new Map<string, BinanceSymbolRule>();

  constructor(options: BinanceAdapterOptions) {
    this.enabled = options.enabled === true;
    this.testnet = options.testnet !== false;
    this.apiKey = options.apiKey ?? "";
    this.apiSecret = options.apiSecret ?? "";
    this.baseUrl = (options.baseUrl ?? (this.testnet ? TESTNET_URL : PRODUCTION_URL)).replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
  }

  static fromEnvironment(env: Record<string, string | undefined> = process.env): BinanceUsdMExecutionPort {
    // All three values are required, and production has a separate explicit opt-in.
    const testnet = env.BINANCE_USDM_TESTNET !== "false";
    const productionApproved = testnet || env.BINANCE_USDM_PRODUCTION_CONFIRMED === "I_UNDERSTAND_LIVE_ORDERS";
    const enabled = env.BINANCE_USDM_ENABLED === "true" && productionApproved && Boolean(env.BINANCE_USDM_API_KEY && env.BINANCE_USDM_API_SECRET);
    if (!enabled) return new DisabledBinanceUsdMAdapter();
    return new BinanceUsdMAdapter({
      enabled,
      testnet,
      apiKey: env.BINANCE_USDM_API_KEY,
      apiSecret: env.BINANCE_USDM_API_SECRET,
      baseUrl: env.BINANCE_USDM_BASE_URL,
    });
  }

  async getPrice(symbol: string): Promise<number> {
    const response = await this.fetchFn(`${this.baseUrl}/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`);
    if (!response.ok) throw new Error(`Binance price request failed (${response.status})`);
    const payload = await response.json() as { price?: unknown };
    const price = toNumber(payload.price);
    if (!price || price <= 0) throw new Error("Binance returned an invalid price");
    return price;
  }

  async marketOrder(request: BinanceMarketOrderRequest): Promise<BinanceExecutionResult> {
    const orderId = clientOrderId(request.idempotencyKey);
    if (!this.enabled) return { accepted: false, clientOrderId: orderId, error: "Binance USD-M execution is disabled" };
    const rule = await this.symbolRule(request.symbol);
    const quantity = quantityFor(request.quantity, rule);
    if (!quantity) return { accepted: false, clientOrderId: orderId, error: "Quantity violates Binance minQty or stepSize" };
    const response = await this.signedRequest("POST", "/fapi/v1/order", {
      symbol: request.symbol,
      side: request.side,
      type: "MARKET",
      quantity,
      reduceOnly: String(request.reduceOnly),
      newClientOrderId: orderId,
      recvWindow: "5000",
    });
    if (response.status === 503) {
      // Execution status is unknown: query by client ID; never blindly retry a MARKET order.
      const lookup = await this.getOrderByClientOrderId(request.symbol, orderId);
      if (lookup) return { accepted: true, orderId: lookup.orderId, clientOrderId: orderId, status: lookup.status };
      return { accepted: false, clientOrderId: orderId, error: "Binance returned 503; order status remains unknown and was not retried" };
    }
    if (!response.ok) return { accepted: false, clientOrderId: orderId, error: `Binance MARKET order failed (${response.status}): ${await response.text()}` };
    const payload = await response.json() as { orderId?: string | number; status?: string };
    return { accepted: true, orderId: payload.orderId === undefined ? undefined : String(payload.orderId), clientOrderId: orderId, status: payload.status };
  }

  async getOrderByClientOrderId(symbol: string, clientId: string): Promise<BinanceOrderStatus | undefined> {
    if (!this.enabled) throw new Error("Binance USD-M execution is disabled");
    const response = await this.signedRequest("GET", "/fapi/v1/order", { symbol, origClientOrderId: clientId, recvWindow: "5000" });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Binance order reconciliation failed (${response.status})`);
    const payload = await response.json() as { orderId?: string | number; clientOrderId?: string; status?: string; executedQty?: string | number };
    const executedQty = toNumber(payload.executedQty);
    return {
      ...(payload.orderId === undefined ? {} : { orderId: String(payload.orderId) }),
      clientOrderId: String(payload.clientOrderId ?? clientId),
      ...(payload.status ? { status: payload.status } : {}),
      ...(executedQty === undefined ? {} : { executedQty }),
    };
  }

  async getPositionAmount(symbol: string): Promise<number> {
    if (!this.enabled) throw new Error("Binance USD-M execution is disabled");
    const response = await this.signedRequest("GET", "/fapi/v3/account", { recvWindow: "5000" });
    if (!response.ok) throw new Error(`Binance position reconciliation failed (${response.status})`);
    const payload = await response.json() as { positions?: Array<{ symbol?: string; positionAmt?: string | number; positionSide?: string }> };
    const record = payload.positions?.find((item) => item.symbol === symbol && (item.positionSide === undefined || item.positionSide === "BOTH"));
    const amount = toNumber(record?.positionAmt);
    // Account v3 may omit symbols with neither a position nor an open order.
    return amount ?? 0;
  }

  async isHedgeMode(): Promise<boolean> {
    const response = await this.signedRequest("GET", "/fapi/v1/positionSide/dual", { recvWindow: "5000" });
    if (!response.ok) throw new Error(`Binance position mode request failed (${response.status})`);
    const payload = await response.json() as { dualSidePosition?: boolean | string };
    return payload.dualSidePosition === true || payload.dualSidePosition === "true";
  }

  private async symbolRule(symbol: string): Promise<BinanceSymbolRule> {
    const cached = this.rules.get(symbol);
    if (cached) return cached;
    const response = await this.fetchFn(`${this.baseUrl}/fapi/v1/exchangeInfo?symbol=${encodeURIComponent(symbol)}`);
    if (!response.ok) throw new Error(`Binance exchangeInfo failed (${response.status})`);
    const payload = await response.json() as { symbols?: Array<{ symbol?: string; filters?: Array<{ filterType?: string; minQty?: string; stepSize?: string }> }> };
    const market = payload.symbols?.find((item) => item.symbol === symbol);
    const filter = market?.filters?.find((item) => item.filterType === "MARKET_LOT_SIZE") ?? market?.filters?.find((item) => item.filterType === "LOT_SIZE");
    const minQty = toNumber(filter?.minQty);
    const stepSize = toNumber(filter?.stepSize);
    if (!minQty || minQty <= 0 || !stepSize || stepSize <= 0) throw new Error(`Binance exchangeInfo lacks a valid MARKET_LOT_SIZE for ${symbol}`);
    const rule = { minQty, stepSize };
    this.rules.set(symbol, rule);
    return rule;
  }

  private async signedRequest(method: "GET" | "POST", path: string, values: Record<string, string>): Promise<Response> {
    const query = new URLSearchParams({ ...values, timestamp: String(Date.now()) });
    const signature = createHmac("sha256", this.apiSecret).update(query.toString()).digest("hex");
    query.set("signature", signature);
    return this.fetchFn(`${this.baseUrl}${path}?${query.toString()}`, {
      method,
      headers: { "X-MBX-APIKEY": this.apiKey },
    });
  }
}
