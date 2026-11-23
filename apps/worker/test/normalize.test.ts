import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { newell } from "@cme/physics";
import { normalizeGoesXray, parseTimeTag } from "../src/feeds/goes.ts";
import { normalizeRtsw } from "../src/feeds/rtsw.ts";
import type { Normalized } from "../src/types.ts";

const DATA = "../../../docs/reconnection/data/";
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(DATA + name, import.meta.url)), "utf8"));
}
function ok<T>(r: Normalized<T>): { rows: T[]; dataTs: number | null } {
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r;
}
const T = (s: string): number => Date.parse(s) / 1000;

// ---- time parsing ---------------------------------------------------------------

test("parseTimeTag: UTC with or without Z, garbage is null", () => {
  assert.equal(parseTimeTag("2026-09-28T18:51:00"), T("2026-09-28T18:51:00Z"));
  assert.equal(parseTimeTag("2026-09-28T18:51:00Z"), T("2026-09-28T18:51:00Z"));
  assert.equal(parseTimeTag("2026-09-28T18:51:00.500Z"), T("2026-09-28T18:51:00Z"));
  for (const bad of ["", "yesterday", "2026-09-28", "2026-13-28T18:51:00", 1759085460, null, undefined, {}]) {
    assert.equal(parseTimeTag(bad), null);
  }
});

// ---- real fixtures --------------------------------------------------------------

test("real GOES fixture: ascending, unique, plausible", () => {
  const body = fixture("goes_xrays_3day.json") as Array<{ flux: number }>;
  const { rows, dataTs } = ok(normalizeGoesXray(body, null));
  // 8630 rows = 4315 minutes; fill-only minutes are dropped.
  assert.ok(rows.length > 4000 && rows.length <= body.length / 2, `rows=${rows.length}`);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].ts > rows[i - 1].ts);
  assert.equal(dataTs, rows[rows.length - 1].ts);
  assert.equal(dataTs, T("2026-09-28T18:51:00Z"));
  assert.ok(rows.every((r) => r.long !== null || r.short !== null));
  assert.ok(rows.every((r) => (r.long === null || r.long > 0) && (r.short === null || r.short > 0)));
  assert.ok(rows.every((r) => r.satellite === 18));
  assert.ok(rows.some((r) => r.long !== null && r.short !== null));
});

test("real GOES fixture: after filters strictly newer, dataTs unchanged", () => {
  const body = fixture("goes_xrays_3day.json");
  const all = ok(normalizeGoesXray(body, null));
  const cut = all.rows[all.rows.length - 3].ts;
  const part = ok(normalizeGoesXray(body, cut));
  assert.deepEqual(part.rows, all.rows.slice(-2));
  const none = ok(normalizeGoesXray(body, all.dataTs));
  assert.deepEqual(none.rows, []);
  assert.equal(none.dataTs, all.dataTs);
});

