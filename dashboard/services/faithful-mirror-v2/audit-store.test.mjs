import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonlAuditStore } from "./audit-store.mjs";

test("audit store exposes only bounded recent redacted JSONL events", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fmv2-observability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JsonlAuditStore({
    eventsPath: join(root, "events.jsonl"),
    snapshotPath: join(root, "snapshot.json"),
    secretValues: ["server-only-token"],
  });
  await store.record({ type: "SOURCE_FILL", at: 1, coin: "BTC" });
  await store.record({ type: "TRACKING_DEBT", at: 2, coin: "ETH", token: "server-only-token" });
  await store.record({ type: "SERVICE_KILLED", at: 3, privateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  assert.deepEqual(await store.readRecentEvents({ limit: 2 }), [
    { type: "TRACKING_DEBT", at: 2, coin: "ETH", token: "[REDACTED]" },
    { type: "SERVICE_KILLED", at: 3, privateKey: "[REDACTED]" },
  ]);
  await store.close();
});
