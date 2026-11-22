import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { Unix } from "@cme/shared";
import { TimelineBar } from "../hud/TimelineBar.tsx";
import { parseReplayParam } from "../lib/replayTime.ts";
import { sceneTime, serverNowS, setScrubTime, useSceneNow } from "../lib/sceneClock.ts";
import { loadHistory } from "../store/history.ts";
import { useLive } from "../store/live.ts";
import { useUi } from "../store/ui.ts";
import { SceneLayout } from "./SceneLayout.tsx";

/** Wait this long after the last move (drag, arrow keys) before loading history for it. */
const SEEK_DEBOUNCE_MS = 250;

/**
 * /replay?t=<unix> (UF7, FR-8): the Live scene and HUD at a past moment, from history, with the 7-day timeline.
 * A missing or invalid ?t means server now − 6 h. Entering sets useUi().timeSource to replay; leaving sets it back
 * to live, so the Live page is untouched. The span ends at server now, so replay waits for the server clock.
 */
export function ReplayPage() {
  const ready = useLive((s) => s.clock !== null);
  if (!ready) return <p className="muted">Waiting for the server clock…</p>;
  return <Replay />;
}

function Replay() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const param = params.get("t");
  const written = useRef<string | null>(null); // the ?t= this page wrote itself

  const writeUrl = useCallback(
    (t: Unix) => {
      const v = String(Math.floor(t));
      written.current = v;
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set("t", v);
        return next;
      }, { replace: true });
    },
    [setParams],
  );

  // Enter replay before the first paint (so no frame shows live time), leave on unmount.
  useLayoutEffect(() => {
    useUi.getState().enterReplay(parseReplayParam(param, serverNowS()));
    return () => {
      setScrubTime(null);
      useUi.getState().exitReplay();
    };
    // ?t= changes after mount are handled below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ?t= changed from outside (a link, back/forward): jump there. Also canonicalise a missing / invalid one.
  const seen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (seen.current === param) return;
    seen.current = param;
    const t = parseReplayParam(param, serverNowS());
    if (param !== String(t)) writeUrl(t);
    if (param === written.current) return;
    if (Math.abs(t - sceneTime()) >= 1) useUi.getState().setReplayTime(t);
  }, [param, writeUrl]);

  // History loads one at a time: a newer request waits for the one in flight instead of aborting it, so fast
  // playback still gets data. loadHistory is a no-op when the window is already loaded.
  const ctrl = useRef<AbortController | null>(null);
  const wanted = useRef<Unix | null>(null);
  const busy = useRef(false);
  const request = useCallback((t: Unix) => {
    wanted.current = Math.floor(t);
    if (busy.current) return;
    busy.current = true;
    void (async () => {
      while (wanted.current !== null && ctrl.current && !ctrl.current.signal.aborted) {
        const next = wanted.current;
        wanted.current = null;
        await loadHistory(next, { signal: ctrl.current.signal });
      }
      busy.current = false;
    })();
  }, []);
  useEffect(() => {
    const c = new AbortController();
    ctrl.current = c;
    request(sceneTime());
    return () => {
      c.abort();
      wanted.current = null;
    };
  }, [request]);

  const seekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (seekTimer.current) clearTimeout(seekTimer.current);
  }, []);
  const onSeek = useCallback(
    (t: Unix) => {
      if (seekTimer.current) clearTimeout(seekTimer.current);
      seekTimer.current = setTimeout(() => request(t), SEEK_DEBOUNCE_MS);
    },
    [request],
  );
  const onCommit = useCallback(
    (t: Unix) => {
      if (seekTimer.current) clearTimeout(seekTimer.current);
      request(t);
      writeUrl(t);
    },
    [request, writeUrl],
  );

  // While playing, keep loading the window around the moving time (checked once a second).
  const now = useSceneNow();
  const playing = useUi((s) => s.timeSource.kind === "replay" && s.timeSource.playing);
  useEffect(() => {
    if (playing && now !== null) request(now);
  }, [playing, now, request]);

  return (
    <SceneLayout mode="replay">
      <TimelineBar onSeek={onSeek} onCommit={onCommit} onExit={() => navigate("/")} onRetry={() => request(sceneTime())} />
    </SceneLayout>
  );
}
