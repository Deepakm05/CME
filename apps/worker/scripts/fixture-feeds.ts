/**
 * A tiny live imitation of the four NOAA SWPC JSON feeds, for `wrangler dev` / CI (GAP T1).
 *
 *   tsx apps/worker/scripts/fixture-feeds.ts --port 8788
 *
 * Serves the saved real payloads in docs/reconnection/data/, with every timestamp shifted so the data ends at
 * wall-clock time. The last 60 minutes of each fixture are held back and released one minute per real minute, so a
 * poller sees a new row about once a minute. Row format, order and time_tag style (Z or no Z) are preserved.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

const DATA_DIR = new URL("../../../docs/reconnection/data/", import.meta.url);
const MIN = 60_000;
const NOAA_LAG = 60_000;
const HOLD_BACK = 60 * MIN;
const SIX_HOURS = 6 * 60 * MIN;

type Row = Record<string, unknown> & { time_tag: string };
interface Source {
  rows: Row[];
  ts: number[];
  z: boolean;
  offset: number;
  kind: "xray6h" | "xray7d" | "plain";
}

const FILES: Record<string, { file: string; kind: Source["kind"] }> = {
  "/json/goes/primary/xrays-6-hour.json": { file: "goes_xrays_3day.json", kind: "xray6h" },
  "/json/goes/primary/xrays-7-day.json": { file: "goes_xrays_3day.json", kind: "xray7d" },
  "/json/rtsw/rtsw_wind_1m.json": { file: "rtsw_wind_1m.json", kind: "plain" },
  "/json/rtsw/rtsw_mag_1m.json": { file: "rtsw_mag_1m.json", kind: "plain" },
};

const parseTs = (s: string) => Date.parse(/Z$/.test(s) ? s : `${s}Z`);
const fmtTs = (ms: number, z: boolean) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, z ? "Z" : "");

function load(file: string, kind: Source["kind"], startNow: number): Source {
  const rows = JSON.parse(readFileSync(new URL(file, DATA_DIR), "utf8")) as Row[];
  const ts = rows.map((r) => parseTs(r.time_tag));
  const newest = Math.max(...ts);
  const startMinute = Math.floor(startNow / MIN) * MIN;
  return { rows, ts, z: rows[0].time_tag.endsWith("Z"), offset: startMinute - NOAA_LAG - newest + HOLD_BACK, kind };
}

export interface FixtureFeeds {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export async function startFixtureFeeds(opts: { port: number; now?: () => number; log?: (line: string) => void }): Promise<FixtureFeeds> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((l: string) => console.log(l));
  const startNow = now();
  const sources = new Map<string, Source>();
  for (const [path, { file, kind }] of Object.entries(FILES)) sources.set(path, load(file, kind, startNow));

  /** Visible rows with shifted time_tags, in the original order. */
  const view = (s: Source) => {
    const limit = now() - NOAA_LAG;
    const idx: number[] = [];
    let newest = -Infinity;
    for (let i = 0; i < s.rows.length; i++) {
      const t = s.ts[i] + s.offset;
      if (t <= limit) {
        idx.push(i);
        if (t > newest) newest = t;
      }
    }
    const from = s.kind === "xray6h" ? newest - SIX_HOURS : -Infinity;
    const out = idx.filter((i) => s.ts[i] + s.offset > from).map((i) => ({ ...s.rows[i], time_tag: fmtTs(s.ts[i] + s.offset, s.z) }));
    return { out, newest };
  };

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const src = sources.get(path);
    let status = 200;
    if (!src || req.method !== "GET") {
      status = src ? 405 : 404;
      res.writeHead(status, { "content-type": "text/plain" }).end(status === 404 ? "not found" : "method not allowed");
    } else {
      const { out, newest } = view(src);
      const etag = `"${createHash("sha1").update(`${path}:${newest}`).digest("hex").slice(0, 16)}"`;
      if (req.headers["if-none-match"] === etag) {
        status = 304;
        res.writeHead(304, { etag }).end();
      } else {
        res.writeHead(200, { "content-type": "application/json", etag }).end(JSON.stringify(out));
      }
    }
    log(`${new Date(now()).toISOString()} ${req.method} ${path} -> ${status}`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", resolve);
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--port");
  const port = i >= 0 ? Number(process.argv[i + 1]) : 8788;
  const f = await startFixtureFeeds({ port });
  console.log(`fixture feeds on http://127.0.0.1:${f.port}`);
}
