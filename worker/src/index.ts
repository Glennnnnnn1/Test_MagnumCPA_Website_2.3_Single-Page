// Router. Two features share this Worker:
//   /lead      — the main site's "Request a Consultation" form (routes/lead.ts)
//   /api/*     — the gated video library and its admin panel (routes/library.ts,
//                routes/admin.ts)
//
// They share a Worker so the library can reuse the lead pipeline's hardened
// modules (validate/sanitize/normalize/ratelimit/audit) rather than growing a
// second, drifting copy of each. The cost is a shared deploy: a bug in library
// code ships alongside the live lead form. Two mitigations, both deliberate —
// the /lead handler was moved out verbatim (a diff shows a pure move), and
// every handler runs inside the try/catch below, so an exception in library
// code returns a 500 for that one request instead of taking /lead down.
import type { Env } from './kv';
import { kvGetJSON, kvPutJSON, kvListPrefix } from './kv';
import { canopyConfigured, createProspect } from './canopy-client';
import { logEvent } from './audit';
import { jsonResponse, corsPreflight } from './http';
import { handleLead } from './routes/lead';
import { handleGate, handleVideos, handleTrack } from './routes/library';
import { handleAdmin } from './routes/admin';
import { getVideoListFresh } from './videos';
import { rollupAnalytics } from './analytics';
import { drainLibraryQueue } from './library-delivery';
import { MAX_CANOPY_ATTEMPTS, BASE_RETRY_DELAY_MS, type PendingCanopyItem } from './queue';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

    if (request.method === 'OPTIONS') return corsPreflight(url.pathname, origin, allowedOrigins);

    try {
      if (url.pathname === '/lead') {
        if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, origin, allowedOrigins);
        return await handleLead(request, env, origin, allowedOrigins);
      }

      if (url.pathname === '/api/videos') {
        if (request.method !== 'GET') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, origin, allowedOrigins);
        return await handleVideos(env, origin, allowedOrigins);
      }

      if (url.pathname === '/api/library/access') {
        if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, origin, allowedOrigins);
        return await handleGate(request, env, origin, allowedOrigins);
      }

      if (url.pathname === '/api/track') {
        if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, origin, allowedOrigins);
        return await handleTrack(request, env, origin, allowedOrigins);
      }

      if (url.pathname.startsWith('/api/admin/')) {
        return await handleAdmin(request, env, origin, allowedOrigins, url.pathname);
      }

      return jsonResponse({ ok: false, error: 'not_found' }, 404, origin, allowedOrigins);
    } catch (err) {
      // A thrown handler must never surface a stack trace to the caller or
      // take down the sibling route. Log it and return an opaque 500.
      await logEvent(env.LEADS_KV, {
        type: 'worker_error',
        reason: String(err),
        meta: { path: url.pathname, method: request.method },
      });
      return jsonResponse({ ok: false, error: 'server_error' }, 500, origin, allowedOrigins);
    }
  },

  // Cron Trigger (see wrangler.toml). Three jobs, each isolated: the video
  // library's rollup and delivery queue must never be able to prevent the
  // consultation queue from flushing, or vice versa.
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    // 1. Fold raw analytics events into daily/monthly counters. The cron is
    //    the ONLY writer of stats:* documents, which is what removes the
    //    read-modify-write race on every counter.
    try {
      const videos = await getVideoListFresh(env);
      const categoryById = new Map(videos.videos.map(v => [v.id, v.category]));
      await rollupAnalytics(env, id => categoryById.get(id));
    } catch (err) {
      await logEvent(env.LIBRARY_KV, { type: 'analytics_rollup_error', reason: String(err) });
    }

    // 2. Retry any video-library lead delivery that failed (webhook/Canopy).
    try {
      await drainLibraryQueue(env);
    } catch (err) {
      await logEvent(env.LIBRARY_KV, { type: 'library_queue_error', reason: String(err) });
    }

    // 3. Flush the main site's pending-Canopy queue once real credentials
    //    exist. A no-op scan (cheap) while Canopy is unconfigured. Unchanged.
    await flushCanopyQueue(env);
  },
};

async function flushCanopyQueue(env: Env): Promise<void> {
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
}
