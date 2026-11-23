/**
 * Committing one tick (backend design §5.2, GAP R3, S1, UC9).
 *
 * Order in the hub: build a PendingTick → commitTick (SQLite, one transaction) → memory.apply(p) →
 * deltaRing.push(...messages) → broadcast each `str`. Memory is only touched after the transaction
 * succeeded, so a failed commit leaves memory, SQLite and seq exactly as they were.
 */
import type { Alert, Delta, FeedStatus, Unix } from "@cme/shared";
import type { FeedState, Sql, Transaction, WindRow, XrayRow } from "../types.ts";
import { writeMeta } from "../db/migrate.ts";
import { saveFeedState, upsertAlert, upsertWind, upsertXray } from "../db/rows.ts";
import { sequenced, type Sequenced } from "./deltaRing.ts";
import { windSeriesFromRows, xraySeriesFromRows } from "./series.ts";

/** How long samples are kept, in SQLite and in the memory rings. */
export const SAMPLE_RETENTION_S = 7 * 86_400;
/** Cleared alerts are deleted this long after they cleared (§4.4); active alerts are never pruned. */
export const ALERT_RETENTION_S = 30 * 86_400;

export interface PendingTick {
  /** New X-ray rows, ascending, all newer than what memory holds. */
  xray: XrayRow[];
  /** New wind rows, ascending, all newer than what memory holds. */
  wind: WindRow[];
  /** Feed states to persist (every feed whose stored state should change, including lastOkAt-only bumps). */
  feeds: FeedState[];
  /** Only the FeedStatuses that visibly changed (feedStatusChanged), i.e. what clients must be told. */
  feedStatuses: FeedStatus[];
  /** Alerts whose stored row changed and that clients must get in `delta.alerts` (e.g. a cleared TEST alert). */
  alerts?: Alert[];
}

export const emptyTick = (): PendingTick => ({ xray: [], wind: [], feeds: [], feedStatuses: [] });

/**
 * Nothing for clients: no new rows and no visible feed change. Such a tick takes no seq and sends nothing
 * (GAP S1), e.g. a round of 304s that only bumped lastOkAt.
 */
export function isEmpty(p: PendingTick): boolean {
  return p.xray.length === 0 && p.wind.length === 0 && p.feedStatuses.length === 0 && !p.alerts?.length;
}

/**
 * Something must be written to SQLite. True whenever !isEmpty(p), and also for a tick that is empty for
 * clients but carries feed states (new ETag, lastOkAt, failCount). Such a tick is written without a seq.
 * To stay inside the write budget (§4, ~300 feed-status writes/day) the hub may leave lastOkAt-only changes
 * out of `p.feeds` and persist them less often; correctness doesn't depend on lastOkAt being durable.
 */
export function needsWrite(p: PendingTick): boolean {
  return !isEmpty(p) || p.feeds.length > 0;
}

/** The client-visible part of a tick. Empty keys are omitted. */
export function toDelta(p: PendingTick): Delta {
  const d: Delta = {};
  if (p.xray.length) d.xray = xraySeriesFromRows(p.xray);
  if (p.wind.length) d.wind = windSeriesFromRows(p.wind);
  if (p.feedStatuses.length) d.feeds = p.feedStatuses;
  if (p.alerts?.length) d.alerts = p.alerts;
  return d;
}

export interface CommitResult {
  /** The seq after this tick: prevSeq + 1 when a delta was produced, else prevSeq. */
  seq: number;
  /** The sequenced messages to log and broadcast, each serialised once. Empty when isEmpty(p). */
  messages: Sequenced[];
}

/**
 * Writes the tick in ONE transaction: sample rows, feed states and, if clients get a delta, meta.seq.
 * If the transaction throws, nothing is written, the error propagates and the caller keeps prevSeq — so a
 * crash can never reuse a seq for different content (GAP R3).
 *
 * - !needsWrite(p): no-op, returns { seq: prevSeq, messages: [] }.
 * - isEmpty(p) but feed states to save: saves them, no seq, no messages.
 * - otherwise: seq = prevSeq + 1 and one `delta` message stamped `now`.
 */
export function commitTick(sql: Sql, tx: Transaction, prevSeq: number, p: PendingTick, now: Unix): CommitResult {
  if (!needsWrite(p)) return { seq: prevSeq, messages: [] };
  const visible = !isEmpty(p);
  const seq = visible ? prevSeq + 1 : prevSeq;
  tx(() => {
    upsertXray(sql, p.xray);
    upsertWind(sql, p.wind);
    for (const s of p.feeds) saveFeedState(sql, s);
    for (const a of p.alerts ?? []) upsertAlert(sql, a);
    if (visible) writeMeta(sql, "seq", String(seq));
  });
  if (!visible) return { seq, messages: [] };
  return { seq, messages: [sequenced({ type: "delta", seq, ts: now, data: toDelta(p) })] };
}

/**
 * Deletes X-ray and wind samples older than SAMPLE_RETENTION_S (UC9), each statement removing at most
 * `batch` rows, until none are left. Returns the number of rows deleted. Run about once an hour.
 */
export function pruneSamples(sql: Sql, now: Unix, batch = 1000): number {
  const cutoff = now - SAMPLE_RETENTION_S;
  let total = 0;
  for (const table of ["xray_sample", "wind_sample"] as const) {
    for (;;) {
      const n = sql.exec<{ ts: number }>(
        `DELETE FROM ${table} WHERE ts IN (SELECT ts FROM ${table} WHERE ts < ? ORDER BY ts LIMIT ?) RETURNING ts`,
        cutoff, batch,
      ).toArray().length;
      total += n;
      if (n < batch) break;
    }
  }
  return total;
}

/**
 * Deletes alerts cleared more than ALERT_RETENTION_S ago (§4.4), at most `batch` rows per statement, until none
 * are left. Returns the number of rows deleted. Run with pruneSamples, about once an hour.
 */
export function pruneClearedAlerts(sql: Sql, now: Unix, batch = 1000): number {
  const cutoff = now - ALERT_RETENTION_S;
  let total = 0;
  for (;;) {
    const n = sql.exec<{ id: string }>(
      `DELETE FROM alert WHERE id IN (SELECT id FROM alert WHERE cleared_at IS NOT NULL AND cleared_at < ? LIMIT ?)
       RETURNING id`,
      cutoff, batch,
    ).toArray().length;
    total += n;
    if (n < batch) break;
  }
  return total;
}
