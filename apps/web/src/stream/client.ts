import { API_PREFIX, PROTOCOL_VERSION, checkLiveState, checkServerMessage, helloSchema, type Alert, type ClientMessage, type LiveState, type ServerMessage } from "@cme/shared";
import type { Conn, LiveStore } from "../store/live.ts";
import { recordArrival } from "../lib/arrival.ts";
import { serverNow } from "../lib/api.ts";
import { applyAlert, applyDelta, applySnapshot, toLiveState } from "./apply.ts";

export interface StateCache {
  load(): Promise<LiveState | null>;
  save(state: LiveState): Promise<void>;
}

export interface LiveStreamOptions {
  store: LiveStore;
  /** "" = same origin (browser). Tests pass "http://localhost:<port>". */
  baseUrl?: string;
  cache?: StateCache;
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
  /** Reconnect delay: base × 2^(failures−1), capped, with jitter. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Switch to polling GET /state after this many WS attempts in a row that got no message. */
  pollAfterFailures?: number;
  pollMs?: number;
  /** Reconnect when nothing (not even a ping, every 15 s) has arrived for this long. */
  silenceMs?: number;
  /** Reconnect from scratch if a requested resync snapshot doesn't come. */
  resyncTimeoutMs?: number;
  cacheEveryMs?: number;
  random?: () => number;
  /** Called for each new `alert` message, after it is in the store (toast / sound / notification). */
  onAlert?: (alert: Alert) => void;
  /** GAP D3: reloads the page when the server's `hello.minClient` is above this build's protocol. Default: location.reload(). */
  reload?: () => void;
  /** Where the "already reloaded once for this minClient" flag lives (loop guard). Default: sessionStorage, else memory. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

/** Close codes the real backend uses to refuse or end a socket it had already accepted (backend design section 7.1). */
const CLOSE_ORIGIN_NOT_ALLOWED = 1008;
const CLOSE_SERVICE_RESTART = 1012;
const CLOSE_TOO_MANY_SOCKETS = 1013;
const RESTART_SPREAD_MS = 3000; // GAP S2
const RELOAD_FLAG = "cme.helloReload";

type Timer = ReturnType<typeof setTimeout>;

/**
 * Keeps the live store in step with the server (docs/design/frontend section 3):
 *
 * - Boot: paint the IndexedDB copy, then GET /state, then open WS /stream?since=<seq>.
 * - Every sequenced message must be seq + 1. A gap sends {"type":"resync"} and drops messages until the
 *   snapshot arrives; a duplicate (seq ≤ current) is ignored.
 * - On close: reconnect with backoff, resuming with ?since=<seq> so the server replays what was missed.
 * - After 3 failed attempts in a row: also poll GET /state every 30 s until the socket is back. An attempt only
 *   counts as successful once the server has delivered a valid snapshot, delta, alert or ping: the real backend
 *   accepts a socket it is about to refuse, so "opened" alone proves nothing.
 * - Close codes: 1008 (origin not allowed) = never reconnect, status "rejected", poll GET /state read-only;
 *   1013 (too many sockets) = poll GET /state at once and retry the socket slowly; 1012 (service restart) =
 *   reconnect after a random 0-3 s.
 * - `hello` with minClient above PROTOCOL_VERSION: save the cache and reload once (GAP D3).
 *
 * No React in here, so it runs unchanged under node:test against the mock server.
 */
export class LiveStream {
  private readonly o: Required<Omit<LiveStreamOptions, "cache" | "onAlert" | "reload" | "storage">> &
    Pick<LiveStreamOptions, "cache" | "onAlert" | "reload" | "storage">;
  private ws: WebSocket | null = null;
  private stopped = true;
  private opened = false; // the current socket connected
  private confirmed = false; // the current socket has delivered a valid message (the only proof it is healthy)
  private rejected = false; // closed with 1008: never reconnect
  private reloading = false;
  private memFlag: string | null = null; // RELOAD_FLAG when there is no sessionStorage
  private awaitingSnapshot = false;
  private dirty = false; // store changed since the last cache save
  private reconnectTimer: Timer | null = null;
  private silenceTimer: Timer | null = null;
  private resyncTimer: Timer | null = null;
  private pollTimer: Timer | null = null;
  private cacheTimer: Timer | null = null;
  private pollAbort: AbortController | null = null;

