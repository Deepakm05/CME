/**
 * Pages Function: forwards same-origin /api/v1/* (REST and the WebSocket upgrade) to the Worker through a
 * service binding, so the browser never makes a cross-origin call and no CORS is needed (backend design §8).
 * The binding is set in apps/web/wrangler.jsonc: cme-worker in production, cme-worker-staging in previews.
 */
interface Env {
  API: { fetch(req: Request): Promise<Response> };
}

export const onRequest = ({ request, env }: { request: Request; env: Env }): Promise<Response> => env.API.fetch(request);
