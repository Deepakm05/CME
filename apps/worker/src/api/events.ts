/**
 * GET /api/v1/events?type&since (backend design §7): flares, CMEs and alerts from SQLite.
 * `type` is a comma list of flare|cme|alert (default all three); unknown names are ignored and keys that were
 * not asked for are left out of the response, as in the mock. `since` defaults to 7 days ago. Alerts are capped at
 * LIMITS.alerts (active first, then the newest cleared), as the client rejects a longer list.
 */
import type { EventsResponse, Unix } from "@cme/shared";
import type { Sql } from "../types.ts";
import { loadAlerts, loadCmesSince, loadFlaresSince } from "../db/rows.ts";
import { SAMPLE_RETENTION_S } from "../state/commit.ts";
import { capAlerts } from "../state/memory.ts";

export type EventType = "flare" | "cme" | "alert";

export function parseEventsQuery(params: URLSearchParams, now: Unix): { types: EventType[]; since: Unix } {
  const types = (params.get("type") ?? "flare,cme,alert")
    .split(",")
    .map((s) => s.trim())
    .filter((t): t is EventType => t === "flare" || t === "cme" || t === "alert");
  const raw = params.get("since");
  const since = raw !== null && raw.trim() !== "" && Number.isFinite(Number(raw)) ? Math.floor(Number(raw)) : now - SAMPLE_RETENTION_S;
  return { types, since };
}

export function eventsResponse(sql: Sql, types: readonly EventType[], since: Unix): EventsResponse {
  const r: EventsResponse = {};
  if (types.includes("flare")) r.flares = loadFlaresSince(sql, since);
  if (types.includes("cme")) r.cmes = loadCmesSince(sql, since);
  if (types.includes("alert")) r.alerts = capAlerts(loadAlerts(sql, since).filter((a) => (a.clearedAt ?? Infinity) >= since));
  return r;
}
