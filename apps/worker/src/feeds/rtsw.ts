/**
 * RTSW (real-time solar wind at L1) normaliser (R2). Takes the parsed wind and mag bodies from
 * services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json and rtsw_mag_1m.json (newest first, one row per
 * spacecraft per minute, at most one `active: true`) and joins them on ts.
 *
 * Pure TypeScript, no Workers-only globals.
 */
import { newell } from "@cme/physics";
import type { Normalized, WindRow } from "../types.ts";
import { MAX_MALFORMED_FRACTION, parseTimeTag } from "./goes.ts";

const WIND_FIELDS = ["proton_speed", "proton_density", "proton_temperature"] as const;
const MAG_FIELDS = ["bt", "bx_gsm", "by_gsm", "bz_gsm"] as const;

type Fields = Record<string, number | null>;
type Read = { ok: true; byTs: Map<number, Fields> } | { ok: false; error: string };

/** Null for null / non-numbers / non-finite / the -9999 and -99999 fill values. */
function clean(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v !== -9999 && v !== -99999 ? v : null;
}

/**
 * Reads one RTSW payload into ts -> field values, keeping only `active === true` rows.
 *
 * A row is malformed if it is not an object, its time_tag does not parse, `active` is not a boolean, or any of the
 * expected `fields` is absent or neither number nor null. More than MAX_MALFORMED_FRACTION (50%) malformed rows
 * (counting inactive ones) rejects the payload as a shape change. An empty array is valid.
 * Should two active rows share a ts, the one with the alphabetically smallest `source` wins (ties: first in the
 * payload), so wind and mag pick the same spacecraft and the choice does not depend on row order.
 */
function readPayload(name: string, body: unknown, fields: readonly string[]): Read {
  if (!Array.isArray(body)) return { ok: false, error: `rtsw ${name}: expected an array` };
  const chosen = new Map<number, { source: string; values: Fields }>();
  let malformed = 0;

  for (const row of body) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) { malformed++; continue; }
    const r = row as Record<string, unknown>;
    const ts = parseTimeTag(r.time_tag);
    if (ts === null || typeof r.active !== "boolean" || !fields.every((f) => f in r && (r[f] === null || typeof r[f] === "number"))) {
      malformed++;
      continue;
    }
    if (!r.active) continue;
    const source = typeof r.source === "string" ? r.source : "";
    const prev = chosen.get(ts);
    if (prev && prev.source <= source) continue;
    const values: Fields = {};
    for (const f of fields) values[f] = clean(r[f]);
    chosen.set(ts, { source, values });
  }

  if (body.length > 0 && malformed / body.length > MAX_MALFORMED_FRACTION) {
    return { ok: false, error: `rtsw ${name}: ${malformed} of ${body.length} rows malformed (time_tag/active/${fields.join("/")})` };
  }
  const byTs = new Map<number, Fields>();
  for (const [ts, c] of chosen) byTs.set(ts, c.values);
  return { ok: true, byTs };
}

function maxKey(m: Map<number, Fields>): number | null {
  let max: number | null = null;
  for (const k of m.keys()) if (max === null || k > max) max = k;
  return max;
}

/**
 * Normalises RTSW wind + mag into one WindRow per minute.
 *
 * - Only active rows are used; wind and mag are joined on ts, a ts in only one payload gets nulls for the other's fields.
 * - speed <= 0 and density < 0 are nulled (on top of the fill values). newell is computed when speed, by and bz are
 *   all present, else null.
 * - A minute whose every field is null is dropped (nothing to store).
 * - Only minutes up to the horizon are emitted: min(newest active wind ts, newest active mag ts). A minute only one
 *   payload has reached yet is held back until the other catches up (so the caller's `after` cursor never skips the
 *   late side's values). One-sided minutes inside the horizon (real gaps) are emitted with nulls. If one payload has
 *   no active rows at all, the other's newest ts is the horizon, so an outage of one feed does not freeze the other.
 * - `dataTs` is the horizon (the newest minute deliverable complete), even if it is not newer than `after`; null if
 *   neither payload has an active row.
 * - A shape error in either payload gives ok:false.
 */
export function normalizeRtsw(wind: unknown, mag: unknown, after: number | null): Normalized<WindRow> {
  const w = readPayload("wind", wind, WIND_FIELDS);
  if (!w.ok) return w;
  const m = readPayload("mag", mag, MAG_FIELDS);
  if (!m.ok) return m;

  // Horizon: the newest minute both payloads have reached. Wind and mag are published separately and mag often runs a
  // minute ahead; emitting that leading minute half-joined would store it with null wind fields, and the caller's
  // `after` cursor would then reject the wind values when they arrive. If one payload has no valid rows at all
  // (an outage), the other's newest ts is the horizon so the feed does not freeze.
  const newestW = maxKey(w.byTs);
  const newestM = maxKey(m.byTs);
  const horizon = newestW !== null && newestM !== null ? Math.min(newestW, newestM) : (newestW ?? newestM);

  const all: WindRow[] = [];
  const stamps = new Set<number>([...w.byTs.keys(), ...m.byTs.keys()]);
  for (const ts of stamps) {
    if (horizon === null || ts > horizon) continue;
    const wf = w.byTs.get(ts);
    const mf = m.byTs.get(ts);
    const speedRaw = wf?.proton_speed ?? null;
    const densityRaw = wf?.proton_density ?? null;
    const speed = speedRaw !== null && speedRaw > 0 ? speedRaw : null;
    const density = densityRaw !== null && densityRaw >= 0 ? densityRaw : null;
    const temperature = wf?.proton_temperature ?? null;
    const bx = mf?.bx_gsm ?? null;
    const by = mf?.by_gsm ?? null;
    const bz = mf?.bz_gsm ?? null;
    const bt = mf?.bt ?? null;
    let nw: number | null = null;
    if (speed !== null && by !== null && bz !== null) {
      const v = newell(speed, by, bz);
      nw = Number.isFinite(v) ? v : null;
    }
    if ([speed, density, temperature, bx, by, bz, bt].every((x) => x === null)) continue;
    all.push({ ts, speed, density, temperature, bx, by, bz, bt, newell: nw });
  }
  all.sort((a, b) => a.ts - b.ts);

  const rows = after === null ? all : all.filter((r) => r.ts > after);
  return { ok: true, rows, dataTs: horizon };
}