  constructor(opts: LiveStreamOptions) {
    this.o = {
      baseUrl: "",
      WebSocketImpl: globalThis.WebSocket,
      fetchImpl: globalThis.fetch.bind(globalThis),
      backoffBaseMs: 500,
      backoffMaxMs: 30_000,
      pollAfterFailures: 3,
      pollMs: 30_000,
      silenceMs: 40_000,
      resyncTimeoutMs: 10_000,
      cacheEveryMs: 30_000,
      random: Math.random,
      ...opts,
    };
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.rejected = false;
    this.setConn({ status: "connecting" });

    const loaded = await this.o.cache?.load().catch(() => null);
    if (this.stopped) return;
    // A cache written by an older version may not match the contract any more: skip it rather than paint junk.
    const cached = loaded ? checkLiveState(loaded) : null;
    // Paint only: the cached seq may belong to another server run, so never resume from it.
    if (cached?.ok && this.o.store.getState().seq === null) applySnapshot(this.o.store, cached.value, "cache", false);

    await this.fetchState();
    if (this.stopped) return;
    this.connect();
    if (this.o.cache) this.cacheTimer = setInterval(() => void this.saveCache(), this.o.cacheEveryMs);
  }

  stop(): void {
    this.stopped = true;
    for (const t of [this.reconnectTimer, this.silenceTimer, this.resyncTimer]) if (t) clearTimeout(t);
    for (const t of [this.pollTimer, this.cacheTimer]) if (t) clearInterval(t);
    this.reconnectTimer = this.silenceTimer = this.resyncTimer = this.pollTimer = this.cacheTimer = null;
    this.pollAbort?.abort();
    this.dropSocket();
    void this.saveCache();
  }

  /** Reconnect now (e.g. the browser's `online` event) instead of waiting out the backoff. */
  reconnectNow(): void {
    if (this.stopped || this.rejected || this.ws?.readyState === 1 /* OPEN */) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.dropSocket();
    this.connect();
  }

  /** Write the current state to the cache, if it changed. Also called on stop() and page hide. */
  async saveCache(): Promise<void> {
    if (!this.o.cache || !this.dirty) return;
    const s = toLiveState(this.o.store.getState());
    if (!s) return;
    this.dirty = false;
    await this.o.cache.save(s).catch(() => {
      this.dirty = true;
    });
  }

  // ---- WebSocket -------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return;
    const seq = this.o.store.getState().seq;
    const since = seq !== null && !this.awaitingSnapshot ? `?since=${seq}` : "";
    this.awaitingSnapshot = false;
    this.opened = false;
    this.confirmed = false;

    let ws: WebSocket;
    try {
      ws = new this.o.WebSocketImpl(`${this.wsBase()}${API_PREFIX}/stream${since}`);
    } catch {
      this.onClose();
      return;
    }
    this.ws = ws;
    // The badge goes live as soon as the socket opens (a quiet server may send nothing for a minute), but this
    // does not reset the failure count or stop polling: only a delivered message does (see confirm()).
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.opened = true;
      if (!this.pollTimer) this.setConn({ status: "live" });
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    // Either event ends this socket, once. Browsers send close after error, Node's WebSocket may not;
    // never call ws.close() from onerror (it can re-fire error). Only close events carry a code.
    ws.onclose = (ev) => this.ws === ws && this.onClose(ev?.code);
    ws.onerror = () => this.ws === ws && this.onClose();
    this.armSilence();
  }

  private onMessage(raw: unknown): void {
    let m: unknown;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }

