import { AU_KM, DONKI_R0_KM, dbmAt, dbmTransitTime } from "@cme/physics";
import type { Alert, Cme, EventsResponse, Flare, Unix } from "@cme/shared";

export type EventKind = "flare" | "cme" | "alert";
export type FlareClassFilter = "C" | "M" | "X";
export const KINDS: readonly EventKind[] = ["flare", "cme", "alert"];
export const CLASSES: readonly FlareClassFilter[] = ["C", "M", "X"];

export const WEEK_S = 7 * 86400;
export const REPLAY_LEAD_S = 30 * 60;
export const ARRIVAL_LEAD_S = 6 * 3600;
export const PLOT_PAD_S = 3600;

/** One line of the events table. `at` is the sort time (begin, launch or raise time). */
export interface EventRow {
  kind: EventKind;
  id: string;
  at: Unix;
  label: string; // "M2.3 flare", "CME 1200 km/s", alert title
  detail: string;
  letter: string | null; // flare class letter, for the class filter
  href: string;
  replayHref: string;
}

export interface EventFilter {
  kind: EventKind | null;
  cls: FlareClassFilter | null;
}

export const eventHref = (kind: EventKind, id: string) => `/events/${kind}/${encodeURIComponent(id)}`;
export const replayHref = (t: Unix) => `/replay?t=${Math.round(t)}`;
/** "Replay this moment": a little before the event starts. */
export const momentReplayHref = (beginAt: Unix) => replayHref(beginAt - REPLAY_LEAD_S);
/** "Replay arrival": a few hours before the shock reaches Earth; null when there is no ETA. */
export const arrivalReplayHref = (eta: Unix | null) => (eta === null ? null : replayHref(eta - ARRIVAL_LEAD_S));

/** Class letter of a flare class string ("M2.3" → "M"), or null. */
export const classLetter = (cls: string): string | null => /^[A-Z]/.exec(cls)?.[0] ?? null;

export function flareRow(f: Flare): EventRow {
  const loc = f.regionNo ? ` · AR ${f.regionNo}` : "";
  return {
    kind: "flare", id: f.id, at: f.beginAt, label: `${f.cls} flare`, detail: `${f.status}${loc}`,
    letter: classLetter(f.cls), href: eventHref("flare", f.id), replayHref: momentReplayHref(f.beginAt),
  };
}

export function cmeRow(c: Cme): EventRow {
  const eta = c.forecast?.eta;
  return {
    kind: "cme", id: c.id, at: c.launchAt, label: `CME ${Math.round(c.speed)} km/s`,
    detail: c.earthDirected ? (eta ? "Earth-directed" : "Earth-directed, no arrival forecast") : "not Earth-directed",
    letter: null, href: eventHref("cme", c.id), replayHref: momentReplayHref(c.launchAt),
  };
}

export function alertRow(a: Alert): EventRow {
  return {
    kind: "alert", id: a.id, at: a.raisedAt, label: a.title, detail: `${a.level}${a.clearedAt === null ? ", active" : ""}`,
    letter: null, href: eventHref("alert", a.id), replayHref: momentReplayHref(a.raisedAt),
  };
}

/** All events as rows, newest first. */
export function toRows(r: EventsResponse): EventRow[] {
  return sortRows([...(r.flares ?? []).map(flareRow), ...(r.cmes ?? []).map(cmeRow), ...(r.alerts ?? []).map(alertRow)]);
}

export const sortRows = (rows: EventRow[]): EventRow[] => [...rows].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));

/** A class filter only applies to flares, so it hides CMEs and alerts unless a kind is chosen that says otherwise. */
export function filterRows(rows: readonly EventRow[], { kind, cls }: EventFilter): EventRow[] {
  return rows.filter((r) => (kind === null || r.kind === kind) && (cls === null || r.letter === cls));
}

/** Parse ?kind=&class=; unknown values are ignored. */
export function parseFilter(p: URLSearchParams): EventFilter {
  const k = p.get("kind");
  const c = p.get("class")?.toUpperCase();
  return {
    kind: KINDS.find((x) => x === k) ?? null,
    cls: CLASSES.find((x) => x === c) ?? null,
  };
}

/** Write a filter back to a query (omitting the defaults), keeping other params. */
export function withFilter(p: URLSearchParams, f: EventFilter): URLSearchParams {
  const q = new URLSearchParams(p);
  if (f.kind) q.set("kind", f.kind);
  else q.delete("kind");
  if (f.cls) q.set("class", f.cls);
  else q.delete("class");
  return q;
}

/** Events request path for the last 7 days of server time (whole seconds). */
export const eventsPath = (now: Unix) => `/events?since=${Math.floor(now - WEEK_S)}`;

const snapDown = (t: number) => Math.floor(t / 60) * 60;
const snapUp = (t: number) => Math.ceil(t / 60) * 60;

/**
 * X-ray window around a flare: begin − 1 h to end + 1 h (peak, else begin, + 1 h while it has no end;
 * never past `now`), snapped outward to whole minutes.
 */
export function flareWindow(f: Flare, now: Unix): { from: Unix; to: Unix } {
  const end = f.endAt ?? f.peakAt ?? f.beginAt;
  return { from: snapDown(f.beginAt - PLOT_PAD_S), to: Math.max(snapUp(Math.min(end + PLOT_PAD_S, now)), snapUp(f.beginAt)) };
}

export const historyPath = (from: Unix, to: Unix) => `/history?series=xray&res=1m&from=${from}&to=${to}`;

/** One sample of a CME's DBM track. */
export interface DbmSample {
  t: Unix;
  km: number;
  speed: number;
}

/** Evenly spaced DBM samples from launch to 1 AU (plus `padS` beyond), or null if it never gets there. */
export function dbmSamples(c: Cme, n = 120, padS = 6 * 3600): { samples: DbmSample[]; arrivalAt: Unix } | null {
  const f = c.forecast;
  const input = { v0: c.speed, w: f?.w ?? 400, ...(f ? { gamma: f.gamma } : {}) };
  const transit = dbmTransitTime(input);
  if (transit === null) return null;
  const span = transit + padS;
  const samples: DbmSample[] = [];
  for (let i = 0; i <= n; i++) {
    const s = (span * i) / n;
    const { v, r } = dbmAt(s, input);
    samples.push({ t: c.launchAt + s, km: r, speed: v });
  }
  return { samples, arrivalAt: c.launchAt + transit };
}

export const kmToAu = (km: number) => km / AU_KM;
export const START_AU = DONKI_R0_KM / AU_KM;

/** Server time at the moment of the call (liveStore clock), else the wall clock; whole minutes so request paths stay stable. */
export function snapNow(server: Unix | null, wall = Date.now() / 1000): Unix {
  return Math.floor((server ?? wall) / 60) * 60;
}

/** "2026-11-22 14:05 UTC" */
export const fmtUtc = (t: Unix | null) => (t === null ? "—" : `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`);
