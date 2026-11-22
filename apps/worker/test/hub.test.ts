/**
 * The live loop wired end to end (HubCore + router), without the Workers runtime: node:sqlite for storage,
 * fake sockets, and the fixture NOAA server (scripts/fixture-feeds.ts) serving the real saved payloads in
 * docs/reconnection/data, time-shifted to a controllable clock.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkLiveState, checkServerMessage, eventsResponseSchema, healthResponseSchema, helloSchema, historyResponseSchema,
  PROTOCOL_VERSION, serverMessageSchema, type Delta, type ServerMessage,
} from "@cme/shared";
import { startFixtureFeeds, type FixtureFeeds } from "../scripts/fixture-feeds.ts";
import { openTestDb, type TestDb } from "./sqlite.ts";
import { HubCore, TEST_ALERT_TTL_S } from "../src/core.ts";
import { route, type Routed } from "../src/api/router.ts";
import { downsample } from "../src/api/history.ts";
import { compileAllowList, originAllowed } from "../src/origin.ts";
import { MAX_SOCKETS, type HubSocket, type SocketMeta } from "../src/sockets.ts";
import { FEED_PERSIST_EVERY_S, mustPersist } from "../src/tick.ts";
import { readSeq } from "../src/db/migrate.ts";
import { upsertFlare } from "../src/db/rows.ts";
import type { FeedState, WorkerFeed } from "../src/types.ts";
import { FEED_DEFS } from "@cme/shared";

// ---- harness ----------------------------------------------------------------------------------------------

const T_START = Date.parse("2026-11-22T10:00:05Z"); // inside the :55–:20 fast window
let clock = T_START;
let feeds: FixtureFeeds;
let base: string;

before(async () => {
  feeds = await startFixtureFeeds({ port: 0, now: () => clock, log: () => {} });
  base = `http://127.0.0.1:${feeds.port}`;
});
after(() => feeds.close());

class FakeSocket implements HubSocket {
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  private m: SocketMeta | null = null;
  send(s: string) {
    if (this.closed) throw new Error("closed");
    this.sent.push(s);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  meta() {
    return this.m;
  }
  setMeta(m: SocketMeta) {
    this.m = m;
  }
  get msgs(): { type: string; seq?: number; [k: string]: unknown }[] {
    return this.sent.map((s) => JSON.parse(s));
  }
  /** Every message except hello must pass the client's own contract check. */
  assertValid() {
    for (const m of this.msgs) {
      if (m.type === "hello") assert.ok(helloSchema.safeParse(m).success, "hello shape");
      else {
        const c = checkServerMessage(m);
        assert.ok(c.ok, `invalid ${m.type}: ${!c.ok && c.error}`);
      }
    }
  }
}

interface Hub {
  core: HubCore;
  db: TestDb;
  sockets: FakeSocket[];
  logs: string[];
  fetched: string[];
  req(path: string, init?: RequestInit): Routed;
  get(path: string, init?: RequestInit): Promise<{ status: number; headers: Headers; body: unknown }>;
  open(since?: string, origin?: string): FakeSocket;
  tick(): Promise<number>;
}

interface HubOpts {
  db?: TestDb;
  fetchFn?: typeof fetch;
  feeds?: readonly WorkerFeed[];
  adminToken?: string;
  pollTimeoutMs?: number;
}

