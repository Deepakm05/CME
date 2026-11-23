/**
 * Schema setup and the `meta` key/value table (schema_v, seq, alarm_last_at).
 */
import type { Sql } from "../types.ts";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts";

/**
 * Creates every table and index (all `IF NOT EXISTS`, so running it again is a no-op) and records the
 * schema version. Call once when the Durable Object starts, before reading anything.
 * Throws if the database was written by a newer schema than this code knows (no silent downgrade).
 */
export function migrate(sql: Sql): void {
  sql.exec(SCHEMA_SQL);
  const v = readMeta(sql, "schema_v");
  if (v !== null && Number(v) > SCHEMA_VERSION) {
    throw new Error(`database schema_v ${v} is newer than this code (${SCHEMA_VERSION})`);
  }
  if (v === null || Number(v) !== SCHEMA_VERSION) writeMeta(sql, "schema_v", String(SCHEMA_VERSION));
}

export function readMeta(sql: Sql, key: string): string | null {
  const rows = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray();
  return rows.length ? rows[0].value : null;
}

export function writeMeta(sql: Sql, key: string, value: string): void {
  sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}

/** The last committed seq, 0 on a fresh database. */
export function readSeq(sql: Sql): number {
  const v = readMeta(sql, "seq");
  const n = v === null ? 0 : Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`meta.seq is corrupt: ${v}`);
  return n;
}
