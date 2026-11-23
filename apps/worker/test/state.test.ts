import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLiveState, serverMessageSchema, STATE_WINDOW_S, type FeedStatus } from "@cme/shared";
import { openTestDb } from "./sqlite.ts";
import type { FeedState, Transaction, WindRow, XrayRow } from "../src/types.ts";
import { ACTIVE_FEEDS, GOES_XRAY, RTSW } from "../src/feeds/defs.ts";
import { migrate, readSeq } from "../src/db/migrate.ts";
import { loadFeedStates, loadWindSince, loadXraySince, upsertWind, upsertXray } from "../src/db/rows.ts";
import { SeriesRing, windRing, windSeries, windSeriesFromRows, xrayRing, xraySeries } from "../src/state/series.ts";
import { DeltaRing, sequenced, type Sequenced } from "../src/state/deltaRing.ts";
import { Memory, feedStatusChanged, toFeedStatus } from "../src/state/memory.ts";
import {
  commitTick, emptyTick, isEmpty, needsWrite, pruneSamples, SAMPLE_RETENTION_S, toDelta, type PendingTick,
} from "../src/state/commit.ts";

const T0 = 1_790_000_040; // a whole minute

const xr = (ts: number, long: number | null = 1e-6): XrayRow => ({ ts, long, short: long === null ? null : long / 100, satellite: 18 });
const wr = (ts: number, bz: number | null = -3): WindRow => ({
  ts, speed: 420, density: 5, temperature: 1e5, bx: 1, by: 2, bz, bt: 6, newell: bz === null ? null : 1234.5,
});

// ---- series ring --------------------------------------------------------------------------------------------

test("series ring: appends in order and ignores rows not newer than the last", () => {
  const r = new SeriesRing(["a", "b"] as const, 5);
  assert.equal(r.lastTs(), null);
  assert.equal(r.append([{ ts: 60, a: 1, b: null }, { ts: 120, a: 2, b: 20 }]), 2);
  assert.equal(r.append([{ ts: 120, a: 99, b: 99 }, { ts: 90, a: 99, b: 99 }, { ts: 180, a: 3, b: 30 }]), 1);
  assert.equal(r.size, 3);
  assert.equal(r.lastTs(), 180);
  assert.deepEqual(r.range(0, 1e12), { t: [60, 120, 180], cols: { a: [1, 2, 3], b: [null, 20, 30] } });
});

test("series ring: wraps around at capacity, dropping the oldest", () => {
  const r = new SeriesRing(["v"] as const, 3);
  for (let i = 1; i <= 7; i++) r.append([{ ts: i * 60, v: i }]);
  assert.equal(r.size, 3);
  assert.equal(r.firstTs(), 300);
  assert.deepEqual(r.range(0, 1e12), { t: [300, 360, 420], cols: { v: [5, 6, 7] } });
  // One batch larger than the ring keeps only the newest rows.
  r.append(Array.from({ length: 5 }, (_, i) => ({ ts: 480 + i * 60, v: 100 + i })));
  assert.deepEqual(r.range(0, 1e12).cols.v, [102, 103, 104]);
});

test("series ring: range is inclusive and works across the wrap point", () => {
  const r = new SeriesRing(["v"] as const, 4);
  for (let i = 1; i <= 6; i++) r.append([{ ts: i * 60, v: i }]); // holds 180..360, physically wrapped
  assert.deepEqual(r.range(240, 300).t, [240, 300]);
  assert.deepEqual(r.range(200, 330).t, [240, 300]);
  assert.deepEqual(r.range(0, 179).t, []);
  assert.deepEqual(r.range(361, 999).t, []);
  assert.deepEqual(r.range(360, 360).cols.v, [6]);
});

test("series ring: null ⇄ NaN, and xray/wind helpers produce the shared shapes", () => {
  const x = xrayRing();
  x.append([xr(T0), xr(T0 + 60, null)]);
  assert.deepEqual(xraySeries(x, T0, T0 + 60), { t: [T0, T0 + 60], long: [1e-6, null], short: [1e-8, null] });
  const w = windRing();
  assert.equal(w.capacity, 10_080);
  w.append([wr(T0), wr(T0 + 60, null)]);
  const s = windSeries(w, T0, T0 + 60);
  assert.deepEqual(s, windSeriesFromRows([wr(T0), wr(T0 + 60, null)]));
  assert.deepEqual(s.bz, [-3, null]);
  assert.deepEqual(Object.keys(s).sort(), ["bt", "bx", "by", "bz", "density", "newell", "speed", "t", "temperature"]);
});

// ---- delta ring -----------------------------------------------------------------------------------------------

