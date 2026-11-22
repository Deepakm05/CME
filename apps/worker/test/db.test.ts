import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Alert, Cme, Flare, SunspotRegion } from "@cme/shared";
import { openTestDb } from "./sqlite.ts";
import type { Sql, SqlValue } from "../src/types.ts";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../src/db/schema.ts";
import { migrate, readMeta, readSeq, writeMeta } from "../src/db/migrate.ts";
import {
  etagsFromColumn, etagsToColumn, getAlert, getCme, getFlare, loadAlerts, loadCmesSince, loadFeedStates, loadFlaresSince,
  loadRegions, loadWindSince, loadXraySince, saveFeedState, upsertAlert, upsertCme, upsertFlare, upsertRegions,
  upsertWind, upsertXray,
} from "../src/db/rows.ts";

const fresh = () => {
  const t = openTestDb();
  migrate(t.sql);
  return t;
};

/** Every row of a table as plain objects (node:sqlite rows have a null prototype). */
const raw = (sql: Sql, table: string, order: string) =>
  sql.exec(`SELECT * FROM ${table} ORDER BY ${order}`).toArray().map((r) => ({ ...r }));

/** Inserts raw column values, then checks that load → upsert of the mapped type writes them back unchanged. */
function roundTrip(sql: Sql, table: string, order: string, rows: Record<string, SqlValue>[], reload: () => void) {
  for (const r of rows) {
    const cols = Object.keys(r);
    sql.exec(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...Object.values(r));
  }
  const before = raw(sql, table, order);
  assert.deepEqual(before, rows.map((r) => ({ ...r })), `${table}: raw insert`);
  reload();
  assert.deepEqual(raw(sql, table, order), before, `${table}: sql → type → sql`);
}

const schemaFile = fileURLToPath(new URL("../../../docs/design/backend/schema.sql", import.meta.url));

test("SCHEMA_SQL is the schema.sql file", () => {
  assert.equal(SCHEMA_SQL, readFileSync(schemaFile, "utf8").replace(/\r\n/g, "\n"));
});

test("migrate is idempotent and records schema_v; seq defaults to 0", () => {
  const { sql } = openTestDb();
  migrate(sql);
  assert.equal(readMeta(sql, "schema_v"), String(SCHEMA_VERSION));
  assert.equal(readSeq(sql), 0);
  writeMeta(sql, "seq", "41");
  upsertXray(sql, [{ ts: 60, long: 1e-6, short: 1e-8, satellite: 18 }]);
  migrate(sql);
  assert.equal(readSeq(sql), 41, "migrate must not touch data");
  assert.equal(loadXraySince(sql, 0).length, 1);
  writeMeta(sql, "seq", "42");
  assert.equal(readSeq(sql), 42);
  assert.equal(readMeta(sql, "nope"), null);
  const tables = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray();
  assert.deepEqual(tables.map((t) => t.name), [
    "alert", "cme", "cme_forecast", "feed_status", "flare", "meta", "sunspot_region", "wind_sample", "xray_sample",
  ]);
});

test("migrate refuses a database from a newer schema", () => {
  const { sql } = fresh();
  writeMeta(sql, "schema_v", String(SCHEMA_VERSION + 1));
  assert.throws(() => migrate(sql), /newer/);
});

test("D1 xray_sample ⇄ XrayRow", () => {
  const { sql } = fresh();
  const rows = [
    { ts: 120, flux_long: 2.5e-6, flux_short: 3.1e-8, satellite: 18 },
    { ts: 180, flux_long: null, flux_short: null, satellite: null },
  ];
  roundTrip(sql, "xray_sample", "ts", rows, () => {
    const loaded = loadXraySince(sql, 0);
    assert.deepEqual(loaded, [
      { ts: 120, long: 2.5e-6, short: 3.1e-8, satellite: 18 },
      { ts: 180, long: null, short: null, satellite: null },
    ]);
    assert.deepEqual(loadXraySince(sql, 150).map((r) => r.ts), [180]);
    sql.exec("DELETE FROM xray_sample");
    upsertXray(sql, loaded);
  });
});

