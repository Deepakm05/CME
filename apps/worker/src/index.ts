/**
 * Worker entry. Thin on purpose: every /api/v1 request goes to the one SpaceWeatherHub Durable Object,
 * which owns the live loop, memory and sockets. The cron trigger runs the alarm watchdog (GAP R4).
 */
import { API_PREFIX } from "@cme/shared";
import type { Env } from "./env.ts";

export { SpaceWeatherHub } from "./hub.ts";

const hub = (env: Env) => env.HUB.get(env.HUB.idFromName("main"));

export default {
  async fetch(req, env): Promise<Response> {
    const { pathname } = new URL(req.url);
    // Only the contract lives here; /mock/* and everything else is 404 (GAP X5).
    if (!pathname.startsWith(`${API_PREFIX}/`)) return new Response("Not found", { status: 404 });
    return hub(env).fetch(req);
  },
  async scheduled(_ev, env): Promise<void> {
    await hub(env).watchdog();
  },
} satisfies ExportedHandler<Env>;