test("real RTSW fixture: active only, ascending, unique, joined, newell", () => {
  const wind = fixture("rtsw_wind_1m.json") as Array<{ active: boolean; time_tag: string }>;
  const mag = fixture("rtsw_mag_1m.json") as Array<{ active: boolean }>;
  const activeWind = wind.filter((r) => r.active).length;
  const activeMag = mag.filter((r) => r.active).length;
  const { rows, dataTs } = ok(normalizeRtsw(wind, mag, null));
  assert.ok(rows.length > 1000, `rows=${rows.length}`);
  assert.ok(rows.length <= activeWind + activeMag);
  assert.ok(rows.length < wind.length, "inactive spacecraft rows must be excluded");
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].ts > rows[i - 1].ts, "strictly ascending, no duplicate ts");
  assert.equal(dataTs, rows[rows.length - 1].ts);
  // Mag runs a minute ahead of wind in the fixture (18:52 vs 18:51); the horizon is the older of the two, so the
  // leading mag-only minute is held back and the newest emitted row is complete.
  assert.equal(dataTs, T("2026-09-28T18:51:00Z"));
  const last = rows[rows.length - 1];
  assert.equal(last.ts, dataTs);
  for (const k of ["speed", "density", "temperature", "bx", "by", "bz", "bt", "newell"] as const) assert.notEqual(last[k], null, k);
  const withBoth = rows.filter((r) => r.speed !== null && r.by !== null && r.bz !== null);
  assert.ok(withBoth.length > 1000);
  for (const r of withBoth) {
    assert.ok(r.newell !== null && Number.isFinite(r.newell));
    assert.equal(r.newell, newell(r.speed as number, r.by as number, r.bz as number));
  }
  assert.ok(rows.every((r) => r.speed === null || r.speed > 0));
  assert.ok(rows.every((r) => r.density === null || r.density >= 0));
  // The newest wind minute carries the values from the top of the fixture, parsed as UTC.
  const w = rows.find((r) => r.ts === T("2026-09-28T18:51:00Z"));
  assert.equal(w?.speed, 329.3);
  assert.equal(w?.density, 2.61);
  assert.equal(w?.temperature, 44664);
});

// ---- R2: GOES synthetic ---------------------------------------------------------

const gx = (time: string, energy: string, flux: number | null, satellite = 18) => ({ time_tag: time, satellite, flux, energy });
const M1 = "2026-09-25T18:53:00Z";
const M2 = "2026-09-25T18:54:00Z";
const M3 = "2026-09-25T18:55:00Z";

test("GOES: long/short mapping and satellite", () => {
  const r = ok(normalizeGoesXray([gx(M1, "0.05-0.4nm", 2e-8, 16), gx(M1, "0.1-0.8nm", 5e-6, 16)], null));
  assert.deepEqual(r.rows, [{ ts: T(M1), long: 5e-6, short: 2e-8, satellite: 16 }]);
});

test("GOES: fill values null the channel; a minute with both null is dropped", () => {
  const body = [
    gx(M1, "0.05-0.4nm", -99999), gx(M1, "0.1-0.8nm", 3e-6),
    gx(M2, "0.05-0.4nm", 0), gx(M2, "0.1-0.8nm", -99999),
    gx(M3, "0.05-0.4nm", 1e-8), gx(M3, "0.1-0.8nm", null),
  ];
  const r = ok(normalizeGoesXray(body, null));
  assert.deepEqual(r.rows, [
    { ts: T(M1), long: 3e-6, short: null, satellite: 18 },
    { ts: T(M3), long: null, short: 1e-8, satellite: 18 },
  ]);
  assert.equal(r.dataTs, T(M3), "dataTs ignores dropped minutes");
});

test("GOES: duplicates per (time_tag, energy) keep the last occurrence", () => {
  const body = [gx(M1, "0.1-0.8nm", 1e-6), gx(M1, "0.1-0.8nm", 2e-6), gx(M1, "0.05-0.4nm", 1e-8)];
  assert.deepEqual(ok(normalizeGoesXray(body, null)).rows, [{ ts: T(M1), long: 2e-6, short: 1e-8, satellite: 18 }]);
});

test("GOES: unordered input is sorted ascending", () => {
  const r = ok(normalizeGoesXray([gx(M3, "0.1-0.8nm", 3e-6), gx(M1, "0.1-0.8nm", 1e-6), gx(M2, "0.1-0.8nm", 2e-6)], null));
  assert.deepEqual(r.rows.map((x) => x.ts), [T(M1), T(M2), T(M3)]);
});

test("GOES: after filters strictly; dataTs reports newest even when nothing is new", () => {
  const body = [gx(M1, "0.1-0.8nm", 1e-6), gx(M2, "0.1-0.8nm", 2e-6), gx(M3, "0.1-0.8nm", 3e-6)];
  assert.deepEqual(ok(normalizeGoesXray(body, T(M2))).rows.map((x) => x.ts), [T(M3)]);
  const none = ok(normalizeGoesXray(body, T(M3)));
  assert.deepEqual(none.rows, []);
  assert.equal(none.dataTs, T(M3));
  assert.deepEqual(ok(normalizeGoesXray([], null)), { ok: true, rows: [], dataTs: null });
});

