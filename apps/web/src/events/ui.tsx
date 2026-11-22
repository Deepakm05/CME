import type { ReactNode } from "react";
import { Link } from "react-router";

/** Loading / error states shared by the events pages. */
export function Loading({ what }: { what: string }) {
  return <p className="muted" role="status">Loading {what}…</p>;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="ev-error" role="alert">
      <p>Could not load this. {message}</p>
      {onRetry ? <button type="button" className="ev-btn" onClick={onRetry}>Try again</button> : null}
    </div>
  );
}

export function NotFound({ what }: { what: string }) {
  return (
    <section>
      <h1>Not found</h1>
      <p>We have no {what} with that id. It may be older than the 7 days we keep, or the link may be wrong.</p>
      <p><Link to="/events">Back to all events</Link></p>
    </section>
  );
}

/** Label/value list. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="ev-facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
