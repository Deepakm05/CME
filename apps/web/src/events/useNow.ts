import { useState } from "react";
import { serverNow } from "../lib/api.ts";
import { liveStore } from "../store/live.ts";
import { snapNow } from "./model.ts";

/** Server time (whole minutes) fixed at mount, so the events request does not change every second. */
export function useNowOnMount(): number {
  const [now] = useState(() => {
    const { clock, clockAt } = liveStore.getState();
    return snapNow(clock ? serverNow(clock, clockAt) : null);
  });
  return now;
}
