/**
 * Replay data layer: snapping (C1), history parsing (F2) and loadHistory against the in-process mock.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { emptyWind, emptyXray, type HistoryResponse } from "@cme/shared";
import { startMockServer } from "../../mock/src/server.ts";
import { loadFixtures } from "../../mock/src/fixtures.ts";
import { REPLAY_AFTER_S, REPLAY_BEFORE_S, REPLAY_SPAN_S, RES_S, replayWindow, snapDown, snapUp } from "../src/lib/historyRange.ts";
import { parseHistoryBody, parseHistoryText, SERIES_COLUMNS, transferablesOf } from "../src/lib/historyParse.ts";
import { createHistory, parseOffThread } from "../src/store/history.ts";
import { WIND_KEYS, XRAY_KEYS } from "../src/store/live.ts";

// ---- snapping ---------------------------------------------------------------

test("snapDown / snapUp: aligned values stay, others move to the bucket edge", () => {
  assert.deepEqual(RES_S, { "1m": 60, "5m": 300 });
  assert.equal(snapDown(600, "5m"), 600);
  assert.equal(snapUp(600, "5m"), 600);
  assert.equal(snapDown(899, "5m"), 600);
  assert.equal(snapUp(601, "5m"), 900);
  assert.equal(snapDown(119, "1m"), 60);
  assert.equal(snapUp(61, "1m"), 120);
  // fractional seconds
  assert.equal(snapDown(600.9, "5m"), 600);
  assert.equal(snapUp(600.1, "5m"), 900);
  // the epoch and negatives; never -0
  assert.ok(Object.is(snapDown(0, "5m"), 0));
  assert.ok(Object.is(snapUp(-0.5, "5m"), 0));
  assert.equal(snapDown(-1, "5m"), -300);
  assert.equal(snapUp(-301, "5m"), -300);
  // realistic timestamp
  const t = 1_700_000_123;
  assert.equal(snapDown(t, "5m") % 300, 0);
  assert.equal(snapUp(t, "5m") % 300, 0);
  assert.ok(snapDown(t, "5m") <= t && t <= snapUp(t, "5m"));
});

test("replayWindow: [t - 6 h, t + 1 h] snapped outward to 5 minutes", () => {
  assert.equal(REPLAY_BEFORE_S, 21_600);
  assert.equal(REPLAY_AFTER_S, 3_600);
  assert.equal(REPLAY_SPAN_S, 604_800);

  const aligned = replayWindow(1_700_000_100); // 1_700_000_100 is a multiple of 300
  assert.deepEqual(aligned, { from: 1_700_000_100 - 21_600, to: 1_700_000_100 + 3_600, res: "5m" });

  const t = 1_700_000_123;
  const w = replayWindow(t);
  assert.equal(w.res, "5m");
  assert.equal(w.from % 300, 0);
  assert.equal(w.to % 300, 0);
  assert.ok(w.from <= t - REPLAY_BEFORE_S && t - REPLAY_BEFORE_S - w.from < 300, "from is the 5 min edge at or below");
  assert.ok(w.to >= t + REPLAY_AFTER_S && w.to - (t + REPLAY_AFTER_S) < 300, "to is the 5 min edge at or above");
});

// ---- parsing ----------------------------------------------------------------

function xrayBody(over: Partial<HistoryResponse> = {}): HistoryResponse {
  return { series: "xray", res: "5m", from: 0, to: 600, data: { t: [0, 300, 600], long: [1e-6, null, 3e-6], short: [1e-7, 2e-7, 3e-7] }, ...over };
}

test("parse: a valid body becomes Float64Array columns, null becomes NaN", () => {
  const p = parseHistoryText(JSON.stringify(xrayBody()));
  assert.equal(p.series, "xray");
  assert.equal(p.res, "5m");
  assert.deepEqual([p.from, p.to], [0, 600]);
  assert.deepEqual(Object.keys(p.cols).sort(), ["long", "short", "t"]);
  for (const c of Object.values(p.cols)) assert.ok(c instanceof Float64Array);
  assert.deepEqual([...p.cols.t], [0, 300, 600]);
  assert.equal(p.cols.long[0], 1e-6);
  assert.ok(Number.isNaN(p.cols.long[1]));
  assert.equal(transferablesOf(p).length, 3);
});

test("parse: a wind body carries every wind column", () => {
  const data = emptyWind();
  data.t.push(0, 300);
  for (const k of WIND_KEYS) data[k].push(1, null);
  const p = parseHistoryBody({ series: "wind", res: "5m", from: 0, to: 300, data });
  assert.deepEqual(Object.keys(p.cols).sort(), ["t", ...WIND_KEYS].sort());
  assert.ok(Number.isNaN(p.cols.bz[1]));
});

test("parse: column lists match the store's keys", () => {
  assert.deepEqual([...SERIES_COLUMNS.xray], [...XRAY_KEYS]);
  assert.deepEqual([...SERIES_COLUMNS.wind], [...WIND_KEYS]);
});

test("parse: malformed bodies are rejected with a message", () => {
  assert.throws(() => parseHistoryText("{not json"), /not valid JSON/);
  assert.throws(() => parseHistoryText("null"), /history:/);
  assert.throws(() => parseHistoryBody({ ...xrayBody(), res: "10m" }), /res/);
  assert.throws(() => parseHistoryBody({ ...xrayBody(), series: "plasma" }), /series/);
  assert.throws(() => parseHistoryBody({ ...xrayBody(), from: "0" }), /from/);
  // columns of different length
  assert.throws(
    () => parseHistoryBody(xrayBody({ data: { t: [0, 300], long: [1], short: [1, 2] } })),
    /history:/,
  );
  // time going backwards
  assert.throws(
    () => parseHistoryBody(xrayBody({ data: { t: [300, 0], long: [1, 2], short: [1, 2] } })),
    /backwards/,
  );
  // a non-finite number (JSON cannot carry NaN, so a string stands in)
  assert.throws(() => parseHistoryBody(xrayBody({ data: { t: [0], long: ["x" as unknown as number], short: [1] } })), /history:/);
  // wind columns under the xray name
  const wind = emptyWind();
  assert.throws(() => parseHistoryBody({ series: "xray", res: "5m", from: 0, to: 0, data: wind }), /no "long" column/);
  // xray columns under the wind name
  assert.throws(() => parseHistoryBody({ series: "wind", res: "5m", from: 0, to: 0, data: emptyXray() }), /no "speed" column/);
});

test("parseOffThread falls back to the main thread without Worker", async () => {
  assert.equal(typeof Worker, "undefined");
  const p = await parseOffThread(JSON.stringify(xrayBody()));
  assert.equal(p.cols.t.length, 3);
  await assert.rejects(parseOffThread("oops"), /not valid JSON/);
});

// ---- loadHistory against the mock ---------------------------------------------

let mock: ReturnType<typeof startMockServer>;
let base: string;

before(async () => {
  mock = startMockServer({ port: 0, fixtures: loadFixtures(), speed: 1 });
  await new Promise((r) => mock.server.once("listening", r));
  base = `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}`;
});
after(() => mock.close());

/** A history controller whose requests are recorded and can be intercepted. */
function harness(intercept?: (url: URL, init: RequestInit | undefined) => Promise<Response | undefined> | Response | undefined) {
  const requests: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url);
    return (await intercept?.(url, init)) ?? fetch(input, init);
  }) as typeof fetch;
  const h = createHistory({ baseUrl: base, fetchImpl });
  const paths = () => requests.map((u) => u.pathname.replace("/api/v1", ""));
  return { ...h, requests, paths, state: () => h.store.getState() };
}

