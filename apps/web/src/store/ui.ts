import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { Unix } from "@cme/shared";
import type { PlanetId } from "../lib/ephemeris.ts";
import { DEFAULT_REPLAY_SPEED, type TimeSource } from "../lib/replayTime.ts";

export type { TimeSource };
export type Scale = "readable" | "true";
/** Camera presets; "focus" flies to the selected object and follows it. */
export type View = "overview" | "top" | "sun" | "earth" | "focus";

/** What the info card shows (UF3). */
export type Selection =
  | { kind: "planet"; id: PlanetId }
  | { kind: "sun" }
  | { kind: "l1" }
  | { kind: "region"; regionNo: number }
  | { kind: "cme"; id: string };

/** Panels that can be minimized to their header line. */
export type PanelId = "xray" | "wind" | "cme";

/**
 * The uiSlice from docs/design/frontend section 2: written only by user input.
 * Remembered across reloads: `scale`, `keyOpen`, `minimized`. The camera always starts at the overview,
 * nothing starts selected, and panels always start shown (`panelsHidden` is not remembered).
 */
export interface UiState {
  scale: Scale;
  view: View;
  /** Bumped on every setView, so picking the same view again re-centres the camera. */
  viewNonce: number;
  /** Key panel open? Open on a first desktop visit, closed on phones; then remembered. */
  keyOpen: boolean;
  selected: Selection | null;
  minimized: Record<PanelId, boolean>;
  /** Every overlay hidden for a clear view of the scene (clock and controls stay). */
  panelsHidden: boolean;
  setScale: (scale: Scale) => void;
  setView: (view: View) => void;
  setKeyOpen: (open: boolean) => void;
  select: (s: Selection | null) => void;
  setMinimized: (panel: PanelId, min: boolean) => void;
  setPanelsHidden: (hidden: boolean) => void;
  /** Live, or a replay moment (UF7). Never remembered: every visit to Live is live. */
  timeSource: TimeSource;
  /** Start replaying at t, paused. */
  enterReplay: (t: Unix) => void;
  /** Jump to t (keeps playing / paused and the speed). */
  setReplayTime: (t: Unix) => void;
  /** Play from `from` (default: the current replay time). */
  play: (from?: Unix) => void;
  /** Pause at `at`: pass the time shown (sceneTime()) so the pause doesn't jump. */
  pause: (at: Unix) => void;
  /** Change speed; `now` = the current replay time, so playback carries on from where it is. */
  setSpeed: (speed: number, now: Unix) => void;
  exitReplay: () => void;
}

const wallS = () => Date.now() / 1000;

/**
 * localStorage, or a throw when it can't be used. Throwing makes zustand's persist keep state in memory only.
 * `localStorage` may throw on access (blocked site data), or exist but be undefined (Node ≥ 25 without
 * --localstorage-file), and writes may throw (private mode, quota); writes that fail are ignored.
 */
function safeLocalStorage(): StateStorage {
  const ls = globalThis.localStorage as Storage | undefined;
  if (!ls || typeof ls.getItem !== "function") throw new Error("localStorage unavailable");
  return {
    getItem: (k) => ls.getItem(k),
    removeItem: (k) => {
      try {
        ls.removeItem(k);
      } catch {
        /* ignore */
      }
    },
    setItem: (k, v) => {
      try {
        ls.setItem(k, v);
      } catch {
        /* ignore: quota or private mode */
      }
    },
  };
}

const wideScreen = () => typeof matchMedia === "undefined" || !matchMedia("(max-width: 640px)").matches;

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      scale: "readable",
      view: "overview",
      viewNonce: 0,
      keyOpen: wideScreen(),
      selected: null,
      minimized: { xray: false, wind: false, cme: true }, // CME cards start compact: they sit over Earth's side of the scene
      panelsHidden: false,
      setScale: (scale) => set({ scale }),
      setKeyOpen: (keyOpen) => set({ keyOpen }),
      setView: (view) => set((s) => ({ view, viewNonce: s.viewNonce + 1 })),
      select: (selected) => set({ selected }),
      setMinimized: (panel, min) => set((s) => ({ minimized: { ...s.minimized, [panel]: min } })),
      setPanelsHidden: (panelsHidden) => set({ panelsHidden }),
      timeSource: { kind: "live" },
      enterReplay: (t) => set({ timeSource: { kind: "replay", t, playing: false, speed: DEFAULT_REPLAY_SPEED, at: wallS() } }),
      setReplayTime: (t) =>
        set((s) => (s.timeSource.kind === "replay" ? { timeSource: { ...s.timeSource, t, at: wallS() } } : {})),
      play: (from) =>
        set((s) =>
          s.timeSource.kind === "replay" ? { timeSource: { ...s.timeSource, t: from ?? s.timeSource.t, playing: true, at: wallS() } } : {},
        ),
      pause: (at) =>
        set((s) => (s.timeSource.kind === "replay" ? { timeSource: { ...s.timeSource, t: at, playing: false, at: wallS() } } : {})),
      setSpeed: (speed, now) =>
        set((s) => (s.timeSource.kind === "replay" ? { timeSource: { ...s.timeSource, t: now, speed, at: wallS() } } : {})),
      exitReplay: () => set({ timeSource: { kind: "live" } }),
    }),
    {
      name: "cme:ui:v1",
      storage: createJSONStorage(safeLocalStorage),
      partialize: (s) => ({ scale: s.scale, keyOpen: s.keyOpen, minimized: s.minimized }),
      // older saved states have no `minimized`; keep the defaults for anything missing
      merge: (saved, current) => {
        const p = (saved ?? {}) as Partial<UiState>;
        return { ...current, ...p, minimized: { ...current.minimized, ...(p.minimized ?? {}) } };
      },
    },
  ),
);

/** Same selection? (for highlighting the selected label) */
export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  switch (a.kind) {
    case "planet":
      return a.id === (b as typeof a).id;
    case "region":
      return a.regionNo === (b as typeof a).regionNo;
    case "cme":
      return a.id === (b as typeof a).id;
    default:
      return true;
  }
}
