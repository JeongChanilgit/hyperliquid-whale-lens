import type { AuditWalletInput } from "../../../lib/server/audit-contract";
import { getAuditUser, readWatchedWallets, syncAudit } from "../../../lib/server/audit-store";

export const dynamic = "force-dynamic";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(): Promise<Response> {
  const user = getAuditUser();
  try {
    return json({ wallets: await readWatchedWallets(user) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to read watched wallets" }, 503);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const user = getAuditUser();
  let body: { wallets?: unknown };
  try {
    body = await request.json() as { wallets?: unknown };
  } catch {
    return json({ error: "A JSON wallets payload is required" }, 400);
  }
  if (!Array.isArray(body.wallets)) return json({ error: "wallets must be an array" }, 400);
  try {
    await syncAudit(user, { wallets: body.wallets as AuditWalletInput[] });
    return json({ wallets: await readWatchedWallets(user) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to save watched wallets" }, 503);
  }
}
