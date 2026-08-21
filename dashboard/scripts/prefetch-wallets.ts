import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HyperliquidClient, THIRTY_DAYS_MS } from "../app/lib/hyperliquid";
import { classifyTradingEvents } from "../app/lib/trading-events";
import type { PortfolioHistory, WalletBundle } from "../app/lib/types";
import { SEED_WALLETS } from "../app/seed-wallets";

const OUTPUT_DIR = join(process.cwd(), "public", "preloaded", "wallets");
const endTime = Math.floor(Date.now() / 60_000) * 60_000;
const startTime = endTime - THIRTY_DAYS_MS;
const client = new HyperliquidClient({ retries: 2 });
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function retryRateLimited<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? Number(error.status) : null;
      if (status !== 429 || attempt === 2) throw error;
      process.stdout.write("  rate limit reached; waiting 65s before retry\n");
      await sleep(65_000);
    }
  }
  throw new Error("unreachable retry state");
}

async function reusableBundle(address: string): Promise<WalletBundle | null> {
  try {
    const bundle = JSON.parse(
      await readFile(join(OUTPUT_DIR, `${address}.json`), "utf8"),
    ) as WalletBundle;
    if (
      bundle.address.toLowerCase() === address &&
      bundle.coverage.complete &&
      bundle.fetchedAt >= Date.now() - CACHE_MAX_AGE_MS
    ) return bundle;
  } catch {
    // A missing, stale, or malformed bundle is refreshed below.
  }
  return null;
}

await mkdir(OUTPUT_DIR, { recursive: true });

const manifest: Array<{
  address: string;
  label: string;
  fetchedAt: number;
  fills: number;
  events: number;
  completedEpisodes: number;
  complete: boolean;
  warnings: string[];
}> = [];

for (const [index, wallet] of SEED_WALLETS.entries()) {
  const address = wallet.address.toLowerCase();
  process.stdout.write(`[${index + 1}/${SEED_WALLETS.length}] ${wallet.label} ${address}\n`);
  const cached = await reusableBundle(address);
  if (cached) {
    manifest.push({
      address,
      label: wallet.label,
      fetchedAt: cached.fetchedAt,
      fills: cached.coverage.fillCount,
      events: cached.events.length,
      completedEpisodes: cached.episodes.filter((episode) => episode.status === "COMPLETED").length,
      complete: cached.coverage.complete,
      warnings: cached.warnings,
    });
    process.stdout.write("  reused complete bundle cached within 24h\n");
    continue;
  }

  const fillResult = await retryRateLimited(() => client.userFillsByTime(address, startTime, endTime));
  await sleep(1_500);
  const ordersResult = await Promise.allSettled([
    retryRateLimited(() => client.historicalOrders(address)),
  ]).then(([result]) => result);
  await sleep(1_500);
  const portfolioResult = await Promise.allSettled([
    retryRateLimited(() => client.portfolio(address)),
  ]).then(([result]) => result);
  const orders = ordersResult.status === "fulfilled" ? ordersResult.value : [];
  const portfolio: PortfolioHistory = portfolioResult.status === "fulfilled" ? portfolioResult.value : { periods: {} };
  const classification = classifyTradingEvents(fillResult.fills, orders);
  const warnings = [...classification.warnings];
  if (!fillResult.coverage.complete && fillResult.coverage.incompleteReason) {
    warnings.push(fillResult.coverage.incompleteReason);
  }
  if (ordersResult.status === "rejected") warnings.push("Historical orders could not be preloaded.");
  if (portfolioResult.status === "rejected") warnings.push("Portfolio history could not be preloaded.");
  const fetchedAt = Date.now();
  const compactEvents = classification.events.map((event) => {
    const compactEvent = { ...event };
    delete compactEvent.order;
    return compactEvent;
  });
  const compactEpisodes = classification.episodes.map((episode) => ({ ...episode, fillIds: [] }));
  const compactPortfolio: PortfolioHistory = portfolio.month
    ? { periods: { month: portfolio.month }, month: portfolio.month }
    : { periods: {} };
  const bundle: WalletBundle = {
    address,
    range: { startTime, endTime },
    // Every displayable fill is retained once inside events. Raw fill/order copies
    // are omitted to keep the preloaded payload small; coverage.fillCount remains authoritative.
    fills: [],
    events: compactEvents,
    episodes: compactEpisodes,
    orders: [],
    portfolio: compactPortfolio,
    coverage: fillResult.coverage,
    warnings,
    cacheHit: true,
    fetchedAt,
    cache: {
      cacheHit: true,
      fetchedAt,
      cachedAt: fetchedAt,
      coverageStart: startTime,
      coverageEnd: endTime,
    },
  };
  await writeFile(join(OUTPUT_DIR, `${address}.json`), JSON.stringify(bundle));
  manifest.push({
    address,
    label: wallet.label,
    fetchedAt,
    fills: bundle.coverage.fillCount,
    events: bundle.events.length,
    completedEpisodes: bundle.episodes.filter((episode) => episode.status === "COMPLETED").length,
    complete: bundle.coverage.complete,
    warnings,
  });
  // Historical-order and fill responses carry item-count rate-limit weight.
  // Keep the preload comfortably below Hyperliquid's shared public limit.
  await sleep(10_000);
}

await writeFile(
  join(process.cwd(), "public", "preloaded", "manifest.json"),
  JSON.stringify({ generatedAt: Date.now(), range: { startTime, endTime }, wallets: manifest }, null, 2),
);

process.stdout.write(`Saved ${manifest.length} wallet bundles to ${OUTPUT_DIR}\n`);
