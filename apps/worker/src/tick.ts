/**
 * Pieces of one alarm tick (backend design §5.2) that don't need the hub's state: polling the due feeds in
 * parallel, normalising what came back, and deciding which feed states are worth a SQLite write.
 * Pure TypeScript; `fetchFn` and `now` are arguments so tests drive it with fixtures.
 */
import type { FeedId } from "@cme/shared";
import type { FeedState, WindRow, WorkerFeed, XrayRow } from "./types.ts";
import { BACKFILL_URLS } from "./feeds/defs.ts";
import { normalizeGoesXray } from "./feeds/goes.ts";
import { normalizeRtsw } from "./feeds/rtsw.ts";
import { BACKFILL_MAX_BYTES, pollFeed, type FeedPoll, type PollOpts } from "./feeds/poll.ts";
import { redact } from "./obs/log.ts";

/** What one feed's poll produced, before normalising. */
export interface FeedFetch {
  feed: WorkerFeed;
  backfill: boolean;
  ms: number;
  result: { ok: true; poll: FeedPoll } | { ok: false; error: string };
}

const errorText = (e: unknown) => redact(e instanceof Error ? e.message : String(e));

/** The feed with its URLs swapped for the one-off backfill URLs (PLAN Phase 1), when there are any. */
function backfillFeed(feed: WorkerFeed): WorkerFeed | null {
  const urls = (BACKFILL_URLS as Partial<Record<FeedId, (base: string) => string[]>>)[feed.id];
  return urls ? { ...feed, urls } : null;
}

/**
 * Polls every feed in `due` in parallel. One feed's failure (timeout, HTTP error, bad JSON, even a thrown
 * bug) never affects another's result [R1]. A backfill poll uses the backfill URLs, no ETags (so a stale
 * validator can't turn it into a 304) and the larger BACKFILL_MAX_BYTES body cap.
 */
export async function fetchDue(
  due: readonly WorkerFeed[],
  states: ReadonlyMap<FeedId, FeedState>,
  base: string,
  backfill: ReadonlySet<FeedId>,
  opts: PollOpts,
): Promise<FeedFetch[]> {
  const settled = await Promise.allSettled(
    due.map(async (feed): Promise<FeedFetch> => {
      const t0 = Date.now();
      const bf = backfill.has(feed.id) ? backfillFeed(feed) : null;
      const st = states.get(feed.id);
      if (!st) throw new Error(`no state for ${feed.id}`);
      try {
        const poll = bf
          ? await pollFeed(bf, base, { ...st, etags: {} }, { ...opts, maxBytes: BACKFILL_MAX_BYTES })
          : await pollFeed(feed, base, st, opts);
        return { feed, backfill: bf !== null, ms: Date.now() - t0, result: { ok: true, poll } };
      } catch (e) {
        return { feed, backfill: bf !== null, ms: Date.now() - t0, result: { ok: false, error: errorText(e) } };
      }
    }),
  );
  return settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { feed: due[i]!, backfill: false, ms: 0, result: { ok: false, error: errorText(s.reason) } },
  );
}

export type Normalised =
  | { ok: true; xray: XrayRow[]; wind: WindRow[]; dataTs: number | null }
  | { ok: false; error: string };

/** Normalises one feed's bodies; only rows newer than `after` (the ring's last ts) are returned. Never throws. */
export function normaliseFeed(id: FeedId, bodies: unknown[], after: { xray: number | null; wind: number | null }): Normalised {
  try {
    if (id === "goes_xray") {
      const n = normalizeGoesXray(bodies[0], after.xray);
      return n.ok ? { ok: true, xray: n.rows, wind: [], dataTs: n.dataTs } : n;
    }
    if (id === "rtsw") {
      const n = normalizeRtsw(bodies[0], bodies[1], after.wind);
      return n.ok ? { ok: true, xray: [], wind: n.rows, dataTs: n.dataTs } : n;
    }
    return { ok: false, error: `${id}: no normaliser in this phase` };
  } catch (e) {
    return { ok: false, error: `${id}: normaliser failed: ${errorText(e)}` };
  }
}

/** Keeps only the ETags of URLs the feed normally polls (drops backfill-only URLs and URLs no longer used). */
export function keepFeedEtags(feed: WorkerFeed, base: string, etags: Record<string, string>): Record<string, string> {
  const urls = new Set(feed.urls(base));
  return Object.fromEntries(Object.entries(etags).filter(([u]) => urls.has(u)));
}

/**
 * feed_status write policy (backend design §4: ~300 feed-status writes a day).
 *
 * A feed's row is written when what it records about failures changes (error or failCount), when the feed
 * gets its first data, or when the stored lastOkAt is FEED_PERSIST_EVERY_S old. A new dataTs or ETag alone
 * (once a minute per feed) is NOT written: the samples written in the same tick already record the data,
 * dataTs is recovered from the rings on start, and a lost ETag only costs one full fetch after a restart.
 * Normal day: 2 feeds × 144 = 288 writes; an outage adds one per failed poll (backoff caps that at 288/day).
 */
export const FEED_PERSIST_EVERY_S = 600;

export function mustPersist(stored: FeedState | undefined, next: FeedState): boolean {
  if (!stored) return true;
  if (next.error !== stored.error || next.failCount !== stored.failCount) return true;
  if (stored.dataTs === null && next.dataTs !== null) return true;
  if (next.lastOkAt === null) return false;
  return stored.lastOkAt === null || next.lastOkAt - stored.lastOkAt >= FEED_PERSIST_EVERY_S;
}

/** One feed's entry in the per-tick log line (§9). */
export interface FeedLog {
  st: 200 | 304 | "err";
  ms: number;
  rows?: number;
  backfill?: true;
  error?: string;
}
