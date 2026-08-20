import type { CandleData, WalletBundle } from "./types";

interface WalletCacheRecord {
  key: string;
  address: string;
  startTime: number;
  endTime: number;
  cachedAt: number;
  data: Omit<WalletBundle, "cacheHit" | "fetchedAt" | "cache">;
}

interface CandleCacheRecord {
  key: string;
  coin: string;
  interval: CandleData["interval"];
  startTime: number;
  endTime: number;
  cachedAt: number;
  data: Omit<CandleData, "cacheHit" | "fetchedAt" | "cache">;
}

const DB_NAME = "hyperliquid-dashboard-cache";
const DB_VERSION = 1;
const WALLET_STORE = "walletBundles";
const CANDLE_STORE = "candles";
const walletMemory = new Map<string, WalletCacheRecord>();
const candleMemory = new Map<string, CandleCacheRecord>();

const browserIndexedDb = (): IDBFactory | undefined => (typeof indexedDB === "undefined" ? undefined : indexedDB);

const openDatabase = async (): Promise<IDBDatabase | undefined> => {
  const factory = browserIndexedDb();
  if (!factory) return undefined;
  return new Promise((resolve) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(WALLET_STORE)) database.createObjectStore(WALLET_STORE, { keyPath: "key" });
      if (!database.objectStoreNames.contains(CANDLE_STORE)) database.createObjectStore(CANDLE_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
    request.onblocked = () => resolve(undefined);
  });
};

const withStore = async <T>(storeName: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> => {
  const database = await openDatabase();
  if (!database) return undefined;
  try {
    return await new Promise<T | undefined>((resolve) => {
      const transaction = database.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
      transaction.onabort = () => resolve(undefined);
    });
  } catch {
    return undefined;
  } finally {
    database.close();
  }
};

const normaliseAddress = (address: string): string => address.trim().toLowerCase();
const candleKey = (coin: string, interval: string, startTime: number, endTime: number): string => `${coin.toUpperCase()}|${interval}|${startTime}|${endTime}`;

export const getWalletCache = async (address: string, startTime: number, endTime: number): Promise<WalletCacheRecord | undefined> => {
  const key = normaliseAddress(address);
  const memory = walletMemory.get(key);
  if (memory && memory.startTime <= startTime && memory.endTime >= endTime && memory.data.coverage.complete) return memory;
  const stored = await withStore<WalletCacheRecord>(WALLET_STORE, "readonly", (store) => store.get(key));
  if (stored) walletMemory.set(key, stored);
  return stored && stored.startTime <= startTime && stored.endTime >= endTime && stored.data.coverage.complete ? stored : undefined;
};

export const putWalletCache = async (bundle: WalletBundle): Promise<void> => {
  const record: WalletCacheRecord = {
    key: normaliseAddress(bundle.address),
    address: bundle.address,
    startTime: bundle.range.startTime,
    endTime: bundle.range.endTime,
    cachedAt: bundle.fetchedAt,
    data: {
      address: bundle.address,
      range: bundle.range,
      fills: bundle.fills,
      events: bundle.events,
      episodes: bundle.episodes,
      orders: bundle.orders,
      portfolio: bundle.portfolio,
      coverage: bundle.coverage,
      warnings: bundle.warnings,
    },
  };
  walletMemory.set(record.key, record);
  await withStore(WALLET_STORE, "readwrite", (store) => store.put(record));
};

export const clearWalletCacheRecord = async (address: string): Promise<void> => {
  const key = normaliseAddress(address);
  walletMemory.delete(key);
  await withStore(WALLET_STORE, "readwrite", (store) => store.delete(key));
};

export const getCandleCache = async (coin: string, interval: CandleData["interval"], startTime: number, endTime: number): Promise<CandleCacheRecord | undefined> => {
  const canonicalCoin = coin.toUpperCase();
  for (const record of candleMemory.values()) {
    if (record.coin === canonicalCoin && record.interval === interval && record.startTime <= startTime && record.endTime >= endTime) return record;
  }
  const database = await openDatabase();
  if (!database) return undefined;
  try {
    const records = await new Promise<CandleCacheRecord[]>((resolve) => {
      const transaction = database.transaction(CANDLE_STORE, "readonly");
      const request = transaction.objectStore(CANDLE_STORE).getAll();
      request.onsuccess = () => resolve(request.result as CandleCacheRecord[]);
      request.onerror = () => resolve([]);
    });
    for (const record of records) candleMemory.set(record.key, record);
    return records.find((record) => record.coin === canonicalCoin && record.interval === interval && record.startTime <= startTime && record.endTime >= endTime);
  } finally {
    database.close();
  }
};

export const putCandleCache = async (data: CandleData): Promise<void> => {
  const record: CandleCacheRecord = {
    key: candleKey(data.coin, data.interval, data.range.startTime, data.range.endTime),
    coin: data.coin.toUpperCase(),
    interval: data.interval,
    startTime: data.range.startTime,
    endTime: data.range.endTime,
    cachedAt: data.fetchedAt,
    data: { coin: data.coin, interval: data.interval, range: data.range, candles: data.candles },
  };
  candleMemory.set(record.key, record);
  await withStore(CANDLE_STORE, "readwrite", (store) => store.put(record));
};

export const clearCandleCacheRecords = async (coin: string): Promise<void> => {
  const canonicalCoin = coin.toUpperCase();
  for (const [key, record] of candleMemory) if (record.coin === canonicalCoin) candleMemory.delete(key);
  const database = await openDatabase();
  if (!database) return;
  try {
    const records = await new Promise<CandleCacheRecord[]>((resolve) => {
      const transaction = database.transaction(CANDLE_STORE, "readonly");
      const request = transaction.objectStore(CANDLE_STORE).getAll();
      request.onsuccess = () => resolve(request.result as CandleCacheRecord[]);
      request.onerror = () => resolve([]);
    });
    await Promise.all(records.filter((record) => record.coin === canonicalCoin).map((record) => withStore(CANDLE_STORE, "readwrite", (store) => store.delete(record.key))));
  } finally {
    database.close();
  }
};