const simNow = () => Math.round(mock.engine.simNow());
const isHistory = (u: URL) => u.pathname.endsWith("/history");

test("loadHistory fills both series in time order, covers the window and loads events", async () => {
  const h = harness();
  const t = simNow() - 2 * 86_400;
  await h.load(t);
  const s = h.state();
  const win = replayWindow(t);

  assert.equal(s.status, "ready");
  assert.equal(s.error, null);
  assert.deepEqual(s.range, [win.from, win.to]);
  assert.equal(s.res, "5m");
  assert.equal(s.seriesRev, 1);

  // 7 h at 5 min is 84 intervals: 85 buckets, up to 86 when both edges were snapped outward
  assert.ok(s.xray.length >= 80 && s.xray.length <= 86, `xray rows: ${s.xray.length}`);
  assert.equal(s.wind.length, s.xray.length);
  for (const series of [s.xray, s.wind]) {
    const v = series.view();
    assert.ok(series.firstT! >= win.from && series.lastT! <= win.to);
    for (let i = 1; i < v.t.length; i++) assert.equal(v.t[i] - v.t[i - 1], 300, "5 min steps, ascending");
  }
  assert.ok(s.xray.view().long.every(Number.isFinite));
  assert.ok(s.wind.view().speed.every((x) => x > 0));

  assert.ok(Array.isArray(s.flares) && Array.isArray(s.cmes) && Array.isArray(s.alerts));
  assert.ok(s.flares.length > 0, "a week of the mock has flares");
  assert.ok(s.eventsSince !== null && s.eventsSince % 300 === 0);
  assert.ok(Math.abs(s.eventsSince! - (simNow() - REPLAY_SPAN_S)) < 600);

  // exactly: xray + wind + health (clock) + events, and the history queries are snapped
  assert.deepEqual(h.paths().sort(), ["/events", "/health", "/history", "/history"]);
  for (const u of h.requests.filter(isHistory)) {
    assert.equal(u.searchParams.get("res"), "5m");
    assert.equal(Number(u.searchParams.get("from")), win.from);
    assert.equal(Number(u.searchParams.get("to")), win.to);
  }
  assert.equal(Number(h.requests.find((u) => u.pathname.endsWith("/events"))!.searchParams.get("since")) % 300, 0);
});

