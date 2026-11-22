/**
 * WebSocket Origin allow-list (backend design §8, GAP X2). Pure; no Workers-only globals.
 *
 * ALLOWED_ORIGINS is a comma-separated list of origins such as `https://app.example.com` or
 * `https://*.cme-web.pages.dev`, where `*` stands for exactly one DNS label ([a-z0-9-]+, no dots).
 * Matching is case-insensitive and exact otherwise (scheme, host and port must all match).
 *
 * A request without an Origin header is allowed: browsers always send one on a WebSocket handshake, so a
 * missing header means a non-browser client (node, wscat, the contract tests), which the allow-list can't
 * meaningfully restrict anyway. The literal origin "null" (sandboxed iframes, file://) is not exempt.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Compiles ALLOWED_ORIGINS into one matcher per entry. Empty entries are ignored. */
export function compileAllowList(list: string | undefined): RegExp[] {
  return (list ?? "")
    .split(",")
    .map((e) => e.trim().replace(/\/+$/, ""))
    .filter((e) => e.length > 0)
    .map((e) => new RegExp(`^${e.split("*").map(escapeRe).join("[a-z0-9-]+")}$`, "i"));
}

export function originAllowed(origin: string | null, allow: readonly RegExp[]): boolean {
  if (origin === null) return true;
  return allow.some((re) => re.test(origin));
}
