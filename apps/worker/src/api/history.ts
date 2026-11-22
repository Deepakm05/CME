/**
 * GET /api/v1/history (backend design §7): served from the 7-day memory rings, never SQLite.
 * Same query semantics as the mock (apps/mock/src/server.ts): res defaults to 1m, `to` to now, `from` to
 * to − 24 h, and `from` is clamped to the 7 days the rings hold. 5m buckets are aligned to multiples of 300 s
 * and stamped with the bucket start: X-ray takes the max of each bucket (flares stay visible), wind the mean.
 */
import { historyQuerySchema, type HistoryRes, type HistoryResponse, type HistorySeries, type Sample, type Unix } from "@cme/shared";
import type { Memory } from "../state/memory.ts";
import { SAMPLE_RETENTION_S } from "../state/commit.ts";
import type { SeriesRange } from "../state/series.ts";

export const DEFAULT_SPAN_S = 86_400;
const BUCKET_S = 300;

export type HistoryQuery = { ok: true; series: HistorySeries; res: HistoryRes; from: Unix; to: Unix } | { ok: false; error: string };

export function parseHistoryQuery(params: URLSearchParams, now: Unix): HistoryQuery {
  const q = (k: string) => params.get(k) ?? undefined;
  const parsed = historyQuerySchema.safeParse({ series: q("series"), res: q("res") ?? "1m", from: q("from"), to: q("to") });
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { ok: false, error: i ? `${i.path.join(".") || "query"}: ${i.message}` : "bad query" };
  }
  const { series, res } = parsed.data;
  const to = parsed.data.to ?? now;
  const from = Math.max(parsed.data.from ?? to - DEFAULT_SPAN_S, to - SAMPLE_RETENTION_S);
  return { ok: true, series, res, from, to };
}

type Agg = "max" | "mean";

/** Buckets rows into 300 s bins; nulls are ignored and an all-null bin stays null. */
export function downsample<F extends string>(r: SeriesRange<F>, agg: Agg): SeriesRange<F> {
  const fields = Object.keys(r.cols) as F[];
  const t: Unix[] = [];
  const cols = Object.fromEntries(fields.map((f) => [f, [] as Sample[]])) as Record<F, Sample[]>;
  let i = 0;
  while (i < r.t.length) {
    const key = Math.floor(r.t[i] / BUCKET_S);
    let j = i;
    while (j < r.t.length && Math.floor(r.t[j] / BUCKET_S) === key) j++;
    t.push(key * BUCKET_S);
    for (const f of fields) {
      let acc: number | null = null;
      let n = 0;
      for (let k = i; k < j; k++) {
        const v = r.cols[f][k];
        if (v === null) continue;
        n++;
        acc = acc === null ? v : agg === "max" ? Math.max(acc, v) : acc + v;
      }
      cols[f].push(acc === null ? null : agg === "max" ? acc : acc / n);
    }
    i = j;
  }
  return { t, cols };
}

export function historyResponse(mem: Memory, q: Extract<HistoryQuery, { ok: true }>): HistoryResponse {
  const ring = q.series === "xray" ? mem.xray : mem.wind;
  let range: SeriesRange<string> = ring.range(q.from, q.to);
  if (q.res === "5m") range = downsample(range, q.series === "xray" ? "max" : "mean");
  return { series: q.series, res: q.res, from: q.from, to: q.to, data: { t: range.t, ...range.cols } as HistoryResponse["data"] };
}

/** s-maxage=60 for ranges that may still grow; a range that ended over an hour ago never changes. */
export function historyCacheControl(to: Unix, now: Unix): string {
  return to < now - 3600 ? "public, max-age=86400, immutable" : "public, s-maxage=60";
}