    this.armSilence();
    this.setConn({ lastMessageAt: Date.now() / 1000 });
    if ((m as { type?: unknown } | null)?.type === "hello") return this.onHello(m);
    const checked = checkServerMessage(m);
    if (checked.ok) {
      this.confirm();
      return this.handle(checked.value);
    }
    // Unknown message types are skipped (the server may add new ones). Anything else that fails the contract
    // is never applied; if it carried a seq, what it held is now missing, so ask for a fresh snapshot.
    if (checked.error === "unknown") return;
    this.setConn({ invalid: this.o.store.getState().conn.invalid + 1, lastInvalid: checked.error });
    if (typeof (m as { seq?: unknown }).seq === "number" && !this.resyncTimer) this.requestResync();
  }

  /**
   * The socket has delivered something valid, so the connection counts as good: reset the failure count and
   * stop polling. A hello alone does not count (the server could still close right after it).
   */
  private confirm(): void {
    if (this.confirmed) return;
    this.confirmed = this.opened = true;
    this.stopPolling();
    this.setConn({ status: "live", failures: 0 });
  }

  /** GAP D3: an old tab saves its cache and reloads once when the server demands a newer protocol. */
  private onHello(m: unknown): void {
    const hello = helloSchema.safeParse(m);
    if (!hello.success) {
      this.setConn({ invalid: this.o.store.getState().conn.invalid + 1, lastInvalid: "hello" });
      return;
    }
    const { minClient } = hello.data;
    if (minClient <= PROTOCOL_VERSION) {
      this.flag("remove"); // this build is accepted: a later bump may reload again
      return;
    }
    // Reloaded already for this minClient and still too old (stale bundle): stay as we are rather than loop.
    if (this.reloading || this.flag("get") === String(minClient)) return;
    this.reloading = true;
    this.flag("set", String(minClient));
    void this.saveCache().finally(() => (this.o.reload ?? (() => location.reload()))());
  }

  private flag(op: "get"): string | null;
  private flag(op: "set", v: string): void;
  private flag(op: "remove"): void;
  private flag(op: "get" | "set" | "remove", v?: string): string | null | void {
    try {
      const st = this.o.storage ?? globalThis.sessionStorage;
      if (op === "get") return st.getItem(RELOAD_FLAG);
      if (op === "set") return st.setItem(RELOAD_FLAG, v!);
      return st.removeItem(RELOAD_FLAG);
    } catch {
      // no storage (private mode, node): keep the guard in memory, which at least covers this page load
      if (op === "get") return this.memFlag;
      this.memFlag = op === "set" ? v! : null;
    }
  }

  private handle(m: ServerMessage): void {
    const store = this.o.store;
    if (m.type === "ping") {
      this.send({ type: "pong", ts: m.ts });
      return;
    }
    if (m.type === "snapshot") {
      const afterGap = this.resyncTimer !== null;
      if (this.resyncTimer) clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
      applySnapshot(store, m.data, "ws");
      if (afterGap) this.setConn({ resyncs: store.getState().conn.resyncs + 1 });
      this.dirty = true;
      return;
    }

    const seq = store.getState().seq;
    if (this.resyncTimer || seq === null) return; // waiting for a snapshot
    if (m.seq <= seq) return; // duplicate / already applied
    if (m.seq !== seq + 1) {
      this.requestResync();
      return;
    }
    if (store.getState().conn.source !== "ws") this.setConn({ source: "ws" });
    if (m.type === "delta") {
      applyDelta(store, m.seq, m.data);
      this.recordArrivals(m.data.xray?.t, m.data.wind?.t);
    } else {
      applyAlert(store, m.seq, m.data);
      this.o.onAlert?.(m.data);
    }
    this.dirty = true;
  }

  /** Only at real-time speed: in a sped-up mock scenario "how late" has no meaning. */
  private recordArrivals(xrayT?: number[], windT?: number[]): void {
    const { clock, clockAt, arrivals } = this.o.store.getState();
    if (!clock || clock.speed !== 1 || !(xrayT?.length || windT?.length)) return;
    const now = serverNow(clock, clockAt);
    this.o.store.setState({
      arrivals: {
        xray: xrayT?.length ? recordArrival(arrivals.xray, now - xrayT[xrayT.length - 1]) : arrivals.xray,
        wind: windT?.length ? recordArrival(arrivals.wind, now - windT[windT.length - 1]) : arrivals.wind,
      },
    });
  }

  private requestResync(): void {
    this.setConn({ gaps: this.o.store.getState().conn.gaps + 1 });
    this.send({ type: "resync" });
    this.resyncTimer = setTimeout(() => {
      // no snapshot came: reconnect without ?since so the server must send one
      this.resyncTimer = null;
      this.awaitingSnapshot = true;
      this.ws?.close();
    }, this.o.resyncTimeoutMs);
  }

  private onClose(code?: number): void {
    this.ws = null;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.resyncTimer) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
      this.awaitingSnapshot = true;
    }
    if (this.stopped) return;

    if (code === CLOSE_ORIGIN_NOT_ALLOWED) {
      // Retrying cannot help (the Origin will not change): stay closed, keep the page fed by polling /state.
      this.rejected = true;
      this.startPolling();
      this.setConn({ status: "rejected" });
      return;
    }

    // Only a socket that delivered something counts as having worked; one closed straight after opening is a failure.
    let failures = this.confirmed ? 1 : this.o.store.getState().conn.failures + 1;
    const full = code === CLOSE_TOO_MANY_SOCKETS;
    if (full) failures = Math.max(failures, this.o.pollAfterFailures);
    this.setConn({ failures, status: this.pollTimer ? "polling" : "reconnecting" });
    if (failures >= this.o.pollAfterFailures) this.startPolling();

    let delay: number;
    if (code === CLOSE_SERVICE_RESTART) {
      delay = this.o.random() * RESTART_SPREAD_MS; // GAP S2: spread the herd
    } else {
      // A full server is retried at the slowest backoff, so that polling carries the load meanwhile.
      const exp = Math.min(this.o.backoffMaxMs, full ? this.o.backoffMaxMs : this.o.backoffBaseMs * 2 ** (failures - 1));
      delay = exp * (0.5 + this.o.random() * 0.5);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** A connection that stays open but silent (half-open TCP, sleeping laptop) is treated as closed. */
  private armSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      if (!this.ws) return;
      this.dropSocket();
      this.onClose();
    }, this.o.silenceMs);
  }

  /** Close the socket without triggering onClose (the caller decides what happens next). */
  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    ws.close();
  }

  private send(m: ClientMessage): void {
    if (this.ws?.readyState === 1 /* OPEN */) this.ws.send(JSON.stringify(m));
  }

  // ---- REST ------------------------------------------------------------------

  private startPolling(): void {
    if (this.pollTimer || this.stopped) return;
    this.setConn({ status: "polling" });
    void this.fetchState();
    this.pollTimer = setInterval(() => void this.fetchState(), this.o.pollMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** GET /state into the store. Failures are fine: the socket or the next poll will catch up. */
  private async fetchState(): Promise<void> {
    this.pollAbort?.abort();
    const ctrl = (this.pollAbort = new AbortController());
    const timeout = setTimeout(() => ctrl.abort(), 5000); // boot must not wait long before trying the socket
    try {
      const res = await this.o.fetchImpl(`${this.o.baseUrl}${API_PREFIX}/state`, { signal: ctrl.signal });
      if (!res.ok) return;
      const checked = checkLiveState(await res.json());
      if (this.stopped || ctrl.signal.aborted) return;
      if (!checked.ok) {
        this.setConn({ invalid: this.o.store.getState().conn.invalid + 1, lastInvalid: `GET /state ${checked.error}` });
        return;
      }
      const s = checked.value;
      const cur = this.o.store.getState().seq;
      if (this.confirmed && cur !== null && s.seq <= cur) return; // the socket is already ahead
      applySnapshot(this.o.store, s, "rest");
      this.dirty = true;
    } catch {
      /* offline, timed out or aborted */
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---- helpers ---------------------------------------------------------------

  private wsBase(): string {
    if (this.o.baseUrl) return this.o.baseUrl.replace(/^http/, "ws");
    return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  }

  private setConn(patch: Partial<Conn>): void {
    const cur = this.o.store.getState().conn;
    this.o.store.setState({ conn: { ...cur, ...patch } });
  }
}
