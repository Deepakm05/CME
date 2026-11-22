import type { FeedId, Unix } from "@cme/shared";
import { formatAge, valueFreshness } from "../lib/freshness.ts";
import { useSceneNow } from "../lib/sceneClock.ts";
import { useLive } from "../store/live.ts";
import { useUi } from "../store/ui.ts";

/**
 * The age of one value ("73 s"), amber once its feed's data is stale (UF8). Put it next to every live value.
 * In replay it is the age at the replay time, with no staleness (feed health is about now, not then).
 */
export function DataAge({ ts, feed }: { ts: Unix | null; feed: FeedId }) {
  const now = useSceneNow();
  const replay = useUi((s) => s.timeSource.kind === "replay");
  const status = useLive((s) => s.feeds.find((f) => f.id === feed));
  if (now === null || ts === null) return <span className="age unknown">—</span>;

  const fresh = replay ? "fresh" : valueFreshness(ts, status, now);
  const when = new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");
  return (
    <span className={`age ${fresh}`} title={`Data time ${when} UTC${!replay && status?.error ? ` · ${status.error}` : ""}`}>
      {formatAge(now - ts)}
      {replay ? " before" : ""}
      {fresh === "stale" ? " · stale" : ""}
    </span>
  );
}