test("a second load inside the loaded range makes no request; outside it reloads", async () => {
  const h = harness();
  // 120 s into a 5-min bucket, so t+540 and t+600 fall in the same bucket and snap to the same window.
  // (An unaligned t made this flaky: when a bucket edge fell between them, t+540 correctly needed a reload.)
  const t = snapDown(simNow() - 3 * 86_400, "5m") + 120;
  await h.load(t);
  const n = h.requests.length;
  const rev = h.state().seriesRev;

  await h.load(t); // same moment
  await h.load(t + 600); // window [t+600-6h, t+600+1h] extends past the loaded [.., t+1h]: not covered
  assert.ok(h.requests.length > n, "moving later than the loaded range loads again");
  const n2 = h.requests.length;
  const rev2 = h.state().seriesRev;
  assert.ok(rev2 > rev);

  await h.load(t + 600);
  await h.load(t + 600 - 60); // window is inside [snapped range]
  assert.equal(h.requests.length, n2, "no request for a window already covered");
  assert.equal(h.state().seriesRev, rev2);
  assert.equal(h.state().status, "ready");
});

test("events are refreshed after 5 minutes, even when the series are covered", async () => {
  let wall = 1_000_000;
  const requests: string[] = [];
  const h = createHistory({
    baseUrl: base,
    wallNow: () => wall,
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
      requests.push(new URL(String(input)).pathname);
      return fetch(input, init);
    }) as typeof fetch,
  });
  const t = simNow() - 86_400;
  await h.load(t);
  const eventsCalls = () => requests.filter((p) => p.endsWith("/events")).length;
  assert.equal(eventsCalls(), 1);
  wall += 4 * 60_000;
  await h.load(t);
  assert.equal(eventsCalls(), 1, "still fresh");
  wall += 2 * 60_000;
  const rev = h.store.getState().seriesRev;
  await h.load(t);
  assert.equal(eventsCalls(), 2, "stale: refreshed");
  assert.equal(h.store.getState().seriesRev, rev, "series untouched by an events refresh");
  assert.equal(requests.filter((p) => p.endsWith("/history")).length, 2);
});

