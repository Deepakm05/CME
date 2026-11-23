/**
 * The contract between backend (mock or real) and frontend.
 * See docs/design/backend/README.md section 3.
 *
 * Conventions:
 * - Every time is unix SECONDS (UTC).
 * - Positions on the Sun are heliographic degrees: lat north +, lon west + (Earth-facing centre = 0,0).
 * - Time series are columnar (one array per field) to keep JSON small and fast to parse.
 */

export type Unix = number;

export type ClockMode = "live" | "mock-replay" | "mock-scenario";

/** Server clock. Data "now" = clock.now + (Date.now()/1000 - receivedAt) * clock.speed. */
export interface Clock {
  now: Unix;
  speed: number; // 1 = real time
  mode: ClockMode;
  scenario: string | null;
}

/** A value in a series column. null = no measurement for that minute (JSON has no NaN). */
export type Sample = number | null;

export interface XraySeries {
  t: Unix[];
  long: Sample[]; // 0.1-0.8 nm flux, W/m^2
  short: Sample[]; // 0.05-0.4 nm flux, W/m^2
}

export interface WindSeries {
  t: Unix[];
  speed: Sample[]; // km/s
  density: Sample[]; // p/cm^3
  temperature: Sample[]; // K
  bx: Sample[]; // nT, GSM
  by: Sample[];
  bz: Sample[];
  bt: Sample[];
  newell: Sample[]; // Newell coupling dPhi/dt (raw units)
}

export interface SunspotRegion {
  regionNo: number;
  observedOn: string; // YYYY-MM-DD
  lat: number;
  lon: number; // at clock.now (rotates ~13.2 deg/day)
  location: string; // e.g. N20E46
  areaMsh: number; // millionths of solar hemisphere
  magClass: string | null; // A, B, BG, BGD ...
  spotCount: number;
  pM: number | null; // M-class flare probability %
  pX: number | null;
}

export type FlareStatus = "rising" | "decaying" | "ended";

export interface Flare {
  id: string;
  beginAt: Unix;
  peakAt: Unix | null;
  endAt: Unix | null;
  cls: string; // current or peak class, e.g. "M2.3"
  peakFlux: number;
  status: FlareStatus;
  regionNo: number | null;
  lat: number | null;
  lon: number | null;
}

export interface CmeForecast {
  computedAt: Unix;
  eta: Unix | null; // null = never reaches 1 AU / not Earth-directed
  arrivalSpeed: number | null; // km/s
  gamma: number; // km^-1
  w: number; // ambient solar wind used, km/s
}

export interface Cme {
  id: string;
  launchAt: Unix; // time at 21.5 solar radii
  speed: number; // km/s
  lat: number;
  lon: number;
  halfAngle: number; // deg
  earthDirected: boolean;
  flareId: string | null;
  forecast: CmeForecast | null;
}

/** TEST is raised on request (to check that alerts reach open tabs) and clears itself after 10 minutes. */
export type AlertRule = "FLARE_M" | "FLARE_X" | "CME_EARTH" | "BZ_SOUTH" | "FEED_STALE" | "TEST";
export type AlertLevel = "watch" | "warning";

export interface Alert {
  id: string;
  rule: AlertRule;
  level: AlertLevel;
  title: string;
  message: string;
  refType: "flare" | "cme" | "wind" | "feed" | "test";
  refId: string;
  raisedAt: Unix;
  clearedAt: Unix | null;
}

export type FeedId = "goes_xray" | "goes_flares" | "rtsw" | "regions" | "donki";

export interface FeedStatus {
  id: FeedId;
  label: string;
  cadenceS: number;
  staleAfterS: number; // data older than this is stale (the client re-checks it when the stream is down)
  lastOkAt: Unix | null;
  dataTs: Unix | null; // newest data time in the feed
  error: string | null;
  stale: boolean;
}

