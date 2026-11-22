/**
 * Validate a GET /history body and turn it into Float64Array columns (GAP_ANALYSIS F2).
 * Pure, with no DOM or store imports, so it runs unchanged in history.worker.ts and on the main thread
 * (Node tests, browsers without module workers).
 */
import { historyResponseSchema, type HistoryRes, type HistorySeries, type Unix } from "@cme/shared";

/** Columns each series must carry (same as XRAY_KEYS / WIND_KEYS in store/live.ts; a test keeps them equal). */
export const SERIES_COLUMNS: Record<HistorySeries, readonly string[]> = {
  xray: ["long", "short"],
  wind: ["speed", "density", "temperature", "bx", "by", "bz", "bt", "newell"],
};

export interface ParsedHistory {
  series: HistorySeries;
  res: HistoryRes;
  from: Unix;
  to: Unix;
  /** `t` plus one column per key. Missing samples (JSON null) are NaN. Each array owns its whole buffer. */
  cols: Record<string, Float64Array>;
}

/** Parse JSON text, then validate it. Throws an Error whose message says what was wrong. */
export function parseHistoryText(text: string): ParsedHistory {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("history: response is not valid JSON");
  }
  return parseHistoryBody(body);
}

/** Validate an already-parsed body with the shared schema and convert it to typed columns. */
export function parseHistoryBody(body: unknown): ParsedHistory {
  const r = historyResponseSchema.safeParse(body);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new Error(`history: ${i ? `${i.path.join(".") || "(root)"}: ${i.message}` : "invalid"}`);
  }
  const { series, res, from, to } = r.data;
  const data = r.data.data as unknown as Record<string, (number | null)[]>;
  // The schema accepts either series shape under either name; the name has to match the columns.
  for (const k of SERIES_COLUMNS[series]) {
    if (!Array.isArray(data[k])) throw new Error(`history: ${series} response has no "${k}" column`);
  }
  const cols: Record<string, Float64Array> = { t: Float64Array.from(data.t as number[]) };
  for (const k of SERIES_COLUMNS[series]) cols[k] = toColumn(data[k]);
  return { series, res, from, to, cols };
}

function toColumn(src: (number | null)[]): Float64Array {
  const out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] ?? NaN;
  return out;
}

/** The ArrayBuffers of a parse result, for postMessage's transfer list. */
export function transferablesOf(p: ParsedHistory): ArrayBuffer[] {
  return Object.values(p.cols).map((c) => c.buffer as ArrayBuffer);
}
