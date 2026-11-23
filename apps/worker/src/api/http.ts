/** Response helpers for /api/v1 (backend design §7, §8). Every JSON response gets nosniff and a charset. */

export const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;

/** A JSON response; `body` is serialised unless it is already a JSON string (`raw`). */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}, raw = false): Response {
  return new Response(raw ? (body as string) : JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, "Cache-Control": "no-store", ...headers },
  });
}

export const errorJson = (status: number, error: string, headers: Record<string, string> = {}) => json({ error }, status, headers);

export const notFound = (method: string, path: string) => errorJson(404, `no route ${method} ${path}`);

/** Compares two strings in time that depends only on their lengths (admin token check). */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
