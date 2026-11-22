import { useLayoutEffect, useRef } from "react";
import { useServerNow } from "../lib/clock.ts";
import { formatReplayTime } from "../lib/replayTime.ts";
import { sceneTime, useIsReplay } from "../lib/sceneClock.ts";
import { clockNote, formatClock } from "../lib/travel.ts";
import { useLive } from "../store/live.ts";
import { useUi } from "../store/ui.ts";
import { useAnimationFrame } from "./useAnimationFrame.ts";

/**
 * The scene's clock: the moment being drawn, in UTC, and whether it is live. Says so whenever time is not
 * real (mock data, a scenario, a speed other than ×1), so a sped-up demo is never mistaken for reality.
 * In replay it is the REPLAY badge with the replay time instead.
 */
export function SceneClock() {
  return useIsReplay() ? <ReplayClock /> : <LiveClock />;
}

function LiveClock() {
  const now = useServerNow();
  const clock = useLive((s) => s.clock);
  const conn = useLive((s) => s.conn);
  if (now === null || !clock) return null;

  const [label, tone, hint] =
    conn.status === "live"
      ? ["LIVE", "ok", "Updating as new data arrives"]
      : conn.source === "cache"
        ? ["SAVED", "warn", "Showing the last saved data while offline"]
        : ["DELAYED", "warn", "Reconnecting; the scene keeps running on the server clock"];
  const note = clockNote(clock);
  return (
    <div className="scene-clock" title={hint}>
      <span className={`clock-state ${tone}`}>
        <span className="dot" aria-hidden />
        {label}
      </span>
      <time dateTime={new Date(now * 1000).toISOString()}>{formatClock(now)}</time>
      {note ? <span className="clock-note">{note}</span> : null}
    </div>
  );
}

/** "REPLAY · Sat 21 Nov 2026, 14:35 UTC": the time text follows playback every frame, written through a ref. */
function ReplayClock() {
  const time = useRef<HTMLTimeElement>(null);
  const src = useUi((s) => s.timeSource);
  const write = () => {
    const el = time.current;
    if (!el) return;
    const t = sceneTime();
    const s = formatReplayTime(t);
    if (el.textContent !== s) {
      el.textContent = s;
      el.dateTime = new Date(Math.floor(t) * 1000).toISOString();
    }
  };
  useLayoutEffect(write);
  useAnimationFrame(write);
  return (
    <div className="scene-clock replay-clock" title="Replaying recorded data: the scene and the charts show this moment">
      <span className="clock-state replay">
        <span className="dot" aria-hidden />
        REPLAY
      </span>
      <time ref={time} />
      {src.kind === "replay" ? <span className="clock-note replay">{src.playing ? `playing ×${src.speed}` : "paused"}</span> : null}
    </div>
  );
}
