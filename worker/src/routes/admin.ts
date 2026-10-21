// Admin API for the video library. Every route below requires a valid bearer
// token except /login itself.
//
// admin.html is served publicly from GitHub Pages and always will be — the
// API is the security boundary, not the page. Do not "hide" the admin page and
// treat that as protection.
import type { Env } from '../kv';
import { logEvent } from '../audit';
import { checkRateLimit } from '../ratelimit';
import { sanitizeText } from '../sanitize';
import { jsonResponse, csvResponse } from '../http';
import { verifyPassword, verifyToken, signToken, newAdminPayload } from '../token';
import { getSettings, getSettingsFresh, putSettings, isKnownCategory, type AppSettings } from '../settings';
import { getVideoListFresh, putVideoList, newVideoId, type Video } from '../videos';
import { normalizeEmbedUrl } from '../videourl';
import { listLeads, leadsToCsv, monthsBetween } from '../leads';
import { getSummary } from '../analytics';

const MAX_BODY_BYTES = 32 * 1024;
const MAX_TITLE = 160;
const MAX_DESCRIPTION = 600;
const MAX_VIDEOS = 500;

// Per-IP and global login budgets. The global one exists because a single
// shared password is guessable from a botnet, where per-IP limiting never
// triggers — that's the attack per-IP limiting structurally cannot see.
const LOGIN_RATE_LIMIT = { prefix: 'rla:', max: 5, windowSeconds: 900 };
const LOGIN_GLOBAL_RATE_LIMIT = { prefix: 'rla:', max: 20, windowSeconds: 900 };

type Ctx = { env: Env; origin: string | null; allowed: string[] };

function ok(ctx: Ctx, body: Record<string, unknown>, status = 200): Response {
  return jsonResponse({ ok: true, ...body }, status, ctx.origin, ctx.allowed);
}
function err(ctx: Ctx, error: string, status: number, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ ok: false, error, ...extra }, status, ctx.origin, ctx.allowed);
}

async function readJson<T>(request: Request): Promise<T | null> {
  const declared = Number(request.headers.get('Content-Length') || '0');
  if (declared > MAX_BODY_BYTES) return null;
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(new TextDecoder().decode(buf)) as T;
  } catch {
    return null;
  }
}

function adminConfigured(env: Env): boolean {
  return !!(env.ADMIN_PASSWORD_HASH && env.ADMIN_TOKEN_SECRET);
}

// Fails CLOSED when the secrets are unset — the deliberate opposite of the
// Turnstile check in routes/lead.ts, which fails open. That asymmetry is the
// point: letting spam through beats blocking every customer, but letting an
// unauthenticated request through is never better than refusing it.
async function requireAdmin(request: Request, ctx: Ctx): Promise<Response | null> {
  const { env } = ctx;
  if (!adminConfigured(env)) return err(ctx, 'admin_not_configured', 503);

  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return err(ctx, 'unauthorized', 401);

  const payload = await verifyToken(token, env.ADMIN_TOKEN_SECRET!);
  if (!payload) return err(ctx, 'unauthorized', 401);

  // The token version check is what makes "sign out everywhere" real. Read
  // through the cache: an 8-hour token surviving up to 60 extra seconds after
  // a logout is an acceptable trade for not spending a KV read per request.
  const settings = await getSettings(env);
  if (payload.ver !== settings.adminTokenVersion) return err(ctx, 'unauthorized', 401);

  return null;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function login(request: Request, ctx: Ctx): Promise<Response> {
  const { env } = ctx;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  if (!adminConfigured(env)) {
    await logEvent(env.LIBRARY_KV, { type: 'admin_login_unconfigured', ip });
    return err(ctx, 'admin_not_configured', 503);
  }

  const perIp = await checkRateLimit(env.LIBRARY_KV, ip, LOGIN_RATE_LIMIT);
  const global = await checkRateLimit(env.LIBRARY_KV, 'global', LOGIN_GLOBAL_RATE_LIMIT);
  if (!perIp.allowed || !global.allowed) {
    await logEvent(env.LIBRARY_KV, { type: 'admin_login_rate_limited', ip });
    return err(ctx, 'rate_limited', 429);
  }

  const body = await readJson<{ password?: string }>(request);
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!password) return err(ctx, 'unauthorized', 401);

  const valid = await verifyPassword(password, env.ADMIN_PASSWORD_HASH!);
  if (!valid) {
    // Logged so a brute-force attempt is visible in the audit trail rather
    // than being invisibly absorbed by the rate limiter.
    await logEvent(env.LIBRARY_KV, { type: 'admin_login_failed', ip });
    return err(ctx, 'unauthorized', 401);
  }

  const settings = await getSettings(env);
  const payload = newAdminPayload(settings.adminTokenVersion);
  const token = await signToken(payload, env.ADMIN_TOKEN_SECRET!);
  await logEvent(env.LIBRARY_KV, { type: 'admin_login_ok', ip });

  return ok(ctx, { token, expiresAt: payload.exp });
}

