/**
 * Daily spend cap check.
 *
 * Queries the usage_meter table via the Supabase REST API using the
 * service_role key (bypasses RLS — we need to read any user's spend).
 *
 * Returns a 429 Response if the day's estimated spend >= DAILY_SPEND_CAP_USD.
 * Returns null if the request is allowed to proceed.
 *
 * Fails open on DB errors: if we can't check the cap, we allow the request.
 * The $10/month Anthropic console cap is the real backstop.
 */
export async function checkSpendCap(userId, env) {
  const cap = parseFloat(env.DAILY_SPEND_CAP_USD ?? '0.50');
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  let rows;
  try {
    const url =
      `${env.SUPABASE_URL}/rest/v1/usage_meter` +
      `?user_id=eq.${userId}&date=eq.${today}&select=estimated_cost_usd`;

    const res = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });

    if (!res.ok) {
      console.error('spend-cap: Supabase query failed', res.status, await res.text());
      return null; // fail open
    }

    rows = await res.json();
  } catch (err) {
    console.error('spend-cap: fetch error', err.message);
    return null; // fail open
  }

  const totalSpend = rows.reduce(
    (sum, row) => sum + parseFloat(row.estimated_cost_usd ?? 0),
    0,
  );

  if (totalSpend >= cap) {
    return new Response(
      JSON.stringify({ error: 'Daily spend cap reached, try again tomorrow' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    );
  }

  return null;
}
