import type { AuditSyncInput } from "../../lib/server/audit-contract";
import { getAuditUser, readAudit, syncAudit } from "../../lib/server/audit-store";

export const dynamic = "force-dynamic";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function numberParam(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function GET(request: Request): Promise<Response> {
  const user = getAuditUser();
  const url = new URL(request.url);
  try {
    const audit = await readAudit(user, {
      ordersCursor: url.searchParams.get("ordersCursor"),
      logsCursor: url.searchParams.get("logsCursor"),
      ordersLimit: numberParam(url.searchParams.get("ordersLimit")),
      logsLimit: numberParam(url.searchParams.get("logsLimit")),
    });
    return json(audit);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to read audit history" }, 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  const user = getAuditUser();
  let body: { action?: unknown; audit?: unknown };
  try {
    body = await request.json() as { action?: unknown; audit?: unknown };
  } catch {
    return json({ error: "A JSON audit payload is required" }, 400);
  }
  if (body.action !== "sync" || !body.audit || typeof body.audit !== "object" || Array.isArray(body.audit)) {
    return json({ error: "A valid audit sync payload is required" }, 400);
  }
  const audit = body.audit as Record<string, unknown>;
  if (["wallets", "orders", "logs", "performance"].some((key) => audit[key] !== undefined && !Array.isArray(audit[key]))) {
    return json({ error: "Audit collection fields must be arrays" }, 400);
  }
  if (audit.run !== undefined && audit.run !== null && (typeof audit.run !== "object" || Array.isArray(audit.run))) {
    return json({ error: "Audit run must be an object" }, 400);
  }
  try {
    const result = await syncAudit(user, audit as AuditSyncInput);
    return json(result, 202);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to persist audit history" }, 503);
  }
}