/** Everything the UI needs to draw the current moment. */
export interface LiveState {
  seq: number;
  clock: Clock;
  xray: XraySeries; // last STATE_WINDOW_S
  wind: WindSeries; // last STATE_WINDOW_S
  regions: SunspotRegion[];
  flares: Flare[]; // last 7 days
  cmes: Cme[]; // last 7 days
  alerts: Alert[]; // active + last 24 h
  feeds: FeedStatus[];
}

export const STATE_WINDOW_S = 6 * 3600;

/** A change since the previous seq. Series are APPENDED; lists are UPSERTED by id; regions REPLACED. */
export interface Delta {
  clock?: Clock;
  xray?: XraySeries;
  wind?: WindSeries;
  regions?: SunspotRegion[];
  flares?: Flare[];
  cmes?: Cme[];
  alerts?: Alert[];
  feeds?: FeedStatus[];
}

// ---- WebSocket protocol ----------------------------------------------------

export type ServerMessage =
  | { type: "snapshot"; seq: number; ts: Unix; data: LiveState }
  | { type: "delta"; seq: number; ts: Unix; data: Delta }
  | { type: "alert"; seq: number; ts: Unix; data: Alert }
  | { type: "ping"; ts: Unix };

export type ClientMessage = { type: "pong"; ts: Unix } | { type: "resync" };

/** WebSocket protocol version (GAP_ANALYSIS D3). Only additive changes are allowed within a version. */
export const PROTOCOL_VERSION = 1;

/**
 * First message on every socket from the real backend. Not part of ServerMessage on purpose: clients that
 * don't know it ignore it as an unknown type, so adding it is backward compatible.
 */
export interface HelloMessage {
  type: "hello";
  protocol: number;
  minClient: number; // a client whose protocol is lower must save its cache and reload
  seq: number; // the server's current seq
  ts: Unix;
}

export const API_PREFIX = "/api/v1";

// ---- feeds -----------------------------------------------------------------

export interface FeedDef {
  id: FeedId;
  label: string;
  cadenceS: number; // normal poll interval
  staleAfterS: number; // data older than this is stale
}

/** The upstream feeds, shared by the mock and the Worker so their FeedStatus can't drift. */
export const FEED_DEFS: readonly FeedDef[] = [
  { id: "goes_xray", label: "GOES X-ray flux", cadenceS: 60, staleAfterS: 300 },
  { id: "goes_flares", label: "GOES flare list", cadenceS: 60, staleAfterS: 600 },
  { id: "rtsw", label: "Solar wind at L1 (RTSW)", cadenceS: 60, staleAfterS: 300 },
  { id: "regions", label: "Sunspot regions (SWPC)", cadenceS: 1800, staleAfterS: 3 * 3600 },
  { id: "donki", label: "CMEs (NASA DONKI)", cadenceS: 300, staleAfterS: 3600 },
];

// ---- REST responses --------------------------------------------------------

export type HistorySeries = "xray" | "wind";
export type HistoryRes = "1m" | "5m";

export interface HistoryResponse {
  series: HistorySeries;
  res: HistoryRes;
  from: Unix;
  to: Unix;
  data: XraySeries | WindSeries;
}

export interface EventsResponse {
  flares?: Flare[];
  cmes?: Cme[];
  alerts?: Alert[];
}

export type HealthStatus = "ok" | "degraded" | "down";

/** Freshness of one feed over the last hour (GAP_ANALYSIS O1). Seconds; null until there are samples. */
export interface FeedLag {
  feed: FeedId;
  p50: number | null;
  p95: number | null;
}

/** The optional fields are filled by the real backend (backend design §9); the mock may leave them out. */
export interface HealthResponse {
  clock: Clock;
  feeds: FeedStatus[];
  status?: HealthStatus;
  seq?: number;
  sockets?: number;
  alarmLagS?: number | null;
  lag?: FeedLag[];
}

// ---- helpers ---------------------------------------------------------------

export function emptyXray(): XraySeries {
  return { t: [], long: [], short: [] };
}

export function emptyWind(): WindSeries {
  return { t: [], speed: [], density: [], temperature: [], bx: [], by: [], bz: [], bt: [], newell: [] };
}
export * from "./schema.ts";
