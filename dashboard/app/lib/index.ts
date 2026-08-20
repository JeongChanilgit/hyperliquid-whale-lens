import { clearCandleCacheRecords, clearWalletCacheRecord, getCandleCache, getWalletCache, putCandleCache, putWalletCache } from "./cache";
import { HyperliquidClient, THIRTY_DAYS_MS } from "./hyperliquid";
import { classifyTradingEvents } from "./trading-events";
import type { CandleData, CandleLoadOptions, WalletBundle, WalletLoadOptions } from "./types";

const DEFAULT_CANDLE_WINDOW_MS = THIRTY_DAYS_MS;
let client = new HyperliquidClient();

// A stable one-minute boundary makes the default rolling ranges cacheable without
// claiming coverage for the few milliseconds that elapsed since the prior call.
const defaultEndTime = (): number => Math.floor(Date.now() / 60_000) * 60_000;

/** Dependency injection hook for focused tests; production callers need not use it. */
export const configureDashboardDataClient = (nextClient: HyperliquidClient): void => {
  client = nextClient;
};

const validRange = (startTime: number, endTime: number): void => {
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) {
    throw new Error("A valid startTime before endTime is required");
  }
};

const validateAddress = (address: string): string => {
  const normalised = address.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalised)) throw new Error("Enter a valid 0x wallet address");
  return normalised;
};

export const isUsablePreloadedWalletBundle = (value: unknown, address: string): value is WalletBundle => {
  if (!value || typeof value !== "object") return false;
  const bundle = value as Partial<WalletBundle>;
  if (typeof bundle.address !== "string" || bundle.address.toLowerCase() !== address.toLowerCase()) return false;
  if (!Array.isArray(bundle.fills) || !Array.isArray(bundle.events) || !Array.isArray(bundle.episodes)) return false;
  const fillCount = Number(bundle.coverage?.fillCount);
  if (!Number.isFinite(fillCount) || fillCount < 0) return false;
  // A complete preload has one classified display event per public fill. Reject
  // stale bundles from an older compact format instead of showing an empty log.
  if (bundle.coverage?.complete && bundle.events.length !== fillCount) return false;
  return true;
};

const loadPreloadedWallet = async (address: string): Promise<WalletBundle | undefined> => {
  if (typeof window === "undefined") return undefined;
  try {
    const response = await fetch(`/preloaded/wallets/${address.toLowerCase()}.json`, {
      // Revalidate the generated file so a prior browser HTTP cache cannot hide
      // newly refreshed logs. IndexedDB remains the reusable local data cache.
      cache: "no-cache",
    });
    if (!response.ok) return undefined;
    const bundle = await response.json() as unknown;
    if (!isUsablePreloadedWalletBundle(bundle, address)) return undefined;
    return {
      ...bundle,
      cacheHit: true,
      cache: { ...bundle.cache, cacheHit: true },
    };
  } catch {
    return undefined;
  }
};

/**
 * Loads public wallet data. Candles are deliberately excluded and only fetched by
 * `loadCandles` after a chart needs them. A complete cached range is reused unless
 * the caller explicitly passes `force: true`.
 */
export const loadWalletBundle = async (address: string, options: WalletLoadOptions = {}): Promise<WalletBundle> => {
  const wallet = validateAddress(address);
  const endTime = options.endTime ?? defaultEndTime();
  const startTime = options.startTime ?? endTime - THIRTY_DAYS_MS;
  validRange(startTime, endTime);

  if (!options.force) {
    const cached = await getWalletCache(wallet, startTime, endTime);
    if (cached) {
      const cache = {
        cacheHit: true,
        fetchedAt: cached.cachedAt,
        cachedAt: cached.cachedAt,
        coverageStart: cached.startTime,
        coverageEnd: cached.endTime,
      };
      return { ...cached.data, cacheHit: true, fetchedAt: cached.cachedAt, cache };
    }
    if (options.startTime === undefined && options.endTime === undefined) {
      const preloaded = await loadPreloadedWallet(wallet);
      if (preloaded) {
        if (preloaded.coverage.complete) await putWalletCache(preloaded);
        return preloaded;
      }
    }
  }

  const fillResult = await client.userFillsByTime(wallet, startTime, endTime);
  const [ordersResult, portfolioResult] = await Promise.allSettled([client.historicalOrders(wallet), client.portfolio(wallet)]);
  const orders = ordersResult.status === "fulfilled" ? ordersResult.value : [];
  const portfolio = portfolioResult.status === "fulfilled" ? portfolioResult.value : { periods: {} };
  const classification = classifyTradingEvents(fillResult.fills, orders);
  const warnings = [...classification.warnings];
  if (!fillResult.coverage.complete && fillResult.coverage.incompleteReason) warnings.push(fillResult.coverage.incompleteReason);
  if (ordersResult.status === "rejected") warnings.push("Historical orders could not be loaded; trigger-stop labels may be incomplete.");
  if (portfolioResult.status === "rejected") warnings.push("Portfolio history could not be loaded.");
  const fetchedAt = Date.now();
  const cache = { cacheHit: false, fetchedAt, coverageStart: startTime, coverageEnd: endTime };
  const bundle: WalletBundle = {
    address: wallet,
    range: { startTime, endTime },
    fills: fillResult.fills,
    events: classification.events,
    episodes: classification.episodes,
    orders,
    portfolio,
    coverage: fillResult.coverage,
    warnings,
    cacheHit: false,
    fetchedAt,
    cache,
  };
  // Incomplete ranges are returned to this active caller but never reused as cache coverage.
  if (fillResult.coverage.complete) await putWalletCache(bundle);
  return bundle;
};

/** Fetches candle snapshots lazily and independently of the wallet bundle. */
export const loadCandles = async (coin: string, options: CandleLoadOptions = {}): Promise<CandleData> => {
  const normalisedCoin = coin.trim();
  if (!normalisedCoin) throw new Error("A coin is required");
  const interval = options.interval ?? "1h";
  const endTime = options.endTime ?? defaultEndTime();
  const startTime = options.startTime ?? endTime - DEFAULT_CANDLE_WINDOW_MS;
  validRange(startTime, endTime);

  if (!options.force) {
    const cached = await getCandleCache(normalisedCoin, interval, startTime, endTime);
    if (cached) {
      const cache = { cacheHit: true, fetchedAt: cached.cachedAt, cachedAt: cached.cachedAt, coverageStart: cached.startTime, coverageEnd: cached.endTime };
      return { ...cached.data, cacheHit: true, fetchedAt: cached.cachedAt, cache };
    }
  }

  const candles = await client.candleSnapshot(normalisedCoin, interval, startTime, endTime);
  const fetchedAt = Date.now();
  const cache = { cacheHit: false, fetchedAt, coverageStart: startTime, coverageEnd: endTime };
  const data: CandleData = {
    coin: normalisedCoin,
    interval,
    range: { startTime, endTime },
    candles,
    cacheHit: false,
    fetchedAt,
    cache,
  };
  await putCandleCache(data);
  return data;
};

export const clearWalletCache = async (address: string): Promise<void> => clearWalletCacheRecord(validateAddress(address));
export const clearCandleCache = async (coin: string): Promise<void> => clearCandleCacheRecords(coin.trim());

export * from "./adapters";
export * from "./hyperliquid";
export * from "./trading-events";
export * from "./types";
