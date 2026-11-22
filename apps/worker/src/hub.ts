/**
 * SpaceWeatherHub: the one Durable Object that owns the live loop (backend design §3–§7).
 *
 * Phase 0: deployable shell. Answers GET /api/v1/health and the cron watchdog; the live loop
 * (alarm, pollers, memory, /state, /stream) is built in Phase 1.
 */
import { DurableObject } from "cloudflare:workers";
import { API_PREFIX, type HealthResponse } from "@cme/shared";
import type { Env } from "./env.ts";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      ...init.headers,
    },
  });

export class SpaceWeatherHub extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    const route = pathname.slice(API_PREFIX.length);
    if (req.method === "GET" && route === "/health") {
      const body: HealthResponse = {
        clock: { now: Math.floor(Date.now() / 1000), speed: 1, mode: "live", scenario: null },
        feeds: [],
        status: "ok",
        seq: 0,
        sockets: 0,
        alarmLagS: null,
        lag: [],
      };
      return json(body);
    }
    return json({ error: "not found" }, { status: 404 });
  }

  /** Called by the cron trigger every minute (GAP R4). Phase 1 re-arms a stalled alarm here. */
  async watchdog(): Promise<void> {}
}
