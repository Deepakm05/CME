/**
 * The feeds the Worker polls (backend design §5.1). Cadence and staleness come from FEED_DEFS in
 * @cme/shared, so the mock and the Worker report the same FeedStatus.
 *
 * Phase 1 polls goes_xray and rtsw. goes_flares, regions and donki arrive in Phase 3; until then they
 * are not reported at all (rather than shown as permanently stale).
 */
import { FEED_DEFS, type FeedId } from "@cme/shared";
import type { WorkerFeed } from "../types.ts";

const def = (id: FeedId) => {
  const d = FEED_DEFS.find((f) => f.id === id);
  if (!d) throw new Error(`no FEED_DEFS entry for ${id}`);
  return d;
};

export const GOES_XRAY: WorkerFeed = {
  ...def("goes_xray"),
  urls: (base) => [`${base}/json/goes/primary/xrays-6-hour.json`],
  fastWindow: true,
};

export const RTSW: WorkerFeed = {
  ...def("rtsw"),
  urls: (base) => [`${base}/json/rtsw/rtsw_wind_1m.json`, `${base}/json/rtsw/rtsw_mag_1m.json`],
  fastWindow: true,
};

/** Feeds polled in this phase, in poll order. */
export const ACTIVE_FEEDS: readonly WorkerFeed[] = [GOES_XRAY, RTSW];

/** One-off backfill when the DB is empty (PLAN Phase 1). RTSW's 1-minute files only cover about a day. */
export const BACKFILL_URLS = {
  goes_xray: (base: string) => [`${base}/json/goes/primary/xrays-7-day.json`],
  rtsw: (base: string) => RTSW.urls(base),
} as const;
