import type { Env } from './kv';
import { kvGetJSON, kvPutJSON, kvListPrefix, uuid } from './kv';
import { validateLead, type LeadInput } from './validate';
import { sanitizeLeadFields } from './sanitize';
import { normalizeName, normalizeEmail, normalizePhoneE164 } from './normalize';
import { computeSpamScore, SPAM_SCORE_THRESHOLD } from './spam';
import { checkDuplicate, markSubmitted } from './dedupe';
import { checkRateLimit } from './ratelimit';
import { verifyTurnstile } from './turnstile';
import { canopyConfigured, createProspect, type NormalizedLead } from './canopy-client';
import { logEvent } from './audit';

const MAX_BODY_BYTES = 50 * 1024;
const REPLAY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CANOPY_ATTEMPTS = 8;
const BASE_RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minutes, doubles per attempt

interface PendingCanopyItem {
  id: string;
  lead: NormalizedLead;
  attempts: number;
  nextRetryAt: number;
  createdAt: number;
}

function jsonResponse(body: unknown, status: number, origin: string | null, allowedOrigins: string[]): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (origin && allowedOrigins.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(JSON.stringify(body), { status, headers });
}

// Deliberately vague — never surface which specific control (rate limit,
// spam score, Turnstile, size cap, malformed JSON) rejected a request, so an
// attacker can't fingerprint and route around individual defenses.
function genericError(origin: string | null, allowedOrigins: string[]): Response {
  return jsonResponse({ ok: false, error: 'submission_failed' }, 400, origin, allowedOrigins);
}

function corsPreflight(origin: string | null, allowedOrigins: string[]): Response {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (origin && allowedOrigins.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(null, { status: 204, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

    if (request.method === 'OPTIONS') return corsPreflight(origin, allowedOrigins);
    if (url.pathname !== '/lead') return jsonResponse({ ok: false, error: 'not_found' }, 404, origin, allowedOrigins);
    if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, origin, allowedOrigins);

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
  },

  // Cron Trigger (see wrangler.toml) — flushes the pending-Canopy queue once
  // real credentials exist. A no-op scan (cheap) while Canopy is unconfigured.
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    if (!canopyConfigured(env)) return;

    const list = await kvListPrefix(env.LEADS_KV, 'pending:');
    const now = Date.now();

    for (const key of list.keys) {
      const item = await kvGetJSON<PendingCanopyItem>(env.LEADS_KV, key.name);
      if (!item || item.nextRetryAt > now) continue;

      try {
        const { canopyId } = await createProspect(env, item.lead);
        await env.LEADS_KV.delete(key.name);
        await logEvent(env.LEADS_KV, { type: 'canopy_created', email: item.lead.email, meta: { canopyId, fromQueue: true } });
      } catch (err) {
        const attempts = item.attempts + 1;
        if (attempts >= MAX_CANOPY_ATTEMPTS) {
          await kvPutJSON(env.LEADS_KV, `deadletter:${item.id}`, { ...item, lastError: String(err) });
          await env.LEADS_KV.delete(key.name);
          await logEvent(env.LEADS_KV, { type: 'canopy_deadletter', email: item.lead.email, meta: { attempts } });
        } else {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempts);
          await kvPutJSON(env.LEADS_KV, key.name, { ...item, attempts, nextRetryAt: now + delay });
        }
      }
    }
  },
};
