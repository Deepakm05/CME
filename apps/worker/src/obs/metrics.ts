// Freshness and health metrics (GAP_ANALYSIS O1; backend design section 9).
// Pure functions and a small in-memory tracker: no Node or Workers-only APIs, so the same code runs under
// `tsx --test` and in the Worker. All times are unix SECONDS unless a name says otherwise (`pushP95` is ms).

import type { FeedId, FeedLag, HealthStatus } from "@cme/shared";

/** Samples older than this (by their ingest time) are dropped. */
export const LAG_WINDOW_S = 3600;
/** Alarm lag above this makes the backend `degraded` (SLI: alarm lag < 30 s). */
export const ALARM_DEGRADED_S = 30;

interface Sample {
  at: number; // unix seconds when the sample was recorded
  value: number;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Nearest-rank percentile (p in 0..100) of an ascending-sorted array, rounded to 0.1. Null when empty. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return round1(sorted[rank - 1]);
}

const keepFresh = (samples: Sample[], now: number): Sample[] =>
  samples.filter((s) => s.at > now - LAG_WINDOW_S);

const p95Of = (samples: Sample[]): number | null =>
  percentile(samples.map((s) => s.value).sort((a, b) => a - b), 95);

/**
 * Ingest lag per feed: `ingestedAt - dataTs - cadenceS`, clamped at 0. Keeps the last hour of samples.
 * Push durations (ms) are tracked the same way so `/health` can report push_ms p95.
 */
export class LagTracker {
  private readonly lagByFeed = new Map<FeedId, Sample[]>();
  private pushSamples: Sample[] = [];

  record(feed: FeedId, ingestedAt: number, dataTs: number, cadenceS: number): void {
    const lag = Math.max(0, ingestedAt - dataTs - cadenceS);
    const list = keepFresh(this.lagByFeed.get(feed) ?? [], ingestedAt);
    list.push({ at: ingestedAt, value: lag });
    this.lagByFeed.set(feed, list);
  }

  /** p50 and p95 ingest lag (seconds) per feed over the last hour. Null values when a feed has no samples. */
  lags(now: number, feeds: FeedId[]): FeedLag[] {
    return feeds.map((feed) => {
      const list = keepFresh(this.lagByFeed.get(feed) ?? [], now);
      if (this.lagByFeed.has(feed)) this.lagByFeed.set(feed, list);
      const sorted = list.map((s) => s.value).sort((a, b) => a - b);
      return { feed, p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
    });
  }

  /** Records one tick's push duration in milliseconds. `at` defaults to now (unix seconds). */
  recordPush(ms: number, at: number = Date.now() / 1000): void {
    this.pushSamples = keepFresh(this.pushSamples, at);
    this.pushSamples.push({ at, value: ms });
  }

  /** p95 push duration in milliseconds over the last hour, or null when there are no samples. */
  pushP95(now: number): number | null {
    this.pushSamples = keepFresh(this.pushSamples, now);
    return p95Of(this.pushSamples);
  }
}

/** How late the alarm fired, in seconds (>= 0). Null when the alarm was not scheduled. */
export function alarmLagS(scheduledAtMs: number | null, firedAtMs: number): number | null {
  if (scheduledAtMs === null) return null;
  return Math.max(0, (firedAtMs - scheduledAtMs) / 1000);
}

/**
 * `down` when feeds exist and every one is stale; `degraded` when any feed is stale or alarm lag > 30 s;
 * otherwise `ok`. An empty feed list is never `down`.
 */
export function healthStatus(feeds: { stale: boolean }[], alarmLagS: number | null): HealthStatus {
  if (feeds.length > 0 && feeds.every((f) => f.stale)) return "down";
  if (feeds.some((f) => f.stale) || (alarmLagS !== null && alarmLagS > ALARM_DEGRADED_S)) return "degraded";
  return "ok";
}
