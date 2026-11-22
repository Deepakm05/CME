# Build Plan: Backend & Frontend

The plan follows [SCOPE.md](../SCOPE.md) and the designs in [backend/](backend/README.md) and [frontend/](frontend/README.md). Each phase ends with something running and deployed for free.

**Order: frontend first, against a mock backend**, so usability can be tested before any backend exists. The phase numbers below describe *what* gets built; the order is:

```
Contract + mock (done) ──► Frontend: Phase 2 → 3 (UI parts) → 4 (UI parts) + usability tests ──► Phase 0 setup ──► Backend: Phase 1 → 3 → 4 ──► Phase 5
```

## Done: contract + mock backend

- [x] `packages/shared`: `LiveState`, `Delta`, WS messages (the protocol package is merged into `shared`)
- [x] `packages/physics`: `dbm*`, `newell`, flare classes, locations (8 tests)
- [x] `apps/mock`: same `/api/v1` + WS contract, replay of saved data, 5 scenarios, chaos faults, control page ([README](../../apps/mock/README.md), 7 tests)
- [x] npm workspaces (pnpm is not installed; the layout is compatible)

## Phase 0: Setup

- [x] Monorepo: `apps/worker` next to `apps/web` (scaffolded) and the existing `apps/mock`, `packages/{shared,physics}`
- [ ] Cloudflare account (free, no card) → `wrangler` login; Pages project linked to GitHub
- [ ] Free NASA API key → Worker secret `NASA_API_KEY`
- [x] GitHub Actions: lint + test + `wrangler deploy` + Pages build on push to `main`
  - [x] Pages reaches the Worker through a Pages Function + service binding (`apps/web/functions/api/v1/[[path]].ts`, `apps/web/wrangler.jsonc`)
- **Done when:** a "hello" Worker and an empty Pages site are live.

## Phase 1: Backend live loop (UC1, UC2, UC5, UC8)

- [ ] `SpaceWeatherHub` Durable Object with an `alarm()` loop and a cron watchdog
- [ ] `schema.sql` migration on first start; `meta.seq`
- [ ] Pollers for GOES X-ray and RTSW wind/mag with `If-None-Match`; adaptive 5 s polling window
- [ ] Normalizers → `xray_sample`, `wind_sample`, memory ring buffers
- [ ] `GET /state`, `WS /stream` (snapshot + delta), `GET /health`
- [ ] Backfill from NOAA's live 7-day X-ray and RTSW 1-minute files on first start. The saved `build_snapshot.py` snapshot ends 2026-09-28 and is ~7 MB, over the Worker bundle limit, so RTSW history starts at ~1 day and grows to 7
- **Done when:** `wscat` shows a new delta within 5 s of NOAA updating, with no browser open beforehand.

## Phase 2: Frontend live view (UF1, UF2, UF8, UF9)

