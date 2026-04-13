/**
 * JWT verification and email allowlist check.
 *
 * Supabase issues HS256 JWTs signed with the project's JWT secret.
 * Cloudflare Workers expose the Web Crypto API (crypto.subtle), so
 * we can verify signatures without any external library.
 *
 * Usage:
 *   const auth = await requireAuth(request, env);
 *   if (auth.error) return auth.error;   // Returns a 401 Response
 *   const { user } = auth;               // { id, email }
 */

const ALLOWED_EMAILS = [
  'danballer13@gmail.com',
  'danabbyballer@gmail.com',
];

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
    payload = await verifyJWT(token, env.SUPABASE_JWT_SECRET);
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
 * Verifies an HS256 JWT using the Web Crypto API.
 * Throws on invalid format, expired token, or bad signature.
 * Returns the decoded payload on success.
 */
async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');

  const [headerB64, payloadB64, signatureB64] = parts;

  // Decode and parse payload (base64url → JSON)
  const payload = JSON.parse(base64urlToString(payloadB64));

  // Check expiry before the more expensive signature verification
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error('JWT expired');
  }

  // Verify HMAC-SHA256 signature
  const encoder = new TextEncoder();
  const signingInput = encoder.encode(`${headerB64}.${payloadB64}`);
  const signatureBytes = base64urlToBytes(signatureB64);

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const valid = await crypto.subtle.verify('HMAC', key, signatureBytes, signingInput);
  if (!valid) throw new Error('Invalid JWT signature');

  return payload;
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
