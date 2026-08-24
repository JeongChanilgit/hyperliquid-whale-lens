import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Whale Lens workspace shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Whale Lens — Hyperliquid Trader Replay<\/title>/i);
  assert.match(html, /Whale Lens/);
  assert.match(html, /트레이딩 분석/);
  assert.match(html, /차트 새로고침/);
  assert.match(html, /투자로그 새로고침/);
  assert.match(html, /거래 내역/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("ships the login-free read-only Faithful Mirror dashboard without browser credentials", async () => {
  const [page, faithfulHook, faithfulPanel, faithfulRoute, layout, packageJson, route, hyperliquidAdapter, tradingChart, copyTradingPanel, runner] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/hooks/use-faithful-mirror-status.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/FaithfulMirrorDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/faithful-mirror-v2/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/api/copy-engine/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/realtime/hyperliquid-execution.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/TradingChart.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/CopyTradingPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../services/copy-runner/runner.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Hyperliquid 실전투자/);
  assert.match(page, /FaithfulMirrorDashboard/);
  assert.match(page, /useFaithfulMirrorStatus/);
  assert.doesNotMatch(page, /useLiveCopySession/);
  assert.doesNotMatch(page, /10-WHALE REALTIME FOLLOW/);
  assert.match(faithfulHook, /\/api\/faithful-mirror-v2/);
  assert.match(faithfulHook, /canStart:\s*false/);
  assert.match(faithfulPanel, /PORTFOLIO_ONLY_ESTIMATE/);
  assert.match(faithfulPanel, /LOCKED/);
  assert.match(faithfulPanel, /유효 레버리지/);
  assert.doesNotMatch(faithfulPanel, /\/arm|\/start|signProtectedIoc/);
  assert.match(faithfulRoute, /requireLocalRequest/);
  assert.match(faithfulRoute, /FMV2_CONTROL_TOKEN/);
  assert.match(faithfulRoute, /targetAccountLabel/);
  assert.doesNotMatch(faithfulRoute, /export async function POST/);
  assert.doesNotMatch(page, /usePaperCopySession/);
  assert.match(page, /selectedTradeId/);
  assert.match(page, /walletRequestRef/);
  assert.match(page, /LOG_PAGE_SIZE/);
  assert.match(page, /다음.*건 보기/s);
  assert.match(page, /loadCandles/);
  assert.match(page, /CHART_INTERVALS/);
  assert.match(page, /마지막 캔들/);
  assert.doesNotMatch(page, /endTime:\s*walletBundle\.range\.endTime/);
  assert.match(page, /tradingEventLabel/);
  assert.match(tradingChart, /캔들 주기/);
  assert.match(tradingChart, /차트 확대 축소/);
  assert.match(tradingChart, /getVisibleLogicalRange/);
  assert.match(copyTradingPanel, /계좌 변화/);
  assert.match(copyTradingPanel, /TRADE HISTORY/);
  assert.match(copyTradingPanel, /selectedOrderId/);
  assert.match(copyTradingPanel, /AccountEquityChart/);
  assert.match(copyTradingPanel, /예정 복제수량/);
  assert.match(copyTradingPanel, /실제 target/);
  assert.match(layout, /lang="ko"/);
  assert.match(layout, /og\.png/);
  assert.match(route, /requireLocalRequest/);
  assert.match(route, /LOCAL_SIMULATION_TOKEN/);
  assert.doesNotMatch(route, /oai-authenticated-user-id/);
  assert.match(route, /HYPERLIQUID/);
  assert.match(route, /arm-live/);
  assert.match(hyperliquidAdapter, /I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS/);
  assert.match(runner, /LIVE_ARM_CONFIRMATION/);
  assert.match(runner, /LIVE_ARM_TTL_MS/);
  assert.doesNotMatch(page, /HYPERLIQUID_AGENT_PRIVATE_KEY/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await assert.rejects(access(new URL("../app/_sites-preview/preview.css", import.meta.url)));
  await access(new URL("../app/components/TradingChart.tsx", import.meta.url));
  await access(new URL("../app/components/CopyTradingPanel.tsx", import.meta.url));
  await access(new URL("../app/lib/index.ts", import.meta.url));
  await access(new URL("../app/lib/realtime/simulation-ledger.ts", import.meta.url));
  await access(new URL("../.openai/hosting.json", import.meta.url));
});

test("preloads all 50 screened wallets and preserves honest 30-day coverage status", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/preloaded/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.wallets.length, 50);
  assert.equal(manifest.wallets.some((wallet) => wallet.complete), true);
  assert.equal(manifest.wallets.every((wallet) => wallet.complete || wallet.warnings.length > 0), true);
  assert.equal(manifest.wallets.every((wallet) => wallet.fills >= 0), true);
  for (const wallet of manifest.wallets) {
    const bundle = JSON.parse(await readFile(new URL(`../public/preloaded/wallets/${wallet.address}.json`, import.meta.url), "utf8"));
    assert.equal(bundle.address.toLowerCase(), wallet.address.toLowerCase());
    assert.equal(bundle.coverage.complete, wallet.complete);
    if (!wallet.complete) assert.ok(bundle.coverage.incompleteReason || bundle.warnings.length > 0);
    assert.equal(bundle.coverage.fillCount, wallet.fills);
    assert.equal(bundle.events.length, wallet.events);
  }
});
