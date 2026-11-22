import uPlot from "uplot";
import type { Aligned } from "../../lib/chartData.ts";
import { CHART } from "./theme.ts";

/** The replay time a chart marks (null in live mode). Read by the draw hooks at draw time. */
export type MarkerRef = { current: number | null };

/** Index of the newest non-null row of `ys` at or before `upTo` (null = no limit), or -1. */
export function lastRow(xs: ArrayLike<number>, ys: ArrayLike<number | null | undefined>, upTo: number | null): number {
  let i = xs.length - 1;
  if (upTo !== null) while (i >= 0 && xs[i] > upTo) i--;
  while (i >= 0 && ys[i] == null) i--;
  return i;
}

/** The rows at or before t (tables in replay never list what came after the replay time). */
export function upTo(data: Aligned, t: number | null): Aligned {
  if (t === null) return data;
  let n = data[0].length;
  while (n > 0 && data[0][n - 1] > t) n--;
  if (n === data[0].length) return data;
  return data.map((c) => c.slice(0, n)) as Aligned;
}

/**
 * Replay: dim everything after the replay time and draw a "now" line at it.
 * `label` (e.g. "14:35") is drawn beside the line when there is room. Call from a draw hook (after the series).
 */
export function drawMarker(u: uPlot, t: number | null, label: string | null): void {
  if (t === null) return;
  const px = uPlot.pxRatio;
  const { left, top, width, height } = u.bbox;
  const x = Math.round(u.valToPos(t, "x", true));
  if (x < left - 1 || x > left + width + 1) return;
  const { ctx } = u;
  ctx.save();
  ctx.fillStyle = CHART.surface;
  ctx.globalAlpha = 0.55;
  ctx.fillRect(x, top, left + width - x, height);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = CHART.ink;
  ctx.lineWidth = 1.5 * px;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, top);
  ctx.lineTo(x + 0.5, top + height);
  ctx.stroke();
  if (label && left + width - x > 40 * px) {
    ctx.font = `${10 * px}px system-ui, sans-serif`;
    ctx.fillStyle = CHART.ink;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(label, x + 5 * px, top + 2 * px);
  }
  ctx.restore();
}
