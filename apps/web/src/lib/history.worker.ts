/**
 * Module Web Worker that parses GET /history bodies off the main thread (GAP_ANALYSIS F2, no-lag rule 4).
 *
 * Protocol (the main thread fetches, the worker only parses; that keeps fetch abortable with a plain
 * AbortSignal and avoids a cancel message):
 *   main -> worker   { id, text }            the response body as text
 *   worker -> main   { id, ok: true, result } ParsedHistory; every column's ArrayBuffer is TRANSFERRED (no copy)
 *                    { id, ok: false, error } validation or JSON failure, as a message
 *
 * Load it with `new Worker(new URL("./history.worker.ts", import.meta.url), { type: "module" })` so Vite bundles
 * it. The main-thread fallback (Node, no Worker) calls parseHistoryText directly; see store/history.ts.
 */
import { parseHistoryText, transferablesOf, type ParsedHistory } from "./historyParse.ts";

export interface HistoryWorkerRequest {
  id: number;
  text: string;
}

export type HistoryWorkerResponse =
  | { id: number; ok: true; result: ParsedHistory }
  | { id: number; ok: false; error: string };

// The DOM lib types `self` as a Window; this is the slice of the worker scope used here.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<HistoryWorkerRequest>) => void) | null;
  postMessage(message: HistoryWorkerResponse, transfer: Transferable[]): void;
};

scope.onmessage = (e) => {
  const { id, text } = e.data;
  try {
    const result = parseHistoryText(text);
    scope.postMessage({ id, ok: true, result }, transferablesOf(result));
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) }, []);
  }
};
