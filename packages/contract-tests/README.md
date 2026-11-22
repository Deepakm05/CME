# @cme/contract-tests

The `/api/v1` contract as executable tests ([design](../../docs/design/contract/DETAILED_DESIGN.md#7-contract-test-suite-t1-built)). Any backend, mock or real, must pass them.

```bash
npm run test:contract                                   # against the mock, started in-process (also part of npm test / CI)

# against a running server
CONTRACT_BASE_URL=http://localhost:8787 CONTRACT_CONTROL=mock npm run test:contract     # a mock you started yourself
CONTRACT_BASE_URL=http://localhost:8788 CONTRACT_WAIT_MS=150000 npm run test:contract   # the Worker (wrangler dev), real-time
```

| Variable | Meaning |
|---|---|
| `CONTRACT_BASE_URL` | Server to test. Unset: start the mock in-process at 600× speed |
| `CONTRACT_CONTROL=mock` | The server has the `/mock/*` controls (test alerts). Without it, tests that need to trigger events are skipped, and the server must **not** have `/mock/*` routes |
| `CONTRACT_CONTROL=worker` | The server is the real Worker: test alerts are raised with `POST /api/v1/admin/test-alert` (`Authorization: Bearer $CONTRACT_ADMIN_TOKEN`, answers `{ "id": "…" }`). It must **not** have `/mock/*` routes |
| `CONTRACT_ADMIN_TOKEN` | The Worker's `ADMIN_TOKEN` (with `CONTRACT_CONTROL=worker`) |
| `CONTRACT_WAIT_MS` | How long to wait for stream traffic (default 8000). A real-time server sends a delta about once a minute |

## Against the Worker locally (what CI does)

`.github/workflows/contract-worker.yml` runs the suite against a real Worker (GAP T1: the backend is done when it passes):

```bash
tsx apps/worker/scripts/fixture-feeds.ts --port 8788 &        # live NOAA imitation
cd apps/worker && npx wrangler dev --port 8787 --ip 127.0.0.1   --var FEED_BASE:http://127.0.0.1:8788 --var ADMIN_TOKEN:ci-token &
CONTRACT_BASE_URL=http://127.0.0.1:8787 CONTRACT_CONTROL=worker CONTRACT_ADMIN_TOKEN=ci-token   CONTRACT_WAIT_MS=150000 npm run test:contract
```

Every message and response is also validated against the schemas in `@cme/shared`.
