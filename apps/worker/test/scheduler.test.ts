import { test } from "node:test";
import assert from "node:assert/strict";
import type { FeedId } from "@cme/shared";
import {
  MAX_BACKOFF_S, afterPoll, backoffS, dueFeeds, isFastWindow, nextPollAt, nextWakeAt,
} from "../src/feeds/scheduler.ts";
import { GOES_XRAY, RTSW } from "../src/feeds/defs.ts";
import type { FeedState, WorkerFeed } from "../src/types.ts";

const M = 1_700_000_040; // second 0 of a minute
assert.equal(M % 60, 0);

const st = (id: FeedId, over: Partial<FeedState> = {}): FeedState => ({
  id, etags: {}, lastOkAt: null, dataTs: null, error: null, failCount: 0, nextAt: 0, ...over,
});
const slow: WorkerFeed = { ...GOES_XRAY, cadenceS: 600, fastWindow: false };

test("fast window boundaries", () => {
  assert.equal(isFastWindow(M + 54), false);
  assert.equal(isFastWindow(M + 55), true);
  assert.equal(isFastWindow(M + 59), true);
  assert.equal(isFastWindow(M), true);
  assert.equal(isFastWindow(M + 20), true);
  assert.equal(isFastWindow(M + 21), false);
});

test("backoff grows and caps at 300 s", () => {
  assert.equal(backoffS(60, 0), 60);
  assert.equal(backoffS(60, 1), 120);
  assert.equal(backoffS(60, 2), 240);
  assert.equal(backoffS(60, 3), MAX_BACKOFF_S);
  assert.equal(backoffS(60, 50), MAX_BACKOFF_S);
});

test("nextPollAt", () => {
  // inside / entering the fast window: every 5 s
  assert.equal(nextPollAt(GOES_XRAY, M + 56, 0), M + 61);
  assert.equal(nextPollAt(GOES_XRAY, M + 54, 0), M + 59);
  assert.equal(nextPollAt(GOES_XRAY, M + 10, 0), M + 15);
  // leaving the window: wait for :55
  assert.equal(nextPollAt(GOES_XRAY, M + 20, 0), M + 55);
  assert.equal(nextPollAt(GOES_XRAY, M + 30, 0), M + 55);
  assert.equal(nextPollAt(GOES_XRAY, M + 21, 0), M + 55);
  // failures use backoff, even in the fast window
  assert.equal(nextPollAt(GOES_XRAY, M + 56, 1), M + 56 + 120);
  // non-fast feeds use cadence
  assert.equal(nextPollAt(slow, M + 30, 0), M + 30 + 600);
  // cadence shorter than distance to next window
  assert.equal(nextPollAt({ ...GOES_XRAY, cadenceS: 10 }, M + 30, 0), M + 40);
});

test("dueFeeds", () => {
  const states = new Map<FeedId, FeedState>([
    ["goes_xray", st("goes_xray", { nextAt: 100 })],
    ["rtsw", st("rtsw", { nextAt: 101 })],
  ]);
  assert.deepEqual(dueFeeds([GOES_XRAY, RTSW], states, 100).map((f) => f.id), ["goes_xray"]);
  assert.deepEqual(dueFeeds([GOES_XRAY, RTSW], states, 101).map((f) => f.id), ["goes_xray", "rtsw"]);
  assert.equal(dueFeeds([GOES_XRAY, RTSW], states, 99).length, 0);
});

test("nextWakeAt clamps to [now+1, now+5]", () => {
  const mk = (n: number) => new Map<FeedId, FeedState>([["rtsw", st("rtsw", { nextAt: n })]]);
  assert.equal(nextWakeAt(mk(50), 100), 101);
  assert.equal(nextWakeAt(mk(103), 100), 103);
  assert.equal(nextWakeAt(mk(500), 100), 105);
  assert.equal(nextWakeAt(new Map(), 100), 105);
});

test("afterPoll transitions", () => {
  const now = M + 30;
  const base = st("goes_xray", { dataTs: 500, lastOkAt: 1, failCount: 2, error: "old", etags: { a: "1" } });
  const ok = afterPoll(GOES_XRAY, base, now, { kind: "ok", dataTs: 400, etags: { b: "2" } });
  assert.deepEqual(ok, { ...base, failCount: 0, error: null, lastOkAt: now, dataTs: 500, etags: { a: "1", b: "2" }, nextAt: M + 55 });
  assert.equal(afterPoll(GOES_XRAY, base, now, { kind: "ok", dataTs: 600 }).dataTs, 600);
  assert.equal(afterPoll(GOES_XRAY, st("goes_xray"), now, { kind: "ok", dataTs: null }).dataTs, null);

  const un = afterPoll(GOES_XRAY, base, now, { kind: "unchanged" });
  assert.equal(un.failCount, 0);
  assert.equal(un.error, null);
  assert.equal(un.lastOkAt, now);
  assert.equal(un.dataTs, 500);

  const e1 = afterPoll(GOES_XRAY, st("goes_xray", { dataTs: 7, lastOkAt: 9 }), now, { kind: "error", error: "HTTP 500 https://x/y?api_key=Z" });
  assert.equal(e1.failCount, 1);
  assert.equal(e1.error, "HTTP 500 https://x/y");
  assert.equal(e1.dataTs, 7);
  assert.equal(e1.lastOkAt, 9);
  assert.equal(e1.nextAt, now + 120);
  const e2 = afterPoll(GOES_XRAY, e1, now, { kind: "error", error: "x" });
  assert.equal(e2.nextAt, now + 240);
});
