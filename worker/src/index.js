/**
 * Household Inventory — Cloudflare Worker
 *
 * Routes:
 *   GET  /health      — liveness check, no auth required
 *   POST /parse-haul  — receipt parsing via Anthropic (implemented Step 7)
 *
 * Request pipeline for authenticated routes:
 *   1. requireAuth    — verify Supabase JWT, check email allowlist
 *   2. checkSpendCap  — reject if daily USD spend >= DAILY_SPEND_CAP_USD
 *   3. checkRateLimit — reject if > 20 parses/user/hour
 *   4. route handler
 */

import { requireAuth } from './auth.js';
import { checkSpendCap } from './spend-cap.js';
import { checkRateLimit } from './rate-limit.js';
import { handleParseHaul } from './parse-haul.js';

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

  // 1. Auth
  const auth = await requireAuth(request, env);
  if (auth.error) return auth.error;

  // 2. Daily spend cap
  const spendCapError = await checkSpendCap(auth.user.id, env);
  if (spendCapError) return spendCapError;

  // 3. Per-user rate limit
  const rateLimitError = await checkRateLimit(auth.user.id, env);
  if (rateLimitError) return rateLimitError;

  // 4. Route handlers
  if (request.method === 'POST' && pathname === '/parse-haul') {
    return handleParseHaul(request, env, auth.user);
  }

  return Response.json({ error: 'not found' }, { status: 404 });
}
