import { useEffect, useRef } from "react";

/**
 * Run `fn` on every animation frame while mounted (and the tab is visible: browsers pause rAF in background
 * tabs). For DOM writes through refs only: never set React state from it.
 */
export function useAnimationFrame(fn: () => void): void {
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  useEffect(() => {
    let id = 0;
    const tick = () => {
      latest.current();
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);
}