function makeHub(opts: HubOpts = {}): Hub {
  const db = opts.db ?? openTestDb();
  const sockets: FakeSocket[] = [];
  const logs: string[] = [];
  const fetched: string[] = [];
  const inner = opts.fetchFn ?? fetch;
  const fetchFn = ((url: string, init?: RequestInit) => {
    fetched.push(url);
    return inner(url, init);
  }) as typeof fetch;
  const core = new HubCore(
    {
      sql: db.sql, tx: db.tx,
      config: { feedBase: base, adminToken: opts.adminToken, allowedOrigins: "http://localhost:5173, https://*.cme-web.pages.dev" },
      sockets: () => sockets.filter((s) => !s.closed),
      fetchFn, pollTimeoutMs: opts.pollTimeoutMs, feeds: opts.feeds, log: (l) => logs.push(l),
    },
    clock,
  );
  const req = (path: string, init?: RequestInit) => route(core, new Request(`http://worker${path}`, init), clock);
  return {
    core, db, sockets, logs, fetched, req,
    async get(path, init) {
      const r = req(path, init);
      assert.equal(r.kind, "http");
      const res = (r as Extract<Routed, { kind: "http" }>).res;
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
    },
    open(since, origin) {
      const headers: Record<string, string> = { upgrade: "websocket" };
      if (origin) headers.origin = origin;
      const r = req(`/api/v1/stream${since === undefined ? "" : `?since=${since}`}`, { headers });
      assert.equal(r.kind, "ws", JSON.stringify(r));
      const ws = new FakeSocket();
      sockets.push(ws);
      core.onOpen(ws, (r as Extract<Routed, { kind: "ws" }>).since, clock);
      return ws;
    },
    tick: () => core.tick(clock),
  };
}

const changes = (db: TestDb) => (db.sql.exec<{ n: number }>("SELECT total_changes() AS n").one().n);
const count = (db: TestDb, table: string) => db.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
const deltas = (ws: FakeSocket) => ws.msgs.filter((m) => m.type === "delta") as unknown as Extract<ServerMessage, { type: "delta" }>[];
const at = (iso: string) => Date.parse(iso);

// ---- the tick ---------------------------------------------------------------------------------------------

