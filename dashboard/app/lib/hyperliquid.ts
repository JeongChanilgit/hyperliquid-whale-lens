import type {
  CandleInterval,
  CandlePoint,
  FillCoverage,
  HistoricalOrder,
  HyperliquidFill,
  PortfolioHistory,
  PortfolioPeriodHistory,
} from "./types";

export const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
export const USER_FILLS_PAGE_SIZE = 500;
export const USER_FILLS_AVAILABILITY_LIMIT = 10_000;

export class HyperliquidApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    /** Network/CORS and 429/5xx failures may be retried by a caller. */
    public readonly recoverable = true,
  ) {
    super(message);
    this.name = "HyperliquidApiError";
  }
}

export interface HyperliquidClientOptions {
  endpoint?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  /** A weighted request unit. Public endpoints below use weight 20. */
  rateWeightMs?: number;
}

export interface FillsByTimeResult {
  fills: HyperliquidFill[];
  coverage: FillCoverage;
}

/**
 * Coverage for a raw fill replay. `reason` is an integration-friendly alias
 * for `incompleteReason`; complete coverage never carries either field.
 */
export interface UnaggregatedFillCoverage extends FillCoverage {
  reason?: string;
}

/** Unaggregated public fills suitable for reconstructing a source position episode. */
export interface UnaggregatedFillsByTimeResult {
  fills: HyperliquidFill[];
  coverage: UnaggregatedFillCoverage;
}

const infoRequestWeight = (type: unknown): number => {
  // These historical/public endpoints have materially higher API cost than a
  // metadata query. Pacing them protects a single browser session from 429s.
  switch (type) {
    case "userFillsByTime":
    case "historicalOrders":
    case "portfolio":
    case "candleSnapshot":
      return 20;
    default:
      return 1;
  }
};

interface RawCandle {
  t?: number | string;
  T?: number | string;
  o?: number | string;
  h?: number | string;
  l?: number | string;
  c?: number | string;
  v?: number | string;
  n?: number | string;
}

const asFiniteNumber = (value: unknown, fallback = 0): number => {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
};

const asTimestamp = (value: unknown): number | undefined => {
  const timestamp = asFiniteNumber(value, Number.NaN);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined;
};

const fillKey = (fill: HyperliquidFill): string =>
  [fill.time, fill.tid ?? "", fill.oid ?? "", fill.coin, fill.side, fill.sz, fill.px, fill.startPosition, fill.hash ?? ""].join("|");

/**
 * Prefer Hyperliquid's immutable transaction identity but retain all economic
 * fields as a deterministic fallback for older responses that omit it.
 */
const unaggregatedFillKey = (fill: HyperliquidFill): string =>
  [
    fill.hash ?? "",
    fill.tid ?? "",
    fill.time,
    fill.oid ?? "",
    fill.coin,
    fill.side,
    fill.sz,
    fill.px,
    fill.startPosition,
    fill.closedPnl,
    fill.fee,
    fill.feeToken ?? "",
  ].join("|");

const normaliseFill = (value: unknown): HyperliquidFill | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const time = asTimestamp(candidate.time);
  const side = candidate.side;
  if (
    time === undefined ||
    (side !== "B" && side !== "A") ||
    typeof candidate.coin !== "string" ||
    candidate.coin.length === 0 ||
    candidate.sz === undefined ||
    candidate.startPosition === undefined
  ) {
    return undefined;
  }
  return { ...candidate, time, side, coin: candidate.coin, px: String(candidate.px ?? "0"), sz: String(candidate.sz), startPosition: String(candidate.startPosition), closedPnl: String(candidate.closedPnl ?? "0"), fee: String(candidate.fee ?? "0") } as HyperliquidFill;
};

/**
 * `userFillsByTime` is permissive for legacy wallet analytics. Episode replay
 * needs an actual fill price, plus canonical optional identity fields, so it
 * uses a stricter normalizer without changing that legacy path.
 */
