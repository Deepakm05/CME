/**
 * The in-memory state every read is served from (NFR-5): the 7-day sample rings and the feed states.
 * Rebuilt from SQLite when the Durable Object starts; updated with memory.apply() after each committed tick.
 */
import { LIMITS, STATE_WINDOW_S, type Alert, type FeedDef, type FeedId, type FeedStatus, type LiveState, type Unix } from "@cme/shared";
import type { FeedState, Sql, WorkerFeed } from "../types.ts";
import { loadAlerts, loadFeedStates, loadWindSince, loadXraySince } from "../db/rows.ts";
import { SAMPLE_RETENTION_S, type PendingTick } from "./commit.ts";
import { windRing, windSeries, xrayRing, xraySeries, type WindRing, type XrayRing } from "./series.ts";

/** A feed that has never been polled: due now, no data. */
export const defaultFeedState = (id: FeedId, now: Unix): FeedState => ({
  id, etags: {}, lastOkAt: null, dataTs: null, error: null, failCount: 0, nextAt: now,
});

/** stale = no data yet, or the newest data is older than the feed's staleAfterS. */
export function toFeedStatus(def: FeedDef, s: FeedState, now: Unix): FeedStatus {
  return {
    id: def.id,
    label: def.label,
    cadenceS: def.cadenceS,
    staleAfterS: def.staleAfterS,
    lastOkAt: s.lastOkAt,
    dataTs: s.dataTs,
    error: s.error,
    stale: s.dataTs === null || now - s.dataTs > def.staleAfterS,
  };
}

/**
 * Whether clients need to hear about a status change. lastOkAt is ignored on purpose: a 304 only bumps it,
 * and that must not create a delta (GAP S1). Clients see the newer lastOkAt with the next real change.
 */
export function feedStatusChanged(a: FeedStatus, b: FeedStatus): boolean {
  return a.id !== b.id || a.label !== b.label || a.cadenceS !== b.cadenceS || a.staleAfterS !== b.staleAfterS
    || a.dataTs !== b.dataTs || a.error !== b.error || a.stale !== b.stale;
}

/** LiveState.alerts holds active alerts plus those raised or cleared in the last day. */
export const ALERT_WINDOW_S = 86_400;

const alertInWindow = (a: Alert, from: Unix) => a.clearedAt === null || a.raisedAt >= from || a.clearedAt >= from;

const byRaised = (a: Alert, b: Alert) => a.raisedAt - b.raisedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * At most `limit` alerts (LIMITS.alerts: the client rejects a longer list): every active alert first (newest
 * raised if even those are too many), then the most recently cleared ones. Returned sorted by raisedAt, id.
 */
export function capAlerts(alerts: readonly Alert[], limit: number = LIMITS.alerts): Alert[] {
  if (alerts.length <= limit) return [...alerts].sort(byRaised);
  const active = alerts.filter((a) => a.clearedAt === null).sort((a, b) => byRaised(b, a));
  const cleared = alerts.filter((a) => a.clearedAt !== null)
    .sort((a, b) => b.clearedAt! - a.clearedAt! || byRaised(b, a));
  return [...active, ...cleared].slice(0, limit).sort(byRaised);
}

export class Memory {
  readonly xray: XrayRing = xrayRing();
  readonly wind: WindRing = windRing();
  readonly feeds = new Map<FeedId, FeedState>();
  /** Active alerts plus the last day's cleared ones, by id (pruneAlerts drops older ones). */
  readonly alerts = new Map<string, Alert>();
  /** The feeds reported in LiveState, in order. */
  readonly defs: readonly WorkerFeed[];
  private cache: { seq: number; str: string } | null = null;

  constructor(defs: readonly WorkerFeed[], now: Unix) {
    this.defs = defs;
    for (const d of defs) this.feeds.set(d.id, defaultFeedState(d.id, now));
  }

  /**
   * Loads the last 7 days of samples and every stored feed state (nextAt = now). Feeds in `feeds` with no
   * stored state get defaults. The schema must already exist (migrate).
   */
  static rebuild(sql: Sql, now: Unix, feeds: readonly WorkerFeed[]): Memory {
    const m = new Memory(feeds, now);
    const from = now - SAMPLE_RETENTION_S;
    m.xray.append(loadXraySince(sql, from));
    m.wind.append(loadWindSince(sql, from));
    for (const [id, s] of loadFeedStates(sql, now)) m.feeds.set(id, s);
    for (const a of loadAlerts(sql, now - ALERT_WINDOW_S)) m.alerts.set(a.id, a);
    return m;
  }

  /** Applies a tick that commitTick has already written. */
  apply(p: PendingTick): void {
    this.xray.append(p.xray);
    this.wind.append(p.wind);
    for (const s of p.feeds) this.feeds.set(s.id, s);
    for (const a of p.alerts ?? []) this.alerts.set(a.id, a);
  }

  /** Drops cleared alerts that left the LiveState window. */
  pruneAlerts(now: Unix): void {
    for (const [id, a] of this.alerts) if (!alertInWindow(a, now - ALERT_WINDOW_S)) this.alerts.delete(id);
  }

  feedState(id: FeedId, now: Unix): FeedState {
    return this.feeds.get(id) ?? defaultFeedState(id, now);
  }

  /** FeedStatus of every reported feed, in `defs` order. */
  feedStatuses(now: Unix): FeedStatus[] {
    return this.defs.map((d) => toFeedStatus(d, this.feedState(d.id, now), now));
  }

  /** Regions, flares and CMEs are empty until Phases 3–4 fill them. */
  liveState(seq: number, now: Unix): LiveState {
    const from = now - STATE_WINDOW_S;
    return {
      seq,
      clock: { now, speed: 1, mode: "live", scenario: null },
      xray: xraySeries(this.xray, from, now),
      wind: windSeries(this.wind, from, now),
      regions: [],
      flares: [],
      cmes: [],
      alerts: capAlerts([...this.alerts.values()].filter((a) => alertInWindow(a, now - ALERT_WINDOW_S))),
      feeds: this.feedStatuses(now),
    };
  }

  /**
   * JSON of liveState for GET /state (§7: ETag "<seq>"). Rebuilt only when seq changes, so clock.now and
   * the stale flags are those of the first request after the change; clients re-check staleness themselves.
   */
  stateJson(seq: number, now: Unix): string {
    if (this.cache?.seq !== seq) this.cache = { seq, str: JSON.stringify(this.liveState(seq, now)) };
    return this.cache.str;
  }
}
