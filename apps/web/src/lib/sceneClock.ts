import type { Unix } from "@cme/shared";
import { liveStore } from "../store/live.ts";
import { useUi } from "../store/ui.ts";
import { serverNow } from "./api.ts";
import { useWallSecond } from "./clock.ts";
import { replayTimeAt } from "./replayTime.ts";

/** Server time from the live clock (wall clock before the first data). Replay's span ends here. */
export function serverNowS(wall = Date.now() / 1000): Unix {
  const { clock, clockAt } = liveStore.getState();
  return clock ? serverNow(clock, clockAt, wall) : wall;
}

// While the timeline is being dragged the scene follows the pointer every frame, without a store write (and so
// a React render) per pointer event; the store is updated at a lower rate and on release.
let scrub: Unix | null = null;

/** Override the replay time while dragging (null to stop). Only has an effect in replay. */
export function setScrubTime(t: Unix | null): void {
  scrub = t;
}

/**
 * The scene's "now". Live: server time. Replay: the replay time (+ elapsed × speed while playing, kept inside
 * the 7 days ending at server now). Everything animated is a pure function of this.
 */
export function sceneTime(wall = Date.now() / 1000): Unix {
  const src = useUi.getState().timeSource;
  if (src.kind === "live") return serverNowS(wall);
  return scrub ?? replayTimeAt(src, wall, serverNowS(wall));
}

/** True while replaying (outside React: the render loop, event handlers). */
export function isReplay(): boolean {
  return useUi.getState().timeSource.kind === "replay";
}

export function useIsReplay(): boolean {
  return useUi((s) => s.timeSource.kind === "replay");
}

/**
 * The scene's now for the HUD, re-rendering once a second and on every replay jump. null in live mode before
 * any data. The 3D scene reads sceneTime() per frame instead.
 */
export function useSceneNow(): Unix | null {
  const wall = useWallSecond();
  const src = useUi((s) => s.timeSource);
  const { clock, clockAt } = liveStore.getState();
  if (src.kind === "live") return clock ? serverNow(clock, clockAt, wall) : null;
  return replayTimeAt(src, wall, clock ? serverNow(clock, clockAt, wall) : wall);
}
