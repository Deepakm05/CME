/**
 * Table ⇄ type mappers (GAP D1). Column names follow docs/design/backend/schema.sql exactly; each table has
 * a `*Row` type (what SELECT * returns), a `*FromRow` mapper, and the upsert/load functions built on them.
 *
 * Conventions: booleans are 0/1; nullable columns map to `null`; upserts are `INSERT … ON CONFLICT DO UPDATE`
 * (never `REPLACE`, which would delete the row first and break the cme_forecast → cme reference).
 */
import type { Alert, Cme, CmeForecast, FeedId, Flare, SunspotRegion, Unix } from "@cme/shared";
import type { FeedState, Sql, SqlValue, WindRow, XrayRow } from "../types.ts";

// ---- row shapes (type aliases, not interfaces, so they satisfy Record<string, SqlValue>) ------------------

export type XraySampleRow = { ts: number; flux_long: number | null; flux_short: number | null; satellite: number | null };

export type WindSampleRow = {
  ts: number; speed: number | null; density: number | null; temperature: number | null;
  bx: number | null; by: number | null; bz: number | null; bt: number | null; newell: number | null;
};

export type FeedStatusRow = {
  feed_id: string; etag: string | null; last_ok_at: number | null; data_ts: number | null;
  error: string | null; fail_count: number;
};

export type SunspotRegionRow = {
  region_no: number; observed_on: string; lat: number | null; lon: number | null; location: string | null;
  area_msh: number | null; mag_class: string | null; spot_count: number | null; p_m: number | null; p_x: number | null;
};

export type FlareRow = {
  id: string; begin_at: number; peak_at: number | null; end_at: number | null; cls: string; peak_flux: number;
  status: string; region_no: number | null; lat: number | null; lon: number | null;
};

export type CmeRow = {
  id: string; launch_at: number; speed: number; lat: number; lon: number; half_angle: number;
  earth_directed: number; flare_id: string | null; updated_at: number;
};

export type CmeForecastRow = {
  cme_id: string; computed_at: number; eta: number | null; arrival_speed: number | null; gamma: number; w: number;
};

export type AlertRow = {
  id: string; rule: string; level: string; title: string; message: string; ref_type: string; ref_id: string;
  raised_at: number; cleared_at: number | null;
};

/** A nullable numeric column → number | null. */
const num = (v: SqlValue | undefined): number | null => (v === null || v === undefined ? null : Number(v));

// ---- xray_sample ⇄ XrayRow --------------------------------------------------------------------------------

export const xrayFromRow = (r: XraySampleRow): XrayRow => ({
  ts: r.ts, long: num(r.flux_long), short: num(r.flux_short), satellite: num(r.satellite),
});

export function upsertXray(sql: Sql, rows: readonly XrayRow[]): void {
  for (const r of rows) {
    sql.exec(
      `INSERT INTO xray_sample (ts, flux_long, flux_short, satellite) VALUES (?, ?, ?, ?)
       ON CONFLICT(ts) DO UPDATE SET flux_long = excluded.flux_long, flux_short = excluded.flux_short,
         satellite = excluded.satellite`,
      r.ts, r.long, r.short, r.satellite,
    );
  }
}

/** Samples with ts ≥ fromTs, ascending. */
export function loadXraySince(sql: Sql, fromTs: Unix): XrayRow[] {
  return sql.exec<XraySampleRow>("SELECT * FROM xray_sample WHERE ts >= ? ORDER BY ts", fromTs).toArray().map(xrayFromRow);
}

// ---- wind_sample ⇄ WindRow --------------------------------------------------------------------------------

export const windFromRow = (r: WindSampleRow): WindRow => ({
  ts: r.ts, speed: num(r.speed), density: num(r.density), temperature: num(r.temperature),
  bx: num(r.bx), by: num(r.by), bz: num(r.bz), bt: num(r.bt), newell: num(r.newell),
});