test("D1 wind_sample ⇄ WindRow", () => {
  const { sql } = fresh();
  const rows = [
    { ts: 60, speed: 450.5, density: 5.2, temperature: 120000, bx: 1.5, by: -2.25, bz: -7.5, bt: 8, newell: 3500.25 },
    { ts: 120, speed: null, density: null, temperature: null, bx: null, by: null, bz: null, bt: null, newell: null },
  ];
  roundTrip(sql, "wind_sample", "ts", rows, () => {
    const loaded = loadWindSince(sql, 0);
    assert.deepEqual(loaded[0], { ts: 60, speed: 450.5, density: 5.2, temperature: 120000, bx: 1.5, by: -2.25, bz: -7.5, bt: 8, newell: 3500.25 });
    assert.equal(loaded[1].speed, null);
    sql.exec("DELETE FROM wind_sample");
    upsertWind(sql, loaded);
  });
});

test("D1 feed_status ⇄ FeedState (etags as JSON, nextAt = now)", () => {
  const { sql } = fresh();
  const etags = { "http://x/a.json": "W/\"abc\"", "http://x/b.json": "\"def\"" };
  const rows = [
    { feed_id: "goes_xray", etag: JSON.stringify(etags), last_ok_at: 1000, data_ts: 960, error: null, fail_count: 0 },
    { feed_id: "rtsw", etag: null, last_ok_at: null, data_ts: null, error: "HTTP 503 from /json/rtsw", fail_count: 3 },
  ];
  roundTrip(sql, "feed_status", "feed_id", rows, () => {
    const m = loadFeedStates(sql, 5000);
    assert.deepEqual(m.get("goes_xray"), {
      id: "goes_xray", etags, lastOkAt: 1000, dataTs: 960, error: null, failCount: 0, nextAt: 5000,
    });
    assert.deepEqual(m.get("rtsw"), {
      id: "rtsw", etags: {}, lastOkAt: null, dataTs: null, error: "HTTP 503 from /json/rtsw", failCount: 3, nextAt: 5000,
    });
    sql.exec("DELETE FROM feed_status");
    for (const s of m.values()) saveFeedState(sql, { ...s, nextAt: 99_999 });
  });
  assert.deepEqual(etagsFromColumn("not json"), {});
  assert.deepEqual(etagsFromColumn("[1]"), {});
  assert.equal(etagsToColumn({}), null);
});

test("D1 flare ⇄ Flare", () => {
  const { sql } = fresh();
  const rows = [
    { id: "2026-11-20T10:00:00Z", begin_at: 1000, peak_at: 1300, end_at: 1900, cls: "M2.3", peak_flux: 2.3e-5, status: "ended", region_no: 4123, lat: 12.5, lon: -30 },
    { id: "2026-11-21T10:00:00Z", begin_at: 2000, peak_at: null, end_at: null, cls: "C1.0", peak_flux: 1e-6, status: "rising", region_no: null, lat: null, lon: null },
  ];
  roundTrip(sql, "flare", "id", rows, () => {
    const loaded = loadFlaresSince(sql, 0);
    const expected: Flare = { id: "2026-11-21T10:00:00Z", beginAt: 2000, peakAt: null, endAt: null, cls: "C1.0", peakFlux: 1e-6, status: "rising", regionNo: null, lat: null, lon: null };
    assert.deepEqual(loaded[1], expected);
    assert.deepEqual(getFlare(sql, rows[0].id)?.regionNo, 4123);
    assert.equal(getFlare(sql, "missing"), null);
    assert.equal(loadFlaresSince(sql, 1500).length, 1);
    sql.exec("DELETE FROM flare");
    for (const f of loaded) upsertFlare(sql, f);
  });
});

