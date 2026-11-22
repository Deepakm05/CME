import { SceneLayout } from "./SceneLayout.tsx";

/** The Sun → Earth scene at the server's now, with live data (UF1). */
export function LivePage() {
  return <SceneLayout mode="live" />;
}
