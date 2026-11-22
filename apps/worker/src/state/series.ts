/**
 * Fixed-capacity columnar ring of 1-minute samples on Float64Array (backend design §4: 7 days in memory, so
 * /history and LiveState never read SQLite). A missing value is stored as NaN and comes back out as null.
 */
import type { Sample, Unix, WindSeries, XraySeries } from "@cme/shared";
import type { WindRow, XrayRow } from "../types.ts";

/** 7 days at 1 minute. */
export const DEFAULT_CAPACITY = 10_080;

export type SeriesRow<F extends string> = { ts: Unix } & { [K in F]: number | null };

export interface SeriesRange<F extends string> {
  t: Unix[];
  cols: Record<F, Sample[]>;
}

export class SeriesRing<F extends string> {
  readonly capacity: number;
  readonly fields: readonly F[];
  private readonly ts: Float64Array;
  private readonly cols: Record<F, Float64Array>;
  private start = 0; // physical index of the oldest row
  private n = 0;

  constructor(fields: readonly F[], capacity = DEFAULT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`bad ring capacity ${capacity}`);
    this.capacity = capacity;
    this.fields = fields;
    this.ts = new Float64Array(capacity);
    this.cols = Object.fromEntries(fields.map((f) => [f, new Float64Array(capacity)])) as Record<F, Float64Array>;
  }

  get size(): number {
    return this.n;
  }

  private phys(i: number): number {
    return (this.start + i) % this.capacity;
  }

  lastTs(): Unix | null {
    return this.n ? this.ts[this.phys(this.n - 1)] : null;
  }

  firstTs(): Unix | null {
    return this.n ? this.ts[this.start] : null;
  }

  /**
   * Appends rows in order. A row whose ts is not newer than the last stored ts is ignored (the ring is
   * append-only and strictly ascending). When full, the oldest row is dropped. Returns how many were added.
   */
  append(rows: readonly SeriesRow<F>[]): number {
    let added = 0;
    let last = this.lastTs();
    for (const r of rows) {
      if (last !== null && r.ts <= last) continue;
      let p: number;
      if (this.n < this.capacity) {
        p = this.phys(this.n);
        this.n++;
      } else {
        p = this.start;
        this.start = (this.start + 1) % this.capacity;
      }
      this.ts[p] = r.ts;
      for (const f of this.fields) {
        const v = r[f];
        this.cols[f][p] = v === null || v === undefined ? NaN : v;
      }
      last = r.ts;
      added++;
    }
    return added;
  }

  /** Logical index of the first row with ts ≥ x (n if none). */
  private lowerBound(x: number): number {
    let lo = 0;
    let hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ts[this.phys(mid)] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Rows with from ≤ ts ≤ to, ascending, as columns (NaN → null). */
  range(from: Unix, to: Unix): SeriesRange<F> {
    const i0 = this.lowerBound(from);
    const end = this.upperBound(to);
    const t: Unix[] = [];
    const cols = Object.fromEntries(this.fields.map((f) => [f, [] as Sample[]])) as Record<F, Sample[]>;
    for (let i = i0; i < end; i++) {
      const p = this.phys(i);
      t.push(this.ts[p]);
      for (const f of this.fields) {
        const v = this.cols[f][p];
        cols[f].push(Number.isNaN(v) ? null : v);
      }
    }
    return { t, cols };
  }

  /** Logical index of the first row with ts > x (n if none). */
  private upperBound(x: number): number {
    let lo = 0;
    let hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ts[this.phys(mid)] <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

// ---- X-ray and wind ---------------------------------------------------------------------------------------

export const XRAY_FIELDS = ["long", "short"] as const;
export const WIND_FIELDS = ["speed", "density", "temperature", "bx", "by", "bz", "bt", "newell"] as const;
export type XrayField = (typeof XRAY_FIELDS)[number];
export type WindField = (typeof WIND_FIELDS)[number];
export type XrayRing = SeriesRing<XrayField>;
export type WindRing = SeriesRing<WindField>;

export const xrayRing = (capacity = DEFAULT_CAPACITY): XrayRing => new SeriesRing(XRAY_FIELDS, capacity);
export const windRing = (capacity = DEFAULT_CAPACITY): WindRing => new SeriesRing(WIND_FIELDS, capacity);

export function xraySeries(ring: XrayRing, from: Unix, to: Unix): XraySeries {
  const { t, cols } = ring.range(from, to);
  return { t, ...cols };
}

export function windSeries(ring: WindRing, from: Unix, to: Unix): WindSeries {
  const { t, cols } = ring.range(from, to);
  return { t, ...cols };
}

const sample = (v: number | null): Sample => (v === null || Number.isNaN(v) ? null : v);

/** Rows (e.g. one tick's new rows) → the shared columnar shape used in a Delta. */
export function xraySeriesFromRows(rows: readonly XrayRow[]): XraySeries {
  return { t: rows.map((r) => r.ts), long: rows.map((r) => sample(r.long)), short: rows.map((r) => sample(r.short)) };
}

export function windSeriesFromRows(rows: readonly WindRow[]): WindSeries {
  const col = (f: WindField) => rows.map((r) => sample(r[f]));
  return {
    t: rows.map((r) => r.ts),
    speed: col("speed"), density: col("density"), temperature: col("temperature"),
    bx: col("bx"), by: col("by"), bz: col("bz"), bt: col("bt"), newell: col("newell"),
  };
}
