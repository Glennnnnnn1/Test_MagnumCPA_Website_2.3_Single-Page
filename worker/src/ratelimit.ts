import { kvGetJSON, kvPutJSON } from './kv';

const WINDOW_SECONDS = 60 * 10; // 10-minute fixed window
const MAX_PER_WINDOW = 5;

interface Counter { count: number }

export interface RateLimitOptions {
  prefix?: string;        // key namespace, so callers don't share a counter
  max?: number;
  windowSeconds?: number;
}

// KV reads/writes aren't atomic, so under truly concurrent requests from the
// same IP within the same window this can under-count by a request or two.
// That's an acceptable trade-off for a low-volume contact form — it's not a
// substitute for Cloudflare's own zone-level Rate Limiting Rules once the
// domain is proxied through Cloudflare (see SETUP-CLOUDFLARE.md), just a
// working baseline that functions today on *.workers.dev with no DNS change.
//
// The defaults reproduce the original 2-argument behaviour exactly (`rl:{ip}:
// {bucket}`, 5 per 10 min), so routes/lead.ts's existing call is unchanged.
// `prefix` exists so a new caller gets its own counter: admin login attempts
// must not be able to exhaust the consultation form's budget, and vice versa.
export async function checkRateLimit(
  kv: KVNamespace,
  id: string,
  opts: RateLimitOptions = {}
): Promise<{ allowed: boolean; count: number }> {
  const windowSeconds = opts.windowSeconds ?? WINDOW_SECONDS;
  const max = opts.max ?? MAX_PER_WINDOW;
  const prefix = opts.prefix ?? 'rl:';

  const windowBucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `${prefix}${id}:${windowBucket}`;
  const existing = await kvGetJSON<Counter>(kv, key);
  const count = (existing?.count ?? 0) + 1;
  await kvPutJSON(kv, key, { count }, windowSeconds);
  return { allowed: count <= max, count };
}