export function upsertWind(sql: Sql, rows: readonly WindRow[]): void {
  for (const r of rows) {
    sql.exec(
      `INSERT INTO wind_sample (ts, speed, density, temperature, bx, by, bz, bt, newell) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ts) DO UPDATE SET speed = excluded.speed, density = excluded.density,
         temperature = excluded.temperature, bx = excluded.bx, by = excluded.by, bz = excluded.bz,
         bt = excluded.bt, newell = excluded.newell`,
      r.ts, r.speed, r.density, r.temperature, r.bx, r.by, r.bz, r.bt, r.newell,
    );
  }
}

/** Samples with ts ≥ fromTs, ascending. */
export function loadWindSince(sql: Sql, fromTs: Unix): WindRow[] {
  return sql.exec<WindSampleRow>("SELECT * FROM wind_sample WHERE ts >= ? ORDER BY ts", fromTs).toArray().map(windFromRow);
}

// ---- feed_status ⇄ FeedState ------------------------------------------------------------------------------

/** etags ⇄ the `etag` column: a JSON object, or NULL when there are none. Unreadable JSON counts as none. */
export function etagsToColumn(etags: Record<string, string>): string | null {
  return Object.keys(etags).length ? JSON.stringify(etags) : null;
}

export function etagsFromColumn(v: string | null): Record<string, string> {
  if (!v) return {};
  try {
    const o: unknown = JSON.parse(v);
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    return Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

/** `nextAt` is not persisted: a loaded feed is due at `now`. */
export const feedStateFromRow = (r: FeedStatusRow, now: Unix): FeedState => ({
  id: r.feed_id as FeedId,
  etags: etagsFromColumn(r.etag),
  lastOkAt: num(r.last_ok_at),
  dataTs: num(r.data_ts),
  error: r.error,
  failCount: r.fail_count,
  nextAt: now,
});

export function saveFeedState(sql: Sql, s: FeedState): void {
  sql.exec(
    `INSERT INTO feed_status (feed_id, etag, last_ok_at, data_ts, error, fail_count) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(feed_id) DO UPDATE SET etag = excluded.etag, last_ok_at = excluded.last_ok_at,
       data_ts = excluded.data_ts, error = excluded.error, fail_count = excluded.fail_count`,
    s.id, etagsToColumn(s.etags), s.lastOkAt, s.dataTs, s.error, s.failCount,
  );
}

export function loadFeedStates(sql: Sql, now: Unix): Map<FeedId, FeedState> {
  const rows = sql.exec<FeedStatusRow>("SELECT * FROM feed_status").toArray();
  return new Map(rows.map((r) => [r.feed_id as FeedId, feedStateFromRow(r, now)]));
}

// ---- sunspot_region ⇄ SunspotRegion -----------------------------------------------------------------------

/**
 * Columns the type requires but the table allows NULL (an odd location is stored without lat/lon, §5.2)
 * read as 0 / "". `loadRegions` skips rows without lat/lon, so those defaults never reach a client.
 * `lon` is the longitude at observation time; rotating it to clock.now is the caller's job.
 */
export const regionFromRow = (r: SunspotRegionRow): SunspotRegion => ({
  regionNo: r.region_no,
  observedOn: r.observed_on,
  lat: r.lat ?? 0,
  lon: r.lon ?? 0,
  location: r.location ?? "",
  areaMsh: r.area_msh ?? 0,
  magClass: r.mag_class,
  spotCount: r.spot_count ?? 0,
  pM: num(r.p_m),
  pX: num(r.p_x),
});

export function upsertRegions(sql: Sql, regions: readonly SunspotRegion[]): void {
  for (const g of regions) {
    sql.exec(
      `INSERT INTO sunspot_region (region_no, observed_on, lat, lon, location, area_msh, mag_class, spot_count, p_m, p_x)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(region_no, observed_on) DO UPDATE SET lat = excluded.lat, lon = excluded.lon,
         location = excluded.location, area_msh = excluded.area_msh, mag_class = excluded.mag_class,
         spot_count = excluded.spot_count, p_m = excluded.p_m, p_x = excluded.p_x`,
      g.regionNo, g.observedOn, g.lat, g.lon, g.location, g.areaMsh, g.magClass, g.spotCount, g.pM, g.pX,
    );
  }
}

/** Regions observed on `observedOn` (default: the latest day in the table) that have a position. */
export function loadRegions(sql: Sql, observedOn?: string): SunspotRegion[] {
  const rows = observedOn === undefined
    ? sql.exec<SunspotRegionRow>(
      `SELECT * FROM sunspot_region WHERE observed_on = (SELECT MAX(observed_on) FROM sunspot_region)
       AND lat IS NOT NULL AND lon IS NOT NULL ORDER BY region_no`,
    ).toArray()
    : sql.exec<SunspotRegionRow>(
      "SELECT * FROM sunspot_region WHERE observed_on = ? AND lat IS NOT NULL AND lon IS NOT NULL ORDER BY region_no",
      observedOn,
    ).toArray();
  return rows.map(regionFromRow);
}

// ---- flare ⇄ Flare ----------------------------------------------------------------------------------------

export const flareFromRow = (r: FlareRow): Flare => ({
  id: r.id,
  beginAt: r.begin_at,
  peakAt: num(r.peak_at),
  endAt: num(r.end_at),
  cls: r.cls,
  peakFlux: r.peak_flux,
  status: r.status as Flare["status"],
  regionNo: num(r.region_no),
  lat: num(r.lat),
  lon: num(r.lon),
});

export function upsertFlare(sql: Sql, f: Flare): void {
  sql.exec(
    `INSERT INTO flare (id, begin_at, peak_at, end_at, cls, peak_flux, status, region_no, lat, lon)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET begin_at = excluded.begin_at, peak_at = excluded.peak_at, end_at = excluded.end_at,
       cls = excluded.cls, peak_flux = excluded.peak_flux, status = excluded.status, region_no = excluded.region_no,
       lat = excluded.lat, lon = excluded.lon`,
    f.id, f.beginAt, f.peakAt, f.endAt, f.cls, f.peakFlux, f.status, f.regionNo, f.lat, f.lon,
  );
}

export function getFlare(sql: Sql, id: string): Flare | null {
  const rows = sql.exec<FlareRow>("SELECT * FROM flare WHERE id = ?", id).toArray();
  return rows.length ? flareFromRow(rows[0]) : null;
}

/** Flares that began at or after fromTs, ascending by begin time. */
export function loadFlaresSince(sql: Sql, fromTs: Unix): Flare[] {
  return sql.exec<FlareRow>("SELECT * FROM flare WHERE begin_at >= ? ORDER BY begin_at, id", fromTs).toArray().map(flareFromRow);
}

// ---- cme (+ cme_forecast) ⇄ Cme -----------------------------------------------------------------------------

/** A cme row LEFT JOINed with its forecast; forecast columns are prefixed `f_` and all NULL when there is none. */
export type CmeJoinedRow = CmeRow & {
  f_computed_at: number | null; f_eta: number | null; f_arrival_speed: number | null; f_gamma: number | null; f_w: number | null;
};

const CME_SELECT = `SELECT c.*, f.computed_at AS f_computed_at, f.eta AS f_eta, f.arrival_speed AS f_arrival_speed,
  f.gamma AS f_gamma, f.w AS f_w FROM cme c LEFT JOIN cme_forecast f ON f.cme_id = c.id`;

export const forecastFromRow = (r: CmeForecastRow): CmeForecast => ({
  computedAt: r.computed_at, eta: num(r.eta), arrivalSpeed: num(r.arrival_speed), gamma: r.gamma, w: r.w,
});

export const cmeFromRow = (r: CmeJoinedRow): Cme => ({
  id: r.id,
  launchAt: r.launch_at,
  speed: r.speed,
  lat: r.lat,
  lon: r.lon,
  halfAngle: r.half_angle,
  earthDirected: r.earth_directed !== 0,
  flareId: r.flare_id,
  forecast: r.f_computed_at === null || r.f_gamma === null || r.f_w === null
    ? null
    : forecastFromRow({
      cme_id: r.id, computed_at: r.f_computed_at, eta: r.f_eta, arrival_speed: r.f_arrival_speed, gamma: r.f_gamma, w: r.f_w,
    }),
});

/**
 * Upserts the CME and its forecast (a null forecast deletes the forecast row). `updatedAt` fills
 * cme.updated_at, which is not part of the `Cme` type (it records when DONKI last revised the CME).
 * Call inside a transaction: it writes up to two tables.
 */
export function upsertCme(sql: Sql, c: Cme, updatedAt: Unix): void {
  sql.exec(
    `INSERT INTO cme (id, launch_at, speed, lat, lon, half_angle, earth_directed, flare_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET launch_at = excluded.launch_at, speed = excluded.speed, lat = excluded.lat,
       lon = excluded.lon, half_angle = excluded.half_angle, earth_directed = excluded.earth_directed,
       flare_id = excluded.flare_id, updated_at = excluded.updated_at`,
    c.id, c.launchAt, c.speed, c.lat, c.lon, c.halfAngle, c.earthDirected ? 1 : 0, c.flareId, updatedAt,
  );
  const f = c.forecast;
  if (f) {
    sql.exec(
      `INSERT INTO cme_forecast (cme_id, computed_at, eta, arrival_speed, gamma, w) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(cme_id) DO UPDATE SET computed_at = excluded.computed_at, eta = excluded.eta,
         arrival_speed = excluded.arrival_speed, gamma = excluded.gamma, w = excluded.w`,
      c.id, f.computedAt, f.eta, f.arrivalSpeed, f.gamma, f.w,
    );
  } else {
    sql.exec("DELETE FROM cme_forecast WHERE cme_id = ?", c.id);
  }
}

export function getCme(sql: Sql, id: string): Cme | null {
  const rows = sql.exec<CmeJoinedRow>(`${CME_SELECT} WHERE c.id = ?`, id).toArray();
  return rows.length ? cmeFromRow(rows[0]) : null;
}

/** CMEs launched at or after fromTs, ascending by launch time, each with its forecast. */
export function loadCmesSince(sql: Sql, fromTs: Unix): Cme[] {
  return sql.exec<CmeJoinedRow>(`${CME_SELECT} WHERE c.launch_at >= ? ORDER BY c.launch_at, c.id`, fromTs)
    .toArray().map(cmeFromRow);
}

// ---- alert ⇄ Alert ----------------------------------------------------------------------------------------

export const alertFromRow = (r: AlertRow): Alert => ({
  id: r.id,
  rule: r.rule as Alert["rule"],
  level: r.level as Alert["level"],
  title: r.title,
  message: r.message,
  refType: r.ref_type as Alert["refType"],
  refId: r.ref_id,
  raisedAt: r.raised_at,
  clearedAt: num(r.cleared_at),
});

export function upsertAlert(sql: Sql, a: Alert): void {
  sql.exec(
    `INSERT INTO alert (id, rule, level, title, message, ref_type, ref_id, raised_at, cleared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET rule = excluded.rule, level = excluded.level, title = excluded.title,
       message = excluded.message, ref_type = excluded.ref_type, ref_id = excluded.ref_id,
       raised_at = excluded.raised_at, cleared_at = excluded.cleared_at`,
    a.id, a.rule, a.level, a.title, a.message, a.refType, a.refId, a.raisedAt, a.clearedAt,
  );
}

export function getAlert(sql: Sql, id: string): Alert | null {
  const rows = sql.exec<AlertRow>("SELECT * FROM alert WHERE id = ?", id).toArray();
  return rows.length ? alertFromRow(rows[0]) : null;
}

/** Active alerts plus any raised or cleared at/after fromTs (LiveState.alerts: "active + last 24 h"). */
export function loadAlerts(sql: Sql, fromTs: Unix): Alert[] {
  return sql.exec<AlertRow>(
    "SELECT * FROM alert WHERE cleared_at IS NULL OR raised_at >= ? OR cleared_at >= ? ORDER BY raised_at, id",
    fromTs, fromTs,
  ).toArray().map(alertFromRow);
}
