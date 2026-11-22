/**
 * HubCore: everything SpaceWeatherHub does, as plain TypeScript (backend design §5–§9). hub.ts is a thin
 * adapter that passes in ctx.storage.sql, transactionSync, the hibernatable sockets and Date.now(); tests pass
 * node:sqlite (test/sqlite.ts), fake sockets and a fixture-serving fetch.
 *
 * Ordering rule for anything sequenced (R3): build → one SQLite transaction (rows + meta.seq) → memory →
 * delta ring → broadcast. Every step after the `await` of a tick's polls is synchronous, so a request handled
 * by the Durable Object between two awaits never sees a half-applied tick.
 */
import {
  PROTOCOL_VERSION, type Alert, type FeedId, type FeedStatus, type HealthResponse, type HelloMessage, type Unix,
} from "@cme/shared";
import type { FeedState, Sql, Transaction, WorkerFeed } from "./types.ts";
import { ACTIVE_FEEDS } from "./feeds/defs.ts";
import { afterPoll, dueFeeds, FAST_INTERVAL_S, nextWakeAt, type PollOutcome } from "./feeds/scheduler.ts";
import { migrate, readMeta, readSeq, writeMeta } from "./db/migrate.ts";
import { loadFeedStates, upsertAlert } from "./db/rows.ts";
import { commitTick, emptyTick, pruneSamples, type PendingTick } from "./state/commit.ts";
import { DeltaRing, sequenced, type Sequenced } from "./state/deltaRing.ts";
import { feedStatusChanged, Memory, toFeedStatus } from "./state/memory.ts";
import { logEvent } from "./obs/log.ts";
import { alarmLagS as computeAlarmLag, healthStatus, LagTracker } from "./obs/metrics.ts";
import { compileAllowList } from "./origin.ts";
import { fetchDue, keepFeedEtags, mustPersist, normaliseFeed, type FeedLog } from "./tick.ts";
import {
  CLOSE, isIdle, MAX_CLIENT_MSG, PING_EVERY_S, trySend, tryClose, type HubSocket,
} from "./sockets.ts";

export interface HubConfig {
  /** NOAA SWPC base URL (env.FEED_BASE). */
  feedBase: string;
  /** env.ADMIN_TOKEN; unset or empty disables POST /admin/test-alert (404). */
  adminToken?: string;
  /** env.ALLOWED_ORIGINS. */
  allowedOrigins: string;
}

export interface HubDeps {
  sql: Sql;
  tx: Transaction;
  config: HubConfig;
  /** The open sockets, from the runtime (ctx.getWebSockets()) so the list survives hibernation. */
  sockets: () => HubSocket[];
  fetchFn?: typeof fetch;
  /** Per-fetch timeout [R1]; default 8 s (poll.ts). */
  pollTimeoutMs?: number;
  /** Feeds to poll; default ACTIVE_FEEDS. */
  feeds?: readonly WorkerFeed[];
  /** Log sink for the JSON lines; default console.log. */
  log?: (line: string) => void;
}

/** TEST alerts clear themselves after this long (§6). */
export const TEST_ALERT_TTL_S = 600;
/** meta.alarm_last_at is written at most this often (the in-memory value is exact). */
export const ALARM_META_EVERY_MS = 60_000;
/** The watchdog re-arms the alarm when it has not run for this long [R4]. */
export const WATCHDOG_STALL_MS = 30_000;
export const PRUNE_EVERY_S = 3600;

const sec = (ms: number): Unix => Math.floor(ms / 1000);
const round1 = (x: number) => Math.round(x * 10) / 10;

export class HubCore {
  readonly sql: Sql;
  readonly tx: Transaction;
  readonly config: HubConfig;
  readonly feeds: readonly WorkerFeed[];
  readonly sockets: () => HubSocket[];
  readonly memory: Memory;
  readonly ring: DeltaRing;
  readonly lag = new LagTracker();
  readonly allowOrigins: RegExp[];
  seq: number;

  /** When the pending alarm is due (ms); set by the adapter whenever it calls setAlarm. */
  scheduledAtMs: number | null = null;
  /** How late the last alarm fired, or how stalled the watchdog found it (s). */
  alarmLagS: number | null = null;
  /** When alarm() last ran (ms). Memory is exact; meta.alarm_last_at is a throttled copy for restarts. */
  alarmLastAtMs: number | null;

  private readonly fetchFn?: typeof fetch;
  private readonly pollTimeoutMs?: number;
  private readonly logSink: (line: string) => void;
  /** The feed_status rows as last written, to apply the write policy (tick.ts mustPersist). */
  private readonly stored = new Map<FeedId, FeedState>();
  /** The FeedStatus clients were last told about, to detect visible changes incl. stale transitions. */
  private readonly reported = new Map<FeedId, FeedStatus>();
  /** Feeds whose ring was empty at start: their next poll uses the backfill URLs (once). */
  readonly backfill = new Set<FeedId>();
  private alarmMetaAtMs: number | null = null;
  private lastPingS = -Infinity;
  private lastPruneS = -Infinity;

