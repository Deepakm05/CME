import { test } from "node:test";
import assert from "node:assert/strict";
import { DONKI_R0_KM } from "@cme/physics";
import type { Alert, Cme, Flare } from "@cme/shared";
import { CME_START_KM } from "../src/lib/cme.ts";
import { REPLAY_SPAN_S } from "../src/lib/historyRange.ts";
import { alertAt, cmeEruptAt, cmesAround, eventsAt, flareAt, replayTimeAt, valueAt } from "../src/lib/replayTime.ts";
import { sceneTime, setScrubTime } from "../src/lib/sceneClock.ts";
import { liveStore } from "../src/store/live.ts";
import { useUi } from "../src/store/ui.ts";

const NOW = 1_790_000_000; // server now
const WALL = 1_700_000_000; // wall clock when the clock was received (server time runs ahead in a mock)

function setClock(speed = 1) {
  liveStore.setState({ clock: { now: NOW, speed, mode: "live", scenario: null }, clockAt: WALL });
}

test("sceneTime: server time live, the replay time in replay, back to server time after exit", () => {
  setClock();
  useUi.getState().exitReplay();
  assert.equal(sceneTime(WALL + 10), NOW + 10, "live = server now");
  useUi.getState().enterReplay(NOW - 3600);
  const s = useUi.getState().timeSource;
  assert.equal(s.kind, "replay");
  assert.equal(s.kind === "replay" && s.playing, false, "starts paused");
  assert.equal(sceneTime(WALL + 10), NOW - 3600, "paused: stays put while the wall clock runs");
  assert.equal(sceneTime(WALL + 500), NOW - 3600);
  useUi.getState().exitReplay();
  assert.equal(sceneTime(WALL + 10), NOW + 10);
});

test("sceneTime while playing: t + elapsed × speed, kept inside the 7 days ending at server now", () => {
  setClock();
  useUi.setState({ timeSource: { kind: "replay", t: NOW - 7200, playing: true, speed: 600, at: WALL } });
  assert.equal(sceneTime(WALL), NOW - 7200);
  assert.equal(sceneTime(WALL + 5), NOW - 7200 + 3000, "5 s at 600× = 50 min");
  assert.equal(sceneTime(WALL + 60), NOW + 60, "clamped to server now (which has moved on 60 s)");
  assert.equal(sceneTime(WALL + 3600), NOW + 3600, "never past server now");
  useUi.setState({ timeSource: { kind: "replay", t: NOW - REPLAY_SPAN_S - 999, playing: false, speed: 60, at: WALL } });
  assert.equal(sceneTime(WALL), NOW - REPLAY_SPAN_S, "never before the span");
  useUi.getState().exitReplay();
});

test("speed of the server clock (a sped-up mock) moves the span end, not the replay rate", () => {
  setClock(10);
  useUi.setState({ timeSource: { kind: "replay", t: NOW - 86_400, playing: true, speed: 60, at: WALL } });
  assert.equal(sceneTime(WALL + 10), NOW - 86_400 + 600);
  useUi.getState().exitReplay();
});

test("actions: pause keeps the shown time, setSpeed carries on from it, play resumes; scrub overrides while dragging", () => {
  setClock();
  const ui = useUi.getState();
  ui.enterReplay(NOW - 5000);
  ui.play();
  let s = useUi.getState().timeSource;
  assert.ok(s.kind === "replay" && s.playing && s.t === NOW - 5000);
  ui.setSpeed(3600, NOW - 4000);
  s = useUi.getState().timeSource;
  assert.ok(s.kind === "replay" && s.speed === 3600 && s.t === NOW - 4000 && s.playing, "speed change restarts from the shown time");
  ui.pause(NOW - 3000);
  s = useUi.getState().timeSource;
  assert.ok(s.kind === "replay" && !s.playing && s.t === NOW - 3000);
  ui.setReplayTime(NOW - 100);
  s = useUi.getState().timeSource;
  assert.ok(s.kind === "replay" && s.t === NOW - 100 && s.speed === 3600, "jump keeps the speed");
  setScrubTime(NOW - 9999);
  assert.equal(sceneTime(WALL), NOW - 9999, "scrub wins while dragging");
  setScrubTime(null);
  assert.equal(sceneTime(WALL), NOW - 100);
  ui.exitReplay();
  setScrubTime(NOW - 9999);
  assert.equal(sceneTime(WALL), NOW, "scrub has no effect live");
  setScrubTime(null);
  // live: setReplayTime / play / pause do nothing
  ui.setReplayTime(NOW - 5);
  ui.play();
  assert.deepEqual(useUi.getState().timeSource, { kind: "live" });
});

test("replayTimeAt is pure: paused ignores the wall clock; negative elapsed doesn't run backwards", () => {
  const src = { kind: "replay" as const, t: NOW - 1000, playing: true, speed: 60, at: WALL };
  assert.equal(replayTimeAt(src, WALL - 50, NOW), NOW - 1000);
  assert.equal(replayTimeAt({ ...src, playing: false }, WALL + 50, NOW), NOW - 1000);
  assert.equal(replayTimeAt(src, WALL + 10, NOW), NOW - 400);
});