test("a superseded load does not overwrite the newer one (older response arrives last, ignoring abort)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const t1 = simNow() - 5 * 86_400;
  const t2 = simNow() - 2 * 86_400;
  const w1 = replayWindow(t1);
  const h = harness(async (u) => {
    // hold the first load's history responses, and hand them back after the second load has finished
    if (isHistory(u) && Number(u.searchParams.get("from")) === w1.from) {
      const res = await fetch(u); // deliberately ignores the abort signal
      await gate;
      return res;
    }
    return undefined;
  });
  const a = h.load(t1);
  await new Promise((r) => setTimeout(r, 50));
  const b = h.load(t2);
  await b;
  const win2 = replayWindow(t2);
  assert.deepEqual(h.state().range, [win2.from, win2.to]);
  const lastT = h.state().xray.lastT;
  const rev = h.state().seriesRev;

  release();
  await a;
  const s = h.state();
  assert.deepEqual(s.range, [win2.from, win2.to], "range still the newer load's");
  assert.equal(s.xray.lastT, lastT);
  assert.equal(s.seriesRev, rev);
  assert.equal(s.status, "ready");
});

test("an aborted load applies nothing and goes back to the previous status", async () => {
  const h = harness();
  const ctrl = new AbortController();
  const p = h.load(simNow() - 86_400, { signal: ctrl.signal });
  ctrl.abort();
  await p;
  assert.equal(h.state().status, "idle");
  assert.equal(h.state().range, null);
  assert.equal(h.state().xray.length, 0);

  await h.load(simNow() - 86_400);
  const before = h.state();
  const ctrl2 = new AbortController();
  const p2 = h.load(simNow() - 4 * 86_400, { signal: ctrl2.signal });
  assert.equal(h.state().status, "loading");
  ctrl2.abort();
  await p2;
  assert.equal(h.state().status, "ready");
  assert.deepEqual(h.state().range, before.range);
  assert.equal(h.state().seriesRev, before.seriesRev);
});

test("an invalid response sets status error and keeps the old data", async () => {
  let corrupt = false;
  const h = harness(async (u) => {
    if (!corrupt || !isHistory(u)) return undefined;
    const body = (await (await fetch(u)).json()) as HistoryResponse;
    body.data.t.pop(); // columns shorter than t: violates the contract
    return Response.json(body);
  });
  await h.load(simNow() - 2 * 86_400);
  const good = h.state();
  const lastT = good.xray.lastT;
  const len = good.xray.length;

  corrupt = true;
  await h.load(simNow() - 5 * 86_400);
  const s = h.state();
  assert.equal(s.status, "error");
  assert.match(s.error ?? "", /history:/);
  assert.deepEqual(s.range, good.range);
  assert.equal(s.xray.lastT, lastT);
  assert.equal(s.xray.length, len);
  assert.equal(s.seriesRev, good.seriesRev);

  corrupt = false;
  await h.load(simNow() - 5 * 86_400);
  assert.equal(h.state().status, "ready", "recovers on the next load");
  assert.equal(h.state().error, null);
});

test("HTTP errors and invalid events are errors too, and series are not half applied", async () => {
  const h = harness((u) => (u.pathname.endsWith("/events") ? Response.json({ flares: [{ id: 1 }] }) : undefined));
  await h.load(simNow() - 86_400);
  assert.equal(h.state().status, "error");
  assert.match(h.state().error ?? "", /events:/);
  assert.equal(h.state().xray.length, 0, "history arrived but nothing is applied until all of it is valid");

  const h2 = harness((u) => (isHistory(u) ? new Response("nope", { status: 503, statusText: "Unavailable" }) : undefined));
  await h2.load(simNow() - 86_400);
  assert.equal(h2.state().status, "error");
  assert.match(h2.state().error ?? "", /503/);
});

test("reset returns to the empty state", async () => {
  const h = harness();
  await h.load(simNow() - 86_400);
  h.reset();
  const s = h.state();
  assert.equal(s.status, "idle");
  assert.equal(s.range, null);
  assert.equal(s.xray.length, 0);
  assert.equal(s.flares.length, 0);
  assert.equal(s.eventsSince, null);
  const n = h.requests.length;
  await h.load(simNow() - 86_400);
  assert.ok(h.requests.length > n, "loads again after a reset");
});
