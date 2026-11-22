import type { HistoryRes, Unix } from "@cme/shared";

/** Seconds per history bucket. */
export const RES_S: Record<HistoryRes, number> = { "1m": 60, "5m": 300 };

/**
 * Snapping for GET /history (GAP_ANALYSIS C1): every client asks for bucket-aligned `from`/`to`, so the CDN
 * sees few distinct URLs and the server can reject unsnapped ones.
 */
export function snapDown(t: Unix, res: HistoryRes): Unix {
  return Math.floor(t / RES_S[res]) * RES_S[res] + 0; // + 0 turns -0 into 0
}

export function snapUp(t: Unix, res: HistoryRes): Unix {
  return Math.ceil(t / RES_S[res]) * RES_S[res] + 0;
}

/** Replay loads this much before and after the chosen moment, and can scrub back this far from "now". */
export const REPLAY_BEFORE_S = 6 * 3600;
export const REPLAY_AFTER_S = 3600;
export const REPLAY_SPAN_S = 7 * 86_400;

/** The series window for a replay at time `t`: [t − 6 h, t + 1 h] snapped outward to 5 minutes. */
export function replayWindow(t: Unix): { from: Unix; to: Unix; res: "5m" } {
  return { from: snapDown(t - REPLAY_BEFORE_S, "5m"), to: snapUp(t + REPLAY_AFTER_S, "5m"), res: "5m" };
}
