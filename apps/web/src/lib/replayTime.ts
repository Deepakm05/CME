import { DONKI_R0_KM } from "@cme/physics";
import type { Alert, Cme, Flare, Unix } from "@cme/shared";
import { CME_START_KM, cmeFrontKm } from "./cme.ts";
import { REPLAY_BEFORE_S, REPLAY_SPAN_S } from "./historyRange.ts";

/**
 * Where the scene's time comes from (docs/design/frontend section 4.3). Replay: `t` was set at wall-clock second
 * `at`; while playing it advances by (wall − at) × speed. Never persisted.
 */
export type TimeSource =
  | { kind: "live" }
  | { kind: "replay"; t: Unix; playing: boolean; speed: number; at: number };

/** Playback speeds offered: 1 min, 10 min and 1 h of scene time per second. */
export const REPLAY_SPEEDS = [60, 600, 3600] as const;
export const DEFAULT_REPLAY_SPEED = 600;
/** Keyboard / drag step on the timeline. */
export const STEP_S = 300;
export const BIG_STEP_S = 3600;
export const PAGE_STEP_S = 6 * 3600;

/** The 7 days replay can show, ending at the server's now. */
export function replaySpan(nowS: Unix): [Unix, Unix] {
  return [nowS - REPLAY_SPAN_S, nowS];
}

export function clampToSpan(t: Unix, nowS: Unix): Unix {
  const [a, b] = replaySpan(nowS);
  return Math.min(b, Math.max(a, t));
}

/** Replay time at wall-clock second `wallS`: t, plus elapsed × speed while playing, kept inside the 7-day span. */
export function replayTimeAt(src: Extract<TimeSource, { kind: "replay" }>, wallS: number, nowS: Unix): Unix {
  const t = src.playing ? src.t + Math.max(0, wallS - src.at) * src.speed : src.t;
  return clampToSpan(t, nowS);
}

/** `?t=` → a replay time: a unix second (or an ISO date) inside the span; anything else → now − 6 h. */
export function parseReplayParam(param: string | null, nowS: Unix): Unix {
  const fallback = Math.floor(nowS - REPLAY_BEFORE_S);
  if (param === null || param.trim() === "") return fallback;
  const p = param.trim();
  const n = /^\d+(\.\d+)?$/.test(p) ? Number(p) : /^\d{4}-\d{2}-\d{2}/.test(p) ? Date.parse(p) / 1000 : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(clampToSpan(n, nowS));
}

// ---- what had happened by time t ------------------------------------------------

/**
 * A flare as it stood at time t, or null if it hadn't begun. History holds each flare's final record; before
 * its end it is shown rising (before the peak) or decaying (after), with no end time yet.
 */
export function flareAt(f: Flare, t: Unix): Flare | null {
  if (f.beginAt > t) return null;
  if (f.endAt !== null && t >= f.endAt) return f.status === "ended" ? f : { ...f, status: "ended" };
  const peaked = f.peakAt !== null && t >= f.peakAt;
  const status = peaked ? "decaying" : "rising";
  if (f.status === status && f.endAt === null && (peaked || f.peakAt === null)) return f;
  return { ...f, status, endAt: null, peakAt: peaked ? f.peakAt : null };
}

/**
 * When a CME left the Sun: its front at the flare site (1.5 Rs), extrapolated back from the DONKI time at 21.5 Rs
 * at the launch speed, the same way the scene draws it (lib/cme.ts).
 */
export function cmeEruptAt(c: Cme): Unix {
  return c.launchAt - (DONKI_R0_KM - CME_START_KM) / Math.max(1, c.speed);
}

/** How far ahead replay mounts CME shells, so one erupting between two HUD ticks is drawn from its first frame. */
export const CME_LOOKAHEAD_S = 2 * 3600;

/**
 * CMEs worth mounting in the replay scene around t: in flight at t, or erupting within the look-ahead (each
 * shell stays hidden until its front leaves the Sun, so nothing launched after t is ever drawn).
 */
export function cmesAround(cmes: Cme[], t: Unix, lookahead = CME_LOOKAHEAD_S): Cme[] {
  return cmes.filter((c) => {
    const at = cmeEruptAt(c);
    return at <= t + lookahead && (at > t || cmeFrontKm(c, t) !== null);
  });
}

/** An alert as it stood at time t (not yet cleared if it cleared later), or null if not yet raised. */
export function alertAt(a: Alert, t: Unix): Alert | null {
  if (a.raisedAt > t) return null;
  return a.clearedAt !== null && a.clearedAt > t ? { ...a, clearedAt: null } : a;
}

export interface Events {
  flares: Flare[];
  cmes: Cme[];
  alerts: Alert[];
}

/** The event-at-time filter: only what had happened by t, each in the state it was in at t. */
export function eventsAt(ev: Events, t: Unix): Events {
  const flares: Flare[] = [];
  for (const f of ev.flares) {
    const g = flareAt(f, t);
    if (g) flares.push(g);
  }
  const alerts: Alert[] = [];
  for (const a of ev.alerts) {
    const b = alertAt(a, t);
    if (b) alerts.push(b);
  }
  return { flares, cmes: ev.cmes.filter((c) => cmeEruptAt(c) <= t), alerts };
}

