import { kvGetJSON, kvPutJSON } from './kv';

const WINDOW_SECONDS = 60 * 10; // 10-minute fixed window
const MAX_PER_WINDOW = 5;

interface Counter { count: number }

// KV reads/writes aren't atomic, so under truly concurrent requests from the
// same IP within the same window this can under-count by a request or two.
// That's an acceptable trade-off for a low-volume contact form — it's not a
// substitute for Cloudflare's own zone-level Rate Limiting Rules once the
// domain is proxied through Cloudflare (see SETUP-CLOUDFLARE.md), just a
// working baseline that functions today on *.workers.dev with no DNS change.
export async function checkRateLimit(kv: KVNamespace, ip: string): Promise<{ allowed: boolean; count: number }> {
  const windowBucket = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
  const key = `rl:${ip}:${windowBucket}`;
  const existing = await kvGetJSON<Counter>(kv, key);
  const count = (existing?.count ?? 0) + 1;
  await kvPutJSON(kv, key, { count }, WINDOW_SECONDS);
  return { allowed: count <= MAX_PER_WINDOW, count };
}
