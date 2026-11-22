import type { SpaceWeatherHub } from "./hub.ts";

/** Bindings from wrangler.jsonc plus secrets. */
export interface Env {
  HUB: DurableObjectNamespace<SpaceWeatherHub>;
  ENVIRONMENT: string;
  /** Comma-separated; `*` matches one label, e.g. https://*.cme-web.pages.dev (GAP X2). */
  ALLOWED_ORIGINS: string;
  /** NOAA SWPC base URL; CI points it at a local fixture server so tests never hit NOAA. */
  FEED_BASE: string;
  NASA_API_KEY?: string; // secret (X4): never logged, never in /health
  ADMIN_TOKEN?: string; // secret
}
