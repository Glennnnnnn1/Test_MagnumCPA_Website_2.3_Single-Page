// Typed helpers over the KV namespaces.
//
// LEADS_KV — the main site's consultation form (unchanged):
//   rl:{ip}:{windowBucket}      rate-limit counters (ratelimit.ts)
//   dup:{kind}:{value}          duplicate-lead detection (dedupe.ts)
//   audit:{iso}:{uuid}          audit log events (audit.ts)
//   pending:{uuid}              leads awaiting Canopy creation (canopy-client.ts)
//   deadletter:{uuid}           leads that exhausted Canopy retries
//
// LIBRARY_KV — the gated video library. A separate namespace so library
// traffic can never evict, throttle or collide with lead-form data:
//   videos:list                 the ordered video catalogue, one document + rev
//   settings:app                categories, booking URL, admin token version
//   lead:{YYYY-MM}:{iso}:{uuid} a captured gate lead — WRITE-ONCE, never
//                               read-modify-write, so concurrent submissions
//                               can't lose one another
//   vldup:email:{email}         repeat-visitor marker (30d) — flags only,
//                               NEVER rejects, unlike LEADS_KV's dup: keys
//   ev:{bucket15}:{type}:{target}:{uuid}
//                               raw analytics event; all data is in the key
//                               name so the cron rollup only ever list()s
//   stats:day:{YYYY-MM-DD}      rolled-up counters (cron is the only writer)
//   stats:month:{YYYY-MM}
//   stats:watermark             last fully-rolled-up 15-minute bucket
//   stats:totals                all-time counters
//   rla:{ip}:{bucket}           admin login attempts (ratelimit.ts)
//   rlg:{ip}:{bucket}           gate submissions (ratelimit.ts)
//   vlpending:{uuid}            gate leads awaiting delivery (library-delivery.ts)
//   vldeadletter:{uuid}         gate leads that exhausted delivery retries

export interface Env {
  LEADS_KV: KVNamespace;
  LIBRARY_KV: KVNamespace;
  ALLOWED_ORIGINS: string;          // comma-separated list
  TURNSTILE_SECRET_KEY?: string;    // set via `wrangler secret put`
  CANOPY_CLIENT_ID?: string;        // set once Canopy access exists
  CANOPY_CLIENT_SECRET?: string;
  CANOPY_API_BASE?: string;         // CONFIRM against real Canopy docs
  CANOPY_TOKEN_URL?: string;        // CONFIRM against real Canopy docs

  // Video library admin. Both are required for the admin API to function at
  // all — see token.ts, which fails CLOSED when either is missing.
  ADMIN_PASSWORD_HASH?: string;     // pbkdf2$<iterations>$<saltB64>$<hashB64>
  ADMIN_TOKEN_SECRET?: string;      // base64, 32 random bytes

  // Optional: POST every captured gate lead here as JSON. Point it at a
  // Zapier/Make webhook to get a live-updating Google Sheet or Excel Online
  // file with no code, while the Canopy API integration is still dormant.
  LEAD_WEBHOOK_URL?: string;
}

export async function kvGetJSON<T>(kv: KVNamespace, key: string, cacheTtl?: number): Promise<T | null> {
  // cacheTtl lets hot, rarely-changing documents (settings, the video list) be
  // served from Cloudflare's edge cache instead of costing a KV read on every
  // request. The trade-off is staleness of up to cacheTtl seconds, which is
  // why mutations return the new document rather than having the client refetch.
  const raw = await kv.get(key, cacheTtl ? { cacheTtl } : undefined);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export async function kvPutJSON(kv: KVNamespace, key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  await kv.put(key, JSON.stringify(value), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
}

export async function kvListPrefix(kv: KVNamespace, prefix: string, limit = 1000) {
  return kv.list({ prefix, limit });
}

// Lists every key under a prefix, following cursors past KV's per-call cap.
// Each page costs a subrequest, so `maxPages` bounds the worst case rather
// than letting one call blow the Worker's subrequest budget.
export async function kvListAll(kv: KVNamespace, prefix: string, maxPages = 10): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await kv.list({ prefix, limit: 1000, cursor });
    for (const k of page.keys) names.push(k.name);
    if (page.list_complete) break;
    cursor = page.cursor;
    if (!cursor) break;
  }
  return names;
}

export function uuid(): string {
  return crypto.randomUUID();
}