const delta = (seq: number, ts: number): Sequenced => sequenced({ type: "delta", seq, ts, data: { xray: { t: [ts], long: [1], short: [null] } } });

test("delta ring: since() for covered, current, ahead-of and too-old seqs", () => {
  const ring = new DeltaRing(10);
  assert.deepEqual(ring.since(10), [], "up to date, empty ring");
  assert.equal(ring.since(9), null, "empty ring cannot cover older seqs (after a restart)");
  assert.equal(ring.since(11), null, "ahead of the server");
  ring.push(delta(11, T0), delta(12, T0 + 60));
  ring.push(delta(13, T0 + 120));
  assert.equal(ring.newestSeq, 13);
  assert.deepEqual(ring.since(13), []);
  assert.deepEqual(ring.since(10)!.map((e) => e.msg.seq), [11, 12, 13]);
  assert.deepEqual(ring.since(12)!.map((e) => e.msg.seq), [13]);
  assert.equal(ring.since(9), null, "older than the ring");
  assert.equal(ring.since(14), null);
  assert.equal(ring.since(-1), null);
  assert.equal(ring.since(11.5), null);
});

test("delta ring: str is serialised once and the same string is handed out every time", () => {
  const ring = new DeltaRing(0);
  const e = delta(1, T0);
  ring.push(e);
  const a = ring.since(0)!;
  const b = ring.since(0)!;
  assert.equal(a[0], e);
  assert.equal(a[0].str, b[0].str);
  assert.equal(a[0].str, JSON.stringify(e.msg));
});

test("delta ring: messages age out after maxAgeS and over maxCount; gaps reset; reused seqs throw", () => {
  const ring = new DeltaRing(0, { maxAgeS: 3600, maxCount: 3 });
  ring.push(delta(1, T0), delta(2, T0 + 60));
  ring.push(delta(3, T0 + 3700)); // 1 and 2 are now over an hour old
  assert.equal(ring.oldestSeq, 3);
  assert.equal(ring.since(1), null);
  assert.deepEqual(ring.since(2)!.map((e) => e.msg.seq), [3]);
  ring.push(delta(4, T0 + 3701), delta(5, T0 + 3702), delta(6, T0 + 3703));
  assert.equal(ring.size, 3);
  assert.equal(ring.since(2), null);
  assert.deepEqual(ring.since(3)!.map((e) => e.msg.seq), [4, 5, 6]);
  ring.push(delta(9, T0 + 3800)); // a gap: 7, 8 were never logged
  assert.equal(ring.since(6), null);
  assert.deepEqual(ring.since(8)!.map((e) => e.msg.seq), [9]);
  assert.throws(() => ring.push(delta(9, T0 + 3900)), /not after/);
  ring.prune(T0 + 3800 + 3601);
  assert.equal(ring.size, 0);
  assert.deepEqual(ring.since(9), []);
});

// ---- feeds and S1 ---------------------------------------------------------------------------------------------

const feedState = (over: Partial<FeedState> = {}): FeedState => ({
  id: "goes_xray", etags: {}, lastOkAt: T0, dataTs: T0, error: null, failCount: 0, nextAt: T0 + 60, ...over,
});

test("toFeedStatus: stale when there is no data or it is older than staleAfterS", () => {
  assert.equal(toFeedStatus(GOES_XRAY, feedState({ dataTs: null }), T0).stale, true);
  assert.equal(toFeedStatus(GOES_XRAY, feedState(), T0 + GOES_XRAY.staleAfterS).stale, false);
  assert.equal(toFeedStatus(GOES_XRAY, feedState(), T0 + GOES_XRAY.staleAfterS + 1).stale, true);
  const s = toFeedStatus(RTSW, feedState({ id: "rtsw", error: "timeout" }), T0);
  assert.deepEqual(s, {
    id: "rtsw", label: RTSW.label, cadenceS: 60, staleAfterS: 300, lastOkAt: T0, dataTs: T0, error: "timeout", stale: false,
  });
});