// ---- the event-at-time filter -----------------------------------------------------

const T = 1_789_000_000;
function flare(over: Partial<Flare> = {}): Flare {
  return {
    id: "f1", beginAt: T, peakAt: T + 600, endAt: T + 1800, cls: "M2.3", peakFlux: 2.3e-5, status: "ended",
    regionNo: 4100, lat: 10, lon: -20, ...over,
  };
}
function cme(over: Partial<Cme> = {}): Cme {
  return { id: "c1", launchAt: T, speed: 1000, lat: 0, lon: 0, halfAngle: 40, earthDirected: true, flareId: null, forecast: null, ...over };
}

test("a flare appears when it begins and is rising, then decaying, then ended, as it was at t", () => {
  const f = flare();
  assert.equal(flareAt(f, T - 1), null, "not begun");
  const rising = flareAt(f, T + 60)!;
  assert.equal(rising.status, "rising");
  assert.equal(rising.endAt, null, "no end yet at t");
  assert.equal(rising.peakAt, null, "no peak yet at t");
  const decaying = flareAt(f, T + 900)!;
  assert.equal(decaying.status, "decaying");
  assert.equal(decaying.peakAt, T + 600);
  assert.equal(decaying.endAt, null);
  assert.equal(flareAt(f, T + 1800), f, "ended: the record itself");
  assert.equal(f.status, "ended", "history is never mutated");
  const open = flare({ peakAt: null, endAt: null, status: "rising" });
  assert.equal(flareAt(open, T + 10), open, "still running at the end of history: unchanged");
});

test("a CME counts from when it left the Sun (front at 1.5 Rs), not from its 21.5 Rs time", () => {
  const c = cme();
  const erupt = T - (DONKI_R0_KM - CME_START_KM) / 1000;
  assert.equal(cmeEruptAt(c), erupt);
  assert.deepEqual(eventsAt({ flares: [], cmes: [c], alerts: [] }, erupt - 1).cmes, [], "launched after t: not shown");
  assert.deepEqual(eventsAt({ flares: [], cmes: [c], alerts: [] }, erupt).cmes, [c], "erupting at t");
  assert.deepEqual(eventsAt({ flares: [], cmes: [c], alerts: [] }, T + 3600).cmes, [c]);
});

test("eventsAt filters flares, CMEs and alerts to what had happened by t", () => {
  const ev = {
    flares: [flare({ id: "early", beginAt: T - 7200, peakAt: T - 7000, endAt: T - 6000 }), flare({ id: "later", beginAt: T + 60 })],
    // "new" is timed at 21.5 Rs a day later; it left the Sun ~4 h before that, still well after t
    cmes: [cme({ id: "old", launchAt: T - 86_400 }), cme({ id: "new", launchAt: T + 86_400 })],
    alerts: [
      { id: "a1", rule: "FLARE_M", level: "watch", title: "", message: "", refType: "flare", refId: "early", raisedAt: T - 7000, clearedAt: T + 99 },
      { id: "a2", rule: "FLARE_M", level: "watch", title: "", message: "", refType: "flare", refId: "later", raisedAt: T + 100, clearedAt: null },
    ] satisfies Alert[],
  };
  const at = eventsAt(ev, T);
  assert.deepEqual(at.flares.map((f) => f.id), ["early"]);
  assert.deepEqual(at.cmes.map((c) => c.id), ["old"]);
  assert.deepEqual(at.alerts.map((a) => [a.id, a.clearedAt]), [["a1", null]], "raised, not yet cleared at t");
  assert.equal(alertAt(ev.alerts[0], T + 200)!.clearedAt, T + 99);
});

test("replay mounts CMEs in flight at t or erupting soon, never ones long gone", () => {
  const inFlight = cme({ id: "in", launchAt: T - 3600 });
  const soon = cme({ id: "soon", launchAt: T + 5 * 3600 }); // leaves the Sun ~1 h after t
  const later = cme({ id: "later", launchAt: T + 86_400 });
  const gone = cme({ id: "gone", launchAt: T - 10 * 86_400 });
  assert.deepEqual(cmesAround([inFlight, soon, later, gone], T).map((c) => c.id), ["in", "soon"]);
});

test("valueAt: the newest finite value at or before t, not older than the limit", () => {
  const t = [0, 300, 600, 900];
  const v = [1, 2, NaN, 4];
  assert.equal(valueAt(t, v, 650), 2, "skips the missing point");
  assert.equal(valueAt(t, v, 900), 4);
  assert.equal(valueAt(t, v, 899), 2);
  assert.equal(valueAt(t, v, -1), null);
  assert.equal(valueAt(t, v, 5000), null, "too old");
  assert.equal(valueAt(t, v, 5000, 1e9), 4);
});