describe("tick", () => {
  test("first tick backfills from the 7-day URL once and emits one delta; hello then snapshot on connect", async () => {
    clock = T_START;
    const h = makeHub();
    assert.deepEqual([...h.core.backfill].sort(), ["goes_xray", "rtsw"]);
    const ws = h.open();
    assert.equal(ws.msgs[0].type, "hello");
    assert.equal(ws.msgs[0].protocol, PROTOCOL_VERSION);
    assert.equal(ws.msgs[1].type, "snapshot");
    assert.equal(ws.msgs[1].seq, 0);

    await h.tick();
    assert.ok(h.fetched.some((u) => u.endsWith("/xrays-7-day.json")), "backfill URL");
    assert.ok(!h.fetched.some((u) => u.endsWith("/xrays-6-hour.json")), "not the normal URL");
    assert.equal(h.core.seq, 1);
    assert.equal(readSeq(h.db.sql), 1);
    assert.equal(h.core.backfill.size, 0);
    const [d] = deltas(ws);
    assert.equal(d.seq, 1);
    assert.ok(d.data.xray!.t.length > 2000, `xray rows ${d.data.xray!.t.length}`);
    assert.ok(d.data.wind!.t.length > 1000, `wind rows ${d.data.wind!.t.length}`);
    assert.deepEqual(d.data.feeds!.map((f) => [f.id, f.stale]), [["goes_xray", false], ["rtsw", false]]);
    assert.equal(count(h.db, "xray_sample"), h.core.memory.xray.size);
    assert.equal(count(h.db, "wind_sample"), h.core.memory.wind.size);
    ws.assertValid();

    const line = JSON.parse(h.logs.find((l) => l.includes('"evt":"tick"'))!);
    assert.equal(line.seq, 1);
    assert.equal(line.feeds.goes_xray.st, 200);
    assert.equal(line.feeds.goes_xray.backfill, true);
    assert.equal(typeof line.ms, "number");

    // The next poll uses the normal URL.
    h.fetched.length = 0;
    clock += 5000;
    await h.tick();
    assert.ok(h.fetched.some((u) => u.endsWith("/xrays-6-hour.json")));
    assert.ok(!h.fetched.some((u) => u.endsWith("/xrays-7-day.json")));
  });

  test("S1: unchanged polls send nothing and write nothing; a new minute gives exactly one delta", async () => {
    clock = T_START;
    const h = makeHub();
    const ws = h.open();
    await h.tick();
    const seq = h.core.seq;
    const before = changes(h.db);
    for (let i = 0; i < 2; i++) {
      clock += 5000; // :10 then :15, same published minute
      await h.tick();
    }
    assert.ok(h.logs.some((l) => l.includes('"st":304')), "saw 304s");
    assert.equal(h.core.seq, seq, "no seq taken");
    assert.equal(changes(h.db), before, "no SQLite writes");
    assert.equal(deltas(ws).length, 1);

    const lastOk = h.db.sql.exec<{ last_ok_at: number }>("SELECT last_ok_at FROM feed_status WHERE feed_id = 'goes_xray'").one().last_ok_at;
    clock = at("2026-11-22T10:01:05Z");
    await h.tick();
    assert.equal(h.core.seq, seq + 1);
    const d = deltas(ws).at(-1)!;
    assert.deepEqual(d.data.xray!.t, [at("2026-11-22T10:00:00Z") / 1000]);
    assert.deepEqual(d.data.wind!.t, [at("2026-11-22T10:00:00Z") / 1000]);
    assert.deepEqual(d.data.feeds!.map((f) => f.dataTs), [at("2026-11-22T10:00:00Z") / 1000, at("2026-11-22T10:00:00Z") / 1000]);
    const lastOk2 = h.db.sql.exec<{ last_ok_at: number }>("SELECT last_ok_at FROM feed_status WHERE feed_id = 'goes_xray'").one().last_ok_at;
    assert.equal(lastOk2, lastOk, "feed_status not rewritten for a new minute (write budget)");
    ws.assertValid();
  });

  test("R1: a feed that never answers doesn't hold up the other", async () => {
    clock = T_START;
    const hanging = ((url: string, init?: RequestInit) =>
      url.includes("/rtsw/")
        ? new Promise<Response>((_r, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)))
        : fetch(url, init)) as typeof fetch;
    const h = makeHub({ fetchFn: hanging, pollTimeoutMs: 100 });
    const ws = h.open();
    const t0 = Date.now();
    await h.tick();
    assert.ok(Date.now() - t0 < 5000);
    const d = deltas(ws)[0];
    assert.ok(d.data.xray!.t.length > 0);
    assert.equal(d.data.wind, undefined);
    const rtsw = d.data.feeds!.find((f) => f.id === "rtsw")!;
    assert.match(rtsw.error!, /timeout/);
    assert.equal(h.core.memory.feedState("rtsw", 0).failCount, 1);
    assert.ok(h.core.backfill.has("rtsw"), "backfill retried after a failure");
    assert.equal(h.db.sql.exec<{ fail_count: number }>("SELECT fail_count FROM feed_status WHERE feed_id='rtsw'").one().fail_count, 1);
  });

  test("a feed going stale with no new data is announced once", async () => {
    clock = T_START;
    let frozen = false;
    const fetchFn = ((url: string, init?: RequestInit) =>
      frozen ? Promise.resolve(new Response(null, { status: 304 })) : fetch(url, init)) as typeof fetch;
    const h = makeHub({ fetchFn });
    const ws = h.open();
    await h.tick();
    frozen = true;
    clock += 400_000; // past staleAfterS = 300 s
    await h.tick();
    const d = deltas(ws).at(-1)!;
    assert.deepEqual(d.data.feeds!.map((f) => [f.id, f.stale]), [["goes_xray", true], ["rtsw", true]]);
    const n = deltas(ws).length;
    clock += 5000;
    await h.tick();
    assert.equal(deltas(ws).length, n, "not repeated");
  });

  test("R3: a restart over the same database keeps seq increasing and memory intact", async () => {
    clock = T_START;
    const dir = mkdtempSync(join(tmpdir(), "hub-"));
    const path = join(dir, "do.sqlite");
    try {
      const a = makeHub({ db: openTestDb(path), adminToken: "t" });
      await a.tick();
      a.core.raiseTestAlert(clock);
      assert.equal(a.core.seq, 2);
      const xraySize = a.core.memory.xray.size;
      a.db.db.close();

      clock += 30_000;
      const b = makeHub({ db: openTestDb(path) });
      assert.equal(b.core.seq, 2);
      assert.equal(b.core.memory.xray.size, xraySize);
      assert.equal(b.core.backfill.size, 0, "no backfill when the rings have data");
      assert.ok(b.core.memory.feedState("goes_xray", 0).dataTs !== null);
      assert.equal(checkLiveState(JSON.parse(b.core.memory.stateJson(b.core.seq, 0))).ok, true);
      assert.ok(b.core.memory.liveState(2, clock / 1000).alerts.some((x) => x.rule === "TEST"));

      const ws = b.open("1"); // the delta ring is memory-only: a restart answers with a snapshot
      assert.deepEqual(ws.msgs.map((m) => m.type), ["hello", "snapshot"]);
      clock = at("2026-11-22T10:01:05Z");
      await b.tick();
      assert.equal(b.core.seq, 3);
      assert.equal(deltas(ws)[0].seq, 3);
      b.db.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed commit is logged, takes no seq, still returns a wake time, and the data comes again next tick", async () => {
    clock = T_START;
    const db = openTestDb();
    let fail = true;
    const h = makeHub({ db: { ...db, tx: (fn) => (fail ? (() => { throw new Error("disk full"); })() : db.tx(fn)) } });
    const ws = h.open();
    const next = await h.tick();
    assert.ok(next > clock && next <= clock + 6000);
    assert.ok(h.logs.some((l) => l.includes('"evt":"tick_error"') && l.includes("disk full")));
    assert.equal(h.core.seq, 0);
    assert.equal(h.core.memory.xray.size, 0);
    assert.equal(deltas(ws).length, 0);
    fail = false;
    clock += 5000;
    await h.tick();
    assert.equal(h.core.seq, 1);
    assert.ok(deltas(ws)[0].data.xray!.t.length > 2000, "backfill retried, not lost to a 304");
  });
});