  /** Startup (R3): migrate, read seq, rebuild memory from SQLite. Synchronous; run inside blockConcurrencyWhile. */
  constructor(deps: HubDeps, nowMs: number) {
    this.sql = deps.sql;
    this.tx = deps.tx;
    this.config = deps.config;
    this.feeds = deps.feeds ?? ACTIVE_FEEDS;
    this.sockets = deps.sockets;
    this.fetchFn = deps.fetchFn;
    this.pollTimeoutMs = deps.pollTimeoutMs;
    this.logSink = deps.log ?? ((l) => console.log(l));
    this.allowOrigins = compileAllowList(deps.config.allowedOrigins);

    const now = sec(nowMs);
    migrate(this.sql);
    this.seq = readSeq(this.sql);
    this.memory = Memory.rebuild(this.sql, now, this.feeds);
    this.ring = new DeltaRing(this.seq);

    // dataTs is not written on every new minute (tick.ts write policy): the rings know better.
    const ringTs: Partial<Record<FeedId, number | null>> = { goes_xray: this.memory.xray.lastTs(), rtsw: this.memory.wind.lastTs() };
    for (const [id, st] of this.memory.feeds) {
      const ts = ringTs[id];
      if (ts != null && (st.dataTs === null || ts > st.dataTs)) this.memory.feeds.set(id, { ...st, dataTs: ts });
    }
    for (const [id, st] of loadFeedStates(this.sql, now)) this.stored.set(id, st);
    for (const s of this.memory.feedStatuses(now)) this.reported.set(s.id, s);
    if (this.memory.xray.size === 0) this.backfill.add("goes_xray");
    if (this.memory.wind.size === 0) this.backfill.add("rtsw");

    const last = readMeta(this.sql, "alarm_last_at");
    this.alarmLastAtMs = last !== null && Number.isFinite(Number(last)) ? Number(last) : null;
  }

  log(evt: string, fields: Record<string, unknown>): void {
    try {
      logEvent(evt, fields, this.logSink);
    } catch {
      /* logging must never break the loop */
    }
  }

  socketCount(): number {
    return this.sockets().length;
  }

  broadcast(str: string): number {
    let n = 0;
    for (const ws of this.sockets()) if (trySend(ws, str)) n++;
    return n;
  }

  // ---- the tick (§5.2) -------------------------------------------------------------------------------------