async function logoutEverywhere(ctx: Ctx): Promise<Response> {
  const settings = await getSettingsFresh(ctx.env);
  await putSettings(ctx.env, { ...settings, adminTokenVersion: settings.adminTokenVersion + 1 });
  return ok(ctx, {});
}

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------
interface VideoInput {
  title?: string;
  description?: string;
  category?: string;
  embedUrl?: string;
  hidden?: boolean;
  rev?: number;
}

function cleanTitle(raw: unknown): string {
  return sanitizeText(raw).slice(0, MAX_TITLE);
}

// sanitizeText strips tags at the boundary; the frontend additionally renders
// every one of these with textContent. Note it does NOT html-escape here —
// escaping on write and rendering as text would show a literal "&amp;" in any
// title containing an ampersand.
function cleanDescription(raw: unknown): string {
  return sanitizeText(raw).slice(0, MAX_DESCRIPTION);
}

async function listVideosAdmin(ctx: Ctx): Promise<Response> {
  const [list, settings] = await Promise.all([getVideoListFresh(ctx.env), getSettings(ctx.env)]);
  return ok(ctx, { rev: list.rev, videos: list.videos, categories: settings.categories, bookUrl: settings.bookUrl });
}

async function createVideo(request: Request, ctx: Ctx): Promise<Response> {
  const body = await readJson<VideoInput>(request);
  if (!body) return err(ctx, 'bad_request', 400);

  const title = cleanTitle(body.title);
  if (!title) return err(ctx, 'validation', 400, { fields: { title: 'Give the video a title.' } });

  const embed = normalizeEmbedUrl(String(body.embedUrl ?? ''));
  if (!embed.ok) return err(ctx, 'validation', 400, { fields: { embedUrl: embed.error } });

  const settings = await getSettings(ctx.env);
  const category = String(body.category ?? '');
  if (!isKnownCategory(settings, category)) {
    return err(ctx, 'validation', 400, { fields: { category: 'Choose a category.' } });
  }

  const list = await getVideoListFresh(ctx.env);
  if (typeof body.rev === 'number' && body.rev !== list.rev) {
    return err(ctx, 'stale_rev', 409, { rev: list.rev });
  }
  if (list.videos.length >= MAX_VIDEOS) return err(ctx, 'too_many_videos', 400);

  const now = new Date().toISOString();
  const video: Video = {
    id: newVideoId(),
    title,
    description: cleanDescription(body.description),
    category,
    embedUrl: embed.value.embedUrl,
    sourceUrl: embed.value.sourceUrl,
    provider: embed.value.provider,
    hidden: body.hidden === true,
    createdAt: now,
    updatedAt: now,
  };

  const next = await putVideoList(ctx.env, [...list.videos, video], list.rev);
  return ok(ctx, { video, rev: next.rev, videos: next.videos });
}

