import { useMemo, type ReactNode, type RefObject } from "react";
import uPlot from "uplot";
import { classFromFlux } from "@cme/physics";
import type { Cme, Unix, XraySeries } from "@cme/shared";
import { windowed, type Aligned } from "../lib/chartData.ts";
import { pow10 } from "../lib/format.ts";
import { CHART } from "../hud/charts/theme.ts";
import { hhmm, useUplot, utc } from "../hud/charts/useUplot.ts";
import { dbmSamples, kmToAu } from "./model.ts";

const BOUNDS = [1e-8, 1e-7, 1e-6, 1e-5, 1e-4];
const CLASS_LABELS = ["A", "B", "C", "M", "X"];
const dayHhmm = (ts: number) => new Date(ts * 1000).toISOString().slice(5, 16).replace("T", " ");

interface Mark {
  t: Unix | null;
  label: string;
  color?: string;
}

const axisBase = { stroke: CHART.inkMuted, font: CHART.font };

function xAxis(fmt: (ts: number) => string): uPlot.Axis {
  return { ...axisBase, grid: { show: false }, ticks: { stroke: CHART.axis, width: 1, size: 4 }, size: 26, values: (_u, s) => s.map((v) => (v == null ? "" : fmt(v))) };
}

/** Plot box with an accessible name. */
function Frame({ label, box, children }: { label: string; box: RefObject<HTMLDivElement>; children?: ReactNode }) {
  return (
    <figure className="ev-chart">
      <div ref={box} className="ev-chart-box" role="img" aria-label={label} />
      {children}
    </figure>
  );
}

