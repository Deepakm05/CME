/** Poll scheduling (backend design §5.1, GAP R1): fast window, backoff, due feeds, alarm wake time. Pure; `now` is unix seconds. */
import type { FeedId } from "@cme/shared";
import type { FeedState, WorkerFeed } from "../types.ts";
import { redact } from "../obs/log.ts";

export const FAST_INTERVAL_S = 5;
export const MAX_BACKOFF_S = 300;

const secOfMinute = (now: number) => ((Math.floor(now) % 60) + 60) % 60;

/** NOAA publishes each minute just after :00, so poll fast from :55 to :20. */
export function isFastWindow(now: number): boolean {
  const s = secOfMinute(now);
  return s >= 55 || s <= 20;
}

export function backoffS(cadenceS: number, failCount: number): number {
  return Math.min(cadenceS * 2 ** failCount, MAX_BACKOFF_S);
}

export function nextPollAt(feed: WorkerFeed, now: number, failCount: number): number {
  if (failCount > 0) return now + backoffS(feed.cadenceS, failCount);
  if (!feed.fastWindow) return now + feed.cadenceS;
  if (isFastWindow(now + FAST_INTERVAL_S)) return now + FAST_INTERVAL_S;
  const sec = secOfMinute(now);
  const nextFastStart = now - sec + (sec < 55 ? 55 : 115);
  return Math.min(now + feed.cadenceS, nextFastStart);
}

export function dueFeeds(feeds: readonly WorkerFeed[], states: Map<FeedId, FeedState>, now: number): WorkerFeed[] {
  return feeds.filter((f) => {
    const st = states.get(f.id);
    return st === undefined || st.nextAt <= now;
  });
}

/** The alarm also drives pings, so wake at least every 5 s and at most 1 s from now. */
export function nextWakeAt(states: Map<FeedId, FeedState>, now: number): number {
  let min = Infinity;
  for (const st of states.values()) min = Math.min(min, st.nextAt);
  return Math.min(Math.max(min, now + 1), now + 5);
}

export type PollOutcome =
  | { kind: "unchanged" }
  | { kind: "ok"; dataTs: number | null; etags?: Record<string, string> }
  | { kind: "error"; error: string };

export function afterPoll(feed: WorkerFeed, state: FeedState, now: number, outcome: PollOutcome): FeedState {
  if (outcome.kind === "error") {
    const failCount = state.failCount + 1;
    return { ...state, failCount, error: redact(outcome.error), nextAt: nextPollAt(feed, now, failCount) };
  }
  const ok: FeedState = { ...state, failCount: 0, error: null, lastOkAt: now, nextAt: nextPollAt(feed, now, 0) };
  if (outcome.kind === "unchanged") return ok;
  const dataTs =
    outcome.dataTs === null ? state.dataTs : state.dataTs === null ? outcome.dataTs : Math.max(state.dataTs, outcome.dataTs);
  return { ...ok, dataTs, etags: outcome.etags ? { ...state.etags, ...outcome.etags } : state.etags };
}
