import { useMemo } from "react";
import type { Alert, Cme, Flare, SunspotRegion, Unix } from "@cme/shared";
import { eventsAt, valueAt } from "../lib/replayTime.ts";
import { latest } from "../lib/travel.ts";
import { historyStore, useHistory } from "./history.ts";
import { liveStore, useLive, type LiveData } from "./live.ts";
import { useUi } from "./ui.ts";

/**
 * The one switch between live and replay data for the scene and the HUD. Live: liveStore as is. Replay:
 * historyStore, with events filtered to what had happened by the replay time. Sunspot regions have no history,
 * so in replay there are none (the timeline says so).
 */
export interface Source {
  replay: boolean;
  flares: Flare[];
  cmes: Cme[];
  alerts: Alert[];
  regions: SunspotRegion[];
  regionsAt: Unix;
  xray: LiveData["xray"];
  wind: LiveData["wind"];
  /** Changes whenever xray / wind do (they are mutated in place). */
  seriesRev: number;
}

const NO_REGIONS: SunspotRegion[] = [];

function pick(replay: boolean): Source {
  if (!replay) {
    const l = liveStore.getState();
    return {
      replay, flares: l.flares, cmes: l.cmes, alerts: l.alerts, regions: l.regions, regionsAt: l.regionsAt,
      xray: l.xray, wind: l.wind, seriesRev: l.seriesRev,
    };
  }
  const h = historyStore.getState();
  return {
    replay, flares: h.flares, cmes: h.cmes, alerts: h.alerts, regions: NO_REGIONS, regionsAt: 0,
    xray: h.xray, wind: h.wind, seriesRev: h.seriesRev,
  };
}

/** The current source, events not filtered by time (for lookups by id, which then check the time themselves). */
export function sourceNow(): Source {
  return pick(useUi.getState().timeSource.kind === "replay");
}

/** The source as of scene time t: in replay only events that had happened by t, each in its state at t. */
export function sourceAt(t: Unix): Source {
  const s = sourceNow();
  return s.replay ? { ...s, ...eventsAt(s, t) } : s;
}

/** A series' value "now": the newest point live, the point at (or just before) t in replay. */
export function seriesNow(s: Pick<Source, "replay">, ts: Float64Array, vs: Float64Array, t: Unix): number | null {
  return s.replay ? valueAt(ts, vs, t) : latest(vs);
}

/** React: the series in use and their revision (for charts; the columns are read with .view()). */
export function useSourceSeries(): Pick<Source, "replay" | "xray" | "wind" | "seriesRev"> {
  const replay = useUi((s) => s.timeSource.kind === "replay");
  const liveRev = useLive((s) => s.seriesRev);
  const histRev = useHistory((s) => s.seriesRev);
  const histX = useHistory((s) => s.xray);
  const histW = useHistory((s) => s.wind);
  if (!replay) {
    const l = liveStore.getState();
    return { replay, xray: l.xray, wind: l.wind, seriesRev: liveRev };
  }
  return { replay, xray: histX, wind: histW, seriesRev: histRev };
}

/** React: the sunspot regions in use (none in replay: there is no regions history). */
export function useSourceRegions(): SunspotRegion[] {
  const replay = useUi((s) => s.timeSource.kind === "replay");
  const regions = useLive((s) => s.regions);
  return replay ? NO_REGIONS : regions;
}

/**
 * React: the source as of t (null = not filtered). Re-renders on any change to the source in use, and to the
 * other store too (cheap, rare).
 */
export function useSource(t: Unix | null): Source {
  const replay = useUi((s) => s.timeSource.kind === "replay");
  const live = [
    useLive((s) => s.flares), useLive((s) => s.cmes), useLive((s) => s.alerts), useLive((s) => s.regions),
    useLive((s) => s.regionsAt), useLive((s) => s.seriesRev),
  ];
  const hist = [useHistory((s) => s.flares), useHistory((s) => s.cmes), useHistory((s) => s.alerts), useHistory((s) => s.seriesRev)];
  return useMemo(
    () => {
      const s = pick(replay);
      return s.replay && t !== null ? { ...s, ...eventsAt(s, t) } : s;
    },
    // the store values are read again inside pick(); these only say when to
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [replay, t, ...live, ...hist],
  );
}
