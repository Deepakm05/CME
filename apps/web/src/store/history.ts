import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import {
  API_PREFIX, eventsResponseSchema, healthResponseSchema,
  type Alert, type Cme, type Flare, type HistoryRes, type HistorySeries, type Unix,
} from "@cme/shared";
import { ColumnSeries, type Columns } from "../lib/series.ts";
import { serverNow as liveServerNow } from "../lib/api.ts";
import { parseHistoryText, type ParsedHistory } from "../lib/historyParse.ts";
import type { HistoryWorkerRequest, HistoryWorkerResponse } from "../lib/history.worker.ts";
import { REPLAY_SPAN_S, replayWindow, snapDown } from "../lib/historyRange.ts";
import { liveStore, WIND_KEYS, XRAY_KEYS } from "./live.ts";

export type HistoryStatus = "idle" | "loading" | "ready" | "error";

/**
 * The historySlice from docs/design/frontend section 3.4. A separate store from liveStore: replay never
 * touches the live view, and going back to live is instant. Written only by loadHistory / resetHistory.
 */
export interface HistoryData {
  status: HistoryStatus;
  error: string | null;
  /** The loaded, snapped series range. */
  range: [Unix, Unix] | null;
  res: HistoryRes;
  /** Same classes and keys as liveStore, so charts can read either with .view(). Mutated in place. */
  xray: ColumnSeries<(typeof XRAY_KEYS)[number]>;
  wind: ColumnSeries<(typeof WIND_KEYS)[number]>;
  /** Bumped whenever xray / wind change. */
  seriesRev: number;
  /** Events for the 7 days ending at the server's now (as of `eventsSince`). */
  flares: Flare[];
  cmes: Cme[];
  alerts: Alert[];
  eventsSince: Unix | null;
}

/** Events are refreshed when older than this (wall-clock ms). */
export const EVENTS_MAX_AGE_MS = 5 * 60_000;

export interface HistoryOptions {
  /** Prefix for API calls; "" (same origin) in the app, the mock's URL in tests. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Data "now" (server time). Default: liveStore's clock, else GET /health. */
  serverNow?: (signal: AbortSignal) => Promise<Unix>;
  /** Parses a /history body; default: the Web Worker, or the main thread where there is none. */
  parse?: (text: string) => Promise<ParsedHistory>;
  /** Wall clock in ms (events age). */
  wallNow?: () => number;
}

export interface HistoryController {
  store: StoreApi<HistoryData>;
  load(t: Unix, opts?: { signal?: AbortSignal }): Promise<void>;
  reset(): void;
}

function initial(): HistoryData {
  return {
    status: "idle", error: null, range: null, res: "5m",
    xray: new ColumnSeries(XRAY_KEYS), wind: new ColumnSeries(WIND_KEYS), seriesRev: 0,
    flares: [], cmes: [], alerts: [], eventsSince: null,
  };
}

/**
 * Build a history store and its loader. The app uses the one below; tests build their own against a mock.
 *
 * load(t): fetches the replay window for xray and wind (5 min res, snapped from/to) and, when older than 5 min,
 * the 7 days of events. Nothing is applied until every response has arrived and validated, so an error keeps
 * the old data. The newest call wins: an older one in flight is aborted and its result is dropped.
 */
