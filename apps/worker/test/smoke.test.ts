import { test } from "node:test";
import assert from "node:assert/strict";
import { openTestDb } from "./sqlite.ts";
import { ACTIVE_FEEDS } from "../src/feeds/defs.ts";

test("test db adapter: exec, bindings, one(), transaction rollback", () => {
  const { sql, tx } = openTestDb();
  sql.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)");
  sql.exec("INSERT INTO t VALUES (?, ?)", "a", 1);
  assert.equal(sql.exec<{ v: number }>("SELECT v FROM t WHERE k = ?", "a").one().v, 1);
  assert.throws(() => tx(() => { sql.exec("INSERT INTO t VALUES (?, ?)", "b", 2); throw new Error("boom"); }));
  assert.equal(sql.exec("SELECT * FROM t").toArray().length, 1);
});

test("active feeds build URLs from the base", () => {
  assert.deepEqual(ACTIVE_FEEDS.map((f) => f.id), ["goes_xray", "rtsw"]);
  assert.ok(ACTIVE_FEEDS.every((f) => f.urls("http://x").every((u) => u.startsWith("http://x/json/"))));
});
