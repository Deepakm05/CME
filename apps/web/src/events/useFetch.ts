import { useEffect, useState } from "react";
import { getJson } from "../lib/api.ts";

export type Fetched<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; data: T };

/** GET `path` (null = wait), validate with `parse` (throws on bad data), abort on unmount or path change. Bump `retry` to re-run. */
export function useFetch<T>(path: string | null, parse: (raw: unknown) => T, retry = 0): Fetched<T> {
  const [res, setRes] = useState<{ key: string; value: Fetched<T> } | null>(null);
  const key = path === null ? null : `${path}#${retry}`;

  useEffect(() => {
    if (path === null || key === null) return;
    const ac = new AbortController();
    getJson<unknown>(path, ac.signal)
      .then((raw) => setRes({ key, value: { state: "ok", data: parse(raw) } }))
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setRes({ key, value: { state: "error", message: e instanceof Error ? e.message : String(e) } });
      });
    return () => ac.abort();
    // `parse` is a module-level function at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return res !== null && res.key === key ? res.value : { state: "loading" };
}