- [x] Vite + React app scaffold: routes, AppShell, dev proxy to the mock ([apps/web](../../apps/web/README.md))
- [x] r3f scene: Sun, Mercury, Venus, Earth, L1 from astronomy-engine; readable / true scale toggle; camera presets; WebGL fallback ([scene-plan.md](frontend/scene-plan.md))
- [x] `useLiveStream`: snapshot/delta apply, `seq` gap → resync, backoff, polling fallback (tested against the mock's chaos modes)
- [x] Zustand live store (Float64Array series, 7 days) + IndexedDB cache
- [x] ConnectionBadge and FreshnessBadge; `DataAge` next to values (`FeedStatus.staleAfterS` added to the contract)
- [x] XrayChart and WindPanel (uPlot, ≤ 1 Hz): flare-class bands, synced crosshair, keyboard reading, table views; Newell coupling shown (FR-5)
- [x] Design-review P1s: real Sun/Earth surfaces, scene clock, Sun–Earth travel times, Key ([scene-plan.md](frontend/scene-plan.md))
- **Done when:** a cold load is interactive in < 2 s and runs at 60 fps; pulling the network cable and reconnecting catches up with no reload.

## Phase 3: Sun & CME physics (UC6, UF3, UF4, UF5)

- [ ] Backend: `solar_regions.json`, flare list, DONKI pollers → `sunspot_region`, `flare`, `cme`
- [x] `packages/physics`: `dbm()`, `newell()`, `classFromFlux()` with unit tests (reuse the formulas in [research-notes.md](../research-notes.md))
- [ ] Backend writes `cme_forecast`
- [x] Frontend animates `CmeShells` per frame from the same `dbm()`; CME card with Earth ETA (the front reaches 1 AU exactly at the forecast ETA, tested)
- [x] SunspotLayer + FlareMarkers placed on the Sun by lat/lon (frontend; drawn in the photosphere shader, rotating 13.2°/day; Sun camera view)
- [x] Click a body, region or CME → info card (UF3); Focus camera; panels can be minimized or all hidden
- **Done when:** a past CME from DONKI replays to Earth with an ETA matching the DBM test values.

## Phase 4: Alerts & replay (UC3, UC7, UF6, UF7)

- [ ] AlertEngine rules (flare ≥ M1, Earth-directed CME, Bz ≤ −10 nT) with de-duplication
- [x] `alert` WS message → toast, sound, Notification API; acks stored in IndexedDB (frontend; the mock's `POST /mock/alert` sends a test alert, delivered in ~0.1 s)
- [ ] Backend: `GET /history` (edge-cached, snapped `from`/`to` rejected otherwise [C1]), `GET /events`
- [x] Replay data layer (frontend): `store/history.ts` separate from the live store, `/history` ranges snapped to 5 min [C1], JSON parsed in `history.worker.ts` and transferred [F2], all responses schema-checked
- [x] Replay page `/replay?t=`: TimelineBar (7-day track, flare ticks by class, CME launches, drag / keyboard, play at 60×/600×/3600×), scene and charts follow the replay time; sunspot regions hidden in replay (no history for them)
- [x] `/events` table (filter by kind and class, kept in the URL) and detail pages for flares (X-ray curve), CMEs (DBM distance and speed charts) and alerts, each with "Replay this moment"
- [ ] Check Replay and the Events pages in a browser against the mock (drag feel, phone layout, playback)
- [ ] Replay while playing fast: load a wider window ahead of the playhead so the charts keep up at 3600×
- [ ] Cold load: the main chunk grew from 86 kB to 110 kB gzipped with Replay (Replay and Events are already lazy routes); find what moved into it ([F4](GAP_ANALYSIS.md))
- [ ] Pruner (UC9)
- **Done when:** replaying the last 7 days shows each flare and CME at the right moment, and a test alert reaches an open tab in < 1 s.

## Phase 5: Harden & launch

- [ ] Load test: 1,000 WebSockets on one DO; check request and duration usage in the Cloudflare dashboard
- [ ] Freshness monitor: `/health` checked by a free uptime pinger (e.g. UptimeRobot)
- [ ] Error budget alarms: Workers analytics → email on 1027 or alarm stall
- [ ] Point `docs/reconnection/index.html` at `/api/v1/*` and serve it at `/guide`
- **Done when:** the NFR targets in [SCOPE.md](../SCOPE.md) are measured and met for 7 days straight.

## Risks

| Risk | Plan |
|---|---|
| 100k requests/day exceeded | Pages for static files, edge cache on `/history`, WS instead of polling; move to the Oracle fallback ([TECH_STACK §4](TECH_STACK.md#4-fallback-if-cloudflare-limits-are-ever-hit)) |
| NOAA changes or removes a feed (as happened with `/products/solar-wind/*`) | Per-feed normalizer + FeedStatus "stale" in the UI; never a blank screen |
| DONKI `DEMO_KEY` limits | Personal key, polled every 5 min |
| Large RTSW payload (2.8 MB) | Download only on change (ETag); parse only the newest rows |
