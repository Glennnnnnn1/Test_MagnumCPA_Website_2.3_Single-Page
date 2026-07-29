// Typed helpers over the LEADS_KV namespace. Key-prefix conventions:
//   rl:{ip}:{windowBucket}      rate-limit counters (ratelimit.ts)
//   dup:{kind}:{value}          duplicate-lead detection (dedupe.ts)
//   audit:{iso}:{uuid}          audit log events (audit.ts)
//   pending:{uuid}              leads awaiting Canopy creation (canopy-client.ts)
//   deadletter:{uuid}           leads that exhausted Canopy retries

export interface Env {
  LEADS_KV: KVNamespace;
  ALLOWED_ORIGINS: string;          // comma-separated list
  TURNSTILE_SECRET_KEY?: string;    // set via `wrangler secret put`
  CANOPY_CLIENT_ID?: string;        // set once Canopy access exists
  CANOPY_CLIENT_SECRET?: string;
  CANOPY_API_BASE?: string;         // CONFIRM against real Canopy docs
  CANOPY_TOKEN_URL?: string;        // CONFIRM against real Canopy docs
}

export async function kvGetJSON<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export async function kvPutJSON(kv: KVNamespace, key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  await kv.put(key, JSON.stringify(value), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
}

export async function kvListPrefix(kv: KVNamespace, prefix: string, limit = 1000) {
  return kv.list({ prefix, limit });
}

export function uuid(): string {
  return crypto.randomUUID();
}
