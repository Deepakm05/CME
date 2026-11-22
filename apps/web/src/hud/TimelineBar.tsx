import { memo, useEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { Unix } from "@cme/shared";
import { useServerNow } from "../lib/clock.ts";
import {
  REPLAY_SPEEDS, cmeMarks, type CmeMark, type FlareTick, dayMarks, flareTicks, formatReplayTime, fracOf, replaySpan, stepForKey, timeAtFrac,
} from "../lib/replayTime.ts";
import { sceneTime, serverNowS, setScrubTime } from "../lib/sceneClock.ts";
import { useHistory } from "../store/history.ts";
import { useUi } from "../store/ui.ts";
import { useAnimationFrame } from "./useAnimationFrame.ts";

/** While dragging, the store (and so the HUD) follows at this rate; the scene follows every frame. */
const DRAG_COMMIT_MS = 120;
/** After the last arrow key, write the URL this much later. */
const KEY_COMMIT_MS = 600;

const SPEED_LABEL: Record<(typeof REPLAY_SPEEDS)[number], string> = { 60: "1 min/s", 600: "10 min/s", 3600: "1 h/s" };

export interface TimelineBarProps {
  /** The replay time moved (drag, keys): load history for it, debounced by the caller. */
  onSeek: (t: Unix) => void;
  /** The replay time settled (release, pause, keys done): write ?t= and load now. */
  onCommit: (t: Unix) => void;
  onExit: () => void;
  onRetry: () => void;
}

/**
 * Replay's 7-day timeline (UF7): flare ticks by class (C short, M taller, X full height), CME launches, a
 * draggable thumb that is a keyboard slider (← → 5 min, Shift 1 h, PgUp/PgDn 6 h, Home/End), play/pause and
 * speed. The playhead is written to the DOM every frame through refs: no React render per frame.
 */
export function TimelineBar({ onSeek, onCommit, onExit, onRetry }: TimelineBarProps) {
  const src = useUi((s) => s.timeSource);
  const { setReplayTime, play, pause, setSpeed } = useUi.getState();
  const status = useHistory((s) => s.status);
  const error = useHistory((s) => s.error);
  const flares = useHistory((s) => s.flares);
  const cmes = useHistory((s) => s.cmes);

  // The track ends at server now; ticks are placed against a range that moves once a minute.
  const serverNow = useServerNow() ?? serverNowS();
  const endMin = Math.floor(serverNow / 60) * 60;
  const range = useMemo(() => replaySpan(endMin), [endMin]);
  const rangeRef = useRef(range);
  useEffect(() => {
    rangeRef.current = range;
  }, [range]);

  const ticks = useMemo(() => flareTicks(flares, range), [flares, range]);
  const launches = useMemo(() => cmeMarks(cmes, range), [cmes, range]);
  const days = useMemo(() => dayMarks(range), [range]);
  const counts = useMemo(() => {
    const c = { C: 0, M: 0, X: 0 };
    for (const t of ticks) c[t.letter]++;
    return c;
  }, [ticks]);

  const track = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const drag = useRef<{ t: Unix; lastCommit: number; pointer: number } | null>(null);
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastText = useRef("");
  useEffect(() => () => {
    if (keyTimer.current) clearTimeout(keyTimer.current);
    setScrubTime(null);
  }, []);

  // Per frame: playhead position and the slider's value; stop at the end of the span.
  useAnimationFrame(() => {
    const t = sceneTime();
    const pct = `${(fracOf(t, rangeRef.current) * 100).toFixed(3)}%`;
    if (thumb.current && thumb.current.style.left !== pct) thumb.current.style.left = pct;
    if (fill.current && fill.current.style.width !== pct) fill.current.style.width = pct;
    const text = formatReplayTime(t);
    if (thumb.current && text !== lastText.current) {
      lastText.current = text;
      thumb.current.setAttribute("aria-valuenow", String(Math.floor(t)));
      thumb.current.setAttribute("aria-valuetext", text);
    }
    const s = useUi.getState().timeSource;
    if (s.kind === "replay" && s.playing && !drag.current && t >= serverNowS() - 1) {
      pause(t);
      onCommit(Math.floor(t));
    }
  });

  const timeAtPointer = (clientX: number): Unix | null => {
    const el = track.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 ? timeAtFrac((clientX - r.left) / r.width, rangeRef.current) : null;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const t = timeAtPointer(e.clientX);
    if (t === null) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    thumb.current?.focus({ preventScroll: true });
    drag.current = { t, lastCommit: performance.now(), pointer: e.pointerId };
    setScrubTime(t);
    setReplayTime(t);
    onSeek(t);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const t = timeAtPointer(e.clientX);
    if (t === null || t === d.t) return;
    d.t = t;
    setScrubTime(t); // the scene follows at once
    const now = performance.now();
    if (now - d.lastCommit > DRAG_COMMIT_MS) {
      d.lastCommit = now;
      setReplayTime(t); // the HUD follows a few times a second
      onSeek(t);
    }
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    setReplayTime(d.t);
    setScrubTime(null);
    onCommit(d.t);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = stepForKey(e.key, e.shiftKey, sceneTime(), replaySpan(Math.floor(serverNowS())));
    if (t === null) return;
    e.preventDefault();
    setReplayTime(t);
    onSeek(t);
    if (keyTimer.current) clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(() => onCommit(t), KEY_COMMIT_MS);
  };

  const playing = src.kind === "replay" && src.playing;
  const speed = src.kind === "replay" ? src.speed : REPLAY_SPEEDS[1];
  const togglePlay = () => {
    const t = sceneTime();
    if (playing) {
      pause(t);
      onCommit(Math.floor(t));
    } else {
      // at the very end there is nothing left to play: start a day back
      play(t >= serverNowS() - 60 ? t - 86_400 : t);
    }
  };

  const t0 = sceneTime();
  return (
    <section className="timeline" aria-label="Replay timeline">
      <div className="tl-controls">
        <button type="button" className="tl-btn tl-live" onClick={onExit} aria-label="Back to live">
          <span aria-hidden>←</span>
          <span><span className="wide-only">Back to </span>live</span>
        </button>
        <button type="button" className="tl-btn tl-play" onClick={togglePlay} aria-pressed={playing} aria-label={playing ? "Pause" : "Play"}>
          {playing ? (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden fill="currentColor"><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
          ) : (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden fill="currentColor"><path d="M4 2.2v11.6a.8.8 0 0 0 1.2.7l9.3-5.8a.8.8 0 0 0 0-1.4L5.2 1.5A.8.8 0 0 0 4 2.2Z" /></svg>
          )}
        </button>
        <div className="seg tl-speed" role="radiogroup" aria-label="Playback speed">
          {REPLAY_SPEEDS.map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={speed === v}
              title={`${v}× real time`}
              onClick={() => setSpeed(v, sceneTime())}
            >
              <span className="wide-only">{SPEED_LABEL[v]}</span>
              <span className="narrow-only">{v}×</span>
            </button>
          ))}
        </div>
        <span className="tl-status" role="status">
          {status === "loading" ? (
            <span className="muted">Loading history…</span>
          ) : status === "error" ? (
            <span className="tl-error">
              History failed to load{error ? `: ${error}` : ""}.{" "}
              <button type="button" className="link-btn" onClick={onRetry}>
                Retry
              </button>
            </span>
          ) : null}
        </span>
        <span className="tl-legend" aria-hidden>
          <span><i className="tl-key flare-C" />C</span>
          <span><i className="tl-key flare-M" />M</span>
          <span><i className="tl-key flare-X" />X</span>
          <span><i className="tl-key cme" />CME</span>
          <span className="tl-note">Sunspot regions: not in replay</span>
        </span>
      </div>
      <p className="sr-only">
        Last 7 days: {counts.C} C, {counts.M} M and {counts.X} X flares; {launches.length} CMEs. Sunspot regions are not shown in replay
        because only today's are known.
      </p>
      <div
        ref={track}
        className="tl-track"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="tl-rail" aria-hidden>
          <div ref={fill} className="tl-fill" />
          <Marks days={days} ticks={ticks} launches={launches} />
        </div>
        <div
          ref={thumb}
          className="tl-thumb"
          role="slider"
          tabIndex={0}
          aria-label="Replay time"
          aria-valuemin={range[0]}
          aria-valuemax={range[1]}
          aria-valuenow={Math.floor(t0)}
          aria-valuetext={formatReplayTime(t0)}
          aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight PageUp PageDown Home End"
          onKeyDown={onKeyDown}
          style={{ left: `${fracOf(t0, range) * 100}%` }}
        />
      </div>
    </section>
  );
}

/** Day lines, flare ticks and CME markers: re-rendered only when the events or the (per-minute) range change. */
const Marks = memo(function Marks({ days, ticks, launches }: { days: ReturnType<typeof dayMarks>; ticks: FlareTick[]; launches: CmeMark[] }) {
  return (
    <>
      {days.map((d) => (
        <span key={d.t} className="tl-day" style={{ left: `${d.frac * 100}%` }}>
          <span>{d.label}</span>
        </span>
      ))}
      {ticks.map((k) => (
        <span key={k.id} className={`tl-tick flare-${k.letter}`} style={{ left: `${k.frac * 100}%`, height: `${k.size * 100}%` }} title={k.label} />
      ))}
      {launches.map((c) => (
        <span key={c.id} className={`tl-cme${c.earthDirected ? " earth" : ""}`} style={{ left: `${c.frac * 100}%` }} title={c.label} />
      ))}
    </>
  );
});