async function updateVideo(request: Request, ctx: Ctx, id: string): Promise<Response> {
  const body = await readJson<VideoInput>(request);
  if (!body) return err(ctx, 'bad_request', 400);

  const list = await getVideoListFresh(ctx.env);
  if (typeof body.rev === 'number' && body.rev !== list.rev) {
    return err(ctx, 'stale_rev', 409, { rev: list.rev });
  }

  const idx = list.videos.findIndex(v => v.id === id);
  if (idx === -1) return err(ctx, 'not_found', 404);

  const current = list.videos[idx];
  const settings = await getSettings(ctx.env);
  const updated: Video = { ...current, updatedAt: new Date().toISOString() };

  if (body.title !== undefined) {
    const title = cleanTitle(body.title);
    if (!title) return err(ctx, 'validation', 400, { fields: { title: 'Give the video a title.' } });
    updated.title = title;
  }
  if (body.description !== undefined) updated.description = cleanDescription(body.description);
  if (body.category !== undefined) {
    if (!isKnownCategory(settings, String(body.category))) {
      return err(ctx, 'validation', 400, { fields: { category: 'Choose a category.' } });
    }
    updated.category = String(body.category);
  }
  if (body.embedUrl !== undefined) {
    const embed = normalizeEmbedUrl(String(body.embedUrl));
    if (!embed.ok) return err(ctx, 'validation', 400, { fields: { embedUrl: embed.error } });
    updated.embedUrl = embed.value.embedUrl;
    updated.sourceUrl = embed.value.sourceUrl;
    updated.provider = embed.value.provider;
  }
  if (body.hidden !== undefined) updated.hidden = body.hidden === true;

  const videos = list.videos.slice();
  videos[idx] = updated;
  const next = await putVideoList(ctx.env, videos, list.rev);
  return ok(ctx, { video: updated, rev: next.rev, videos: next.videos });
}

async function deleteVideo(request: Request, ctx: Ctx, id: string): Promise<Response> {
  const url = new URL(request.url);
  const revParam = url.searchParams.get('rev');

  const list = await getVideoListFresh(ctx.env);
  if (revParam !== null && Number(revParam) !== list.rev) {
    return err(ctx, 'stale_rev', 409, { rev: list.rev });
  }
  if (!list.videos.some(v => v.id === id)) return err(ctx, 'not_found', 404);

  const next = await putVideoList(ctx.env, list.videos.filter(v => v.id !== id), list.rev);
  return ok(ctx, { rev: next.rev, videos: next.videos });
}

