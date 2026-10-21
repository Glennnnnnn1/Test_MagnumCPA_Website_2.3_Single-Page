// Shared HTTP/CORS helpers. Extracted from index.ts when the Worker grew from
// a single /lead endpoint into a small route table, so that every response —
// lead form, video library, admin API — goes through one CORS implementation
// instead of three drifting copies.

// `Vary: Origin` is mandatory on every response here, not optional politeness.
// These handlers emit a body whose Access-Control-Allow-Origin header depends
// on the *request's* Origin. Without Vary, any cache in front of the Worker
// (Cloudflare's own, a corporate proxy) may serve a response cached for one
// origin to a request from another, either leaking the ACAO or — more likely —
// breaking a legitimate caller with a mismatched header. This was latent while
// the only route was POST /lead (POSTs aren't cached); GET /api/videos makes
// it real.
const VARY_SIMPLE = 'Origin';
const VARY_PREFLIGHT = 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers';

// Never '*', and never reflect an origin that isn't on the allowlist.
function allowOrigin(
  headers: Record<string, string>,
  origin: string | null,
  allowedOrigins: string[]
): Record<string, string> {
  if (origin && allowedOrigins.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

export function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
  allowedOrigins: string[],
  extraHeaders?: Record<string, string>
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Vary: VARY_SIMPLE,
    ...extraHeaders,
  };
  return new Response(JSON.stringify(body), { status, headers: allowOrigin(headers, origin, allowedOrigins) });
}

// Deliberately vague — never surface which specific control (rate limit,
// spam score, Turnstile, size cap, malformed JSON) rejected a request, so an
// attacker can't fingerprint and route around individual defenses.
export function genericError(origin: string | null, allowedOrigins: string[]): Response {
  return jsonResponse({ ok: false, error: 'submission_failed' }, 400, origin, allowedOrigins);
}

// A CSV download. Kept separate from jsonResponse rather than widening its
// signature, because the Content-Disposition path has no JSON body to encode.
export function csvResponse(
  csv: string,
  filename: string,
  origin: string | null,
  allowedOrigins: string[]
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
    Vary: VARY_SIMPLE,
  };
  return new Response(csv, { status: 200, headers: allowOrigin(headers, origin, allowedOrigins) });
}

export function noContent(origin: string | null, allowedOrigins: string[]): Response {
  const headers: Record<string, string> = { Vary: VARY_SIMPLE };
  return new Response(null, { status: 204, headers: allowOrigin(headers, origin, allowedOrigins) });
}

// Path-aware preflight. /lead answers exactly what it answered before the
// route table existed (POST, OPTIONS / Content-Type) so the live consultation
// form on index.html sees zero change; only /api/* advertises the wider method
// set and the Authorization header the admin routes need.
export function corsPreflight(pathname: string, origin: string | null, allowedOrigins: string[]): Response {
  const isApi = pathname.startsWith('/api/');
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': isApi ? 'GET, POST, PUT, DELETE, OPTIONS' : 'POST, OPTIONS',
    'Access-Control-Allow-Headers': isApi ? 'Content-Type, Authorization' : 'Content-Type',
    Vary: VARY_PREFLIGHT,
  };
  if (isApi) headers['Access-Control-Max-Age'] = '86400';
  return new Response(null, { status: 204, headers: allowOrigin(headers, origin, allowedOrigins) });
}
