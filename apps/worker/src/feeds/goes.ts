/**
 * GOES X-ray normaliser (R2). Input is the parsed body of
 * services.swpc.noaa.gov/json/goes/primary/xrays-3-day.json: an ascending array of rows
 * { time_tag, satellite, flux, energy: "0.1-0.8nm" | "0.05-0.4nm", ... }, two rows per minute.
 *
 * Pure TypeScript, no Workers-only globals.
 */
import type { Normalized, XrayRow } from "../types.ts";

/** A payload where more than this fraction of rows is malformed is treated as a changed shape. */
export const MAX_MALFORMED_FRACTION = 0.5;

const LONG_BAND = "0.1-0.8nm";
const SHORT_BAND = "0.05-0.4nm";

const TIME_TAG = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z?$/;

/**
 * Parses a NOAA time_tag to unix seconds. The tag is always UTC, with or without a trailing "Z"
 * (GOES has it, RTSW does not), so it is never handed to Date's local-time parsing. null if unparseable.
 */
export function parseTimeTag(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = TIME_TAG.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** A usable flux: finite and > 0. Fill values (0, negatives, -99999) and non-numbers become null. */
function cleanFlux(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Normalises a GOES X-ray payload.
 *
 * - A row is malformed if it is not an object, its time_tag does not parse, its `energy` is not one of the two
 *   known bands, or its `flux` is missing / neither a number nor null. Malformed rows are skipped; if more than
 *   MAX_MALFORMED_FRACTION (50%) of the rows are malformed the whole payload is rejected as a shape change.
 *   An empty array is valid (nothing to add).
 * - Fill values (flux <= 0, -99999) make that channel null; a minute with both channels null is dropped.
 * - Per (time_tag, energy) the last occurrence in the payload wins.
 * - `dataTs` is the newest ts among the kept minutes, even if it is not newer than `after`.
 */
export function normalizeGoesXray(body: unknown, after: number | null): Normalized<XrayRow> {
  if (!Array.isArray(body)) return { ok: false, error: "goes_xray: expected an array" };

  const byTs = new Map<number, { long: unknown; short: unknown; satellite: number | null }>();
  let malformed = 0;

  for (const row of body) {
    if (!isRecord(row)) { malformed++; continue; }
    const ts = parseTimeTag(row.time_tag);
    const energy = row.energy;
    const fluxOk = "flux" in row && (row.flux === null || typeof row.flux === "number");
    if (ts === null || (energy !== LONG_BAND && energy !== SHORT_BAND) || !fluxOk) {
      malformed++;
      continue;
    }
    let m = byTs.get(ts);
    if (!m) { m = { long: null, short: null, satellite: null }; byTs.set(ts, m); }
    if (energy === LONG_BAND) m.long = row.flux; else m.short = row.flux;
    const sat = row.satellite;
    if (typeof sat === "number" && Number.isFinite(sat)) m.satellite = sat;
  }

  if (body.length > 0 && malformed / body.length > MAX_MALFORMED_FRACTION) {
    return { ok: false, error: `goes_xray: ${malformed} of ${body.length} rows malformed (time_tag/energy/flux)` };
  }

  const kept: XrayRow[] = [];
  for (const [ts, m] of byTs) {
    const long = cleanFlux(m.long);
    const short = cleanFlux(m.short);
    if (long === null && short === null) continue;
    kept.push({ ts, long, short, satellite: m.satellite });
  }
  kept.sort((a, b) => a.ts - b.ts);

  const dataTs = kept.length ? kept[kept.length - 1].ts : null;
  const rows = after === null ? kept : kept.filter((r) => r.ts > after);
  return { ok: true, rows, dataTs };
}
