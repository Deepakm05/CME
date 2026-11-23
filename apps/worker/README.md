# @cme/worker

The real backend: one Cloudflare Worker plus the `SpaceWeatherHub` Durable Object. It polls NOAA SWPC and NASA
DONKI, normalises the data, and serves `/api/v1` (REST and the WebSocket stream). The design is in
[DETAILED_DESIGN.md](../../docs/design/backend/DETAILED_DESIGN.md).

## Layout

```
src/
  index.ts    Worker entry: routing, CORS and origin checks, cron watchdog
  hub.ts      SpaceWeatherHub Durable Object: alarm() loop, WebSocket fan-out, /state, /health
  types.ts    Env bindings and shared server-side types
  feeds/      Upstream pollers and normalisers (GOES X-ray, RTSW, flares, regions, DONKI)
  db/         SQLite schema and migrations (forward-only, additive)
  state/      In-memory ring buffers and the sequenced delta log
  obs/        Freshness metrics (ingest lag, push time, alarm lag) and the health status rule
test/         node:test suites (run with tsx)
```

## Commands

Run from the repository root.

| Task | Command |
|---|---|
| Local dev (`wrangler dev`) | `npm run worker` |
| Tests | `npm test -w @cme/worker` |
| Deploy to production | `npm run deploy:worker` (or the `deploy` job in CI on push to `main`) |
| Deploy to staging | `npm run deploy:staging -w @cme/worker` (or the `preview` job on pull requests) |

Secrets are never in `wrangler.jsonc`. Set them once per environment, from `apps/worker`:

```sh
npx wrangler secret put NASA_API_KEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put NASA_API_KEY --env staging
npx wrangler secret put ADMIN_TOKEN --env staging
```

CI needs the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Until both are set, the deploy
and preview jobs skip without failing.

## Rollback

- **Worker:** from `apps/worker`, run `npx wrangler rollback` to return to the previous version. Add
  `--env staging` for staging.
- **Pages:** in the Cloudflare dashboard, open the `cme-web` project, go to Deployments, and choose
  "rollback to this deployment" on the last good one.
- **Schema:** migrations are forward-only and additive, so a rollback never needs a down-migration. Roll back
  the code, not the database.

## Local dev on Windows

On some Windows machines, Application Control (WDAC or similar) blocks `workerd.exe`, which `wrangler dev` needs.
If `npm run worker` fails with an access or policy error, that is the likely cause. The contract suite against the
Worker runs in CI on Linux, so it still gates every change.