test("D1 cme + cme_forecast ⇄ Cme (boolean, forecast join, null forecast)", () => {
  const { sql } = fresh();
  const cmeRows = [
    { id: "2026-11-20T08:24:00-CME-001", launch_at: 1000, speed: 1200, lat: -10, lon: 15, half_angle: 40, earth_directed: 1, flare_id: "2026-11-20T08:00:00Z", updated_at: 1100 },
    { id: "2026-11-21T08:24:00-CME-001", launch_at: 2000, speed: 500, lat: 30, lon: 80, half_angle: 20, earth_directed: 0, flare_id: null, updated_at: 2100 },
  ];
  const fcRows = [{ cme_id: cmeRows[0].id, computed_at: 1100, eta: 150_000, arrival_speed: 650.5, gamma: 2e-8, w: 400 }];
  const fcNullEta = [{ cme_id: cmeRows[0].id, computed_at: 1100, eta: null, arrival_speed: null, gamma: 2e-8, w: 400 }];
  for (const fc of [fcRows, fcNullEta]) {
    sql.exec("DELETE FROM cme_forecast");
    sql.exec("DELETE FROM cme");
    let loaded: Cme[] = [];
    roundTrip(sql, "cme", "id", cmeRows, () => {
      roundTrip(sql, "cme_forecast", "cme_id", fc, () => {
        loaded = loadCmesSince(sql, 0);
        assert.deepEqual(loaded[0].forecast, {
          computedAt: 1100, eta: fc[0].eta, arrivalSpeed: fc[0].arrival_speed, gamma: 2e-8, w: 400,
        });
        assert.equal(loaded[0].earthDirected, true);
        assert.equal(loaded[1].earthDirected, false);
        assert.equal(loaded[1].forecast, null);
        assert.deepEqual(getCme(sql, cmeRows[0].id), loaded[0]);
        assert.equal(getCme(sql, "missing"), null);
        sql.exec("DELETE FROM cme_forecast");
        sql.exec("DELETE FROM cme");
        for (const [i, c] of loaded.entries()) upsertCme(sql, c, cmeRows[i].updated_at);
      });
    });
  }
  // A null forecast removes the forecast row; updating a CME with a forecast keeps the cme row.
  const c = getCme(sql, cmeRows[0].id)!;
  upsertCme(sql, { ...c, speed: 1300 }, 3000);
  assert.equal(getCme(sql, c.id)?.speed, 1300);
  assert.equal(raw(sql, "cme_forecast", "cme_id").length, 1);
  upsertCme(sql, { ...c, forecast: null }, 3100);
  assert.equal(raw(sql, "cme_forecast", "cme_id").length, 0);
  assert.equal(getCme(sql, c.id)?.forecast, null);
});

test("D1 alert ⇄ Alert", () => {
  const { sql } = fresh();
  const rows = [
    { id: "FLARE_M:f1", rule: "FLARE_M", level: "watch", title: "M flare", message: "M2.3 in AR 4123", ref_type: "flare", ref_id: "f1", raised_at: 1000, cleared_at: 2000 },
    { id: "BZ_SOUTH:3000", rule: "BZ_SOUTH", level: "warning", title: "Bz south", message: "Bz ≤ −10 nT", ref_type: "wind", ref_id: "3000", raised_at: 3000, cleared_at: null },
  ];
  roundTrip(sql, "alert", "raised_at", rows, () => {
    const loaded = loadAlerts(sql, 0);
    const expected: Alert = { id: "BZ_SOUTH:3000", rule: "BZ_SOUTH", level: "warning", title: "Bz south", message: "Bz ≤ −10 nT", refType: "wind", refId: "3000", raisedAt: 3000, clearedAt: null };
    assert.deepEqual(loaded.find((a) => a.id === expected.id), expected);
    assert.equal(getAlert(sql, "FLARE_M:f1")?.clearedAt, 2000);
    // Active ones always; cleared ones only if raised/cleared since fromTs.
    assert.deepEqual(loadAlerts(sql, 2500).map((a) => a.id), ["BZ_SOUTH:3000"]);
    assert.equal(loadAlerts(sql, 1500).length, 2);
    sql.exec("DELETE FROM alert");
    for (const a of loaded) upsertAlert(sql, a);
  });
});

test("D1 sunspot_region ⇄ SunspotRegion", () => {
  const { sql } = fresh();
  const rows = [
    { region_no: 4120, observed_on: "2026-11-20", lat: 20, lon: -46, location: "N20E46", area_msh: 240, mag_class: "BG", spot_count: 12, p_m: 30, p_x: 5 },
    { region_no: 4123, observed_on: "2026-11-21", lat: -12, lon: 10, location: "S12W10", area_msh: 30, mag_class: null, spot_count: 2, p_m: null, p_x: null },
  ];
  roundTrip(sql, "sunspot_region", "region_no, observed_on", rows, () => {
    const latest = loadRegions(sql);
    const expected: SunspotRegion = { regionNo: 4123, observedOn: "2026-11-21", lat: -12, lon: 10, location: "S12W10", areaMsh: 30, magClass: null, spotCount: 2, pM: null, pX: null };
    assert.deepEqual(latest, [expected]);
    const older = loadRegions(sql, "2026-11-20");
    assert.equal(older[0].magClass, "BG");
    sql.exec("DELETE FROM sunspot_region");
    upsertRegions(sql, [...older, ...latest]);
  });
  // A region without a position is stored but not loaded.
  sql.exec("INSERT INTO sunspot_region (region_no, observed_on, location) VALUES (?, ?, ?)", 4124, "2026-11-21", "odd");
  assert.deepEqual(loadRegions(sql).map((r) => r.regionNo), [4123]);
});
