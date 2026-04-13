/**
 * Household Inventory — Cloudflare Worker
 *
 * Routes:
 *   GET  /health      — liveness check, no auth required
 *   POST /parse-haul  — receipt parsing via Anthropic (spend cap + rate limit added Step 6)
 */

import { requireAuth } from './auth.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight requests from the PWA
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const response = await handleRequest(request, env, ctx);

    // Attach CORS headers to every response
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      headers.set(key, value);
    }
    return new Response(response.body, { status: response.status, headers });
  },
};

async function handleRequest(request, env, ctx) {
  const { pathname } = new URL(request.url);

  // Health check — no auth required
  if (request.method === 'GET' && pathname === '/health') {
    return Response.json({ ok: true, ts: new Date().toISOString() });
  }

  // All routes below require a valid Supabase JWT from an allowed email
  const auth = await requireAuth(request, env);
  if (auth.error) return auth.error;

  // Parse haul — stub until Steps 6–7
  if (request.method === 'POST' && pathname === '/parse-haul') {
    return Response.json({ error: 'not implemented' }, { status: 501 });
  }

  return Response.json({ error: 'not found' }, { status: 404 });
}