// ---- REST ---------------------------------------------------------------------------------------------------

describe("routes", () => {
  let h: Hub;
  before(async () => {
    clock = T_START;
    h = makeHub({ adminToken: "s3cret" });
    await h.tick();
  });

  test("GET /state: LiveState with ETag; If-None-Match gets 304", async () => {
    const r = await h.get("/api/v1/state");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("etag"), `"${h.core.seq}"`);
    assert.equal(r.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("cache-control"), "no-store");
    const c = checkLiveState(r.body);
    assert.ok(c.ok, !c.ok ? c.error : "");
    assert.ok(c.value.xray.t.length > 0 && c.value.wind.t.length > 0);
    const r304 = await h.get("/api/v1/state", { headers: { "if-none-match": `"${h.core.seq}"` } });
    assert.equal(r304.status, 304);
    assert.equal((await h.get("/api/v1/state", { headers: { "if-none-match": '"0"' } })).status, 200);
  });

  test("GET /health: valid, with seq, sockets, lag and status", async () => {
    const r = await h.get("/api/v1/health");
    assert.equal(r.status, 200);
    const p = healthResponseSchema.safeParse(r.body);
    assert.ok(p.success);
    assert.equal(p.data.seq, h.core.seq);
    assert.equal(p.data.status, "ok");
    assert.deepEqual(p.data.lag!.map((l) => l.feed), ["goes_xray", "rtsw"]);
    assert.ok(p.data.lag!.every((l) => l.p50 !== null));
  });

  test("GET /history: 5m buckets over 24 h, 1m from the ring; bad queries get 400", async () => {
    const now = Math.floor(clock / 1000);
    for (const series of ["xray", "wind"]) {
      const r = await h.get(`/api/v1/history?series=${series}&res=5m&from=${now - 86400}&to=${now}`);
      assert.equal(r.status, 200);
      const p = historyResponseSchema.safeParse(r.body);
      assert.ok(p.success, series);
      const ts = p.data.data.t;
      assert.ok(ts.length > 200, `${series}: ${ts.length}`);
      assert.ok(ts.every((t) => t % 300 === 0));
      assert.ok(ts[0] >= now - 86400 - 300 && ts.at(-1)! <= now);
      assert.equal(r.headers.get("cache-control"), "public, s-maxage=60");
    }
    const one = await h.get(`/api/v1/history?series=xray&from=${now - 3600}&to=${now}`);
    const p = historyResponseSchema.parse(one.body);
    assert.equal(p.res, "1m");
    assert.ok(p.data.t.length >= 59 && p.data.t.length <= 61);
    const old = await h.get(`/api/v1/history?series=xray&res=5m&from=${now - 86400}&to=${now - 7200}`);
    assert.equal(old.headers.get("cache-control"), "public, max-age=86400, immutable");
    for (const q of ["series=sun", "series=xray&res=1h", "series=xray&from=abc", "res=1m", "series=wind&to=1.5"]) {
      const r = await h.get(`/api/v1/history?${q}`);
      assert.equal(r.status, 400, q);
      assert.equal(typeof (r.body as { error: string }).error, "string");
    }
  });

  test("downsample: xray max, wind mean, nulls ignored, all-null stays null", () => {
    const r = { t: [0, 60, 240, 300, 360], cols: { a: [1, null, 3, null, null], b: [2, 4, null, null, 5] } };
    assert.deepEqual(downsample(r, "max"), { t: [0, 300], cols: { a: [3, null], b: [4, 5] } });
    assert.deepEqual(downsample(r, "mean"), { t: [0, 300], cols: { a: [2, null], b: [3, 5] } });
  });

  test("GET /events: type filter omits unrequested keys", async () => {
    const now = Math.floor(clock / 1000);
    upsertFlare(h.db.sql, {
      id: "f1", beginAt: now - 3600, peakAt: null, endAt: null, cls: "M1.0", peakFlux: 1e-5, status: "rising",
      regionNo: null, lat: null, lon: null,
    });
    const r = await h.get("/api/v1/events?type=flare,cme");
    assert.equal(r.status, 200);
    assert.ok(eventsResponseSchema.safeParse(r.body).success);
    const b = r.body as Record<string, unknown[]>;
    assert.deepEqual(Object.keys(b).sort(), ["cmes", "flares"]);
    assert.equal(b.flares.length, 1);
    const all = await h.get("/api/v1/events");
    assert.deepEqual(Object.keys(all.body as object).sort(), ["alerts", "cmes", "flares"]);
    assert.deepEqual((await h.get(`/api/v1/events?type=flare&since=${now}`)).body, { flares: [] });
    assert.deepEqual((await h.get("/api/v1/events?type=bogus")).body, {});
  });

  test("everything else is a JSON 404 (incl. mock-only routes)", async () => {
    for (const [m, p] of [["GET", "/api/v1/nope"], ["POST", "/api/v1/state"], ["GET", "/mock/reset"], ["GET", "/api/v1/admin/test-alert"]]) {
      const r = await h.get(p, { method: m });
      assert.equal(r.status, 404, `${m} ${p}`);
      assert.equal(r.headers.get("content-type"), "application/json; charset=utf-8");
    }
  });

  test("POST /admin/test-alert: auth, sequenced alert at once, in /state, cleared after 10 min", async () => {
    const ws = h.open();
    const post = (auth?: string) => h.get("/api/v1/admin/test-alert", { method: "POST", headers: auth ? { authorization: auth } : {} });
    assert.equal((await post()).status, 401);
    assert.equal((await post("Bearer wrong")).status, 401);
    assert.equal((await post("s3cret")).status, 401);
    const seq = h.core.seq;
    const r = await post("Bearer s3cret");
    assert.equal(r.status, 200);
    const id = (r.body as { id: string }).id;
    assert.match(id, /^TEST:\d+:\d+$/);
    const msg = ws.msgs.at(-1)!;
    assert.equal(msg.type, "alert");
    assert.equal(msg.seq, seq + 1);
    assert.equal(readSeq(h.db.sql), seq + 1, "seq committed with the alert row");
    assert.ok(serverMessageSchema.safeParse(msg).success);
    const st = checkLiveState((await h.get("/api/v1/state")).body);
    assert.ok(st.ok && st.value.alerts.some((a) => a.id === id && a.clearedAt === null));

    clock += (TEST_ALERT_TTL_S + 5) * 1000;
    await h.tick();
    const cleared = deltas(ws).flatMap((d) => (d.data as Delta).alerts ?? []).find((a) => a.id === id);
    assert.ok(cleared && cleared.clearedAt !== null, "clearing sent as a delta");
    const st2 = checkLiveState((await h.get("/api/v1/state")).body);
    assert.ok(st2.ok && st2.value.alerts.find((a) => a.id === id)?.clearedAt !== null);
    const ev = (await h.get("/api/v1/events?type=alert")).body as { alerts: { id: string; clearedAt: number | null }[] };
    assert.ok(ev.alerts.find((a) => a.id === id)?.clearedAt);
    ws.assertValid();
  });

  test("POST /admin/test-alert is 404 when ADMIN_TOKEN is not set", async () => {
    const h2 = makeHub();
    const r = await h2.get("/api/v1/admin/test-alert", { method: "POST", headers: { authorization: "Bearer " } });
    assert.equal(r.status, 404);
  });
});

