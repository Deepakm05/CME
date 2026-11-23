/**
 * LiveStream against the real mock server (in-process, random port), including its chaos faults.
 * The mock runs at 600× so a delta arrives every second.
 */
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { PROTOCOL_VERSION, type LiveState } from "@cme/shared";
import { startMockServer } from "../../mock/src/server.ts";
import { loadFixtures } from "../../mock/src/fixtures.ts";
import { createLiveStore, type LiveStore } from "../src/store/live.ts";
import { LiveStream, type LiveStreamOptions } from "../src/stream/client.ts";

let mock: ReturnType<typeof startMockServer>;
let base: string;

before(async () => {
  mock = startMockServer({ port: 0, fixtures: loadFixtures(), speed: 600 });
  await new Promise((r) => mock.server.once("listening", r));
  base = `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}`;
});
after(() => mock.close());

const running: LiveStream[] = [];
afterEach(async () => {
  running.splice(0).forEach((s) => s.stop());
  await chaos({});
});

const chaos = (c: Record<string, number>) =>
  fetch(`${base}/mock/chaos`, { method: "POST", body: JSON.stringify(c) }).then((r) => r.json());

async function waitFor(what: string, ok: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A WebSocket class that records every URL it was opened with. */
function recordingWs(urls: string[], allow: () => boolean = () => true): typeof WebSocket {
  return class extends WebSocket {
    constructor(url: string | URL) {
      urls.push(String(url));
      super(allow() ? url : "ws://127.0.0.1:1/refused");
    }
  };
}

function open(opts: Partial<LiveStreamOptions> = {}) {
  const store = createLiveStore();
  const stream = new LiveStream({ store, baseUrl: base, backoffBaseMs: 20, backoffMaxMs: 100, random: () => 1, ...opts });
  running.push(stream);
  return { store, stream };
}

const caughtUp = (store: LiveStore) => () =>
  store.getState().seq === mock.engine.seq && store.getState().conn.status === "live";

test("boot: GET /state, then the socket resumes from that seq and deltas apply in order", async () => {
  const urls: string[] = [];
  const { store, stream } = open({ WebSocketImpl: recordingWs(urls) });
  await stream.start();
  assert.equal(store.getState().conn.source, "rest", "painted from GET /state before the socket");
  assert.match(urls[0], /\/api\/v1\/stream\?since=\d+$/);

  const seq0 = store.getState().seq!;
  await waitFor("3 deltas", () => store.getState().seq! >= seq0 + 3);
  await waitFor("caught up", caughtUp(store));
  const s = store.getState();
  assert.equal(s.conn.source, "ws");
  assert.equal(s.conn.gaps, 0);
  assert.equal(s.xray.lastT, mock.engine.state().xray.t.at(-1));
  assert.ok(s.xray.length > 300 && s.wind.length > 300, "6 h of series");
  stream.stop();
});

test("a seq gap triggers a resync, and the store ends up equal to the server", async () => {
  const { store, stream } = open();
  await stream.start();
  await chaos({ skipEveryN: 3 });
  await waitFor("gap detected and resynced", () => store.getState().conn.resyncs >= 1);
  await chaos({});
  await waitFor("caught up", caughtUp(store));

  const server = mock.engine.state();
  const s = store.getState();
  assert.ok(s.conn.gaps >= 1);
  assert.equal(s.xray.lastT, server.xray.t.at(-1));
  assert.deepEqual(s.flares.map((f) => f.id).sort(), server.flares.map((f) => f.id).sort());
  assert.deepEqual(s.feeds.map((f) => `${f.id}:${f.stale}`), server.feeds.map((f) => `${f.id}:${f.stale}`));
  stream.stop();
});

test("a dropped socket reconnects with ?since and catches up without a snapshot", async () => {
  const urls: string[] = [];
  const sockets: WebSocket[] = [];
  const Base = recordingWs(urls);
  const { store, stream } = open({
    WebSocketImpl: class extends Base {
      constructor(url: string | URL) {
        super(url);
        sockets.push(this);
      }
    },
  });
  await stream.start();
  await waitFor("live", caughtUp(store));
  const seqAtDrop = store.getState().seq!;

  sockets[0].close(); // like a network blip
  await waitFor("reconnected", () => urls.length === 2);
  assert.ok(urls[1].endsWith(`?since=${seqAtDrop}`) || Number(urls[1].split("since=")[1]) > seqAtDrop);
  await waitFor("caught up", () => store.getState().seq! > seqAtDrop + 1 && caughtUp(store)());
  assert.equal(store.getState().conn.resyncs, 0);
  assert.equal(store.getState().conn.gaps, 0);
  stream.stop();
});

test("after 3 failed attempts it polls GET /state, and stops polling when the socket is back", async () => {
  let allow = false;
  const { store, stream } = open({ WebSocketImpl: recordingWs([], () => allow), pollMs: 300 });
  await stream.start();
  await waitFor("polling", () => store.getState().conn.status === "polling");
  const seq0 = store.getState().seq!;
  await waitFor("data keeps flowing over REST", () => store.getState().seq! > seq0);
  assert.equal(store.getState().conn.source, "rest");

  allow = true;
  await waitFor("live again", caughtUp(store));
  assert.equal(store.getState().conn.failures, 0);
  stream.stop();
});

test("a cached state paints first, but its seq is never used to resume", async () => {
  const cached = (await fetch(`${base}/api/v1/state`).then((r) => r.json())) as LiveState;
  cached.seq = 999_999; // from another server run
  const urls: string[] = [];
  let saved: LiveState | null = null;
  let goOffline!: () => void;
  const offline = new Promise<never>((_, reject) => (goOffline = () => reject(new Error("offline"))));
  const { store, stream } = open({
    cache: { load: async () => cached, save: async (s) => void (saved = s) },
    fetchImpl: () => offline, // GET /state hangs until the cache paint was checked, then fails
    WebSocketImpl: recordingWs(urls),
  });

  const starting = stream.start();
  await waitFor("painted from cache", () => store.getState().conn.source === "cache");
  assert.equal(store.getState().seq, null);
  goOffline();
  await starting;
  assert.ok(urls[0].endsWith("/api/v1/stream"), `no ?since: ${urls[0]}`);
  await waitFor("live from a snapshot", caughtUp(store));

  stream.stop(); // saves on stop
  await waitFor("saved", () => saved !== null);
  assert.equal(saved!.seq, store.getState().seq);
});

test("a silent socket (half-open connection) is dropped and replaced", async () => {
  const urls: string[] = [];
  const { store, stream } = open({ WebSocketImpl: recordingWs(urls), silenceMs: 300 });
  await chaos({ latencyMs: 2000 }); // nothing arrives for 2 s
  await stream.start();
  await waitFor("second attempt", () => urls.length >= 2, 3000);
  await chaos({});
  await waitFor("live", caughtUp(store));
  stream.stop();
});

test("the badge goes live when the socket opens, even if the server is quiet", async () => {
  const { store, stream } = open();
  await chaos({ latencyMs: 3000 }); // like real-time speed: nothing for a while after connecting
  await stream.start();
  await waitFor("live before any message", () => store.getState().conn.status === "live", 2000);
  assert.equal(store.getState().conn.lastMessageAt, null);
  assert.equal(store.getState().conn.source, "rest");
});

test("a test alert reaches an open page in under 1 s (PLAN phase 4)", async () => {
  const got: { id: string; at: number }[] = [];
  const { store, stream } = open({ onAlert: (a) => got.push({ id: a.id, at: Date.now() }) });
  await stream.start();
  await waitFor("caught up", caughtUp(store));
  const sent = Date.now();
  const a = await fetch(`${base}/mock/alert`, { method: "POST", body: "{}" }).then((r) => r.json());
  await waitFor("alert delivered", () => got.some((g) => g.id === a.id), 1000);
  const ms = got.find((g) => g.id === a.id)!.at - sent;
  assert.ok(ms < 1000, `delivered in ${ms} ms`);
  assert.ok(store.getState().alerts.some((x) => x.id === a.id && x.clearedAt === null), "in the store too");
});

test("a message that breaks the contract is never applied; the client resyncs and catches up", async () => {
  let corruptNext = false;
  // Corrupts the next delta it receives: an X-ray column of strings, shorter than its times.
  const Corrupting = class extends WebSocket {
    set onmessage(fn: ((ev: MessageEvent) => void) | null) {
      super.onmessage = fn && ((ev: MessageEvent) => {
        const m = JSON.parse(String(ev.data));
        if (corruptNext && m.type === "delta") {
          corruptNext = false;
          m.data.xray = { t: [m.ts, m.ts + 60], long: ["oops"], short: [] };
          return fn({ data: JSON.stringify(m) } as MessageEvent);
        }
        fn(ev);
      });
    }
  } as typeof WebSocket;

  const { store, stream } = open({ WebSocketImpl: Corrupting });
  await stream.start();
  await waitFor("caught up", caughtUp(store));
  const lastT = store.getState().xray.lastT;
  corruptNext = true;
  await waitFor("rejected", () => store.getState().conn.invalid === 1);
  assert.match(store.getState().conn.lastInvalid ?? "", /xray/);
  await waitFor("resynced and caught up", () => store.getState().conn.resyncs >= 1 && caughtUp(store)());
  const s = store.getState();
  assert.ok(s.xray.lastT! >= lastT!, "series intact");
  assert.ok([...s.xray.view().long].every((v) => Number.isNaN(v) || v > 0), "no junk in the store");
  assert.equal(s.xray.lastT, mock.engine.state().xray.t.at(-1));
});

// ---- close codes, success only after a delivered message, hello (backend design 7.1, GAPS D3/S2/S3) ----------

/** A scripted socket: the test decides when it opens, what it receives and how it closes. */
class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWs.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  say(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  /** What the real backend does to a socket it refuses: accept it, then close it at once. */
  rejectWith(code: number) {
    this.open();
    this.closeWith(code);
  }
  closeWith(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}

function fake(opts: Partial<LiveStreamOptions> = {}) {
  FakeWs.all = [];
  const stateGets: number[] = [];
  const fetchImpl = ((url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith("/api/v1/state")) stateGets.push(Date.now());
    return fetch(url, init);
  }) as typeof fetch;
  const o = open({ WebSocketImpl: FakeWs as unknown as typeof WebSocket, fetchImpl, ...opts });
  return { ...o, stateGets, sockets: () => FakeWs.all };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("close 1008 (origin not allowed): no reconnect, status rejected, /state still polled", async () => {
  const { store, stream, stateGets, sockets } = fake({ pollMs: 80 });
  await stream.start();
  assert.equal(sockets().length, 1);
  sockets()[0].rejectWith(1008);
  assert.equal(store.getState().conn.status, "rejected");
  await waitFor("read-only polling", () => stateGets.length >= 4);
  assert.equal(sockets().length, 1, "never reconnected");
  assert.equal(store.getState().conn.status, "rejected");
  assert.equal(store.getState().conn.source, "rest");
  stream.reconnectNow(); // online / tab-visible events must not retry either
  await tick(50);
  assert.equal(sockets().length, 1);
});

test("close 1013 (too many sockets): polling starts at once, the socket is retried slowly", async () => {
  const { store, stream, stateGets, sockets } = fake({ pollMs: 60, backoffBaseMs: 10, backoffMaxMs: 400 });
  await stream.start();
  const before = stateGets.length;
  sockets()[0].rejectWith(1013);
  assert.equal(store.getState().conn.status, "polling", "first rejection, not the third");
  await waitFor("polls", () => stateGets.length >= before + 3);
  assert.equal(sockets().length, 1, "no 10 ms retry storm against a full server");
  await waitFor("slow retry", () => sockets().length === 2);
  sockets()[1].open();
  sockets()[1].say({ type: "ping", ts: 1 });
  assert.equal(store.getState().conn.status, "live");
  assert.equal(store.getState().conn.failures, 0);
  await tick(50); // let a poll that was already in flight finish
  const n = stateGets.length;
  await tick(200);
  assert.equal(stateGets.length, n, "polling stopped once the socket delivered");
});

test("sockets that open and close at once count as failures and fall back to polling", async () => {
  const { store, stream, sockets } = fake({ pollMs: 5000, backoffBaseMs: 20, backoffMaxMs: 100 });
  await stream.start();
  let seen = 0;
  while (store.getState().conn.status !== "polling" && seen < 10) {
    await waitFor("next socket", () => sockets().length > seen, 1000);
    sockets()[seen++].rejectWith(1006); // accepted, then dropped: never delivers anything
  }
  assert.equal(store.getState().conn.status, "polling");
  assert.equal(seen, 3, "polling after pollAfterFailures = 3 attempts, not after 1 forever");
  assert.equal(store.getState().conn.failures, 3);
  await waitFor("fourth socket", () => sockets().length > seen);
  sockets()[seen].rejectWith(1006);
  assert.equal(store.getState().conn.failures, 4, "the count keeps growing, so the backoff does too");
});

test("a socket that delivered a message counts as healthy: failures reset", async () => {
  const { store, stream, sockets } = fake({ pollAfterFailures: 2, backoffBaseMs: 10 });
  await stream.start();
  sockets()[0].rejectWith(1006);
  assert.equal(store.getState().conn.failures, 1);
  await waitFor("retry", () => sockets().length === 2);
  sockets()[1].open();
  sockets()[1].say({ type: "hello", protocol: 1, minClient: 1, seq: 1, ts: 1 });
  assert.equal(store.getState().conn.failures, 1, "hello alone is not proof");
  sockets()[1].say({ type: "ping", ts: 2 });
  assert.equal(store.getState().conn.failures, 0);
  sockets()[1].closeWith(1006);
  assert.equal(store.getState().conn.failures, 1, "after a good run the next drop starts again at 1");
});

test("close 1012 (restart): reconnects after a random 0-3 s, never at once", async () => {
  for (const [r, lo, hi] of [
    [0.2, 400, 1500],
    [0, 0, 400],
  ] as const) {
    const { stream, sockets } = fake({ random: () => r, backoffBaseMs: 10, backoffMaxMs: 20 });
    await stream.start();
    sockets()[0].open();
    sockets()[0].say({ type: "ping", ts: 1 });
    const t0 = Date.now();
    sockets()[0].closeWith(1012);
    await waitFor("reconnect", () => sockets().length === 2, 3500);
    const ms = Date.now() - t0;
    assert.ok(ms >= lo && ms <= hi, `random=${r}: reconnected after ${ms} ms (expected ${lo}-${hi})`);
    stream.stop();
  }
  // random() just below 1 means just under 3 s: still waiting after 0.5 s
  const { stream, sockets } = fake({ random: () => 0.999 });
  await stream.start();
  sockets()[0].closeWith(1012);
  await tick(500);
  assert.equal(sockets().length, 1, "still waiting at 0.5 s");
  stream.stop();
});

const helloMsg = (minClient: number) => ({ type: "hello", protocol: minClient, minClient, seq: 5, ts: 1 });
const memStorage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

test("hello with minClient above PROTOCOL_VERSION saves the cache and reloads once", async () => {
  const order: string[] = [];
  const storage = memStorage();
  const { stream, sockets } = fake({
    storage,
    reload: () => void order.push("reload"),
    cache: { load: async () => null, save: async () => void order.push("save") },
  });
  await stream.start(); // GET /state fills the store, so there is something to save
  sockets()[0].open();
  sockets()[0].say(helloMsg(PROTOCOL_VERSION + 1));
  sockets()[0].say(helloMsg(PROTOCOL_VERSION + 1)); // a repeat does nothing
  await waitFor("reload", () => order.includes("reload"));
  assert.deepEqual(order, ["save", "reload"]);

  // the next page load (new stream, same sessionStorage) sees the flag and does not loop
  const again = fake({ storage, reload: () => void order.push("reload again") });
  await again.stream.start();
  again.sockets()[0].open();
  again.sockets()[0].say(helloMsg(PROTOCOL_VERSION + 1));
  await tick(100);
  assert.ok(!order.includes("reload again"));
});

test("hello that this build satisfies does nothing (and re-arms the reload guard)", async () => {
  let reloads = 0;
  const storage = memStorage();
  const { store, stream, sockets } = fake({ storage, reload: () => void reloads++ });
  await stream.start();
  sockets()[0].open();
  sockets()[0].say({ type: "hello", protocol: PROTOCOL_VERSION, minClient: PROTOCOL_VERSION, seq: 5, ts: 1 });
  sockets()[0].say({ type: "hello", protocol: 1, minClient: "x" }); // malformed: counted, never acted on
  await tick(50);
  assert.equal(reloads, 0);
  assert.equal(store.getState().conn.invalid, 1);
  storage.setItem("cme.helloReload", String(PROTOCOL_VERSION + 1));
  sockets()[0].say({ type: "hello", protocol: PROTOCOL_VERSION, minClient: PROTOCOL_VERSION, seq: 5, ts: 1 });
  assert.equal(storage.getItem("cme.helloReload"), null);
});
