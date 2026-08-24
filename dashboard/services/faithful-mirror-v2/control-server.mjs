import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const MAX_BODY_BYTES = 16 * 1024;

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

export const createControlServer = ({ lifecycle, host = "127.0.0.1", port = 8790, controlToken }) => {
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