test("S1: a tick of 304s that only bumps lastOkAt is empty (no seq, no delta) but still saves feed state", () => {
  const before = toFeedStatus(GOES_XRAY, feedState(), T0);
  const after = toFeedStatus(GOES_XRAY, feedState({ lastOkAt: T0 + 60 }), T0 + 60);
  assert.equal(feedStatusChanged(before, after), false);
  assert.equal(feedStatusChanged(before, { ...before, error: "HTTP 500" }), true);
  assert.equal(feedStatusChanged(before, { ...before, stale: true }), true);
  assert.equal(feedStatusChanged(before, { ...before, dataTs: T0 + 60 }), true);

  const p: PendingTick = { ...emptyTick(), feeds: [feedState({ lastOkAt: T0 + 60 })] };
  assert.equal(isEmpty(p), true);
  assert.equal(needsWrite(p), true);
  assert.deepEqual(toDelta(p), {});
  assert.equal(needsWrite(emptyTick()), false);

  const { sql, tx } = openTestDb();
  migrate(sql);
  const r = commitTick(sql, tx, 7, p, T0 + 60);
  assert.deepEqual(r, { seq: 7, messages: [] });
  assert.equal(readSeq(sql), 0, "no seq written");
  assert.equal(loadFeedStates(sql, T0).get("goes_xray")?.lastOkAt, T0 + 60);
  assert.deepEqual(commitTick(sql, tx, 7, emptyTick(), T0 + 60), { seq: 7, messages: [] });
});

test("toDelta omits empty keys", () => {
  assert.deepEqual(Object.keys(toDelta({ ...emptyTick(), wind: [wr(T0)] })), ["wind"]);
  const fs = toFeedStatus(GOES_XRAY, feedState(), T0);
  assert.deepEqual(toDelta({ ...emptyTick(), xray: [xr(T0)], feedStatuses: [fs] }), {
    xray: { t: [T0], long: [1e-6], short: [1e-8] },
    feeds: [fs],
  });
});

// ---- commit, restart, R3 -------------------------------------------------------------------------------------

/** Builds a tick the way the hub would: new rows + feed states, statuses only if visibly changed. */
function tick(mem: Memory, now: number, xray: XrayRow[], wind: WindRow[]): PendingTick {
  const feeds: FeedState[] = [];
  const feedStatuses: FeedStatus[] = [];
  for (const [def, rows] of [[GOES_XRAY, xray], [RTSW, wind]] as const) {
    const prev = mem.feedState(def.id, now);
    const last = rows.length ? rows[rows.length - 1].ts : prev.dataTs;
    const next: FeedState = { ...prev, lastOkAt: now, dataTs: last, etags: { [def.urls("http://x")[0]]: `"${now}"` }, nextAt: now + 60 };
    feeds.push(next);
    const a = toFeedStatus(def, prev, now);
    const b = toFeedStatus(def, next, now);
    if (feedStatusChanged(a, b)) feedStatuses.push(b);
  }
  return { xray, wind, feeds, feedStatuses };
}

test("R3: seq survives a restart and continues; memory rebuilt from SQLite matches; messages are valid", () => {
  const path = join(tmpdir(), `cme-state-${process.pid}-${Date.now()}.sqlite`);
  try {
    const a = openTestDb(path);
    migrate(a.sql);
    const mem = Memory.rebuild(a.sql, T0, ACTIVE_FEEDS);
    const ring = new DeltaRing(readSeq(a.sql));
    let seq = readSeq(a.sql);
    assert.equal(seq, 0);
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      const now = T0 + i * 60 + 5;
      const p = tick(mem, now, [xr(T0 + i * 60, 1e-6 * (i + 1))], i === 2 ? [] : [wr(T0 + i * 60)]);
      assert.equal(isEmpty(p), false);
      const r = commitTick(a.sql, a.tx, seq, p, now);
      assert.equal(r.seq, seq + 1);
      assert.equal(r.messages.length, 1);
      for (const m of r.messages) {
        assert.ok(serverMessageSchema.safeParse(JSON.parse(m.str)).success, m.str);
        assert.equal(m.str, JSON.stringify(m.msg));
      }
      mem.apply(p);
      ring.push(...r.messages);
      seq = r.seq;
      seen.push(seq);
    }
    assert.deepEqual(seen, [1, 2, 3, 4, 5]);
    assert.deepEqual(ring.since(2)!.map((e) => e.msg.seq), [3, 4, 5]);
    const now = T0 + 5 * 60;
    const live = mem.liveState(seq, now);
    const checked = checkLiveState(live);
    assert.ok(checked.ok, checked.ok ? "" : checked.error);
    assert.equal(live.xray.t.length, 5);
    assert.equal(live.wind.t.length, 4);
    assert.deepEqual(live.feeds.map((f) => f.id), ["goes_xray", "rtsw"]);
    a.db.close();

    // "Restart": a new connection and a rebuilt Memory.
    const b = openTestDb(path);
    migrate(b.sql);
    const seq2 = readSeq(b.sql);
    assert.equal(seq2, 5);
    const mem2 = Memory.rebuild(b.sql, now, ACTIVE_FEEDS);
    assert.deepEqual(mem2.liveState(seq2, now), live);
    assert.equal(mem2.feeds.get("goes_xray")?.nextAt, now, "nextAt is not persisted: due at once");
    assert.deepEqual(mem2.feeds.get("goes_xray")?.etags, mem.feeds.get("goes_xray")?.etags);
    const ring2 = new DeltaRing(seq2);
    assert.equal(ring2.since(3), null, "ring is empty after restart: snapshot");
    assert.deepEqual(ring2.since(5), []);
    const r = commitTick(b.sql, b.tx, seq2, tick(mem2, now + 60, [xr(T0 + 300)], []), now + 60);
    assert.equal(r.seq, 6, "seq continues, never repeats");
    b.db.close();
  } finally {
    rmSync(path, { force: true });
  }
});

