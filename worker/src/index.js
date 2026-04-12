/**
 * Household Inventory — Cloudflare Worker
 *
 * Routes:
 *   GET  /health      — liveness check, no auth
 *   POST /parse-haul  — receipt parsing via Anthropic (auth added Step 5)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Health check — no auth required
    if (request.method === 'GET' && pathname === '/health') {
      return Response.json({ ok: true, ts: new Date().toISOString() });
    }

    // Parse haul — stub until Steps 5-7
    if (request.method === 'POST' && pathname === '/parse-haul') {
      return Response.json({ error: 'not implemented' }, { status: 501 });
    }

    return Response.json({ error: 'not found' }, { status: 404 });
  },
};