  /**
   * One alarm tick. Never throws: a failing feed only marks that feed, and a failure anywhere else is logged.
   * Returns when the next alarm should fire (ms); the adapter calls setAlarm with it in a `finally`.
   */
  async tick(nowMs: number): Promise<number> {
    const started = Date.now();
    const now = sec(nowMs);
    this.alarmLagS = computeAlarmLag(this.scheduledAtMs, nowMs);
    this.alarmLastAtMs = nowMs;
    this.persistAlarmLastAt(nowMs);

    const feedLog: Partial<Record<FeedId, FeedLog>> = {};
    let msgs = 0;
    let polled = 0;
    try {
      const due = dueFeeds(this.feeds, this.memory.feeds, now);
      polled = due.length;
      const fetched = due.length
        ? await fetchDue(due, this.memory.feeds, this.config.feedBase, this.backfill, {
          fetchFn: this.fetchFn, timeoutMs: this.pollTimeoutMs,
        })
        : [];

      // ---- synchronous from here: build, commit, apply, broadcast ----
      const p: PendingTick = { ...emptyTick(), alerts: [] };
      const next = new Map<FeedId, FeedState>();
      const backfilled: FeedId[] = [];
      const after = { xray: this.memory.xray.lastTs(), wind: this.memory.wind.lastTs() };
      for (const f of fetched) {
        const id = f.feed.id;
        let outcome: PollOutcome;
        const entry: FeedLog = { st: "err", ms: f.ms };
        if (f.backfill) entry.backfill = true;
        if (!f.result.ok) {
          outcome = { kind: "error", error: f.result.error };
        } else if (f.result.poll.kind === "unchanged") {
          outcome = { kind: "unchanged" };
          entry.st = 304;
        } else {
          const n = normaliseFeed(id, f.result.poll.bodies, after);
          if (!n.ok) {
            outcome = { kind: "error", error: n.error };
          } else {
            p.xray.push(...n.xray);
            p.wind.push(...n.wind);
            entry.st = 200;
            entry.rows = n.xray.length + n.wind.length;
            outcome = { kind: "ok", dataTs: n.dataTs, etags: keepFeedEtags(f.feed, this.config.feedBase, f.result.poll.etags) };
            if (f.backfill) backfilled.push(id);
          }
        }
        if (outcome.kind === "error") entry.error = outcome.error;
        feedLog[id] = entry;
        next.set(id, afterPoll(f.feed, this.memory.feedState(id, now), now, outcome));
      }

      for (const a of this.memory.alerts.values()) {
        if (a.rule === "TEST" && a.clearedAt === null && now >= a.raisedAt + TEST_ALERT_TTL_S) p.alerts!.push({ ...a, clearedAt: now });
      }

      // Visible feed changes, including a feed that went stale with no poll at all.
      for (const def of this.feeds) {
        const fs = toFeedStatus(def, next.get(def.id) ?? this.memory.feedState(def.id, now), now);
        const prev = this.reported.get(def.id);
        if (!prev || feedStatusChanged(prev, fs)) p.feedStatuses.push(fs);
      }
      for (const [id, st] of next) if (mustPersist(this.stored.get(id), st)) p.feeds.push(st);

      let res: ReturnType<typeof commitTick>;
      try {
        res = commitTick(this.sql, this.tx, this.seq, p, now);
      } catch (e) {
        // Nothing was written; memory keeps the old states (and ETags) so the same data is fetched again.
        this.log("tick_error", { stage: "commit", error: e, seq: this.seq });
        for (const id of next.keys()) {
          const st = this.memory.feedState(id, now);
          this.memory.feeds.set(id, { ...st, nextAt: now + FAST_INTERVAL_S });
        }
        return this.nextWakeMs(now);
      }

      this.seq = res.seq;
      this.memory.apply(p);
      for (const [id, st] of next) this.memory.feeds.set(id, st);
      for (const s of p.feeds) this.stored.set(s.id, s);
      for (const s of p.feedStatuses) this.reported.set(s.id, s);
      for (const id of backfilled) this.backfill.delete(id);
      if (res.messages.length) {
        this.ring.push(...res.messages);
        for (const m of res.messages) this.broadcast(m.str);
        msgs = res.messages.length;
      }

      if (p.xray.length) this.lag.record("goes_xray", now, p.xray[p.xray.length - 1].ts, this.cadence("goes_xray"));
      if (p.wind.length) this.lag.record("rtsw", now, p.wind[p.wind.length - 1].ts, this.cadence("rtsw"));
      if (msgs) this.lag.recordPush(Date.now() - started, now);
    } catch (e) {
      this.log("tick_error", { stage: "tick", error: e, seq: this.seq });
    }

    this.keepAlive(now);
    this.hourly(now);
    if (polled || msgs) {
      this.log("tick", { seq: this.seq, ms: Date.now() - started, feeds: feedLog, sockets: this.socketCount(), msgs });
    }
    return this.nextWakeMs(now);
  }

  private cadence(id: FeedId): number {
    return this.feeds.find((f) => f.id === id)?.cadenceS ?? 60;
  }

  nextWakeMs(now: Unix): number {
    try {
      return nextWakeAt(this.memory.feeds, now) * 1000;
    } catch {
      return (now + FAST_INTERVAL_S) * 1000;
    }
  }

  private persistAlarmLastAt(nowMs: number): void {
    if (this.alarmMetaAtMs !== null && nowMs - this.alarmMetaAtMs < ALARM_META_EVERY_MS) return;
    try {
      writeMeta(this.sql, "alarm_last_at", String(nowMs));
      this.alarmMetaAtMs = nowMs;
    } catch (e) {
      this.log("tick_error", { stage: "alarm_last_at", error: e });
    }
  }

  /** Pings every PING_EVERY_S and closes sockets whose client stopped answering [S4]. */
  private keepAlive(now: Unix): void {
    try {
      if (now - this.lastPingS < PING_EVERY_S) return;
      this.lastPingS = now;
      const ping = JSON.stringify({ type: "ping", ts: now });
      for (const ws of this.sockets()) {
        let meta = null;
        try {
          meta = ws.meta();
        } catch {
          /* no attachment */
        }
        if (isIdle(meta, now)) tryClose(ws, CLOSE.IDLE, "no pong for 45 s");
        else trySend(ws, ping);
      }
    } catch (e) {
      this.log("tick_error", { stage: "ping", error: e });
    }
  }

  private hourly(now: Unix): void {
    if (now - this.lastPruneS < PRUNE_EVERY_S) return;
    this.lastPruneS = now;
    try {
      const deleted = pruneSamples(this.sql, now);
      this.memory.pruneAlerts(now);
      if (deleted) this.log("prune", { deleted });
    } catch (e) {
      this.log("tick_error", { stage: "prune", error: e });
    }
  }

  // ---- test alert (§6) ---------------------------------------------------------------------------------------

