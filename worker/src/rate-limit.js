/**
 * Per-user sliding-window rate limit: 20 parse requests per hour.
 *
 * Uses the RATE_LIMIT KV namespace. Key format:
 *   rate:{userId}:{YYYY-MM-DDTHH}   (one bucket per clock hour)
 *
 * Each bucket stores a request count and expires after 2 hours so
 * stale keys are cleaned up automatically by Cloudflare.
 *
 * Returns a 429 Response (with Retry-After header) if the limit is hit.
 * Returns null if the request is allowed to proceed.
 */

const MAX_REQUESTS_PER_HOUR = 20;
const BUCKET_TTL_SECONDS = 7200; // 2 hours — covers current + previous bucket

export async function checkRateLimit(userId, env) {
  const now = new Date();

  // Hour bucket: "2026-04-12T14" — changes every clock hour
  const hourBucket = now.toISOString().slice(0, 13);
  const key = `rate:${userId}:${hourBucket}`;

  const current = parseInt((await env.RATE_LIMIT.get(key)) ?? '0', 10);

  if (current >= MAX_REQUESTS_PER_HOUR) {
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    const retryAfter = Math.ceil((nextHour.getTime() - now.getTime()) / 1000);

    return new Response(
      JSON.stringify({ error: 'Rate limit exceeded, try again later' }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
        },
      },
    );
  }

  // Increment and extend TTL
  await env.RATE_LIMIT.put(key, String(current + 1), {
    expirationTtl: BUCKET_TTL_SECONDS,
  });

  return null;
}