export function createHistory(opts: HistoryOptions = {}): HistoryController {
  const base = opts.baseUrl ?? "";
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const wallNow = opts.wallNow ?? Date.now;
  const parse = opts.parse ?? parseOffThread;
  const store = (createStore<HistoryData>()(initial));

  let gen = 0; // bumped by every load/reset; a result is applied only if its gen is still current
  let current: AbortController | null = null;
  let eventsAt: number | null = null; // wall-clock ms of the last successful events load

  const get = async (path: string, signal: AbortSignal) => {
    const res = await fetchImpl(`${base}${API_PREFIX}${path}`, { signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
    return res;
  };

  const serverNow = opts.serverNow ?? (async (signal: AbortSignal): Promise<Unix> => {
    const { clock, clockAt } = liveStore.getState();
    if (clock) return liveServerNow(clock, clockAt);
    const r = healthResponseSchema.safeParse(await (await get("/health", signal)).json());
    if (!r.success) throw new Error("health: invalid response");
    return r.data.clock.now;
  });

  async function fetchSeries(series: HistorySeries, from: Unix, to: Unix, res: HistoryRes, signal: AbortSignal) {
    const path = `/history?series=${series}&res=${res}&from=${from}&to=${to}`;
    const p = await parse(await (await get(path, signal)).text());
    if (p.series !== series || p.res !== res) throw new Error(`history: asked for ${series}/${res}, got ${p.series}/${p.res}`);
    return p;
  }

  async function fetchEvents(signal: AbortSignal) {
    const since = snapDown((await serverNow(signal)) - REPLAY_SPAN_S, "5m");
    const r = eventsResponseSchema.safeParse(await (await get(`/events?since=${since}`, signal)).json());
    if (!r.success) {
      const i = r.error.issues[0];
      throw new Error(`events: ${i ? `${i.path.join(".") || "(root)"}: ${i.message}` : "invalid"}`);
    }
    return { since, flares: r.data.flares ?? [], cmes: r.data.cmes ?? [], alerts: r.data.alerts ?? [] };
  }

  async function load(t: Unix, o: { signal?: AbortSignal } = {}): Promise<void> {
    const win = replayWindow(t);
    const mine = ++gen;
    current?.abort();
    const ctrl = (current = new AbortController());
    const ext = o.signal;
    if (ext?.aborted) ctrl.abort();
    else ext?.addEventListener("abort", () => ctrl.abort(), { once: true });
    /** Aborted by the caller or superseded by a newer call: apply nothing. */
    const dropped = () => mine !== gen || ctrl.signal.aborted;

    const cur = store.getState();
    const covered = cur.range !== null && cur.range[0] <= win.from && cur.range[1] >= win.to;
    const eventsStale = eventsAt === null || wallNow() - eventsAt > EVENTS_MAX_AGE_MS;

    try {
      if (covered) {
        if (cur.status !== "ready" || cur.error) store.setState({ status: "ready", error: null });
        if (!eventsStale) return;
        // Quiet refresh: a failure here leaves the (still valid) replay alone; the next call tries again.
        try {
          const ev = await fetchEvents(ctrl.signal);
          if (!dropped()) applyEvents(ev);
        } catch {
          /* offline, aborted or invalid: keep what is shown */
        }
        return;
      }

      store.setState({ status: "loading", error: null });
      const [x, w, ev] = await Promise.all([
        fetchSeries("xray", win.from, win.to, win.res, ctrl.signal),
        fetchSeries("wind", win.from, win.to, win.res, ctrl.signal),
        eventsStale ? fetchEvents(ctrl.signal) : null,
      ]);
      if (dropped()) return;
      const s = store.getState();
      fill(s.xray, x);
      fill(s.wind, w);
      store.setState({ status: "ready", error: null, range: [win.from, win.to], res: win.res, seriesRev: s.seriesRev + 1 });
      if (ev) applyEvents(ev);
    } catch (e) {
      if (mine === gen && !ctrl.signal.aborted) {
        store.setState({ status: "error", error: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      if (mine === gen) {
        if (ctrl.signal.aborted) {
          // The caller aborted and nothing replaced this call: go back to what is on screen.
          const s = store.getState();
          if (s.status === "loading") store.setState({ status: s.range ? "ready" : "idle" });
        }
        current = null;
      }
    }
  }

  function applyEvents(ev: Awaited<ReturnType<typeof fetchEvents>>): void {
    eventsAt = wallNow();
    store.setState({ flares: ev.flares, cmes: ev.cmes, alerts: ev.alerts, eventsSince: ev.since });
  }

  function reset(): void {
    gen++;
    current?.abort();
    current = null;
    eventsAt = null;
    store.setState(initial(), true);
  }

  return { store, load, reset };
}

/** Replace a series' content with a parsed window. The arrays are copied once into the series' own buffers. */
function fill<K extends string>(dst: ColumnSeries<K>, p: ParsedHistory): void {
  dst.clear();
  dst.append(p.cols as unknown as Columns<K>); // Float64Array columns index like number[]; NaN stays NaN
}

// ---- parsing off the main thread (GAP_ANALYSIS F2) ---------------------------

interface Pending { text: string; resolve(p: ParsedHistory): void; reject(e: Error): void }

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, Pending>();

/**
 * Parse in history.worker.ts (typed arrays come back as transferables). Without Worker (Node) or when the
 * worker cannot start or crashes, the same function runs on the main thread: this is a speed-up, not a dependency.
 */
export function parseOffThread(text: string): Promise<ParsedHistory> {
  const w = getWorker();
  if (!w) return Promise.resolve().then(() => parseHistoryText(text));
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { text, resolve, reject });
    const req: HistoryWorkerRequest = { id, text };
    w.postMessage(req);
  });
}

function getWorker(): Worker | null {
  if (worker) return worker;
  if (workerBroken || typeof Worker === "undefined") return null;
  try {
    const w = new Worker(new URL("../lib/history.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<HistoryWorkerResponse>) => {
      const m = e.data;
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
    };
    w.onerror = () => {
      // Could not load or crashed: finish everything queued on the main thread and stop using the worker.
      workerBroken = true;
      worker = null;
      w.terminate();
      for (const [id, p] of pending) {
        pending.delete(id);
        try {
          p.resolve(parseHistoryText(p.text));
        } catch (err) {
          p.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    };
    worker = w;
    return w;
  } catch {
    workerBroken = true;
    return null;
  }
}

// ---- the app's store -----------------------------------------------------------

const app = createHistory();

/** The app's one history store (replay). */
export const historyStore: StoreApi<HistoryData> = app.store;

export function useHistory<T>(selector: (s: HistoryData) => T): T {
  return useStore(historyStore, selector);
}

/** Load the replay window around `t` and the last 7 days of events; see createHistory. Never rejects. */
export function loadHistory(t: Unix, opts?: { signal?: AbortSignal }): Promise<void> {
  return app.load(t, opts);
}

/** Back to the empty state (e.g. on leaving replay); aborts a load in flight. */
export function resetHistory(): void {
  app.reset();
}
