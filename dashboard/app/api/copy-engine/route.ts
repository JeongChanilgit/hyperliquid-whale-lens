import { HyperliquidExecutionAdapter } from "../../lib/realtime/hyperliquid-execution";
import { RealtimeCopyEngine } from "../../lib/realtime/copy-engine";
import type { CopyEngineConfig } from "../../lib/copy-types";

export const runtime = "nodejs";

type EngineGlobal = typeof globalThis & { __copyEngine?: RealtimeCopyEngine };
const engineGlobal = globalThis as EngineGlobal;

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const requireLocalRequest = (request: Request): Response | undefined => {
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1") return undefined;
  return json({ error: "This personal copy-engine control route is available only on localhost" }, 403);
};

const readBody = async (request: Request): Promise<Record<string, unknown> | undefined> => {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
};

const LOCAL_RUNNER_BASE_URL = "http://127.0.0.1:8788";
const LOCAL_SIMULATION_TOKEN = "whale-lens-local-simulation-only-v1";

const runnerBaseUrl = (): string =>
  process.env.COPY_RUNNER_BASE_URL?.trim().replace(/\/$/, "") || LOCAL_RUNNER_BASE_URL;

const callStandaloneRunner = async (
  path: string,
  init: RequestInit = {},
): Promise<Response | undefined> => {
  const baseUrl = runnerBaseUrl();
  const token = process.env.COPY_RUNNER_CONTROL_TOKEN?.trim() || LOCAL_SIMULATION_TOKEN;
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        "x-copy-runner-control-token": token,
        "content-type": "application/json",
      },
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) return json(payload, response.status);
    const snapshot = payload.engine ?? null;
    return json({
      running: Boolean(snapshot && typeof snapshot === "object" && ["STARTING", "RUNNING"].includes(String((snapshot as { state?: unknown }).state))),
      snapshot,
      executionEnabled: payload.executionEnabled === true,
      liveArmed: payload.liveArmed === true,
      liveArmExpiresAt: typeof payload.liveArmExpiresAt === "number" ? payload.liveArmExpiresAt : null,
      testnet: payload.testnet !== false,
      durable: true,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Standalone copy runner is unavailable" }, 503);
  }
};

/**
 * Personal localhost-only control bridge. The browser needs no login, while the
 * downstream standalone runner keeps its own server-side control token.
 */
export async function GET(request: Request): Promise<Response> {
  const denial = requireLocalRequest(request);
  if (denial) return denial;
  const standalone = await callStandaloneRunner("/status");
  if (standalone) return standalone;
  const execution = HyperliquidExecutionAdapter.fromEnvironment();
  return json({
    running: Boolean(engineGlobal.__copyEngine),
    snapshot: engineGlobal.__copyEngine?.snapshot() ?? null,
    executionEnabled: execution.enabled,
    liveArmed: false,
    liveArmExpiresAt: null,
    testnet: execution.testnet,
  });
}

export async function POST(request: Request): Promise<Response> {
  const denial = requireLocalRequest(request);
  if (denial) return denial;
  const body = await readBody(request);
  if (!body || typeof body.action !== "string") return json({ error: "A copy-engine action is required" }, 400);
  const standalonePath = body.action === "start"
    ? "/start"
    : body.action === "arm-live"
      ? "/arm"
    : body.action === "stop"
      ? "/stop"
      : body.action === "kill-switch"
        ? "/kill"
        : body.action === "configure-simulation"
          ? "/configure"
        : undefined;
  if (standalonePath) {
    const standalone = await callStandaloneRunner(standalonePath, {
      method: "POST",
      body: body.action === "kill-switch"
        ? JSON.stringify({ enabled: body.enabled })
        : body.action === "arm-live"
          ? JSON.stringify({ confirmation: body.confirmation })
        : body.action === "configure-simulation"
          ? JSON.stringify({ marginPerWhaleUsd: body.marginPerWhaleUsd })
          : "{}",
    });
    if (standalone) return standalone;
  }

  if (body.action === "start") {
    const config = body.config as CopyEngineConfig | undefined;
    if (!config || !Array.isArray(config.whales) || !config.risk) return json({ error: "A valid copy-engine config is required" }, 400);
    if (config.mode === "HYPERLIQUID") {
      return json({ error: "Live execution requires the standalone runner and a fresh server-side arm" }, 503);
    }
    try {
      engineGlobal.__copyEngine?.stop();
      // This legacy in-process path is simulation-only. Live execution remains
      // exclusively in the standalone runner after a server-side arm.
      engineGlobal.__copyEngine = new RealtimeCopyEngine({ config });
      engineGlobal.__copyEngine.start();
      return json({ snapshot: engineGlobal.__copyEngine.snapshot(), executionEnabled: false, testnet: true }, 201);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Unable to start copy engine" }, 400);
    }
  }

  if (body.action === "configure-simulation") {
    return json({ error: "Simulation sizing changes require the standalone local runner" }, 503);
  }

  const engine = engineGlobal.__copyEngine;
  if (!engine) return json({ error: "Copy engine is not running" }, 409);
  if (body.action === "stop") {
    engine.stop();
    return json({ snapshot: engine.snapshot() });
  }
  if (body.action === "kill-switch") {
    if (typeof body.enabled !== "boolean") return json({ error: "kill-switch requires a boolean enabled value" }, 400);
    engine.setKillSwitch(body.enabled);
    return json({ snapshot: engine.snapshot() });
  }
  return json({ error: "Unsupported copy-engine action" }, 400);
}

export async function DELETE(request: Request): Promise<Response> {
  const denial = requireLocalRequest(request);
  if (denial) return denial;
  const standalone = await callStandaloneRunner("/stop", { method: "POST", body: "{}" });
  if (standalone) return standalone;
  engineGlobal.__copyEngine?.stop();
  engineGlobal.__copyEngine = undefined;
  return json({ stopped: true });
}