test("GOES: a few bad rows are skipped, mostly-bad payloads are a shape error", () => {
  const good = [gx(M1, "0.1-0.8nm", 1e-6), gx(M2, "0.1-0.8nm", 2e-6), gx(M3, "0.1-0.8nm", 3e-6)];
  const withBad = [...good, null, "x", { time_tag: "nope", energy: "0.1-0.8nm", flux: 1 }];
  assert.equal(ok(normalizeGoesXray(withBad, null)).rows.length, 3, "exactly 50% malformed is tolerated");
  const mostlyBad = [good[0], null, "x", { time_tag: "nope", energy: "0.1-0.8nm", flux: 1 }];
  assert.equal(normalizeGoesXray(mostlyBad, null).ok, false);
});

test("GOES: changed shape gives ok:false", () => {
  const cases: Record<string, unknown> = {
    object: { data: [gx(M1, "0.1-0.8nm", 1e-6)] },
    null: null,
    string: "<html>503</html>",
    renamedFlux: [{ time_tag: M1, satellite: 18, irradiance: 1e-6, energy: "0.1-0.8nm" }],
    renamedEnergy: [{ time_tag: M1, satellite: 18, flux: 1e-6, band: "0.1-0.8nm" }],
    unknownBand: [gx(M1, "1-8A", 1e-6), gx(M2, "0.5-4A", 1e-6)],
    noTime: [{ satellite: 18, flux: 1e-6, energy: "0.1-0.8nm" }],
    stringFlux: [{ time_tag: M1, satellite: 18, flux: "1e-6", energy: "0.1-0.8nm" }],
  };
  for (const [name, body] of Object.entries(cases)) {
    const r = normalizeGoesXray(body, null);
    assert.equal(r.ok, false, name);
    assert.ok(!r.ok && r.error.length > 0 && r.error.length < 200, name);
  }
});

// ---- R2: RTSW synthetic ---------------------------------------------------------

const W1 = "2026-09-28T18:51:00"; // no Z
const W2 = "2026-09-28T18:52:00";
const W3 = "2026-09-28T18:53:00";

const wr = (time: string, o: Record<string, unknown> = {}) => ({
  time_tag: time, active: true, source: "SOLAR1", proton_speed: 400, proton_density: 5, proton_temperature: 90000, ...o,
});
const mr = (time: string, o: Record<string, unknown> = {}) => ({
  time_tag: time, active: true, source: "SOLAR1", bt: 6, bx_gsm: 1, by_gsm: 3, bz_gsm: -4, ...o,
});

test("RTSW: join, UTC parsing without Z, field mapping, newell", () => {
  const r = ok(normalizeRtsw([wr(W1)], [mr(W1)], null));
  assert.deepEqual(r.rows, [{
    ts: T("2026-09-28T18:51:00Z"), speed: 400, density: 5, temperature: 90000,
    bx: 1, by: 3, bz: -4, bt: 6, newell: newell(400, 3, -4),
  }]);
});

test("RTSW: inactive rows are ignored", () => {
  const wind = [wr(W1, { active: false, source: "ACE", proton_speed: 999 }), wr(W1)];
  const mag = [mr(W1, { active: false, source: "ACE", bt: 99 }), mr(W1)];
  const r = ok(normalizeRtsw(wind, mag, null));
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].speed, 400);
  assert.equal(r.rows[0].bt, 6);
  // Only inactive rows: nothing to report.
  assert.deepEqual(ok(normalizeRtsw([wr(W1, { active: false })], [mr(W1, { active: false })], null)), { ok: true, rows: [], dataTs: null });
});

