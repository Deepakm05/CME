/**
 * SpaceWeatherHub: the one Durable Object that owns the live loop (backend design §3–§9).
 *
 * A thin adapter over the Workers APIs. All behaviour is in HubCore (core.ts) and the router (api/router.ts),
 * which are plain TypeScript tested under `tsx --test`; this file only connects them to ctx.storage, the
 * alarm, and hibernatable WebSockets.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { HubCore } from "./core.ts";
import { route } from "./api/router.ts";
import type { HubSocket, SocketMeta } from "./sockets.ts";

/** A hibernatable WebSocket seen through the HubSocket interface; per-socket state is its attachment. */
const wrap = (ws: WebSocket): HubSocket => ({
  send: (s) => ws.send(s),
  close: (code, reason) => ws.close(code, reason),
  meta: () => (ws.deserializeAttachment() as SocketMeta | null) ?? null,
  setMeta: (m) => ws.serializeAttachment(m),
});

export class SpaceWeatherHub extends DurableObject<Env> {
  private core!: HubCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // R3: nothing is served until the schema exists, seq is read and memory is rebuilt. Arming the alarm here
    // means the loop starts on the first request of any kind (e.g. GET /health), with no cron needed.
    void ctx.blockConcurrencyWhile(async () => {
      const storage = ctx.storage;
      this.core = new HubCore(
        {
          sql: storage.sql,
          tx: (fn) => storage.transactionSync(fn),
          config: { feedBase: env.FEED_BASE, adminToken: env.ADMIN_TOKEN, allowedOrigins: env.ALLOWED_ORIGINS },
          sockets: () => ctx.getWebSockets().map(wrap),
        },
        Date.now(),
      );
      let at = await storage.getAlarm();
      if (at === null) {
        at = Date.now();
        await storage.setAlarm(at);
      }
      // Seeds the in-memory alarm-last-at to now, so the watchdog doesn't see the restart as a stall.
      this.core.alarmArmedAtStart(at, Date.now());
    });
  }

  private async arm(atMs: number): Promise<void> {
    await this.ctx.storage.setAlarm(atMs);
    this.core.scheduledAtMs = atMs;
  }

  async fetch(req: Request): Promise<Response> {
    const r = route(this.core, req, Date.now());
    if (r.kind === "http") return r.res;
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    if (r.kind === "ws-reject") {
      // Accept, then close with the code the client acts on (1008 stay closed, 1013 fall back to polling).
      server.accept();
      server.close(r.code, r.reason);
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server);
    this.core.onOpen(wrap(server), r.since, Date.now());
    return new Response(null, { status: 101, webSocket: client });
  }

  /** One tick (§5.2). The next alarm is armed in `finally`, so an exception can never stop the loop. */
  async alarm(): Promise<void> {
    let next = Date.now() + 5000;
    try {
      next = await this.core.tick(Date.now());
    } finally {
      await this.arm(Math.max(next, Date.now() + 250));
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.core.onMessage(wrap(ws), message, Date.now());
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Per-socket state lives in the attachment, so there's nothing else to clean up; finish the close handshake.
    try {
      ws.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, reason);
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "socket error");
    } catch {
      /* already closed */
    }
  }

  /** Called by the cron trigger every minute (§5.4, R4): re-arms a stalled or missing alarm. */
  async watchdog(): Promise<void> {
    const now = Date.now();
    const stalled = this.core.watchdog(now);
    if (stalled || (await this.ctx.storage.getAlarm()) === null) await this.arm(now);
  }
}
