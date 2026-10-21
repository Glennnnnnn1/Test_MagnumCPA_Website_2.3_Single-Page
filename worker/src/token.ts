// Admin credential handling for the video library.
//
// Explicitly NOT the pattern used by the main site's admin-login.html, which
// compares a plaintext password in client-side JS — that file is publicly
// served, so the password is readable by anyone who views source. Here the
// password never reaches the browser, the Worker stores only a PBKDF2 digest,
// and the browser holds a short-lived HMAC-signed token instead.
//
// Everything below is pure (no KV, no env beyond the secret strings), which
// makes it directly unit-testable — see the tests in the Video Library repo.

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_BITS = 256;
const TOKEN_VERSION = 'v1';
const TOKEN_TTL_SECONDS = 8 * 60 * 60; // 8 hours, no refresh — re-login

export interface AdminTokenPayload {
  scope: 'admin';
  iat: number;   // epoch seconds
  exp: number;   // epoch seconds
  jti: string;
  ver: number;   // settings.adminTokenVersion at issue time
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function b64urlFromBytes(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return b64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

// Compares two digests without leaking their contents through timing. Both
// values are HMAC'd under a key generated fresh for this single comparison,
// so even though the final loop isn't itself constant-time, an attacker can't
// use its timing to learn anything about the inputs — they'd have to predict
// a random key first. Preferred over Cloudflare's timingSafeEqual, which
// throws on a length mismatch (a trap: the throw is itself an oracle).
async function timingSafeEqual(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  const blindKey = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const [ma, mb] = await Promise.all([
    crypto.subtle.sign('HMAC', blindKey, a),
    crypto.subtle.sign('HMAC', blindKey, b),
  ]);
  const va = new Uint8Array(ma);
  const vb = new Uint8Array(mb);
  let diff = va.length ^ vb.length;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    PBKDF2_BITS
  );
  return new Uint8Array(bits);
}

// Format: pbkdf2$<iterations>$<saltB64>$<hashB64>
// Self-describing so the iteration count can be raised later without
// invalidating existing hashes.
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

  const iterations = Number(parts[1]);
  // Reject an absurdly low iteration count outright: a stored hash is
  // attacker-influenced input if the secret store is ever mis-set, and
  // honouring `pbkdf2$1$...` would silently disable the work factor.
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 5_000_000) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = b64ToBytes(parts[2]);
    expected = b64ToBytes(parts[3]);
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== PBKDF2_BITS / 8) return false;

  const actual = await deriveBits(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

async function hmacKey(secretB64: string, usages: Array<'sign' | 'verify'>): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    b64ToBytes(secretB64),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages
  );
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// Token: v1.<base64url(payload JSON)>.<base64url(HMAC-SHA256 of the payload string)>
//
// The MAC covers the exact base64url payload *string*, never a re-serialized
// object — so verification can't be broken by JSON key ordering or by any
// difference between how two runtimes stringify the same value.
export async function signToken(payload: AdminTokenPayload, secretB64: string): Promise<string> {
  const payloadB64 = b64urlFromBytes(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secretB64, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64));
  return `${TOKEN_VERSION}.${payloadB64}.${b64urlFromBytes(new Uint8Array(sig))}`;
}

export function newAdminPayload(tokenVersion: number): AdminTokenPayload {
  const iat = nowSeconds();
  return {
    scope: 'admin',
    iat,
    exp: iat + TOKEN_TTL_SECONDS,
    jti: crypto.randomUUID(),
    ver: tokenVersion,
  };
}

// Returns the payload only if the signature is valid AND the token hasn't
// expired. The caller still has to check `ver` against current settings —
// that's the "sign out everywhere" check, and it needs a KV read this pure
// module deliberately doesn't do.
export async function verifyToken(token: string, secretB64: string): Promise<AdminTokenPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;

  const payloadB64 = parts[1];
  let sig: Uint8Array;
  try {
    sig = b64urlToBytes(parts[2]);
  } catch {
    return null;
  }

  let valid: boolean;
  try {
    const key = await hmacKey(secretB64, ['verify']);
    // crypto.subtle.verify is constant-time by implementation, so no
    // hand-rolled comparison is needed on this hot path.
    valid = await crypto.subtle.verify('HMAC', key, sig, enc.encode(payloadB64));
  } catch {
    return null; // malformed secret
  }
  if (!valid) return null;

  let payload: AdminTokenPayload;
  try {
    payload = JSON.parse(dec.decode(b64urlToBytes(payloadB64)));
  } catch {
    return null;
  }

  if (payload?.scope !== 'admin') return null;
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds()) return null;
  if (typeof payload.ver !== 'number') return null;

  return payload;
}

// Convenience for generating ADMIN_TOKEN_SECRET.
export function randomSecretB64(): string {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(32)));
}