// ---- WebSocket session ------------------------------------------------------------------------------------

describe("stream", () => {
  test("?since: backlog when the ring has it, nothing when current, snapshot otherwise; resync; ping and idle close", async () => {
    clock = T_START;
    const h = makeHub();
    await h.tick();
    clock = at("2026-11-22T10:01:05Z");
    await h.tick();
    clock = at("2026-11-22T10:02:05Z");
    await h.tick();
    const seq = h.core.seq;
    assert.equal(seq, 3);

    const back = h.open(String(seq - 2));
    assert.deepEqual(back.msgs.map((m) => [m.type, m.seq]), [["hello", seq], ["delta", seq - 1], ["delta", seq]]);
    assert.deepEqual(h.open(String(seq)).msgs.map((m) => m.type), ["hello"]);
    for (const s of [String(seq + 1_000_000), "abc", "-1", ""]) {
      assert.deepEqual(h.open(s).msgs.map((m) => m.type), ["hello", "snapshot"], s);
    }
    back.assertValid();

    const ws = h.open();
    const snap = ws.msgs[1] as unknown as { seq: number; data: unknown };
    assert.equal(snap.seq, seq);
    assert.ok(checkLiveState(snap.data).ok);
    h.core.onMessage(ws, JSON.stringify({ type: "resync" }), clock);
    assert.equal(ws.msgs.at(-1)!.type, "snapshot");
    h.core.onMessage(ws, "not json", clock);
    h.core.onMessage(ws, JSON.stringify({ type: "pong", ts: 1 }), clock);
    assert.equal(ws.meta()!.ponged, true);
    const quiet = h.open(); // never pongs, like the contract tests' client

    clock += 50_000;
    await h.tick();
    assert.deepEqual(ws.closed?.code, 1001, "ponging client silent > 45 s is closed");
    assert.equal(quiet.closed, null, "a client that never pongs is left alone");
    assert.equal(quiet.msgs.at(-1)!.type, "ping");
    ws.assertValid();
    quiet.assertValid();
  });

  test("origin allow-list, upgrade check and the socket cap", () => {
    const allow = compileAllowList("http://localhost:5173, https://*.cme-web.pages.dev,");
    assert.ok(originAllowed(null, allow), "no Origin header (node, wscat)");
    assert.ok(originAllowed("http://localhost:5173", allow));
    assert.ok(originAllowed("HTTP://LOCALHOST:5173", allow));
    assert.ok(originAllowed("https://abc-123.cme-web.pages.dev", allow));
    assert.ok(!originAllowed("https://a.b.cme-web.pages.dev", allow), "* is one label");
    assert.ok(!originAllowed("https://cme-web.pages.dev", allow));
    assert.ok(!originAllowed("http://abc.cme-web.pages.dev", allow), "scheme");
    assert.ok(!originAllowed("http://localhost:5174", allow), "port");
    assert.ok(!originAllowed("https://evil.com/https://x.cme-web.pages.dev", allow));
    assert.ok(!originAllowed("null", allow));
    assert.ok(!originAllowed("https://x.cme-webXpages.dev", allow), "dots are literal");
    assert.ok(!originAllowed("http://localhost:5173", compileAllowList("")));

    clock = T_START;
    const h = makeHub();
    const ws = (origin?: string, upgrade = true) => {
      const headers: Record<string, string> = upgrade ? { upgrade: "websocket" } : {};
      if (origin) headers.origin = origin;
      return h.req("/api/v1/stream", { headers });
    };
    assert.deepEqual(ws("https://evil.example"), { kind: "ws-reject", code: 1008, reason: "origin not allowed" });
    assert.equal(ws("https://pr-7.cme-web.pages.dev").kind, "ws");
    assert.equal(ws().kind, "ws");
    const plain = ws(undefined, false);
    assert.equal(plain.kind === "http" && plain.res.status, 426);
    for (let i = 0; i < MAX_SOCKETS; i++) h.sockets.push(new FakeSocket());
    assert.deepEqual(ws(), { kind: "ws-reject", code: 1013, reason: "too many sockets" });
  });
});