test("RTSW: two active rows for one ts pick one deterministically", () => {
  const wind = [wr(W1, { source: "SOLAR1", proton_speed: 400 }), wr(W1, { source: "ACE", proton_speed: 450 })];
  const mag = [mr(W1, { source: "SOLAR1", bt: 6 }), mr(W1, { source: "ACE", bt: 7 })];
  const a = ok(normalizeRtsw(wind, mag, null));
  const b = ok(normalizeRtsw([...wind].reverse(), [...mag].reverse(), null));
  assert.equal(a.rows.length, 1);
  assert.deepEqual(a, b);
  assert.equal(a.rows[0].speed, 450, "alphabetically smallest source (ACE) wins, in wind and mag alike");
  assert.equal(a.rows[0].bt, 7);
});

test("RTSW: fill values and impossible values become null", () => {
  const wind = [wr(W1, { proton_speed: -9999, proton_density: -99999, proton_temperature: null }), wr(W2, { proton_speed: 0, proton_density: -1 }), wr(W3, { proton_density: 0 })];
  const mag = [mr(W1, { bt: -9999, bx_gsm: -99999, by_gsm: 2, bz_gsm: -1 }), mr(W2, { by_gsm: null }), mr(W3)];
  const rows = ok(normalizeRtsw(wind, mag, null)).rows;
  assert.deepEqual(rows[0], { ts: T("2026-09-28T18:51:00Z"), speed: null, density: null, temperature: null, bx: null, by: 2, bz: -1, bt: null, newell: null });
  assert.equal(rows[1].speed, null);
  assert.equal(rows[1].density, null);
  assert.equal(rows[1].newell, null, "no speed and no by");
  assert.equal(rows[2].density, 0, "density 0 is allowed");
  assert.ok(rows[2].newell !== null);
});

test("RTSW: a minute with every field null is dropped", () => {
  const wind = [wr(W1, { proton_speed: -9999, proton_density: -9999, proton_temperature: -9999 }), wr(W2)];
  const mag = [mr(W1, { bt: -9999, bx_gsm: -9999, by_gsm: -9999, bz_gsm: -9999 }), mr(W2)];
  const r = ok(normalizeRtsw(wind, mag, null));
  assert.deepEqual(r.rows.map((x) => x.ts), [T("2026-09-28T18:52:00Z")]);
  assert.equal(r.dataTs, T("2026-09-28T18:52:00Z"));
});

test("RTSW: one-sided minutes inside the horizon are emitted with nulls", () => {
  const r = ok(normalizeRtsw([wr(W1), wr(W3)], [mr(W2), mr(W3)], null));
  assert.equal(r.dataTs, T(W3 + "Z"));
  assert.equal(r.rows.length, 3);
  const [a, b, c] = r.rows;
  assert.deepEqual([a.speed, a.bx, a.by, a.bz, a.bt, a.newell], [400, null, null, null, null, null]);
  assert.deepEqual([b.speed, b.density, b.temperature, b.newell], [null, null, null, null]);
  assert.equal(b.bt, 6);
  assert.notEqual(c.speed, null);
  assert.notEqual(c.bz, null);
  assert.notEqual(c.newell, null);
});

test("RTSW: leading edge, a minute only one side has reached is held back until the other catches up", () => {
  // Poll 1: mag is a minute ahead. W2 is not emitted, so the caller's cursor stays at W1.
  const p1 = ok(normalizeRtsw([wr(W1)], [mr(W1), mr(W2)], null));
  assert.deepEqual(p1.rows.map((x) => x.ts), [T(W1 + "Z")]);
  assert.equal(p1.dataTs, T(W1 + "Z"));
  // Poll 2: wind catches up. W2 comes out complete.
  const p2 = ok(normalizeRtsw([wr(W1), wr(W2)], [mr(W1), mr(W2)], p1.dataTs));
  assert.equal(p2.rows.length, 1);
  assert.equal(p2.rows[0].ts, T(W2 + "Z"));
  assert.deepEqual([p2.rows[0].speed, p2.rows[0].bt], [400, 6]);
  assert.notEqual(p2.rows[0].newell, null);
  assert.equal(p2.dataTs, T(W2 + "Z"));
  // Wind ahead of mag is held back the same way.
  const p3 = ok(normalizeRtsw([wr(W1), wr(W2)], [mr(W1)], null));
  assert.deepEqual(p3.rows.map((x) => x.ts), [T(W1 + "Z")]);
});

