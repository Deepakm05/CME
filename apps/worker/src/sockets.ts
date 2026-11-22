/**
 * The WebSocket session (backend design §7.1, GAP D3, S3, S4, X2) without Workers APIs: the hub wraps each
 * hibernatable WebSocket in a HubSocket, and the per-socket state lives in its attachment (SocketMeta), so it
 * survives hibernation. Socket counts always come from the runtime's list (ctx.getWebSockets()), never a
 * counter in memory.
 */
import type { Unix } from "@cme/shared";

export interface SocketMeta {
  connectedAt: Unix;
  /** Last time the client sent anything. */
  lastSeen: Unix;
  /** The client has answered a ping at least once, so it takes part in the keep-alive (see IDLE_CLOSE_S). */
  ponged: boolean;
}

export interface HubSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
  meta(): SocketMeta | null;
  setMeta(m: SocketMeta): void;
}

export const MAX_SOCKETS = 5000;
export const PING_EVERY_S = 15;
/**
 * A socket whose client answers pings but has sent nothing for this long is closed [S4]. Clients that never
 * sent a pong (wscat, the contract tests, other non-browser tools) are exempt: closing them would only break
 * them, and the runtime reports their sockets closed when the TCP connection goes.
 */
export const IDLE_CLOSE_S = 45;
/** Client messages longer than this are ignored. */
export const MAX_CLIENT_MSG = 1024;

export const CLOSE = {
  /** Origin not on the allow-list: the client stays closed. */
  ORIGIN: 1008,
  /** Over MAX_SOCKETS: the client falls back to polling. */
  TOO_MANY: 1013,
  /** No pong for IDLE_CLOSE_S. */
  IDLE: 1001,
} as const;

/** `?since=` → a non-negative integer seq, or null (absent or malformed: the client gets a snapshot). */
export function parseSince(v: string | null): number | null {
  if (v === null || !/^\d{1,15}$/.test(v)) return null;
  return Number(v);
}

/** Sends without throwing (a socket can be closing while still listed); returns whether it was sent. */
export function trySend(ws: HubSocket, data: string): boolean {
  try {
    ws.send(data);
    return true;
  } catch {
    return false;
  }
}

export function tryClose(ws: HubSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    /* already closed */
  }
}

export function isIdle(m: SocketMeta | null, now: Unix): boolean {
  return m !== null && m.ponged && now - m.lastSeen > IDLE_CLOSE_S;
}
