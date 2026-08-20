import assert from "node:assert/strict";
import test from "node:test";
import { HyperliquidClient, USER_FILLS_PAGE_SIZE } from "./hyperliquid";

const fill = (time: number, tid: string, extra: Record<string, unknown> = {}) => ({
  coin: "BTC",
  side: "B",
  px: "100",
  sz: "0.01",
  startPosition: "0",
  time,
  tid,
  oid: `order-${tid}`,
  hash: `hash-${tid}`,
  closedPnl: "0",
  fee: "0.001",
  feeToken: "USDC",
  ...extra,
});

test("the default browser fetch keeps the global receiver", async () => {
  const originalFetch = globalThis.fetch;
  let receiverWasGlobal = false;

  globalThis.fetch = function (this: typeof globalThis): Promise<Response> {
    receiverWasGlobal = this === globalThis;
    return Promise.resolve(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  } as typeof fetch;

  try {
    const client = new HyperliquidClient({ retries: 0, rateWeightMs: 0 });
    await client.postInfo<unknown[]>({ type: "candleSnapshot", req: {} });
    assert.equal(receiverWasGlobal, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the legacy aggregated fill fetch remains aggregated", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const client = new HyperliquidClient({
    retries: 0,
    rateWeightMs: 0,
    fetchFn: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify([fill(100, "legacy")]), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.userFillsByTime("0xsource", 100, 200);

  assert.equal(requests[0]?.aggregateByTime, true);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.fills.length, 1);
});

test("unaggregated fill replay keeps raw fill fields and de-duplicates an inclusive page boundary", async () => {
  const firstPage = Array.from({ length: USER_FILLS_PAGE_SIZE }, (_, index) => fill(
    index === USER_FILLS_PAGE_SIZE - 1 ? 200 : 100,
    `first-${index}`,
  ));
  const boundary = firstPage.at(-1)!;
  const calls: Array<Record<string, unknown>> = [];
  const client = new HyperliquidClient({
    retries: 0,
    rateWeightMs: 0,
    fetchFn: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(request);
      const page = request.startTime === 100
        ? firstPage
        : [boundary, fill(300, "after-boundary", { startPosition: "5", side: "A", px: "101" })];
      return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.unaggregatedUserFillsByTime("0xsource", 100, 400);

  assert.deepEqual(calls.map((request) => request.aggregateByTime), [false, false]);
  assert.deepEqual(calls.map((request) => request.startTime), [100, 200]);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.fills.length, USER_FILLS_PAGE_SIZE + 1);
  assert.deepEqual(result.fills.at(-1), fill(300, "after-boundary", { startPosition: "5", side: "A", px: "101" }));
});

test("unaggregated fill replay marks a capped inclusive timestamp as incomplete", async () => {
  const page = Array.from({ length: USER_FILLS_PAGE_SIZE }, (_, index) => fill(100, `same-time-${index}`));
  const client = new HyperliquidClient({
    retries: 0,
    rateWeightMs: 0,
    fetchFn: async () => new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } }),
  });

  const result = await client.unaggregatedUserFillsByTime("0xsource", 100, 200);

  assert.equal(result.coverage.complete, false);
  assert.match(result.coverage.reason ?? "", /inclusive capped timestamp/);
  assert.equal(result.fills.length, USER_FILLS_PAGE_SIZE);
});

test("unaggregated fill replay uses the shared retry and rate-limit path", async () => {
  let attempts = 0;
  const client = new HyperliquidClient({
    retries: 1,
    rateWeightMs: 0,
    fetchFn: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("rate limited", { status: 429 })
        : new Response(JSON.stringify([fill(100, "after-rate-limit")]), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.unaggregatedUserFillsByTime("0xsource", 100, 200);

  assert.equal(attempts, 2);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.fills[0]?.tid, "after-rate-limit");
});

test("unaggregated fill replay never claims complete coverage at the 10,000-fill limit", async () => {
  const client = new HyperliquidClient({
    retries: 0,
    rateWeightMs: 0,
    fetchFn: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { startTime: number };
      const pageStart = request.startTime;
      const page = Array.from({ length: USER_FILLS_PAGE_SIZE }, (_, index) => fill(
        pageStart + index + 1,
        `${pageStart}-${index}`,
      ));
      return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.unaggregatedUserFillsByTime("0xsource", 0, 999_999);

  assert.equal(result.coverage.complete, false);
  assert.match(result.coverage.reason ?? "", /10,000-fill/);
  assert.equal(result.fills.length, 10_000);
  assert.equal(result.coverage.pagesFetched, 20);
});
