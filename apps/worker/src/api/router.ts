/**
 * /api/v1 routing (backend design §7, §8). Plain URL routing over HubCore; the WebSocket upgrade itself is
 * left to hub.ts, which gets back what to do with it.
 *
 * Origin rejection style for /stream: the socket is accepted and closed at once with 1008 (or 1013 when the
 * hub is full) rather than refused with 403, because a browser only ever sees a refused handshake as 1006
 * and couldn't tell "stay closed" from "network blip, retry" (§7.1 close codes).
 */
import { API_PREFIX } from "@cme/shared";
import type { HubCore } from "../core.ts";
import { originAllowed } from "../origin.ts";
import { CLOSE, MAX_SOCKETS, parseSince } from "../sockets.ts";
import { errorJson, json, notFound, safeEqual } from "./http.ts";
import { historyCacheControl, historyResponse, parseHistoryQuery } from "./history.ts";
import { eventsResponse, parseEventsQuery } from "./events.ts";

export type Routed =
  | { kind: "http"; res: Response }
  | { kind: "ws"; since: number | null }
  | { kind: "ws-reject"; code: number; reason: string };

const http = (res: Response): Routed => ({ kind: "http", res });

export function route(core: HubCore, req: Request, nowMs: number): Routed {
  try {
    return dispatch(core, req, nowMs);
  } catch (e) {
    core.log("http_error", { method: req.method, path: new URL(req.url).pathname, error: e });
    return http(errorJson(500, "internal error"));
  }
}

function dispatch(core: HubCore, req: Request, nowMs: number): Routed {
  const url = new URL(req.url);
  const path = url.pathname.startsWith(`${API_PREFIX}/`) ? url.pathname.slice(API_PREFIX.length) : null;
  const now = Math.floor(nowMs / 1000);
  const m = req.method;
  if (path === null) return http(notFound(m, url.pathname));

  if (m === "GET" && path === "/stream") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return http(errorJson(426, "expected a WebSocket upgrade", { Upgrade: "websocket" }));
    }
    if (!originAllowed(req.headers.get("origin"), core.allowOrigins)) return { kind: "ws-reject", code: CLOSE.ORIGIN, reason: "origin not allowed" };
    if (core.socketCount() >= MAX_SOCKETS) return { kind: "ws-reject", code: CLOSE.TOO_MANY, reason: "too many sockets" };
    return { kind: "ws", since: parseSince(url.searchParams.get("since")) };
  }

  if (m === "GET" && path === "/state") {
    const etag = `"${core.seq}"`;
    const inm = req.headers.get("if-none-match");
    if (inm !== null && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) {
      return http(new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-store" } }));
    }
    return http(json(core.memory.stateJson(core.seq, now), 200, { ETag: etag }, true));
  }

  if (m === "GET" && path === "/health") return http(json(core.health(nowMs)));

  if (m === "GET" && path === "/history") {
    const q = parseHistoryQuery(url.searchParams, now);
    if (!q.ok) return http(errorJson(400, q.error));
    return http(json(historyResponse(core.memory, q), 200, { "Cache-Control": historyCacheControl(q.to, now) }));
  }

  if (m === "GET" && path === "/events") {
    const { types, since } = parseEventsQuery(url.searchParams, now);
    return http(json(eventsResponse(core.sql, types, since), 200, { "Cache-Control": "public, s-maxage=30" }));
  }

  if (m === "POST" && path === "/admin/test-alert") {
    const token = core.config.adminToken;
    if (!token) return http(notFound(m, url.pathname));
    const auth = req.headers.get("authorization") ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!safeEqual(given, token)) return http(errorJson(401, "unauthorized", { "WWW-Authenticate": "Bearer" }));
    return http(json({ id: core.raiseTestAlert(nowMs).id }));
  }

  return http(notFound(m, url.pathname));
}
