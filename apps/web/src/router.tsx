import { createBrowserRouter } from "react-router";
import { AppShell } from "./shell/AppShell.tsx";
import { LivePage } from "./pages/Live.tsx";
import { SunPage } from "./pages/Sun.tsx";
import { StatusPage } from "./pages/Status.tsx";

/**
 * Routes from docs/design/frontend/README.md section 4. /guide is served statically, outside the SPA.
 * Replay and the Events pages are lazy chunks, so the Live page's cold load doesn't pay for them.
 */
export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <LivePage /> },
      { path: "/sun", element: <SunPage /> },
      { path: "/replay", lazy: async () => ({ Component: (await import("./pages/Replay.tsx")).ReplayPage }) },
      { path: "/events", lazy: async () => ({ Component: (await import("./pages/Events.tsx")).EventsPage }) },
      {
        path: "/events/:kind/:id",
        lazy: async () => ({ Component: (await import("./pages/EventDetail.tsx")).EventDetailPage }),
      },
      { path: "/status", element: <StatusPage /> },
    ],
  },
]);