test("R3: a tick whose transaction throws leaves seq, rows and memory unchanged", () => {
  const { sql, tx } = openTestDb();
  migrate(sql);
  const mem = Memory.rebuild(sql, T0, ACTIVE_FEEDS);
  const first = tick(mem, T0, [xr(T0)], [wr(T0)]);
  const ok = commitTick(sql, tx, 0, first, T0);
  assert.equal(ok.seq, 1);
  mem.apply(first);
  const crashAtCommit: Transaction = (fn) => tx(() => {
    fn();
    throw new Error("crash before commit");
  });
  const p = tick(mem, T0 + 60, [xr(T0 + 60)], [wr(T0 + 60)]);
  // The hub applies memory only after commitTick returns, so a throw leaves memory alone too.
  assert.throws(() => commitTick(sql, crashAtCommit, ok.seq, p, T0 + 60), /crash/);
  assert.equal(readSeq(sql), 1);
  assert.equal(loadXraySince(sql, 0).length, 1);
  assert.equal(loadWindSince(sql, 0).length, 1);
  assert.deepEqual([...loadFeedStates(sql, T0).values()].map((s) => s.lastOkAt), [T0, T0], "feed states rolled back");
  assert.equal(mem.xray.lastTs(), T0);
  // The same seq is then used for the retried (identical) content only.
  const retry = commitTick(sql, tx, ok.seq, p, T0 + 60);
  assert.equal(retry.seq, 2);
  assert.equal(readSeq(sql), 2);
});

// ---- memory ---------------------------------------------------------------------------------------------------

test("liveState: window, defaults for unpolled feeds, schema-valid; stateJson cached per seq", () => {
  const { sql } = openTestDb();
  migrate(sql);
  const now = T0 + STATE_WINDOW_S + 600;
  upsertXray(sql, [xr(T0 - 60), xr(T0), xr(now - 60), xr(now)]);
  upsertWind(sql, [wr(now - SAMPLE_RETENTION_S - 60), wr(now - 120)]);
  const mem = Memory.rebuild(sql, now, ACTIVE_FEEDS);
  assert.equal(mem.xray.size, 4);
  assert.equal(mem.wind.size, 1, "rebuild loads only the last 7 days");
  const live = mem.liveState(3, now);
  assert.ok(checkLiveState(live).ok);
  assert.deepEqual(live.xray.t, [now - 60, now]);
  assert.deepEqual(live.clock, { now, speed: 1, mode: "live", scenario: null });
  assert.deepEqual([live.regions, live.flares, live.cmes, live.alerts], [[], [], [], []]);
  assert.ok(live.feeds.every((f) => f.stale && f.dataTs === null && f.lastOkAt === null));
  assert.equal(mem.feeds.get("rtsw")?.nextAt, now);

  const s1 = mem.stateJson(3, now);
  assert.deepEqual(JSON.parse(s1), live);
  mem.apply({ ...emptyTick(), xray: [xr(now + 60)] });
  assert.equal(mem.stateJson(3, now + 60), s1, "same seq: cached string");
  const s2 = mem.stateJson(4, now + 60);
  assert.notEqual(s2, s1);
  assert.equal(JSON.parse(s2).xray.t.at(-1), now + 60);
});

test("pruneSamples deletes samples older than 7 days in batches", () => {
  const { sql } = openTestDb();
  migrate(sql);
  const now = T0 + SAMPLE_RETENTION_S;
  const old = Array.from({ length: 25 }, (_, i) => T0 - 3600 + i * 60);
  upsertXray(sql, [...old.map((ts) => xr(ts)), xr(T0), xr(now)]);
  upsertWind(sql, [...old.slice(0, 7).map((ts) => wr(ts)), wr(now)]);
  assert.equal(pruneSamples(sql, now, 10), 32);
  assert.deepEqual(loadXraySince(sql, 0).map((r) => r.ts), [T0, now], "exactly 7 days old is kept");
  assert.deepEqual(loadWindSince(sql, 0).map((r) => r.ts), [now]);
  assert.equal(pruneSamples(sql, now), 0);
});
