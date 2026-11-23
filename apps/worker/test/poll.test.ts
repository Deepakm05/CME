import { test } from "node:test";
import assert from "node:assert/strict";
import { FeedError, pollFeed, pollJson } from "../src/feeds/poll.ts";
import { afterPoll } from "../src/feeds/scheduler.ts";
import { logEvent, redact } from "../src/obs/log.ts";
import { GOES_XRAY, RTSW } from "../src/feeds/defs.ts";
import type { FeedState } from "../src/types.ts";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

const hangingFetch = ((_url: string, init?: RequestInit) =>
  new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
  })) as unknown as typeof fetch;

const state = (id: "goes_xray" | "rtsw", etags: Record<string, string> = {}): FeedState => ({
  id, etags, lastOkAt: null, dataTs: null, error: null, failCount: 0, nextAt: 0,
});

test("R1: hung fetch times out; other feeds still yield data", async () => {
  const fetchFn = ((url: string, init?: RequestInit) =>
    url.includes("xrays") ? Promise.resolve(json([{ a: 1 }], { headers: { etag: "e1" } })) : hangingFetch(url, init)) as typeof fetch;
  const t0 = Date.now();
  const [a, b] = await Promise.allSettled([
    pollFeed(GOES_XRAY, "http://x", state("goes_xray"), { fetchFn, timeoutMs: 50 }),
    pollFeed(RTSW, "http://x", state("rtsw"), { fetchFn, timeoutMs: 50 }),
  ]);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected");
  assert.ok((b as PromiseRejectedResult).reason instanceof FeedError);
  assert.match((b as PromiseRejectedResult).reason.message, /timeout/);
});

test("sends If-None-Match and maps 304 to unchanged", async () => {
  let seen: Headers | undefined;
  const fetchFn = (async (_u: string, init?: RequestInit) => {
    seen = new Headers(init?.headers);
    return new Response(null, { status: 304 });
  }) as typeof fetch;
  assert.deepEqual(await pollJson("http://x/a", '"abc"', { fetchFn }), { kind: "unchanged" });
  assert.equal(seen?.get("if-none-match"), '"abc"');
  await pollJson("http://x/a", null, { fetchFn });
  assert.equal(seen?.get("if-none-match"), null);
});

test("returns body and etag on 200", async () => {
  const fetchFn = (async () => json({ ok: true }, { headers: { etag: "E" } })) as unknown as typeof fetch;
  assert.deepEqual(await pollJson("http://x", null, { fetchFn }), { kind: "data", etag: "E", body: { ok: true } });
});

test("HTTP 500 and bad JSON are FeedErrors", async () => {
  const f500 = (async () => new Response("no", { status: 500 })) as typeof fetch;
  await assert.rejects(pollJson("http://x/a?api_key=K", null, { fetchFn: f500 }), (e: Error) =>
    e instanceof FeedError && e.message === "HTTP 500 http://x/a");
  const bad = (async () => new Response("{nope")) as typeof fetch;
  await assert.rejects(pollJson("http://x", null, { fetchFn: bad }), /bad JSON/);
});

test("size cap: content-length, and streaming without content-length", async () => {
  const big = "[" + "1,".repeat(500) + "1]";
  const withLen = (async () => new Response(big, { headers: { "content-length": String(big.length) } })) as typeof fetch;
  await assert.rejects(pollJson("http://x", null, { fetchFn: withLen, maxBytes: 100 }), /over 100 bytes/);

  let cancelled = false;
  const stream = (liar: boolean) => (async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(new TextEncoder().encode("1,".repeat(40))); },
      cancel() { cancelled = true; },
    });
    return new Response(body, liar ? { headers: { "content-length": "5" } } : {});
  }) as typeof fetch;
  await assert.rejects(pollJson("http://x", null, { fetchFn: stream(false), maxBytes: 100 }), /over 100 bytes/);
  assert.ok(cancelled);
  cancelled = false;
  await assert.rejects(pollJson("http://x", null, { fetchFn: stream(true), maxBytes: 100 }), /over 100 bytes/);
  assert.ok(cancelled);
  // under the cap passes
  const ok = (async () => new Response("[1]")) as typeof fetch;
  assert.deepEqual((await pollJson("http://x", null, { fetchFn: ok, maxBytes: 100 })), { kind: "data", etag: null, body: [1] });
});

test("pollFeed: all 304 -> unchanged", async () => {
  const fetchFn = (async () => new Response(null, { status: 304 })) as typeof fetch;
  const urls = RTSW.urls("http://x");
  const st = state("rtsw", { [urls[0]!]: "a", [urls[1]!]: "b" });
  assert.deepEqual(await pollFeed(RTSW, "http://x", st, { fetchFn }), { kind: "unchanged" });
});

test("pollFeed: partial 304 re-fetches the other URL without If-None-Match, bodies in order", async () => {
  const [wind, mag] = RTSW.urls("http://x") as [string, string];
  const calls: Array<{ url: string; inm: string | null }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const inm = new Headers(init?.headers).get("if-none-match");
    calls.push({ url, inm });
    if (url === wind) return json("W", { headers: { etag: "w2" } });
    return inm ? new Response(null, { status: 304 }) : json("M", { headers: { etag: "m1" } });
  }) as typeof fetch;
  const res = await pollFeed(RTSW, "http://x", state("rtsw", { [wind]: "w1", [mag]: "m1" }), { fetchFn });
  assert.deepEqual(res, { kind: "data", bodies: ["W", "M"], etags: { [wind]: "w2", [mag]: "m1" } });
  assert.equal(calls.length, 3);
  assert.equal(calls[2]!.url, mag);
  assert.equal(calls[2]!.inm, null);
});

test("X4: NASA key never appears in FeedError, log line or feed state", async () => {
  const url = "https://api.nasa.gov/DONKI/CMEAnalysis?startDate=x&api_key=SECRET123";
  const fetchFn = (async (u: string) => { throw new TypeError(`fetch failed for ${u} (api_key=SECRET123)`); }) as typeof fetch;
  let err: unknown;
  try { await pollJson(url, null, { fetchFn }); } catch (e) { err = e; }
  assert.ok(err instanceof FeedError);
  assert.ok(!err.message.includes("SECRET123"), err.message);

  const lines: string[] = [];
  logEvent("poll_error", { feed: "donki", error: err, url, nested: { u: [url] } }, (l) => lines.push(l));
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]!.includes("SECRET123"), lines[0]);
  assert.equal(JSON.parse(lines[0]!).evt, "poll_error");

  const next = afterPoll(GOES_XRAY, state("goes_xray"), 1000, { kind: "error", error: `boom ${url} token=SECRET123` });
  assert.ok(!next.error!.includes("SECRET123"), next.error!);
  assert.ok(!redact(`${url} and key api_key=SECRET123`).includes("SECRET123"));
});
