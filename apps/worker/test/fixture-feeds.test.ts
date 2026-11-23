import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startFixtureFeeds, type FixtureFeeds } from "../scripts/fixture-feeds.ts";

const PATHS = [
  "/json/goes/primary/xrays-6-hour.json",
  "/json/goes/primary/xrays-7-day.json",
  "/json/rtsw/rtsw_wind_1m.json",
  "/json/rtsw/rtsw_mag_1m.json",
];
const MIN = 60_000;
const ts = (s: string) => Date.parse(/Z$/.test(s) ? s : `${s}Z`);

describe("fixture feeds", () => {
  let f: FixtureFeeds;
  let clock = Date.parse("2026-11-22T10:00:30Z");
  const url = (p: string) => `http://127.0.0.1:${f.port}${p}`;
  const get = async (p: string) => {
    const r = await fetch(url(p));
    return { r, body: (await r.json()) as { time_tag: string }[] };
  };
  const newest = (rows: { time_tag: string }[]) => Math.max(...rows.map((r) => ts(r.time_tag)));

  before(async () => {
    f = await startFixtureFeeds({ port: 0, now: () => clock, log: () => {} });
  });
  after(() => f.close());

  it("newest visible row is about now - 60 s for every path", async () => {
    for (const p of PATHS) {
      const { body } = await get(p);
      const lag = clock - newest(body);
      assert.ok(lag >= 60_000 && lag < 60_000 + MIN, `${p} lag ${lag}`);
    }
  });

  it("a new row appears when the clock advances a minute, and the ETag changes", async () => {
    for (const p of PATHS) {
      const a = await get(p);
      clock += MIN;
      const b = await get(p);
      assert.equal(newest(b.body) - newest(a.body), MIN, p);
      assert.notEqual(a.r.headers.get("etag"), b.r.headers.get("etag"));
    }
  });

  it("answers 304 to a matching If-None-Match", async () => {
    for (const p of PATHS) {
      const etag = (await get(p)).r.headers.get("etag")!;
      assert.match(etag, /^"[0-9a-f]+"$/);
      const r = await fetch(url(p), { headers: { "if-none-match": etag } });
      assert.equal(r.status, 304);
      assert.equal(r.headers.get("etag"), etag);
    }
  });

  it("preserves time_tag style, order and the 6-hour window", async () => {
    const x6 = (await get(PATHS[0])).body;
    const x7 = (await get(PATHS[1])).body;
    assert.ok(x6.every((r) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(r.time_tag)));
    assert.ok(x6.length < x7.length);
    assert.ok(newest(x6) - Math.min(...x6.map((r) => ts(r.time_tag))) <= 6 * 60 * MIN);
    assert.ok(x7.every((r, i) => i === 0 || ts(r.time_tag) >= ts(x7[i - 1].time_tag)), "xrays ascending");
    for (const p of PATHS.slice(2)) {
      const rows = (await get(p)).body;
      assert.ok(rows.every((r) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(r.time_tag)), `${p} has no Z`);
      assert.ok(rows.every((r, i) => i === 0 || ts(r.time_tag) <= ts(rows[i - 1].time_tag)), `${p} newest first`);
    }
  });

  it("404s unknown paths", async () => {
    assert.equal((await fetch(url("/json/nope.json"))).status, 404);
  });
});