test("RTSW: one payload with no active rows falls back to the other's newest ts", () => {
  const magOutage = ok(normalizeRtsw([wr(W1), wr(W2)], [], null));
  assert.deepEqual(magOutage.rows.map((x) => [x.ts, x.speed, x.bt]), [[T(W1 + "Z"), 400, null], [T(W2 + "Z"), 400, null]]);
  assert.equal(magOutage.dataTs, T(W2 + "Z"));
  const inactiveMag = ok(normalizeRtsw([wr(W1)], [mr(W1, { active: false })], null));
  assert.equal(inactiveMag.rows.length, 1);
  assert.equal(inactiveMag.dataTs, T(W1 + "Z"));
  const windOutage = ok(normalizeRtsw([], [mr(W1), mr(W2)], T(W1 + "Z")));
  assert.deepEqual(windOutage.rows.map((x) => x.ts), [T(W2 + "Z")]);
  assert.equal(windOutage.dataTs, T(W2 + "Z"));
  assert.deepEqual(ok(normalizeRtsw([], [], null)), { ok: true, rows: [], dataTs: null });
});

test("RTSW: newest-first input is returned ascending; after filters strictly; dataTs when nothing is new", () => {
  const wind = [wr(W3), wr(W2), wr(W1)];
  const mag = [mr(W3), mr(W2), mr(W1)];
  const all = ok(normalizeRtsw(wind, mag, null));
  assert.deepEqual(all.rows.map((x) => x.ts), [W1, W2, W3].map((s) => T(s + "Z")));
  assert.deepEqual(ok(normalizeRtsw(wind, mag, T(W2 + "Z"))).rows.map((x) => x.ts), [T(W3 + "Z")]);
  const none = ok(normalizeRtsw(wind, mag, T(W3 + "Z")));
  assert.deepEqual(none.rows, []);
  assert.equal(none.dataTs, T(W3 + "Z"));
  assert.deepEqual(ok(normalizeRtsw([], [], null)), { ok: true, rows: [], dataTs: null });
});

test("RTSW: changed shape in either payload gives ok:false", () => {
  const w = [wr(W1)];
  const m = [mr(W1)];
  const renamed = (row: Record<string, unknown>, from: string, to: string) => {
    const { [from]: v, ...rest } = row;
    return { ...rest, [to]: v };
  };
  const cases: Array<[string, unknown, unknown]> = [
    ["wind object", { rows: w }, m],
    ["mag object", w, { rows: m }],
    ["wind null", null, m],
    ["wind renamed speed", [renamed(w[0], "proton_speed", "speed")], m],
    ["mag renamed bz", w, [renamed(m[0], "bz_gsm", "bz")]],
    ["mag no active flag", w, [renamed(m[0], "active", "is_active")]],
    ["wind bad time", [wr("not a time")], m],
    ["wind string value", [wr(W1, { proton_speed: "400" })], m],
  ];
  for (const [name, wind, mag] of cases) {
    const r = normalizeRtsw(wind, mag, null);
    assert.equal(r.ok, false, name);
    assert.ok(!r.ok && r.error.length > 0 && r.error.length < 200, name);
  }
});

test("RTSW: a few bad rows among good ones are skipped", () => {
  const wind = [wr(W3), wr(W2), wr(W1), null, wr("bad")];
  const r = ok(normalizeRtsw(wind, [mr(W3), mr(W2), mr(W1)], null));
  assert.equal(r.rows.length, 3);
});
