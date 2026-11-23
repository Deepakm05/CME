/**
 * Shared shapes between the Worker's modules. Everything except hub.ts and index.ts is plain TypeScript that
 * takes its inputs (now, sql, fetch) as arguments, so it runs under `tsx --test` without the Workers runtime.
 * Keep this file free of Workers-only globals.
 */
import type { FeedDef, FeedId, Unix } from "@cme/shared";

// ---- SQLite ------------------------------------------------------------------

export type SqlValue = string | number | null | ArrayBuffer;

/**
 * The subset of the Durable Object `SqlStorage` the modules use. Tests adapt node:sqlite to it
 * (test/sqlite.ts), so the same code runs in both places.
 */
export interface Sql {
  exec<T extends Record<string, SqlValue> = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T>;
}
export interface SqlCursor<T> {
  toArray(): T[];
  one(): T; // throws if there isn't exactly one row
}

/** Runs `fn` atomically: DO `ctx.storage.transactionSync`, or BEGIN/COMMIT in tests. */
export type Transaction = <T>(fn: () => T) => T;

// ---- Normalised upstream rows ---------------------------------------------------

/** One minute of GOES X-ray flux (table `xray_sample`). */
export interface XrayRow {
  ts: Unix;
  long: number | null; // 0.1-0.8 nm, W/m^2
  short: number | null; // 0.05-0.4 nm, W/m^2
  satellite: number | null;
}

/** One minute of solar wind at L1: RTSW wind + mag joined on ts (table `wind_sample`). */
export interface WindRow {
  ts: Unix;
  speed: number | null;
  density: number | null;
  temperature: number | null;
  bx: number | null;
  by: number | null;
  bz: number | null;
  bt: number | null;
  newell: number | null;
}

/**
 * Result of a normaliser. `rows` are ascending by ts and strictly newer than the `after` it was given.
 * `ok: false` means the payload's shape is wrong: the feed is marked `error` and keeps its last good data (R2).
 */
export type Normalized<T> =
  | { ok: true; rows: T[]; dataTs: Unix | null } // dataTs = newest ts in the payload (even if not newer)
  | { ok: false; error: string };

// ---- Polling -------------------------------------------------------------------

export type PollResult =
  | { kind: "unchanged" } // HTTP 304
  | { kind: "data"; etag: string | null; body: unknown };

/** How the Worker fetches each feed. URLs are built from env.FEED_BASE so CI can use a fixture server. */
export interface WorkerFeed extends FeedDef {
  /** Every URL this feed needs per poll (RTSW needs wind + mag). */
  urls(base: string): string[];
  /** Poll every 5 s during the fast window (:55 to :20 past each minute) instead of every cadenceS. */
  fastWindow: boolean;
}

/** A feed's runtime state. Persisted in `feed_status` except `nextAt`, which is memory only. */
export interface FeedState {
  id: FeedId;
  /** ETag per URL. Stored as JSON in feed_status.etag. */
  etags: Record<string, string>;
  lastOkAt: Unix | null; // last successful poll (200 or 304)
  dataTs: Unix | null; // newest data time seen
  error: string | null; // last error, already redacted (X4)
  failCount: number; // consecutive failures, drives backoff (R1)
  nextAt: Unix; // when to poll next
}
