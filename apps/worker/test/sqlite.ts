/**
 * Test helper: node:sqlite behind the same `Sql` interface as the Durable Object's ctx.storage.sql,
 * plus a BEGIN/COMMIT `Transaction`.
 */
import { DatabaseSync } from "node:sqlite";
import type { Sql, SqlCursor, SqlValue, Transaction } from "../src/types.ts";

export interface TestDb {
  sql: Sql;
  tx: Transaction;
  db: DatabaseSync;
}

export function openTestDb(path = ":memory:"): TestDb {
  const db = new DatabaseSync(path);
  const sql: Sql = {
    exec<T>(query: string, ...bindings: SqlValue[]): SqlCursor<T> {
      // DO SqlStorage.exec accepts several ;-separated statements when there are no bindings.
      if (bindings.length === 0 && !/^\s*(select|with|pragma)\b/i.test(query)) {
        db.exec(query);
        return cursor<T>([]);
      }
      const stmt = db.prepare(query);
      const args = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b));
      if (/^\s*(select|with|pragma)\b/i.test(query) || /\breturning\b/i.test(query)) {
        return cursor<T>(stmt.all(...args) as T[]);
      }
      stmt.run(...args);
      return cursor<T>([]);
    },
  };
  const tx: Transaction = (fn) => {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  return { sql, tx, db };
}

function cursor<T>(rows: T[]): SqlCursor<T> {
  return {
    toArray: () => rows,
    one: () => {
      if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
      return rows[0];
    },
  };
}