/** Dashed vertical lines with small labels at the top. */
function vlines(u: uPlot, marks: Mark[]) {
  const { ctx } = u;
  const px = uPlot.pxRatio;
  const [x0, x1] = [u.scales.x.min ?? -Infinity, u.scales.x.max ?? Infinity];
  ctx.save();
  ctx.font = `${11 * px}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.setLineDash([4 * px, 4 * px]);
  ctx.lineWidth = px;
  for (const m of marks) {
    if (m.t === null || m.t < x0 || m.t > x1) continue;
    const x = u.valToPos(m.t, "x", true);
    ctx.strokeStyle = m.color ?? CHART.inkMuted;
    ctx.beginPath();
    ctx.moveTo(x, u.bbox.top);
    ctx.lineTo(x, u.bbox.top + u.bbox.height);
    ctx.stroke();
    ctx.fillStyle = CHART.inkSecondary;
    const right = x > u.bbox.left + u.bbox.width * 0.8;
    ctx.textAlign = right ? "right" : "left";
    ctx.fillText(m.label, x + (right ? -4 : 4) * px, u.bbox.top + 2 * px);
  }
  ctx.restore();
}

/** GOES X-ray flux around one flare: log scale, C/M/X bands, begin/peak/end markers. */
export function FlareXray({ xray, from, to, marks }: { xray: XraySeries; from: Unix; to: Unix; marks: Mark[] }) {
  const data: Aligned = useMemo(() => windowed(xray.t, [xray.long as number[], xray.short as number[]], from, to, { positive: true }), [xray, from, to]);
  const make = useMemo(
    () => (width: number, height: number): uPlot.Options => ({
      width, height, tzDate: utc, padding: [10, 6, 0, 0], legend: { show: false },
      cursor: { drag: { x: false, y: false }, y: false },
      scales: { x: { time: true }, y: { distr: 3, log: 10, range: [1e-9, 1e-3] } },
      axes: [
        xAxis(hhmm),
        { ...axisBase, size: 46, gap: 4, space: 12, splits: () => BOUNDS, values: (_u, s) => s.map((v) => (v == null ? "" : pow10(Math.round(Math.log10(v))))), grid: { stroke: CHART.grid, width: 1 }, ticks: { show: false } },
        { side: 1, scale: "y", stroke: CHART.inkSecondary, font: CHART.font, size: 20, gap: 4, space: 12, splits: () => BOUNDS.map((b) => b * Math.sqrt(10)), values: (_u, s) => s.map((_v, i) => CLASS_LABELS[i]), grid: { show: false }, ticks: { show: false } },
      ],
      series: [
        {},
        { label: "Long 0.1–0.8 nm", stroke: CHART.series1, width: 2, points: { show: false } },
        { label: "Short 0.05–0.4 nm", stroke: CHART.series2, width: 2, points: { show: false } },
      ],
      hooks: {
        drawAxes: [
          (u) => {
            const { ctx } = u;
            const { left, width } = u.bbox;
            const y = (v: number) => u.valToPos(v, "y", true);
            ctx.save();
            ctx.globalAlpha = 0.08;
            ctx.fillStyle = CHART.serious;
            ctx.fillRect(left, y(1e-4), width, y(1e-5) - y(1e-4));
            ctx.fillStyle = CHART.critical;
            ctx.fillRect(left, y(1e-3), width, y(1e-4) - y(1e-3));
            ctx.restore();
          },
        ],
        draw: [(u) => vlines(u, marks)],
      },
    }),
    [marks],
  );
  const { box } = useUplot(make, data, [from, to]);
  let top = 0;
  for (const v of data[1]) if (v != null && v > top) top = v;
  return (
    <Frame
      box={box}
      label={`X-ray flux from ${hhmm(from)} to ${hhmm(to)} UTC${top ? `, peak class ${classFromFlux(top)}` : ", no data in this window"}.`}
    />
  );
}

/** One DBM line chart with a vertical arrival line and an optional horizontal 1 AU line. */
function DbmChart({ t, y, unit, label, arrivalAt, hline }: { t: number[]; y: number[]; unit: string; label: string; arrivalAt: Unix; hline?: number }) {
  const data: Aligned = useMemo(() => [t, y], [t, y]);
  const make = useMemo(
    () => (width: number, height: number): uPlot.Options => ({
      width, height, tzDate: utc, padding: [10, 6, 0, 0], legend: { show: false },
      cursor: { drag: { x: false, y: false }, y: false },
      scales: { x: { time: true }, y: { range: (_u, lo, hi) => [Math.min(lo, hline ?? lo) * 0.95, Math.max(hi, hline ?? hi) * 1.05] } },
      axes: [
        xAxis(dayHhmm),
        { ...axisBase, size: 52, gap: 4, grid: { stroke: CHART.grid, width: 1 }, ticks: { show: false }, values: (_u, s) => s.map((v) => (v == null ? "" : `${Math.round(v * 100) / 100}`)) },
      ],
      series: [{}, { label: unit, stroke: CHART.series1, width: 2, points: { show: false } }],
      hooks: {
        draw: [
          (u) => {
            vlines(u, [{ t: arrivalAt, label: "arrives at Earth", color: CHART.serious }]);
            if (hline === undefined) return;
            const { ctx } = u;
            const px = uPlot.pxRatio;
            const yy = u.valToPos(hline, "y", true);
            ctx.save();
            ctx.setLineDash([4 * px, 4 * px]);
            ctx.strokeStyle = CHART.serious;
            ctx.lineWidth = px;
            ctx.beginPath();
            ctx.moveTo(u.bbox.left, yy);
            ctx.lineTo(u.bbox.left + u.bbox.width, yy);
            ctx.stroke();
            ctx.fillStyle = CHART.inkSecondary;
            ctx.font = `${11 * px}px system-ui, sans-serif`;
            ctx.textBaseline = "bottom";
            ctx.fillText("1 AU (Earth)", u.bbox.left + 6 * px, yy - 3 * px);
            ctx.restore();
          },
        ],
      },
    }),
    [arrivalAt, hline, unit],
  );
  const { box } = useUplot(make, data, [t[0], t[t.length - 1]]);
  return <Frame box={box} label={label} />;
}

/** DBM distance–time and speed–time charts for a CME, computed here from the same model as the server. */
export function CmeCharts({ cme }: { cme: Cme }) {
  const track = useMemo(() => dbmSamples(cme), [cme]);
  const cols = useMemo(
    () => (track ? { t: track.samples.map((s) => s.t), au: track.samples.map((s) => kmToAu(s.km)), v: track.samples.map((s) => s.speed) } : null),
    [track],
  );
  if (!track || !cols) return <p className="muted">This CME never reaches 1 AU in the model, so there is no track to draw.</p>;
  return (
    <div className="ev-charts">
      <section>
        <h3>Distance from the Sun (AU)</h3>
        <DbmChart t={cols.t} y={cols.au} unit="AU" arrivalAt={track.arrivalAt} hline={1} label="Modelled distance of the CME front from the Sun against time, reaching 1 AU at the arrival time." />
      </section>
      <section>
        <h3>Speed (km/s)</h3>
        <DbmChart t={cols.t} y={cols.v} unit="km/s" arrivalAt={track.arrivalAt} label="Modelled speed of the CME front against time, slowing toward the solar wind speed." />
      </section>
    </div>
  );
}
