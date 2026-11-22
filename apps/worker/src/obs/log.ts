/**
 * Log redaction and the one-line JSON logger (backend design §9, GAP X4).
 * NASA_API_KEY must never reach logs or /health: query strings are stripped from every URL and any
 * api_key=/token= pair left over is masked.
 */

const URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const SECRET_PARAM_RE = /\b(api[_-]?key|apikey|token|access[_-]?token|key)=[^\s&"'<>]*/gi;

/** Strip the query string (and fragment) from every http(s) URL in `text`, then mask stray secret params. */
export function redact(text: string): string {
  const noQuery = text.replace(URL_RE, (url) => {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : url.slice(0, cut);
  });
  return noQuery.replace(SECRET_PARAM_RE, "$1=***");
}

function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redact(value);
  if (value instanceof Error) return redact(value.message);
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1);
  return out;
}

/** Emit one JSON line `{"evt":…, …fields}` with every string redacted. */
export function logEvent(
  evt: string,
  fields: Record<string, unknown>,
  sink: (line: string) => void = console.log,
): void {
  sink(JSON.stringify({ evt, ...(redactDeep(fields) as Record<string, unknown>) }));
}
