import { test } from "node:test";
import assert from "node:assert/strict";
import { AU_KM } from "@cme/physics";
import type { Alert, Cme, EventsResponse, Flare } from "@cme/shared";
import {
  arrivalReplayHref, dbmSamples, eventHref, eventsPath, filterRows, flareWindow, historyPath, momentReplayHref,
  parseFilter, snapNow, toRows, withFilter,
} from "../src/events/model.ts";

const T = 1_800_000_000;
const flare = (id: string, cls: string, beginAt: number, over: Partial<Flare> = {}): Flare => ({
  id, beginAt, peakAt: beginAt + 600, endAt: beginAt + 1500, cls, peakFlux: 1e-5, status: "ended", regionNo: null, lat: null, lon: null, ...over,
});
const cme: Cme = { id: "c/1", launchAt: T + 50, speed: 1400, lat: 5, lon: 3, halfAngle: 60, earthDirected: true, flareId: null, forecast: { computedAt: T, eta: T + 200_000, arrivalSpeed: 700, gamma: 0.2e-7, w: 400 } };
const alert: Alert = { id: "a1", rule: "FLARE_X", level: "warning", title: "X flare", message: "m", refType: "flare", refId: "f1", raisedAt: T + 20, clearedAt: null };
const data: EventsResponse = { flares: [flare("f1", "M2.3", T), flare("f2", "C5.0", T + 100), flare("f3", "X1.1", T - 100)], cmes: [cme], alerts: [alert] };

test("rows are newest first across kinds", () => {
  assert.deepEqual(toRows(data).map((r) => r.id), ["f2", "c/1", "a1", "f1", "f3"]);
});

test("filters by kind and class; class filter keeps only flares of that class", () => {
  const rows = toRows(data);
  assert.deepEqual(filterRows(rows, { kind: "cme", cls: null }).map((r) => r.id), ["c/1"]);
  assert.deepEqual(filterRows(rows, { kind: null, cls: "M" }).map((r) => r.id), ["f1"]);
  assert.deepEqual(filterRows(rows, { kind: "flare", cls: null }).length, 3);
  assert.equal(filterRows(rows, { kind: "alert", cls: "X" }).length, 0);
  assert.equal(filterRows(rows, { kind: null, cls: null }).length, 5);
});

test("filter round-trips through the URL and ignores junk", () => {
  const q = withFilter(new URLSearchParams("keep=1"), { kind: "flare", cls: "X" });
  assert.equal(q.toString(), "keep=1&kind=flare&class=X");
  assert.deepEqual(parseFilter(q), { kind: "flare", cls: "X" });
  assert.deepEqual(parseFilter(new URLSearchParams("kind=bogus&class=z")), { kind: null, cls: null });
  assert.deepEqual(parseFilter(new URLSearchParams("class=m")), { kind: null, cls: "M" });
  assert.equal(withFilter(q, { kind: null, cls: null }).toString(), "keep=1");
});

test("replay links: 30 min before the event, 6 h before arrival, none without an ETA", () => {
  assert.equal(momentReplayHref(T), `/replay?t=${T - 1800}`);
  assert.equal(arrivalReplayHref(T), `/replay?t=${T - 6 * 3600}`);
  assert.equal(arrivalReplayHref(null), null);
  assert.equal(toRows(data).find((r) => r.id === "f1")!.replayHref, `/replay?t=${T - 1800}`);
});

test("ids are URL-encoded in links", () => {
  assert.equal(eventHref("cme", "c/1"), "/events/cme/c%2F1");
});

test("events request is the last 7 days; now snaps to whole minutes", () => {
  assert.equal(eventsPath(T), `/events?since=${T - 7 * 86400}`);
  assert.equal(snapNow(1_800_000_037.9), 1_800_000_000);
  assert.equal(snapNow(null, 125), 120);
});

test("flare window is begin − 1 h … end + 1 h, snapped outward to whole minutes", () => {
  const f = flare("f", "M1.0", T + 17, { endAt: T + 1517 });
  const w = flareWindow(f, T + 10 * 86400);
  assert.equal(w.from % 60, 0);
  assert.equal(w.to % 60, 0);
  assert.ok(w.from <= f.beginAt - 3600 && w.from > f.beginAt - 3600 - 60);
  assert.ok(w.to >= f.endAt! + 3600 && w.to < f.endAt! + 3600 + 60);
  assert.equal(historyPath(w.from, w.to), `/history?series=xray&res=1m&from=${w.from}&to=${w.to}`);
});

test("a flare still in progress is cut at now", () => {
  const f = flare("f", "M1.0", T, { endAt: null, peakAt: null });
  const w = flareWindow(f, T + 600);
  assert.ok(w.to <= T + 660);
  assert.ok(w.to > w.from);
});

test("DBM samples run from launch to past 1 AU and arrive at the forecast time", () => {
  const r = dbmSamples(cme, 100)!;
  assert.equal(r.samples.length, 101);
  assert.equal(r.samples[0].t, cme.launchAt);
  assert.ok(r.samples[0].km < AU_KM / 10);
  assert.ok(r.samples[100].km > AU_KM);
  assert.ok(r.arrivalAt > cme.launchAt);
  assert.ok(r.samples.every((s, i) => i === 0 || (s.t > r.samples[i - 1].t && s.km > r.samples[i - 1].km)));
  assert.ok(r.samples[100].speed < 1400 && r.samples[100].speed > 400);
});