const normaliseUnaggregatedFill = (value: unknown): HyperliquidFill | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.px === undefined) return undefined;
  const fill = normaliseFill(candidate);
  if (!fill) return undefined;
  const oid = candidate.oid;
  const tid = candidate.tid;
  const hash = candidate.hash;
  const feeToken = candidate.feeToken;
  return {
    ...fill,
    px: String(candidate.px),
    ...(typeof oid === "number" || typeof oid === "string" ? { oid } : {}),
    ...(typeof tid === "number" || typeof tid === "string" ? { tid } : {}),
    ...(typeof hash === "string" ? { hash } : {}),
    ...(typeof feeToken === "string" ? { feeToken } : {}),
  };
};

const periodHistory = (value: unknown): PortfolioPeriodHistory => {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const points = (field: string) => {
    const source = record[field];
    if (!Array.isArray(source)) return [];
    return source.flatMap((point) => {
      if (!Array.isArray(point)) return [];
      const time = asTimestamp(point[0]);
      const valueAtTime = asFiniteNumber(point[1], Number.NaN);
      return time === undefined || !Number.isFinite(valueAtTime) ? [] : [{ time, value: valueAtTime }];
    });
  };
  return {
    accountValueHistory: points("accountValueHistory"),
    pnlHistory: points("pnlHistory"),
    vlmHistory: points("vlmHistory"),
  };
};

export const normalisePortfolio = (value: unknown): PortfolioHistory => {
  const periods: Record<string, PortfolioPeriodHistory> = {};
  if (Array.isArray(value)) {
    for (const tuple of value) {
      if (Array.isArray(tuple) && typeof tuple[0] === "string") periods[tuple[0]] = periodHistory(tuple[1]);
    }
  } else if (value && typeof value === "object") {
    for (const [period, history] of Object.entries(value as Record<string, unknown>)) periods[period] = periodHistory(history);
  }
  return { periods, month: periods.month };
};

/** Public-only browser client. It never accepts, reads, or stores user credentials. */
export class HyperliquidClient {
  private readonly endpoint: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly rateWeightMs: number;
  private nextRequestAt = 0;

  constructor(options: HyperliquidClientOptions = {}) {
    this.endpoint = options.endpoint ?? HYPERLIQUID_INFO_URL;
    // Browser `fetch` requires the global receiver in some runtimes. Keeping an
    // unbound reference and invoking it as `this.fetchFn(...)` can throw
    // `TypeError: Illegal invocation` before the request is sent.
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retries = options.retries ?? 1;
    // 20 weighted units x 53ms mirrors the project's conservative 1.05s pacing.
    this.rateWeightMs = options.rateWeightMs ?? 53;
  }

  private async pace(payload: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    const requestAt = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = requestAt + infoRequestWeight(payload.type) * this.rateWeightMs;
    if (requestAt > now) await new Promise<void>((resolve) => setTimeout(resolve, requestAt - now));
  }