/** The newest finite value at or before `at`, no older than `maxAgeS`; null if none. `t` is sorted. */
export function valueAt(t: ArrayLike<number>, v: ArrayLike<number>, at: Unix, maxAgeS = 1800): number | null {
  let lo = 0, hi = t.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (t[m] <= at) lo = m + 1;
    else hi = m;
  }
  for (let i = lo - 1; i >= 0 && at - t[i] <= maxAgeS; i--) if (Number.isFinite(v[i])) return v[i];
  return null;
}

// ---- timeline math ----------------------------------------------------------------

/** Position of t on a track spanning `range`, 0…1 (clamped). */
export function fracOf(t: Unix, range: [Unix, Unix]): number {
  const w = range[1] - range[0];
  return w <= 0 ? 1 : Math.min(1, Math.max(0, (t - range[0]) / w));
}

/** Time at a position on the track, snapped to `step` seconds (the end of the track is never snapped past). */
export function timeAtFrac(frac: number, range: [Unix, Unix], step = STEP_S): Unix {
  const f = Math.min(1, Math.max(0, frac));
  const t = range[0] + f * (range[1] - range[0]);
  return Math.min(range[1], Math.max(range[0], Math.round(t / step) * step));
}

/** New time for a key on the timeline slider, or null for a key it doesn't handle. */
export function stepForKey(key: string, shift: boolean, t: Unix, range: [Unix, Unix]): Unix | null {
  const clamp = (x: Unix) => Math.min(range[1], Math.max(range[0], x));
  const step = shift ? BIG_STEP_S : STEP_S;
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return clamp(Math.ceil(t / step) * step - step);
    case "ArrowRight":
    case "ArrowUp":
      return clamp(Math.floor(t / step) * step + step);
    case "PageDown":
      return clamp(t - PAGE_STEP_S);
    case "PageUp":
      return clamp(t + PAGE_STEP_S);
    case "Home":
      return range[0];
    case "End":
      return range[1];
    default:
      return null;
  }
}

export type FlareLetter = "C" | "M" | "X";

export interface FlareTick {
  id: string;
  frac: number;
  letter: FlareLetter;
  /** Tick height as a share of the track: X tallest. */
  size: number;
  label: string;
}

const TICK_SIZE: Record<FlareLetter, number> = { C: 0.35, M: 0.65, X: 1 };

/** Ticks for the C, M and X flares that began inside the range (A and B are too common and too small to show). */
export function flareTicks(flares: Flare[], range: [Unix, Unix]): FlareTick[] {
  const out: FlareTick[] = [];
  for (const f of flares) {
    const letter = f.cls[0]?.toUpperCase();
    if (letter !== "C" && letter !== "M" && letter !== "X") continue;
    if (f.beginAt < range[0] || f.beginAt > range[1]) continue;
    out.push({ id: f.id, frac: fracOf(f.beginAt, range), letter, size: TICK_SIZE[letter], label: `${f.cls} flare ${formatReplayTime(f.beginAt)}` });
  }
  // smaller first, so bigger ticks are drawn on top
  return out.sort((a, b) => a.size - b.size || a.frac - b.frac);
}

export interface CmeMark {
  id: string;
  frac: number;
  earthDirected: boolean;
  label: string;
}

/** Markers where CMEs left the Sun inside the range. */
export function cmeMarks(cmes: Cme[], range: [Unix, Unix]): CmeMark[] {
  return cmes
    .map((c) => ({ c, at: cmeEruptAt(c) }))
    .filter(({ at }) => at >= range[0] && at <= range[1])
    .map(({ c, at }) => ({
      id: c.id,
      frac: fracOf(at, range),
      earthDirected: c.earthDirected,
      label: `CME${c.earthDirected ? " toward Earth" : ""} ${formatReplayTime(at)}`,
    }));
}

// Built once: these run every frame (badge, slider value).
const DATE_FMT = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const DAY_FMT = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" });

/** "Sat 21 Nov 2026, 14:35 UTC": for the slider's aria-valuetext and the replay badge. */
export function formatReplayTime(t: Unix): string {
  const d = new Date(Math.floor(t) * 1000);
  const date = DATE_FMT.format(d).replace(",", "");
  return `${date}, ${d.toISOString().slice(11, 16)} UTC`;
}

/** Day boundaries (00:00 UTC) inside the range, for the track's day lines and labels. */
export function dayMarks(range: [Unix, Unix]): { t: Unix; frac: number; label: string }[] {
  const out: { t: Unix; frac: number; label: string }[] = [];
  for (let t = Math.ceil(range[0] / 86_400) * 86_400; t <= range[1]; t += 86_400) {
    out.push({ t, frac: fracOf(t, range), label: DAY_FMT.format(new Date(t * 1000)) });
  }
  return out;
}
