import { test } from "node:test";
import assert from "node:assert/strict";
import { LagTracker, percentile, alarmLagS, healthStatus, LAG_WINDOW_S } from "../src/obs/metrics.ts";

test("percentile: nearest-rank on known data", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(hundred, 50), 50);
  assert.equal(percentile(hundred, 95), 95);
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(twenty, 50), 10);
  assert.equal(percentile(twenty, 95), 19);
  assert.equal(percentile([7], 95), 7);
});

test("percentile: rounds to 0.1", () => {
  assert.equal(percentile([1.04], 50), 1);
  assert.equal(percentile([1.06], 50), 1.1);
});

test("percentile: null when empty", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([], 95), null);
});

test("record clamps negative lag to 0 and subtracts cadence", () => {
  const t = new LagTracker();
  t.record("goes_xray", 1000, 900, 60); // lag 40
  t.record("rtsw", 1000, 1100, 60); // would be negative -> 0
  const [xray, rtsw] = t.lags(1000, ["goes_xray", "rtsw"]);
  assert.equal(xray.p50, 40);
  assert.equal(xray.p95, 40);
  assert.equal(rtsw.p50, 0);
  assert.equal(rtsw.p95, 0);
});

test("lags: p50 and p95 per feed", () => {
  const t = new LagTracker();
  for (let i = 1; i <= 20; i++) t.record("goes_xray", 1000 + i, 1000 + i - i, 0); // lag = i
  const [lag] = t.lags(1020, ["goes_xray"]);
  assert.equal(lag.p50, 10);
  assert.equal(lag.p95, 19);
});

test("lags: null for a feed with no samples", () => {
  const t = new LagTracker();
  assert.deepEqual(t.lags(1000, ["donki"]), [{ feed: "donki", p50: null, p95: null }]);
});

test("samples expire after one hour, by ingest time", () => {
  const t = new LagTracker();
  t.record("goes_xray", 0, 0, 0); // lag 0
  t.record("goes_xray", 100, 0, 0); // lag 100
  // At now = 3600 the sample at 0 is exactly one hour old: expired. The one at 100 remains.
  assert.deepEqual(t.lags(LAG_WINDOW_S, ["goes_xray"]), [{ feed: "goes_xray", p50: 100, p95: 100 }]);
  // Once everything is older than an hour there are no samples.
  assert.deepEqual(t.lags(100 + LAG_WINDOW_S, ["goes_xray"]), [{ feed: "goes_xray", p50: null, p95: null }]);
});

test("expiry also happens on record", () => {
  const t = new LagTracker();
  t.record("rtsw", 0, 0, 0); // lag 0
  t.record("rtsw", 5000, 4990, 0); // lag 10, and the first sample is pruned
  assert.deepEqual(t.lags(5000, ["rtsw"]), [{ feed: "rtsw", p50: 10, p95: 10 }]);
});

test("push p95 over the last hour, in ms", () => {
  const t = new LagTracker();
  assert.equal(t.pushP95(100), null);
  t.recordPush(120, 100);
  t.recordPush(80, 101);
  assert.equal(t.pushP95(101), 120);
  assert.equal(t.pushP95(100 + LAG_WINDOW_S + 1), null);
});

test("alarmLagS: seconds, clamped at 0, null when not scheduled", () => {
  assert.equal(alarmLagS(1000, 1500), 0.5);
  assert.equal(alarmLagS(2000, 1000), 0);
  assert.equal(alarmLagS(null, 1000), null);
});

test("healthStatus truth table", () => {
  const cases: [{ stale: boolean }[], number | null, string][] = [
    [[], null, "ok"],
    [[{ stale: false }, { stale: false }], null, "ok"],
    [[{ stale: false }], 30, "ok"],
    [[{ stale: false }], 30.1, "degraded"],
    [[{ stale: true }, { stale: false }], null, "degraded"],
    [[{ stale: true }, { stale: false }], 45, "degraded"],
    [[{ stale: true }], null, "down"],
    [[{ stale: true }, { stale: true }], 5, "down"],
    [[{ stale: true }, { stale: true }], 45, "down"],
    [[], 45, "degraded"],
  ];
  for (const [feeds, lag, want] of cases) {
    assert.equal(healthStatus(feeds, lag), want, `feeds=${JSON.stringify(feeds)} alarm=${lag}`);
  }
});