// ---- watchdog, write policy, secrets -------------------------------------------------------------------------

describe("ops", () => {
  test("watchdog: re-arms when the alarm hasn't run for 30 s and /health turns degraded", async () => {
    clock = T_START;
    const h = makeHub();
    await h.tick();
    h.core.scheduledAtMs = clock + 5000;
    assert.equal(h.core.watchdog(clock + 10_000), false);
    clock += 40_000;
    assert.equal(h.core.watchdog(clock), true);
    assert.ok(h.logs.some((l) => l.includes('"evt":"watchdog"') && l.includes('"level":"error"')));
    const body = h.core.health(clock);
    assert.ok(body.alarmLagS! >= 30);
    assert.equal(body.status, "degraded");
  });

  test("feed_status write policy", () => {
    const s = (o: Partial<FeedState>): FeedState => ({
      id: "goes_xray", etags: {}, lastOkAt: 1000, dataTs: 900, error: null, failCount: 0, nextAt: 0, ...o,
    });
    assert.equal(mustPersist(undefined, s({})), true, "never stored");
    assert.equal(mustPersist(s({}), s({ lastOkAt: 1005, dataTs: 960, etags: { u: "e" } })), false, "new minute, new etag");
    assert.equal(mustPersist(s({}), s({ lastOkAt: 1000 + FEED_PERSIST_EVERY_S })), true, "lastOkAt refresh");
    assert.equal(mustPersist(s({}), s({ error: "HTTP 500", failCount: 1 })), true, "failure");
    assert.equal(mustPersist(s({ error: "x", failCount: 2 }), s({ lastOkAt: 1010 })), true, "recovery");
    assert.equal(mustPersist(s({ dataTs: null }), s({ dataTs: 960 })), true, "first data");
  });

  test("X4: an api_key in a failing URL never reaches /health or the logs", async () => {
    clock = T_START;
    const SECRET = "SECRETKEY123";
    const donki: WorkerFeed = {
      ...FEED_DEFS.find((f) => f.id === "donki")!,
      urls: (b) => [`${b}/DONKI/CMEAnalysis?startDate=2026-11-15&mostAccurateOnly=true&api_key=${SECRET}`],
      fastWindow: false,
    };
    for (const fetchFn of [
      (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
      (async (u: string) => {
        throw new TypeError(`connect ECONNREFUSED for ${u} (api_key=${SECRET})`);
      }) as unknown as typeof fetch,
    ]) {
      const h = makeHub({ feeds: [donki], fetchFn });
      await h.tick();
      const health = JSON.stringify((await h.get("/api/v1/health")).body);
      assert.match(health, /DONKI\/CMEAnalysis/);
      assert.ok(!health.includes(SECRET), health);
      assert.ok(h.logs.length > 0);
      assert.ok(!h.logs.join("\n").includes(SECRET), h.logs.join("\n"));
      assert.ok(!JSON.stringify(h.db.sql.exec("SELECT * FROM feed_status").toArray()).includes(SECRET));
    }
  });
});
