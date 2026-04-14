/**
 * JWT verification and email allowlist check.
 *
 * Supabase issues ES256 JWTs (ECDSA P-256) signed with a private key.
 * The corresponding public keys are published at:
 *   {SUPABASE_URL}/auth/v1/.well-known/jwks.json
 *
 * We fetch those keys once and cache them in memory for the lifetime of
 * this Worker instance. Verification uses the Web Crypto API — no library needed.
 */

const ALLOWED_EMAILS = [
  'danballer13@gmail.com',
  'danabbyballer@gmail.com',
];

// Module-level cache — Workers reuse instances across requests
let cachedKeys = null;

/**
 * Verifies the Bearer JWT in the Authorization header.
 * Returns { user: { id, email } } on success, or { error: Response } on failure.
 */
export async function requireAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: unauthorized('Missing or invalid Authorization header') };
  }

  const token = authHeader.slice(7); // strip "Bearer "

  let payload;
  try {
    payload = await verifyJWT(token, env.SUPABASE_URL);
  } catch (err) {
    return { error: unauthorized(err.message) };
  }

  if (!ALLOWED_EMAILS.includes(payload.email)) {
    return { error: unauthorized('Email not permitted') };
  }

  return { user: { id: payload.sub, email: payload.email } };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function unauthorized(message) {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Fetches and caches Supabase's JWKS public keys.
 * Tries all keys when verifying — handles key rotation gracefully.
 */
async function getPublicKeys(supabaseUrl) {
  if (cachedKeys) return cachedKeys;

  const res = await fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
  if (!res.ok) throw new Error('Failed to fetch JWKS');

  const { keys } = await res.json();

  cachedKeys = await Promise.all(
    keys.map((jwk) =>
      crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      )
    )
  );

  return cachedKeys;
}

/**
 * Verifies an ES256 JWT using Supabase's published public keys.
 * Throws on malformed token, expiry, or invalid signature.
 * Returns the decoded payload on success.
 */
async function verifyJWT(token, supabaseUrl) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');

  const [headerB64, payloadB64, signatureB64] = parts;

  // Decode and parse payload
  const payload = JSON.parse(base64urlToString(payloadB64));

  // Check expiry before the more expensive signature verification
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error('JWT expired');
  }

  const encoder = new TextEncoder();
  const signingInput = encoder.encode(`${headerB64}.${payloadB64}`);
  const signatureBytes = base64urlToBytes(signatureB64);

  const keys = await getPublicKeys(supabaseUrl);

  // Try each key — supports key rotation
  for (const key of keys) {
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signatureBytes,
      signingInput,
    );
    if (valid) return payload;
  }

  throw new Error('Invalid JWT signature');
}

/** Decodes a base64url string to a plain string (for JSON payloads). */
function base64urlToString(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
  return atob(padded);
}

/** Decodes a base64url string to a Uint8Array (for signature bytes). */
function base64urlToBytes(str) {
  const binary = base64urlToString(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
