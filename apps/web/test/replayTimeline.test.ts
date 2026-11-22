import { test } from "node:test";
import assert from "node:assert/strict";
import type { Cme, Flare } from "@cme/shared";
import { REPLAY_SPAN_S } from "../src/lib/historyRange.ts";
import {
  cmeEruptAt, cmeMarks, dayMarks, flareTicks, formatReplayTime, fracOf, parseReplayParam, replaySpan, stepForKey, timeAtFrac,
} from "../src/lib/replayTime.ts";

const NOW = 1_790_000_100; // not on a 5-minute boundary
const RANGE = replaySpan(NOW);

function flare(id: string, cls: string, beginAt: number): Flare {
  return { id, beginAt, peakAt: null, endAt: null, cls, peakFlux: 1e-5, status: "rising", regionNo: null, lat: null, lon: null };
}

test("the track spans the 7 days ending at server now", () => {
  assert.deepEqual(RANGE, [NOW - REPLAY_SPAN_S, NOW]);
  assert.equal(fracOf(RANGE[0], RANGE), 0);
  assert.equal(fracOf(NOW, RANGE), 1);
  assert.equal(fracOf(NOW - REPLAY_SPAN_S / 2, RANGE), 0.5);
  assert.equal(fracOf(NOW + 999, RANGE), 1, "clamped");
  assert.equal(fracOf(0, RANGE), 0, "clamped");
});

test("a position on the track → a time snapped to 5 min, inside the span", () => {
  const t = timeAtFrac(0.5, RANGE);
  assert.equal(t % 300, 0);
  assert.ok(Math.abs(t - (NOW - REPLAY_SPAN_S / 2)) <= 150);
  assert.equal(timeAtFrac(1, RANGE), NOW, "the end is now, never snapped past it");
  assert.equal(timeAtFrac(1.4, RANGE), NOW);
  assert.equal(timeAtFrac(-0.2, RANGE), timeAtFrac(0, RANGE));
  assert.ok(timeAtFrac(0, RANGE) >= RANGE[0]);
  // round trip: within half a step
  for (const f of [0.1, 0.33, 0.77]) assert.ok(Math.abs(fracOf(timeAtFrac(f, RANGE), RANGE) - f) * REPLAY_SPAN_S <= 150);
});

test("keys: ← → 5 min on the 5-min grid, Shift 1 h, PgUp/PgDn 6 h, Home/End; others ignored", () => {
  const t = NOW - 86_400 + 120; // off the grid
  assert.equal(stepForKey("ArrowRight", false, t, RANGE), Math.floor(t / 300) * 300 + 300);
  assert.equal(stepForKey("ArrowLeft", false, t, RANGE), Math.floor(t / 300) * 300);
  const on = NOW - 86_400 - 86_400 % 300;
  assert.equal(stepForKey("ArrowLeft", false, on, RANGE), on - 300);
  assert.equal(stepForKey("ArrowRight", true, on, RANGE)! % 3600, 0);
  assert.equal(stepForKey("ArrowLeft", true, on - (on % 3600), RANGE), on - (on % 3600) - 3600);
  assert.equal(stepForKey("PageUp", false, on, RANGE), on + 6 * 3600);
  assert.equal(stepForKey("PageDown", false, on, RANGE), on - 6 * 3600);
  assert.equal(stepForKey("Home", false, t, RANGE), RANGE[0]);
  assert.equal(stepForKey("End", false, t, RANGE), NOW);
  assert.equal(stepForKey("ArrowRight", true, NOW - 10, RANGE), NOW, "clamped to the end");
  assert.equal(stepForKey("ArrowLeft", false, RANGE[0], RANGE), RANGE[0], "clamped to the start");
  assert.equal(stepForKey("a", false, t, RANGE), null);
});

test("flare ticks: only C, M and X in the span, sized by class, bigger ones drawn last", () => {
  const ticks = flareTicks(
    [
      flare("x", "X1.2", NOW - 3600),
      flare("b", "B5.0", NOW - 3600),
      flare("m", "M3.1", NOW - 7200),
      flare("c", "C2.0", NOW - 10_800),
      flare("old", "M1.0", NOW - REPLAY_SPAN_S - 60),
    ],
    RANGE,
  );
  assert.deepEqual(ticks.map((k) => k.id), ["c", "m", "x"]);
  assert.deepEqual(ticks.map((k) => k.letter), ["C", "M", "X"]);
  assert.ok(ticks[0].size < ticks[1].size && ticks[1].size < ticks[2].size);
  assert.equal(ticks[2].frac, fracOf(NOW - 3600, RANGE));
  assert.match(ticks[2].label, /^X1\.2 flare /);
});

test("CME markers sit where each CME left the Sun", () => {
  const c: Cme = { id: "c", launchAt: NOW - 86_400, speed: 800, lat: 0, lon: 0, halfAngle: 30, earthDirected: true, flareId: null, forecast: null };
  const out = cmeMarks([c, { ...c, id: "future", launchAt: NOW + 86_400 }], RANGE);
  assert.equal(out.length, 1);
  assert.equal(out[0].frac, fracOf(cmeEruptAt(c), RANGE));
  assert.ok(out[0].earthDirected);
});

test("?t=: unix seconds or an ISO date, clamped to the span; missing or junk → now − 6 h", () => {
  assert.equal(parseReplayParam(null, NOW), NOW - 6 * 3600);
  assert.equal(parseReplayParam("", NOW), NOW - 6 * 3600);
  assert.equal(parseReplayParam("tomorrow", NOW), NOW - 6 * 3600);
  assert.equal(parseReplayParam("-5", NOW), NOW - 6 * 3600, "not a plain number");
  assert.equal(parseReplayParam(String(NOW - 1000), NOW), NOW - 1000);
  assert.equal(parseReplayParam(String(NOW - 1000.7), NOW), NOW - 1001);
  assert.equal(parseReplayParam("1", NOW), NOW - REPLAY_SPAN_S, "too old: the start of the span");
  assert.equal(parseReplayParam(String(NOW + 9999), NOW), NOW, "future: now");
  const iso = new Date((NOW - 7200) * 1000).toISOString();
  assert.equal(parseReplayParam(iso, NOW), Math.floor(NOW - 7200));
});

test("readable times for the slider and the badge; day lines at 00:00 UTC", () => {
  assert.equal(formatReplayTime(Date.UTC(2026, 10, 21, 14, 35, 59) / 1000), "Sat 21 Nov 2026, 14:35 UTC");
  const days = dayMarks(RANGE);
  assert.ok(days.length === 7 || days.length === 8);
  for (const d of days) {
    assert.equal(d.t % 86_400, 0);
    assert.ok(d.frac >= 0 && d.frac <= 1);
  }
});
