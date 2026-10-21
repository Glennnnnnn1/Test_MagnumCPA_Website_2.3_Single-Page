// The "Request a Consultation" endpoint for the main site (index.html posts
// here via LEAD_API_URL). Moved out of index.ts verbatim when the Worker grew
// a route table — the pipeline below is byte-for-byte what it was, so a diff
// shows a pure move and this money path can't regress behind a refactor.
//
// Deliberately NOT reused by the video-library gate: this handler calls
// markSubmitted(), which writes dup:email/dup:phone keys with a 24h TTL. A
// visitor gated into the video library in the morning would then be silently
// dropped as a duplicate if they submitted a real consultation request that
// afternoon. See routes/library.ts for the gate's own path.
import type { Env } from '../kv';
import { kvPutJSON, uuid } from '../kv';
import { validateLead, type LeadInput } from '../validate';
import { sanitizeLeadFields } from '../sanitize';
import { normalizeName, normalizeEmail, normalizePhoneE164 } from '../normalize';
import { computeSpamScore, SPAM_SCORE_THRESHOLD } from '../spam';
import { checkDuplicate, markSubmitted } from '../dedupe';
import { checkRateLimit } from '../ratelimit';
import { verifyTurnstile } from '../turnstile';
import { canopyConfigured, createProspect, type NormalizedLead } from '../canopy-client';
import { logEvent } from '../audit';
import { jsonResponse, genericError } from '../http';
import { type PendingCanopyItem } from '../queue';

const MAX_BODY_BYTES = 50 * 1024;
const REPLAY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export async function handleLead(
  request: Request,
  env: Env,
  origin: string | null,
  allowedOrigins: string[]
): Promise<Response> {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) return genericError(origin, allowedOrigins);

  // Never trust a client-supplied Content-Length alone — check it as an
  // early rejection, then verify the real body size after reading it.
  const declaredLength = Number(request.headers.get('Content-Length') || '0');
  if (declaredLength > MAX_BODY_BYTES) return jsonResponse({ ok: false, error: 'payload_too_large' }, 413, origin, allowedOrigins);

  const bodyBuf = await request.arrayBuffer();
  if (bodyBuf.byteLength > MAX_BODY_BYTES) return jsonResponse({ ok: false, error: 'payload_too_large' }, 413, origin, allowedOrigins);
  if (bodyBuf.byteLength === 0) return genericError(origin, allowedOrigins);

  let payload: { meta?: Record<string, unknown>; lead?: LeadInput };
  try {
    payload = JSON.parse(new TextDecoder().decode(bodyBuf));
  } catch {
    return genericError(origin, allowedOrigins);
  }

  const meta = payload.meta || {};
  const leadRaw = payload.lead || {};
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const userAgent = request.headers.get('User-Agent');
  const honeypot = String(meta.hp ?? '');
  const clientTs = Number(meta.ts ?? 0);
  const turnstileToken = String(meta.turnstileToken ?? '');

  // Replay/staleness check — independent of Turnstile's own single-use
  // token behavior, since Turnstile may not be configured yet in dev.
  if (clientTs && Math.abs(Date.now() - clientTs) > REPLAY_WINDOW_MS) {
    await logEvent(env.LEADS_KV, { type: 'lead_rejected', reason: 'stale_timestamp', ip });
    return genericError(origin, allowedOrigins);
  }

  // Honeypot: appear to succeed to the bot (don't teach it what tripped
  // the trap) while quietly logging and dropping the submission.
  if (honeypot.trim().length > 0) {
    await logEvent(env.LEADS_KV, { type: 'lead_flagged', reason: 'honeypot_filled', ip });
    return jsonResponse({ ok: true }, 200, origin, allowedOrigins);
  }

  // Turnstile: fail closed once configured. If TURNSTILE_SECRET_KEY isn't
  // set yet (pre-launch/dev), skip with an audit note rather than blocking
  // every submission — this must be configured before real launch; see
  // SETUP-CLOUDFLARE.md.
  if (env.TURNSTILE_SECRET_KEY) {
    const passed = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, turnstileToken, ip);
    if (!passed) {
      await logEvent(env.LEADS_KV, { type: 'lead_rejected', reason: 'turnstile_failed', ip });
      return genericError(origin, allowedOrigins);
    }
  } else {
    await logEvent(env.LEADS_KV, { type: 'warning', reason: 'turnstile_not_configured', ip });
  }

  const rl = await checkRateLimit(env.LEADS_KV, ip);
  if (!rl.allowed) {
    await logEvent(env.LEADS_KV, { type: 'lead_rejected', reason: 'rate_limited', ip });
    return jsonResponse({ ok: false, error: 'rate_limited' }, 429, origin, allowedOrigins);
  }

  const validation = validateLead(leadRaw);
  if (!validation.valid) {
    return jsonResponse({ ok: false, error: 'validation', fields: validation.errors }, 400, origin, allowedOrigins);
  }

  const sanitized = sanitizeLeadFields(leadRaw as Record<string, unknown>);
  const normalized: NormalizedLead = {
    firstName: normalizeName(sanitized.firstName),
    lastName: normalizeName(sanitized.lastName),
    email: normalizeEmail(sanitized.email),
    phone: normalizePhoneE164(sanitized.phone),
    businessName: sanitized.businessName || '',
    state: sanitized.state || '',
    serviceNeeded: sanitized.serviceNeeded || '',
    revenue: sanitized.revenue || '',
    preferredContact: sanitized.preferredContact || '',
    bestTimeToCall: sanitized.bestTimeToCall || '',
    message: sanitized.message || '',
    submittedAt: new Date().toISOString(),
  };
  const fullName = `${normalized.firstName} ${normalized.lastName}`;

  const spamCheck = computeSpamScore({ honeypot, userAgent, email: normalized.email, message: normalized.message });
  const dupCheck = await checkDuplicate(env.LEADS_KV, normalized.email, normalized.phone, fullName);

  if (spamCheck.score >= SPAM_SCORE_THRESHOLD || dupCheck.isDuplicate) {
    await logEvent(env.LEADS_KV, {
      type: 'lead_flagged',
      reason: [...spamCheck.reasons, ...dupCheck.reasons].join(','),
      email: normalized.email,
      ip,
      meta: { spamScore: spamCheck.score },
    });
    // Flagged, not deleted — a human can review the audit log — but we
    // don't create a Canopy prospect or count it as a clean lead.
    return jsonResponse({ ok: true }, 200, origin, allowedOrigins);
  }

  await markSubmitted(env.LEADS_KV, normalized.email, normalized.phone, fullName);

  if (canopyConfigured(env)) {
    try {
      const { canopyId } = await createProspect(env, normalized);
      await logEvent(env.LEADS_KV, { type: 'canopy_created', email: normalized.email, ip, meta: { canopyId } });
      return jsonResponse({ ok: true }, 200, origin, allowedOrigins);
    } catch (err) {
      await logEvent(env.LEADS_KV, { type: 'canopy_error', email: normalized.email, ip, meta: { error: String(err) } });
      // fall through to the pending queue below — the lead is never lost
    }
  }

  const item: PendingCanopyItem = {
    id: uuid(),
    lead: normalized,
    attempts: 0,
    nextRetryAt: Date.now(),
    createdAt: Date.now(),
  };
  await kvPutJSON(env.LEADS_KV, `pending:${item.id}`, item);
  await logEvent(env.LEADS_KV, { type: 'canopy_pending', email: normalized.email, ip });

  return jsonResponse({ ok: true }, 200, origin, allowedOrigins);
}