// Takes the full ordered id array rather than a move delta. The server checks
// it against the current set, so a reorder computed from a stale list is
// rejected outright instead of quietly dropping or duplicating a video.
async function reorderVideos(request: Request, ctx: Ctx): Promise<Response> {
  const body = await readJson<{ ids?: string[]; rev?: number }>(request);
  if (!body || !Array.isArray(body.ids)) return err(ctx, 'bad_request', 400);

  const list = await getVideoListFresh(ctx.env);
  if (typeof body.rev === 'number' && body.rev !== list.rev) {
    return err(ctx, 'stale_rev', 409, { rev: list.rev });
  }

  const current = list.videos.map(v => v.id);
  const given = body.ids.map(String);
  const sameSet =
    given.length === current.length &&
    new Set(given).size === given.length &&
    given.every(id => current.includes(id));
  if (!sameSet) return err(ctx, 'stale_rev', 409, { rev: list.rev });

  const byId = new Map(list.videos.map(v => [v.id, v]));
  const next = await putVideoList(ctx.env, given.map(id => byId.get(id)!), list.rev);
  return ok(ctx, { rev: next.rev, videos: next.videos });
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------
function rangeFromQuery(url: URL): { from: Date; to: Date } {
  const to = url.searchParams.get('to') ? new Date(url.searchParams.get('to')!) : new Date();
  const fromParam = url.searchParams.get('from');
  const from = fromParam ? new Date(fromParam) : new Date(to.getTime() - 364 * 86400000);
  const valid = (d: Date) => !Number.isNaN(d.getTime());
  if (!valid(from) || !valid(to) || from > to) {
    const now = new Date();
    return { from: new Date(now.getTime() - 364 * 86400000), to: now };
  }
  return { from, to };
}

async function leadsJson(request: Request, ctx: Ctx): Promise<Response> {
  const url = new URL(request.url);
  const { from, to } = rangeFromQuery(url);
  const leads = await listLeads(ctx.env, monthsBetween(from, to));
  const limit = Math.min(Number(url.searchParams.get('limit') || 200), 1000);
  return ok(ctx, { total: leads.length, leads: leads.slice(0, limit) });
}

async function leadsCsv(request: Request, ctx: Ctx): Promise<Response> {
  const url = new URL(request.url);
  const { from, to } = rangeFromQuery(url);
  const leads = await listLeads(ctx.env, monthsBetween(from, to));
  const stamp = new Date().toISOString().slice(0, 10);
  return csvResponse(leadsToCsv(leads), `magnum-video-library-leads-${stamp}.csv`, ctx.origin, ctx.allowed);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
async function updateSettings(request: Request, ctx: Ctx): Promise<Response> {
  const body = await readJson<Partial<AppSettings>>(request);
  if (!body) return err(ctx, 'bad_request', 400);

  const current = await getSettingsFresh(ctx.env);
  const next: AppSettings = { ...current };

  if (body.bookUrl !== undefined) {
    const raw = String(body.bookUrl).trim();
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return err(ctx, 'validation', 400, { fields: { bookUrl: 'Enter a full https:// link.' } });
    }
    // This value becomes an href on a public page; anything but https is a
    // vector, not a convenience.
    if (parsed.protocol !== 'https:') {
      return err(ctx, 'validation', 400, { fields: { bookUrl: 'The booking link must start with https://' } });
    }
    next.bookUrl = parsed.toString();
  }

  if (body.gateTurnstile !== undefined) next.gateTurnstile = body.gateTurnstile === true;

  if (Array.isArray(body.categories)) {
    const cleaned = body.categories
      .map((c, i) => ({
        slug: sanitizeText((c as { slug?: unknown })?.slug).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40),
        label: sanitizeText((c as { label?: unknown })?.label).slice(0, 60),
        order: i,
      }))
      .filter(c => c.slug && c.label);
    if (cleaned.length === 0) {
      return err(ctx, 'validation', 400, { fields: { categories: 'Keep at least one category.' } });
    }
    next.categories = cleaned;
  }

  const saved = await putSettings(ctx.env, next);
  return ok(ctx, { settings: saved });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export async function handleAdmin(
  request: Request,
  env: Env,
  origin: string | null,
  allowed: string[],
  pathname: string
): Promise<Response> {
  const ctx: Ctx = { env, origin, allowed };
  const method = request.method;
  // pathname arrives as /api/admin/<rest>
  const rest = pathname.replace(/^\/api\/admin\/?/, '');

  if (rest === 'login') {
    if (method !== 'POST') return err(ctx, 'method_not_allowed', 405);
    return login(request, ctx);
  }

  const denied = await requireAdmin(request, ctx);
  if (denied) return denied;

  if (rest === 'session') return ok(ctx, {});
  if (rest === 'logout') {
    if (method !== 'POST') return err(ctx, 'method_not_allowed', 405);
    return logoutEverywhere(ctx);
  }

  if (rest === 'videos') {
    if (method === 'GET') return listVideosAdmin(ctx);
    if (method === 'POST') return createVideo(request, ctx);
    return err(ctx, 'method_not_allowed', 405);
  }

  // Checked before the /videos/{id} pattern below — "order" is a route, not an id.
  if (rest === 'videos/order') {
    if (method !== 'PUT') return err(ctx, 'method_not_allowed', 405);
    return reorderVideos(request, ctx);
  }

  if (rest.startsWith('videos/')) {
    const id = rest.slice('videos/'.length);
    if (!id || id.includes('/')) return err(ctx, 'not_found', 404);
    if (method === 'PUT') return updateVideo(request, ctx, id);
    if (method === 'DELETE') return deleteVideo(request, ctx, id);
    return err(ctx, 'method_not_allowed', 405);
  }

  if (rest === 'leads') {
    if (method !== 'GET') return err(ctx, 'method_not_allowed', 405);
    return leadsJson(request, ctx);
  }
  if (rest === 'leads.csv') {
    if (method !== 'GET') return err(ctx, 'method_not_allowed', 405);
    return leadsCsv(request, ctx);
  }

  if (rest === 'analytics') {
    if (method !== 'GET') return err(ctx, 'method_not_allowed', 405);
    const days = Number(new URL(request.url).searchParams.get('days') || 30);
    const summary = await getSummary(env, Number.isFinite(days) ? days : 30);
    const list = await getVideoListFresh(env);
    // Titles are joined here rather than in the browser so the dashboard can
    // label a play count even after the video itself has been deleted.
    const titles: Record<string, string> = {};
    for (const v of list.videos) titles[v.id] = v.title;
    return ok(ctx, { summary, videoTitles: titles });
  }

  if (rest === 'settings') {
    if (method === 'GET') return ok(ctx, { settings: await getSettingsFresh(env) });
    if (method === 'PUT') return updateSettings(request, ctx);
    return err(ctx, 'method_not_allowed', 405);
  }

  return err(ctx, 'not_found', 404);
}
