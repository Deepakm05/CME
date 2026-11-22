import { useFrame } from "@react-three/fiber";
import { positionsAt, type Positions } from "../lib/ephemeris.ts";
import { sceneTime } from "../lib/sceneClock.ts";

/**
 * The scene's "now": server time live, the replay time in replay (lib/sceneClock.ts, kept free of three.js so
 * it can be tested in Node).
 */
export { sceneTime };

// Every component asks for positions in its own useFrame; compute them once per frame.
let cacheKey = -1;
let cache: Positions | null = null;
let cacheT = 0;

/** Body positions for the frame being drawn. `frameTime` is r3f's state.clock.elapsedTime (same within a frame). */
export function framePositions(frameTime: number): Positions {
  if (frameTime !== cacheKey || !cache) {
    cacheT = sceneTime();
    cache = positionsAt(cacheT);
    cacheKey = frameTime;
  }
  return cache;
}

/** The scene time (unix s) that the current frame's positions were computed for. */
export function frameSceneTime(frameTime: number): number {
  framePositions(frameTime);
  return cacheT;
}

/** Run `fn` every frame with this frame's positions. Never sets React state: no re-render per frame. */
export function useFramePositions(fn: (p: Positions) => void): void {
  useFrame((state) => fn(framePositions(state.clock.elapsedTime)));
}
