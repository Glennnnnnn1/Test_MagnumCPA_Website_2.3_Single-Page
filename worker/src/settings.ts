// The library's single settings document. Small, rarely written, read on
// nearly every request — so it's read through the edge cache and always
// merged over defaults, meaning a missing or partially-written document
// degrades to sane values instead of throwing.
import type { Env } from './kv';
import { kvGetJSON, kvPutJSON } from './kv';

const SETTINGS_KEY = 'settings:app';
const SETTINGS_CACHE_TTL = 60; // seconds

export interface Category {
  slug: string;
  label: string;
  order: number;
}

export interface AppSettings {
  categories: Category[];
  bookUrl: string;
  // Turnstile on the gate form. On by default; the site key already exists.
  gateTurnstile: boolean;
  // Bumping this invalidates every admin token already issued — that's what
  // "sign out everywhere" does, and it's why tokens carry a `ver` claim.
  adminTokenVersion: number;
  updatedAt: string;
}

// Mirrors the four service tiles on the main site so the library's categories
// read as the same business, not a second taxonomy.
export const DEFAULT_SETTINGS: AppSettings = {
  categories: [
    { slug: 'tax', label: 'Tax', order: 0 },
    { slug: 'bookkeeping-payroll', label: 'Bookkeeping & Payroll', order: 1 },
    { slug: 'consulting', label: 'Consulting', order: 2 },
    { slug: 'security', label: 'Security', order: 3 },
    { slug: 'general', label: 'General', order: 4 },
  ],
  bookUrl: 'https://magnumcpa.as.me/10MinuteCall',
  gateTurnstile: true,
  adminTokenVersion: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
};

export async function getSettings(env: Env): Promise<AppSettings> {
  const stored = await kvGetJSON<Partial<AppSettings>>(env.LIBRARY_KV, SETTINGS_KEY, SETTINGS_CACHE_TTL);
  if (!stored) return { ...DEFAULT_SETTINGS };
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    // An empty category list would leave the admin unable to file anything;
    // fall back rather than persist a dead end.
    categories: stored.categories?.length ? stored.categories : DEFAULT_SETTINGS.categories,
  };
}

// Reads without the cache TTL. Used on the write path, where acting on a
// 60-second-stale adminTokenVersion would silently undo a "sign out
// everywhere" that just happened.
export async function getSettingsFresh(env: Env): Promise<AppSettings> {
  const stored = await kvGetJSON<Partial<AppSettings>>(env.LIBRARY_KV, SETTINGS_KEY);
  if (!stored) return { ...DEFAULT_SETTINGS };
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    categories: stored.categories?.length ? stored.categories : DEFAULT_SETTINGS.categories,
  };
}

export async function putSettings(env: Env, settings: AppSettings): Promise<AppSettings> {
  const next = { ...settings, updatedAt: new Date().toISOString() };
  await kvPutJSON(env.LIBRARY_KV, SETTINGS_KEY, next);
  return next;
}

export function isKnownCategory(settings: AppSettings, slug: string): boolean {
  return settings.categories.some(c => c.slug === slug);
}
