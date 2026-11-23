/**
 * WebSocket load test for /api/v1/stream (GAP S5).
 *
 *   tsx apps/worker/scripts/load.ts --url wss://host/api/v1/stream --sockets 1000 --ramp 50/s --duration 120 [--origin https://app.example]
 *
 * Opens N sockets (ramped), holds them for --duration seconds, then reports connection outcomes with close codes,
 * time-to-first-snapshot, deltas per socket and the delivery skew of each delta seq across sockets.
 * Node 22+: the global WebSocket (undici) accepts `{ headers }` as a second argument, used for Origin.
 */

export {};

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const url = arg("url");
if (!url) {
  console.error("usage: load.ts --url wss://host/api/v1/stream [--sockets 1000] [--ramp 50/s] [--duration 120] [--origin https://…]");
  process.exit(2);
}
const sockets = Number(arg("sockets", "1000"));
const ramp = Number((arg("ramp", "50/s") ?? "50").replace(/\/s$/, ""));
const durationS = Number(arg("duration", "120"));
const origin = arg("origin");

const pct = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : NaN);
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const f = (n: number) => (Number.isFinite(n) ? n.toFixed(0) : "-");

let connected = 0;
let failed = 0;
let closed = 0;
const closeCodes = new Map<number, number>();
const firstSnapshotMs: number[] = [];
const deltasPerSocket: number[] = [];
/** seq -> arrival times (ms, wall clock) across sockets. */
const arrivals = new Map<number, number[]>();
const sockOpen: WebSocket[] = [];

function openSocket(): Promise<void> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let deltas = 0;
    let gotSnapshot = false;
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        deltasPerSocket.push(deltas);
        resolve();
      }
    };
    let ws: WebSocket;
    try {
      ws = origin
        ? new (WebSocket as unknown as new (u: string, o: { headers: Record<string, string> }) => WebSocket)(url!, { headers: { origin } })
        : new WebSocket(url!);
    } catch {
      failed++;
      resolve();
      return;
    }
    let opened = false;
    ws.onopen = () => {
      opened = true;
      connected++;
      sockOpen.push(ws);
    };
    ws.onmessage = (ev) => {
      const at = Date.now();
      let m: { type?: string; seq?: number };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.type === "snapshot" && !gotSnapshot) {
        gotSnapshot = true;
        firstSnapshotMs.push(at - t0);
      } else if (m.type === "delta" && typeof m.seq === "number") {
        deltas++;
        const a = arrivals.get(m.seq);
        if (a) a.push(at);
        else arrivals.set(m.seq, [at]);
      }
    };
    ws.onerror = () => {
      if (!opened) failed++;
    };
    ws.onclose = (ev) => {
      if (opened) {
        closed++;
        closeCodes.set(ev.code, (closeCodes.get(ev.code) ?? 0) + 1);
      }
      done();
    };
    // Resolve the per-socket tally when the run ends (sockets are closed below).
    setTimeout(done, (sockets / ramp + durationS + 5) * 1000);
  });
}

console.log(`load: ${sockets} sockets @ ${ramp}/s for ${durationS}s -> ${url}${origin ? ` (Origin ${origin})` : ""}`);
const all: Promise<void>[] = [];
const interval = 1000 / ramp;
const started = Date.now();
for (let i = 0; i < sockets; i++) {
  all.push(openSocket());
  const wait = started + (i + 1) * interval - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  if (i > 0 && i % 200 === 0) console.log(`  ${i} opened, ${connected} connected, ${failed} failed`);
}
console.log(`ramp done; holding for ${durationS}s`);
await new Promise((r) => setTimeout(r, durationS * 1000));
const stillOpen = sockOpen.filter((w) => w.readyState === WebSocket.OPEN).length;
for (const w of sockOpen) if (w.readyState === WebSocket.OPEN) w.close(1000, "load test over");
await Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, 5000))]);

const skews: number[] = [];
let worst = 0;
for (const times of arrivals.values()) {
  if (times.length < 2) continue;
  const s = Math.max(...times) - Math.min(...times);
  skews.push(s);
  worst = Math.max(worst, s);
}
const snap = sorted(firstSnapshotMs);
const dps = sorted(deltasPerSocket);
const skew = sorted(skews);
const codes = [...closeCodes.entries()].map(([c, n]) => `${c}x${n}`).join(", ") || "-";

console.log("\n=== summary ===");
console.table({
  sockets: { value: sockets },
  connected: { value: connected },
  failed: { value: failed },
  "still open at end": { value: stillOpen },
  "closed (total, incl. ours at end)": { value: closed },
  "closed (code x count)": { value: codes },
  "snapshot p50 / p95 (ms)": { value: `${f(pct(snap, 50))} / ${f(pct(snap, 95))}` },
  "deltas per socket min / p50 / max": { value: `${f(dps[0])} / ${f(pct(dps, 50))} / ${f(dps[dps.length - 1])}` },
  "distinct delta seqs": { value: arrivals.size },
  "delivery skew p50 / p95 / max (ms)": { value: `${f(pct(skew, 50))} / ${f(pct(skew, 95))} / ${f(worst)}` },
});
process.exit(failed > 0 ? 1 : 0);
