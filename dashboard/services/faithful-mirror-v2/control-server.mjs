import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 200;

const sendJson = (response, statusCode, body) => {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(body)}\n`);
};

const controlTokenMatches = (provided, expected) => {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const actual = Buffer.from(provided, "utf8");
  const required = Buffer.from(expected, "utf8");
  if (actual.length !== required.length) {
    timingSafeEqual(required, required);
    return false;
  }
  return timingSafeEqual(actual, required);
};

const readJsonBody = async (request) => {
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      const error = new Error("request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (received === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be a JSON object");
    return parsed;
  } catch {
    const error = new Error("body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
};

const publicError = (error) => ({ ok: false, error: error?.publicMessage ?? "request rejected" });

const boundedEventLimit = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return DEFAULT_EVENT_LIMIT;
  return Math.min(MAX_EVENT_LIMIT, Math.max(1, parsed));
};

const clippedText = (value, maximum = 240) => {
  if (typeof value !== "string") return null;
  return value
    .replace(/0x[a-f0-9]{64}\b/gi, "[REDACTED]")
    .replace(/0x[a-f0-9]{40}\b/gi, "[ADDRESS_REDACTED]")
    .replace(/\b(token|secret|password|authorization|api[_-]?key)\s*([:=])\s*\S+/gi, "$1$2[REDACTED]")
    .slice(0, maximum);
};
const nullableNumber = (value) => value == null || value === "" || typeof value === "boolean" || !Number.isFinite(Number(value)) ? null : Number(value);
const nullableBoolean = (value) => typeof value === "boolean" ? value : null;
const eventDetail = (event) => event.detail && typeof event.detail === "object" && !Array.isArray(event.detail) ? event.detail : {};
const eventValue = (event, key) => {
  const detail = eventDetail(event);
  return detail[key] ?? event[key];
};
const eventMessage = (event) => {
  const direct = clippedText(eventValue(event, "message")) ?? clippedText(eventValue(event, "reason")) ?? clippedText(eventValue(event, "status"));
  if (direct) return direct;
  const error = eventValue(event, "error");
  if (error && typeof error === "object") return clippedText(error.message);
  return null;
};

const EVENT_DETAIL_KEYS = [
  "reason", "status", "phase", "sourceOrderId", "targetOrderId", "desiredSize", "actualSize", "deltaSize",
  "notionalUsd", "residualBps", "sourceOpenOrderCount", "accountMode", "mode", "state", "armExpiresAt",
  "recoveredCheckpoint", "killSwitchRequested", "accepted", "count",
];

const normalizeEventDetail = (value) => {
  const text = clippedText(value);
  if (text != null) return text;
  const boolean = nullableBoolean(value);
  if (boolean != null) return boolean;
  const number = nullableNumber(value);
  if (number != null) return number;
  return null;
};

/**
 * The audit file is an internal recovery log.  Expose only small, named,
 * display-safe fields to any authenticated consumer; never relay raw records
 * because a future writer could add sensitive operational context.
 */
export const normalizeControlEvent = (value) => {
  const event = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const details = {};
  for (const key of EVENT_DETAIL_KEYS) {
    const raw = eventValue(event, key);
    if (raw === undefined) continue;
    const normalized = normalizeEventDetail(raw);
    if (normalized !== null) details[key] = normalized;
  }
  const reasons = eventValue(event, "reasons");
  if (Array.isArray(reasons)) {
    details.reasons = reasons.slice(0, 12).map((entry) => clippedText(String(entry), 120)).filter(Boolean);
  }
  return {
    at: Number.isFinite(Number(eventValue(event, "at"))) ? Math.trunc(Number(eventValue(event, "at"))) : null,
    type: clippedText(String(event.type ?? "EVENT"), 120) ?? "EVENT",
    pairId: clippedText(eventValue(event, "pairId"), 120),
    coin: clippedText(eventValue(event, "coin"), 80),
    side: clippedText(eventValue(event, "side"), 24),
    message: eventMessage(event),
    details,
  };
};

export const createControlServer = ({ lifecycle, auditStore = null, host = "127.0.0.1", port = 8790, controlToken }) => {
  if (!lifecycle || typeof lifecycle.status !== "function") throw new Error("Control server requires lifecycle.status()");
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Control server must bind a loopback host");
  if (typeof controlToken !== "string" || controlToken.length < 16) throw new Error("Control server requires a control token of at least 16 characters");

  const server = createServer(async (request, response) => {
    const method = String(request.method ?? "GET").toUpperCase();
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (method === "GET" && path === "/health") {
      sendJson(response, 200, { ok: true, service: "faithful-mirror-v2" });
      return;
    }
    if (!controlTokenMatches(request.headers["x-fmv2-control-token"], controlToken)) {
      sendJson(response, 401, { ok: false, error: "unauthorized" });
      return;
    }
    try {
      if (method === "GET" && path === "/status") {
        sendJson(response, 200, { ok: true, status: await lifecycle.status() });
        return;
      }
      if (method === "GET" && path === "/events") {
        if (!auditStore || typeof auditStore.readRecentEvents !== "function") {
          sendJson(response, 503, { ok: false, error: "event history is unavailable" });
          return;
        }
        const limit = boundedEventLimit(new URL(request.url ?? "/", "http://localhost").searchParams.get("limit"));
        const events = await auditStore.readRecentEvents({ limit });
        sendJson(response, 200, { ok: true, events: events.map(normalizeControlEvent) });
        return;
      }
      if (method !== "POST") {
        sendJson(response, 404, { ok: false, error: "not found" });
        return;
      }
      const body = await readJsonBody(request);
      const handlers = {
        "/arm": () => lifecycle.arm(body),
        "/start": () => lifecycle.start(body),
        "/stop": () => lifecycle.stop(body),
        "/kill": () => lifecycle.kill(body),
        "/reconcile": () => lifecycle.reconcile(body),
      };
      const handler = handlers[path];
      if (!handler) {
        sendJson(response, 404, { ok: false, error: "not found" });
        return;
      }
      sendJson(response, 200, { ok: true, result: await handler() });
    } catch (error) {
      sendJson(response, Number.isInteger(error?.statusCode) ? error.statusCode : 409, publicError(error));
    }
  });

  return {
    server,
    async listen() {
      await new Promise((resolveListen, rejectListen) => {
        const onError = (error) => { server.off("listening", onListen); rejectListen(error); };
        const onListen = () => { server.off("error", onError); resolveListen(); };
        server.once("error", onError);
        server.once("listening", onListen);
        server.listen({ host, port, exclusive: true });
      });
      return server.address();
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    },
  };
};

export const isControlTokenMatch = controlTokenMatches;
