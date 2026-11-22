import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { cmeSchema, eventsResponseSchema, historyResponseSchema, type Alert, type Cme, type Flare, type XraySeries } from "@cme/shared";
import { formatLocation } from "@cme/physics";
import { alertHint, alertTarget } from "../lib/alerts.ts";
import { formatDuration } from "../lib/travel.ts";
import { liveStore } from "../store/live.ts";
import { useShowAlert } from "../shell/useAlertDelivery.ts";
import { CmeCharts, FlareXray } from "../events/Charts.tsx";
import { arrivalReplayHref, eventsPath, flareWindow, fmtUtc, historyPath, momentReplayHref } from "../events/model.ts";
import { ErrorBox, Facts, Loading, NotFound } from "../events/ui.tsx";
import { useFetch } from "../events/useFetch.ts";
import { useNowOnMount } from "../events/useNow.ts";

const parseEvents = (raw: unknown) => eventsResponseSchema.parse(raw);
const parseCme = (raw: unknown) => cmeSchema.parse(raw);
const parseHistory = (raw: unknown) => historyResponseSchema.parse(raw);

/** Detail page for one flare, CME or alert (/events/:kind/:id). */
export function EventDetailPage() {
  const { kind, id } = useParams();
  if (!id) return <NotFound what="event" />;
  switch (kind) {
    case "flare":
      return <FlareDetail id={id} />;
    case "cme":
      return <CmeDetail id={id} />;
    case "alert":
      return <AlertDetail id={id} />;
    default:
      return <NotFound what="event" />;
  }
}

const Back = () => <p><Link to="/events">← All events</Link></p>;

function FlareDetail({ id }: { id: string }) {
  const now = useNowOnMount();
  const [retry, setRetry] = useState(0);
  const res = useFetch(eventsPath(now), parseEvents, retry);
  if (res.state === "loading") return <Loading what="flare" />;
  if (res.state === "error") return <ErrorBox message={res.message} onRetry={() => setRetry((n) => n + 1)} />;
  const flare = (res.data.flares ?? []).find((f) => f.id === id);
  if (!flare) return <NotFound what="flare" />;
  return <FlareView flare={flare} now={now} />;
}

function FlareView({ flare: f, now }: { flare: Flare; now: number }) {
  const win = useMemo(() => flareWindow(f, now), [f, now]);
  const hist = useFetch(historyPath(win.from, win.to), parseHistory);
  const marks = useMemo(() => [{ t: f.beginAt, label: "begin" }, { t: f.peakAt, label: "peak" }, { t: f.endAt, label: "end" }], [f]);
  const loc = f.lat !== null && f.lon !== null ? formatLocation(f.lat, f.lon) : null;
  return (
    <section className="ev-page">
      <Back />
      <h1>{f.cls} flare</h1>
      <Facts
        rows={[
          ["Class", f.cls],
          ["Status", f.status],
          ["Begin", fmtUtc(f.beginAt)],
          ["Peak", fmtUtc(f.peakAt)],
          ["End", fmtUtc(f.endAt)],
          ["Active region", f.regionNo ? `AR ${f.regionNo}` : "unknown"],
          ["Location", loc ?? "unknown"],
        ]}
      />
      <p><Link className="ev-btn" to={momentReplayHref(f.beginAt)}>Replay this moment</Link></p>
      <h2>X-ray flux around the flare</h2>
      <p className="muted">One hour either side, 1-minute data. Shaded bands mark M and X class.</p>
      {hist.state === "loading" ? <Loading what="X-ray data" /> : null}
      {hist.state === "error" ? <ErrorBox message={hist.message} /> : null}
      {hist.state === "ok" ? <FlareXray xray={hist.data.data as XraySeries} from={win.from} to={win.to} marks={marks} /> : null}
    </section>
  );
}

function CmeDetail({ id }: { id: string }) {
  const [retry, setRetry] = useState(0);
  const res = useFetch(`/cmes/${encodeURIComponent(id)}`, parseCme, retry);
  if (res.state === "loading") return <Loading what="CME" />;
  if (res.state === "error") {
    return res.message.startsWith("404") ? <NotFound what="CME" /> : <ErrorBox message={res.message} onRetry={() => setRetry((n) => n + 1)} />;
  }
  return <CmeView cme={res.data} />;
}

function CmeView({ cme: c }: { cme: Cme }) {
  const eta = c.forecast?.eta ?? null;
  const replay = arrivalReplayHref(eta);
  return (
    <section className="ev-page">
      <Back />
      <h1>CME, {Math.round(c.speed)} km/s</h1>
      <Facts
        rows={[
          ["Launch (at 21.5 solar radii)", fmtUtc(c.launchAt)],
          ["Speed", `${Math.round(c.speed)} km/s`],
          ["Half-width", `${Math.round(c.halfAngle)}°`],
          ["Direction", formatLocation(c.lat, c.lon)],
          ["Earth-directed", c.earthDirected ? "yes" : "no"],
          ["Earth arrival (forecast)", eta === null ? "none forecast" : `${fmtUtc(eta)}${c.forecast?.arrivalSpeed ? `, about ${Math.round(c.forecast.arrivalSpeed)} km/s` : ""}`],
          ["Launched by flare", c.flareId ? <Link key="f" to={`/events/flare/${encodeURIComponent(c.flareId)}`}>{c.flareId}</Link> : "unknown"],
        ]}
      />
      <p className="ev-actions">
        {replay ? <Link className="ev-btn" to={replay}>Replay arrival</Link> : null}
        <Link className="ev-btn" to={momentReplayHref(c.launchAt)}>Replay launch</Link>
      </p>
      <h2>Drag-based model</h2>
      <p className="muted">
        Computed in your browser from the launch speed and the ambient wind used by the forecast
        {c.forecast ? ` (${Math.round(c.forecast.w)} km/s)` : " (assumed 400 km/s)"}.
      </p>
      <CmeCharts cme={c} />
    </section>
  );
}

function AlertDetail({ id }: { id: string }) {
  const now = useNowOnMount();
  const [retry, setRetry] = useState(0);
  const res = useFetch(eventsPath(now), parseEvents, retry);
  const show = useShowAlert();
  if (res.state === "loading") return <Loading what="alert" />;
  if (res.state === "error") return <ErrorBox message={res.message} onRetry={() => setRetry((n) => n + 1)} />;
  const a: Alert | undefined = (res.data.alerts ?? []).find((x) => x.id === id);
  if (!a) return <NotFound what="alert" />;
  const target = alertTarget(a, res.data.flares ?? liveStore.getState().flares);
  const hint = alertHint(a);
  return (
    <section className="ev-page">
      <Back />
      <h1>{a.title}</h1>
      <p>{a.message}</p>
      {hint ? <p className="muted">{hint}</p> : null}
      <Facts
        rows={[
          ["Level", a.level],
          ["Rule", a.rule],
          ["Raised", fmtUtc(a.raisedAt)],
          ["Cleared", a.clearedAt === null ? "still active" : `${fmtUtc(a.clearedAt)} (after ${formatDuration(a.clearedAt - a.raisedAt)})`],
        ]}
      />
      <p className="ev-actions">
        {target ? <button type="button" className="ev-btn" onClick={() => show(a)}>Show me</button> : null}
        {a.refType === "flare" || a.refType === "cme" ? <Link className="ev-btn" to={`/events/${a.refType}/${encodeURIComponent(a.refId)}`}>Open the {a.refType}</Link> : null}
        <Link className="ev-btn" to={momentReplayHref(a.raisedAt)}>Replay this moment</Link>
      </p>
    </section>
  );
}