  /**
   * Raises a TEST alert and sends it at once, outside the tick. The alert row and meta.seq are written in one
   * transaction before memory or any socket sees it (R3). It clears itself TEST_ALERT_TTL_S later via a delta.
   */
  raiseTestAlert(nowMs: number): Alert {
    const now = sec(nowMs);
    const seq = this.seq + 1;
    const alert: Alert = {
      id: `TEST:${now}:${seq}`, rule: "TEST", level: "watch", title: "Test alert",
      message: "This is a test. Alerts are reaching this page.", refType: "test", refId: String(now),
      raisedAt: now, clearedAt: null,
    };
    const msg = sequenced({ type: "alert", seq, ts: now, data: alert });
    this.tx(() => {
      upsertAlert(this.sql, alert);
      writeMeta(this.sql, "seq", String(seq));
    });
    this.seq = seq;
    this.memory.alerts.set(alert.id, alert);
    this.ring.push(msg);
    this.broadcast(msg.str);
    this.log("alert", { id: alert.id, seq, sockets: this.socketCount() });
    return alert;
  }

  // ---- reads -----------------------------------------------------------------------------------------------

  /** Alarm lag for /health: the last alarm's lateness, or how overdue the pending alarm is if that is worse. */
  currentAlarmLagS(nowMs: number): number | null {
    const overdue = this.scheduledAtMs === null ? null : Math.max(0, (nowMs - this.scheduledAtMs) / 1000);
    if (this.alarmLagS === null && overdue === null) return null;
    return round1(Math.max(this.alarmLagS ?? 0, overdue ?? 0));
  }

  health(nowMs: number): HealthResponse {
    const now = sec(nowMs);
    const feeds = this.memory.feedStatuses(now);
    const alarmLagS = this.currentAlarmLagS(nowMs);
    return {
      clock: { now, speed: 1, mode: "live", scenario: null },
      feeds,
      status: healthStatus(feeds, alarmLagS),
      seq: this.seq,
      sockets: this.socketCount(),
      alarmLagS,
      lag: this.lag.lags(now, this.feeds.map((f) => f.id)),
    };
  }

  /** `{type:"snapshot"}` around the cached LiveState JSON, so the state is serialised once per seq (S3). */
  snapshotStr(now: Unix): string {
    return `{"type":"snapshot","seq":${this.seq},"ts":${now},"data":${this.memory.stateJson(this.seq, now)}}`;
  }

  // ---- WebSocket session (§7.1) ----------------------------------------------------------------------------

  /** A socket was accepted: hello first, then the missed messages if the ring has them, else a snapshot. */
  onOpen(ws: HubSocket, since: number | null, nowMs: number): void {
    const now = sec(nowMs);
    try {
      ws.setMeta({ connectedAt: now, lastSeen: now, ponged: false });
    } catch {
      /* attachment is best effort */
    }
    const hello: HelloMessage = { type: "hello", protocol: PROTOCOL_VERSION, minClient: 1, seq: this.seq, ts: now };
    trySend(ws, JSON.stringify(hello));
    const missed: Sequenced[] | null = since === null ? null : this.ring.since(since);
    if (missed === null) trySend(ws, this.snapshotStr(now));
    else for (const m of missed) trySend(ws, m.str);
  }

  /** `pong` marks the socket alive; `resync` gets a snapshot. Anything else is ignored. */
  onMessage(ws: HubSocket, data: string | ArrayBuffer, nowMs: number): void {
    if (typeof data !== "string" || data.length > MAX_CLIENT_MSG) return;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const type = (msg as { type?: unknown } | null)?.type;
    const now = sec(nowMs);
    if (type === "pong" || type === "resync") {
      try {
        const m = ws.meta();
        ws.setMeta({ connectedAt: m?.connectedAt ?? now, lastSeen: now, ponged: (m?.ponged ?? false) || type === "pong" });
      } catch {
        /* attachment is best effort */
      }
    }
    if (type === "resync") trySend(ws, this.snapshotStr(now));
  }

  // ---- watchdog (§5.4, R4) ---------------------------------------------------------------------------------

  /**
   * Called by the cron every minute. Returns true when the alarm has not run for WATCHDOG_STALL_MS and must be
   * re-armed now; records the stall as alarm lag so /health turns degraded.
   */
  watchdog(nowMs: number): boolean {
    const last = this.alarmLastAtMs;
    if (last === null || nowMs - last <= WATCHDOG_STALL_MS) return false;
    const stalledS = round1((nowMs - last) / 1000);
    this.alarmLagS = Math.max(this.alarmLagS ?? 0, stalledS);
    this.log("watchdog", { level: "error", msg: "alarm stalled, re-arming", stalledS, seq: this.seq });
    return true;
  }
}
