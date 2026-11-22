/**
 * Feed polling (backend design §5.2, GAP R1): per-fetch timeout, body size cap, conditional GET,
 * and a multi-URL poll that returns every body whenever any URL changed.
 */
import type { FeedState, PollResult, WorkerFeed } from "../types.ts";
import { redact } from "../obs/log.ts";

export class FeedError extends Error {
  constructor(message: string) {
    super(redact(message));
    this.name = "FeedError";
  }
}

export interface PollOpts {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 5_000_000;

async function readCapped(res: Response, maxBytes: number, shownUrl: string): Promise<string> {
  const tooBig = () => new FeedError(`response over ${maxBytes} bytes ${shownUrl}`);
  const lenHeader = res.headers.get("content-length");
  if (lenHeader !== null && Number(lenHeader) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig();
  }
  if (!res.body) {
    const text = await res.text();
    if (new TextEncoder().encode(text).length > maxBytes) throw tooBig();
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** GET `url` as JSON. 304 -> unchanged. Every failure is a FeedError with a redacted message. */
export async function pollJson(url: string, etag: string | null, opts: PollOpts = {}): Promise<PollResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const shown = redact(url);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (etag) headers["if-none-match"] = etag;
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 304) {
      await res.body?.cancel().catch(() => {});
      return { kind: "unchanged" };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new FeedError(`HTTP ${res.status} ${shown}`);
    }
    const text = await readCapped(res, maxBytes, shown);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (e) {
      throw new FeedError(`bad JSON from ${shown}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { kind: "data", etag: res.headers.get("etag"), body };
  } catch (e) {
    if (e instanceof FeedError) throw e;
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new FeedError(`timeout after ${timeoutMs}ms ${shown}`);
    throw new FeedError(`fetch failed ${shown}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export type FeedPoll = { kind: "unchanged" } | { kind: "data"; bodies: unknown[]; etags: Record<string, string> };

/** Poll every URL of `feed`. If any returned data, every URL's body is returned (304s are re-fetched unconditionally). */
export async function pollFeed(feed: WorkerFeed, base: string, state: FeedState, opts: PollOpts = {}): Promise<FeedPoll> {
  const urls = feed.urls(base);
  const results = await Promise.all(urls.map((u) => pollJson(u, state.etags[u] ?? null, opts)));
  if (results.every((r) => r.kind === "unchanged")) return { kind: "unchanged" };
  const etags: Record<string, string> = { ...state.etags };
  const bodies: unknown[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    let r = results[i]!;
    if (r.kind === "unchanged") {
      r = await pollJson(url, null, opts);
      if (r.kind === "unchanged") throw new FeedError(`unexpected 304 without validator ${redact(url)}`);
    }
    bodies.push(r.body);
    if (r.etag) etags[url] = r.etag;
    else delete etags[url];
  }
  return { kind: "data", bodies, etags };
}
