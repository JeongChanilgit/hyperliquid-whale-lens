import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WalletBundle } from "../app/lib/types";

const walletDir = join(process.cwd(), "public", "preloaded", "wallets");
const files = (await readdir(walletDir)).filter((file) => file.endsWith(".json"));

for (const file of files) {
  const path = join(walletDir, file);
  const bundle = JSON.parse(await readFile(path, "utf8")) as WalletBundle;
  bundle.events = bundle.events.map((event) => {
    const compactEvent = { ...event };
    delete compactEvent.order;
    return compactEvent;
  });
  bundle.episodes = bundle.episodes.map((episode) => ({ ...episode, fillIds: [] }));
  bundle.fills = [];
  bundle.orders = [];
  bundle.portfolio = bundle.portfolio.month
    ? { periods: { month: bundle.portfolio.month }, month: bundle.portfolio.month }
    : { periods: {} };
  await writeFile(path, JSON.stringify(bundle));
}

process.stdout.write(`Compacted ${files.length} preloaded wallet bundles.\n`);