  async postInfo<T>(payload: Record<string, unknown>): Promise<T> {
    let lastError: HyperliquidApiError | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      await this.pace(payload);
      const controller = typeof AbortController === "undefined" ? undefined : new AbortController();
      const timeout = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
      try {
        const response = await this.fetchFn(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller?.signal,
        });
        if (!response.ok) {
          throw new HyperliquidApiError(
            `Hyperliquid info request failed (${response.status})`,
            response.status,
            response.status === 429 || response.status >= 500,
          );
        }
        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof HyperliquidApiError) lastError = error;
        else {
          const message = error instanceof Error ? error.message : "unknown network error";
          // Browsers intentionally expose CORS failures as a generic network error.
          lastError = new HyperliquidApiError(`Hyperliquid request was blocked by the network or browser CORS policy: ${message}`);
        }
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
      if (!lastError.recoverable || attempt === this.retries) break;
    }
    throw lastError ?? new HyperliquidApiError("Hyperliquid info request failed");
  }

  /**
   * Reconstructs the requested time range with aggregateByTime enabled. Sorting is
   * stable, so API order is retained for fills sharing one millisecond.
   */
  async userFillsByTime(user: string, startTime: number, endTime: number): Promise<FillsByTimeResult> {
    let cursor = startTime;
    const seen = new Set<string>();
    const collected: Array<{ fill: HyperliquidFill; sourceIndex: number }> = [];
    let pagesFetched = 0;
    let incompleteReason: string | undefined;

    for (let pageIndex = 0; pageIndex < 30; pageIndex += 1) {
      const page = await this.postInfo<unknown>({
        type: "userFillsByTime",
        user,
        startTime: cursor,
        endTime,
        aggregateByTime: true,
      });
      pagesFetched += 1;
      if (!Array.isArray(page)) {
        incompleteReason = "Hyperliquid returned a non-list fills response";
        break;
      }
      if (page.length === 0) break;

      const orderedPage = page
        .map(normaliseFill)
        .filter((fill): fill is HyperliquidFill => fill !== undefined)
        .sort((left, right) => left.time - right.time);
      if (orderedPage.length !== page.length) {
        incompleteReason = "Hyperliquid returned a fill with invalid required fields";
        break;
      }
      for (const fill of orderedPage) {
        const key = fillKey(fill);
        if (!seen.has(key)) {
          seen.add(key);
          collected.push({ fill, sourceIndex: collected.length });
        }
      }

      if (collected.length >= USER_FILLS_AVAILABILITY_LIMIT) {
        incompleteReason = "The 10,000-fill API availability limit was reached";
        break;
      }
      if (page.length < USER_FILLS_PAGE_SIZE) break;

      const lastTime = orderedPage.at(-1)?.time;
      if (lastTime === undefined || lastTime < cursor) {
        incompleteReason = "Fill pagination moved backwards";
        break;
      }
      if (lastTime === cursor) {
        incompleteReason = "Fill pagination stalled at a capped timestamp";
        break;
      }
      cursor = lastTime;
      if (pageIndex === 29) incompleteReason = "Fill pagination exceeded 30 pages";
    }

    collected.sort((left, right) => left.fill.time - right.fill.time || left.sourceIndex - right.sourceIndex);
    return {
      fills: collected.map(({ fill }) => fill),
      coverage: {
        startTime,
        endTime,
        complete: incompleteReason === undefined,
        pagesFetched,
        fillCount: collected.length,
        incompleteReason,
      },
    };
  }

  /**
   * Fetches individual (non-aggregated) fills for a replay bootstrap.
   *
   * Hyperliquid pagination is timestamp-inclusive but has no secondary cursor.
   * Re-requesting the previous final timestamp protects fills sharing that
   * boundary; stable identity de-duplication removes the overlap. If the API
   * caps that timestamp or its 10k availability ceiling makes completeness
   * unknowable, return partial data with explicit incomplete coverage rather
   * than pretending an episode can be reconstructed exactly.
   */
  async unaggregatedUserFillsByTime(user: string, startTime: number, endTime: number): Promise<UnaggregatedFillsByTimeResult> {
    const maxPages = Math.ceil(USER_FILLS_AVAILABILITY_LIMIT / USER_FILLS_PAGE_SIZE);
    let cursor = startTime;
    let pagesFetched = 0;
    let incompleteReason: string | undefined;
    let sourceIndex = 0;
    const seen = new Set<string>();
    const collected: Array<{ fill: HyperliquidFill; sourceIndex: number }> = [];

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await this.postInfo<unknown>({
        type: "userFillsByTime",
        user,
        startTime: cursor,
        endTime,
        aggregateByTime: false,
      });
      pagesFetched += 1;
      if (!Array.isArray(page)) {
        incompleteReason = "Hyperliquid returned a non-list unaggregated fills response";
        break;
      }
      if (page.length === 0) break;

      const orderedPage = page
        .map(normaliseUnaggregatedFill)
        .filter((fill): fill is HyperliquidFill => fill !== undefined)
        .sort((left, right) => left.time - right.time);
      if (orderedPage.length !== page.length) {
        incompleteReason = "Hyperliquid returned an unaggregated fill without replay-required fields";
        break;
      }

      const countBeforePage = collected.length;
      for (const fill of orderedPage) {
        const key = unaggregatedFillKey(fill);
        if (seen.has(key)) continue;
        if (collected.length >= USER_FILLS_AVAILABILITY_LIMIT) {
          incompleteReason = "The 10,000-fill API availability limit was reached";
          break;
        }
        seen.add(key);
        collected.push({ fill, sourceIndex });
        sourceIndex += 1;
      }
      if (incompleteReason) break;
      if (collected.length >= USER_FILLS_AVAILABILITY_LIMIT) {
        incompleteReason = "The 10,000-fill API availability limit was reached";
        break;
      }
      const lastTime = orderedPage.at(-1)?.time;
      if (lastTime === undefined || lastTime < cursor) {
        incompleteReason = "Unaggregated fill pagination moved backwards";
        break;
      }
      if (page.length < USER_FILLS_PAGE_SIZE) break;
      if (lastTime === cursor) {
        incompleteReason = "Unaggregated fill pagination stalled at an inclusive capped timestamp";
        break;
      }
      if (collected.length === countBeforePage) {
        incompleteReason = "Unaggregated fill pagination returned no new stable fill identities";
        break;
      }
      cursor = lastTime;
      if (pageIndex === maxPages - 1) {
        incompleteReason = "Unaggregated fill pagination reached the 10,000-fill page limit";
      }
    }

    collected.sort((left, right) => left.fill.time - right.fill.time || left.sourceIndex - right.sourceIndex);
    const coverage: UnaggregatedFillCoverage = {
      startTime,
      endTime,
      complete: incompleteReason === undefined,
      pagesFetched,
      fillCount: collected.length,
      ...(incompleteReason ? { incompleteReason, reason: incompleteReason } : {}),
    };
    return { fills: collected.map(({ fill }) => fill), coverage };
  }

  async historicalOrders(user: string): Promise<HistoricalOrder[]> {
    const response = await this.postInfo<unknown>({ type: "historicalOrders", user });
    return Array.isArray(response) ? (response.filter((order): order is HistoricalOrder => Boolean(order && typeof order === "object")) as HistoricalOrder[]) : [];
  }

  async portfolio(user: string): Promise<PortfolioHistory> {
    return normalisePortfolio(await this.postInfo<unknown>({ type: "portfolio", user }));
  }

  /** Called only by `loadCandles`; wallet loading never eagerly downloads candles. */
  async candleSnapshot(coin: string, interval: CandleInterval, startTime: number, endTime: number): Promise<CandlePoint[]> {
    const response = await this.postInfo<unknown>({
      type: "candleSnapshot",
      req: { coin, interval, startTime, endTime },
    });
    if (!Array.isArray(response)) throw new HyperliquidApiError("Hyperliquid returned a non-list candle response");
    return response.flatMap((raw) => {
      const candle = raw as RawCandle;
      const time = asTimestamp(candle.t);
      const end = asTimestamp(candle.T);
      const open = asFiniteNumber(candle.o, Number.NaN);
      const high = asFiniteNumber(candle.h, Number.NaN);
      const low = asFiniteNumber(candle.l, Number.NaN);
      const close = asFiniteNumber(candle.c, Number.NaN);
      const volume = asFiniteNumber(candle.v, Number.NaN);
      if (time === undefined || end === undefined || [open, high, low, close, volume].some((value) => !Number.isFinite(value))) return [];
      const trades = asFiniteNumber(candle.n, Number.NaN);
      return [{ time, endTime: end, open, high, low, close, volume, ...(Number.isFinite(trades) ? { trades } : {}) }];
    });
  }
}
