import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { eventsResponseSchema } from "@cme/shared";
import { CLASSES, KINDS, eventsPath, filterRows, fmtUtc, parseFilter, toRows, withFilter, type EventFilter } from "../events/model.ts";
import { ErrorBox, Loading } from "../events/ui.tsx";
import { useFetch } from "../events/useFetch.ts";
import { useNowOnMount } from "../events/useNow.ts";

const parse = (raw: unknown) => eventsResponseSchema.parse(raw);
const KIND_LABEL = { flare: "Flares", cme: "CMEs", alert: "Alerts" } as const;

/** Every flare, CME and alert of the last 7 days in one table, filterable by kind and flare class (kept in the URL). */
export function EventsPage() {
  const [params, setParams] = useSearchParams();
  const filter = parseFilter(params);
  const now = useNowOnMount();
  const [retry, setRetry] = useState(0);
  const res = useFetch(eventsPath(now), parse, retry);
  const rows = useMemo(() => (res.state === "ok" ? toRows(res.data) : []), [res]);
  const shown = useMemo(() => filterRows(rows, { kind: filter.kind, cls: filter.cls }), [rows, filter.kind, filter.cls]);
  const set = (f: EventFilter) => setParams(withFilter(params, f), { replace: true });

  return (
    <section className="ev-page">
      <h1>Events</h1>
      <p className="muted">Flares, coronal mass ejections and alerts from the last 7 days, newest first. Times are UTC.</p>

      <div className="ev-filters">
        <div className="seg" role="group" aria-label="Kind">
          <button type="button" aria-pressed={filter.kind === null} onClick={() => set({ ...filter, kind: null })}>All</button>
          {KINDS.map((k) => (
            <button key={k} type="button" aria-pressed={filter.kind === k} onClick={() => set({ ...filter, kind: k })}>{KIND_LABEL[k]}</button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Flare class">
          <button type="button" aria-pressed={filter.cls === null} onClick={() => set({ ...filter, cls: null })}>Any class</button>
          {CLASSES.map((c) => (
            <button key={c} type="button" aria-pressed={filter.cls === c} onClick={() => set({ ...filter, cls: c })}>{c}</button>
          ))}
        </div>
      </div>

      {res.state === "loading" ? <Loading what="events" /> : null}
      {res.state === "error" ? <ErrorBox message={res.message} onRetry={() => setRetry((n) => n + 1)} /> : null}
      {res.state === "ok" && shown.length === 0 ? (
        <p className="ev-empty">
          {rows.length === 0 ? "No events in the last 7 days." : "No events match these filters."}{" "}
          {rows.length > 0 ? <button type="button" className="link-btn" onClick={() => set({ kind: null, cls: null })}>Clear filters</button> : null}
        </p>
      ) : null}
      {res.state === "ok" && shown.length > 0 ? (
        <div className="ev-table-wrap">
          <table className="ev-table">
            <caption className="sr-only">Solar events of the last 7 days, newest first ({shown.length} shown)</caption>
            <thead>
              <tr>
                <th scope="col">Time (UTC)</th>
                <th scope="col">Kind</th>
                <th scope="col">Event</th>
                <th scope="col">Details</th>
                <th scope="col">Replay</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.kind}:${r.id}`}>
                  <td data-label="Time" className="ev-time">{fmtUtc(r.at)}</td>
                  <td data-label="Kind"><span className={`ev-kind ev-kind-${r.kind}`}>{r.kind}</span></td>
                  <th scope="row" data-label="Event"><Link to={r.href}>{r.label}</Link></th>
                  <td data-label="Details" className="muted">{r.detail}</td>
                  <td data-label="Replay"><Link to={r.replayHref}>Replay this moment</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
