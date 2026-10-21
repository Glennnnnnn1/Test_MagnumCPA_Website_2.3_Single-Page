// The video catalogue: one KV document holding every video in display order.
//
// One document rather than one key per video, because the library page needs
// all of them on every load (1 KV read, edge-cached), because order is a
// property of the list rather than of any item, and because N-key reads would
// spend the Worker's subrequest budget on a page that renders a grid.
//
// The cost of one document is that concurrent writers can clobber each other.
// That's handled with an explicit `rev` rather than a lock: a mutation must
// state the rev it read, and a stale one is rejected with 409 instead of
// silently overwriting. With a single admin this effectively never fires, but
// it turns the one case that does happen — two admin tabs open, reorder in
// one and delete in the other — from silent data loss into "refresh and retry".
import type { Env } from './kv';
import { kvGetJSON, kvPutJSON, uuid } from './kv';
import type { Provider } from './videourl';

const VIDEOS_KEY = 'videos:list';
const VIDEOS_CACHE_TTL = 60; // seconds, public reads only

export interface Video {
  id: string;
  title: string;
  description: string;
  category: string;
  embedUrl: string;
  sourceUrl: string;
  provider: Provider;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VideoList {
  rev: number;
  updatedAt: string;
  videos: Video[];
}

const EMPTY: VideoList = { rev: 0, updatedAt: '1970-01-01T00:00:00.000Z', videos: [] };

// Public read path — edge-cached. Staleness of up to VIDEOS_CACHE_TTL is fine
// for visitors; the admin path uses getVideoListFresh so an edit is never
// applied on top of a cached copy.
export async function getVideoList(env: Env): Promise<VideoList> {
  const stored = await kvGetJSON<VideoList>(env.LIBRARY_KV, VIDEOS_KEY, VIDEOS_CACHE_TTL);
  return normalizeList(stored);
}

export async function getVideoListFresh(env: Env): Promise<VideoList> {
  const stored = await kvGetJSON<VideoList>(env.LIBRARY_KV, VIDEOS_KEY);
  return normalizeList(stored);
}

function normalizeList(stored: VideoList | null): VideoList {
  if (!stored || !Array.isArray(stored.videos)) return { ...EMPTY, videos: [] };
  return {
    rev: typeof stored.rev === 'number' ? stored.rev : 0,
    updatedAt: stored.updatedAt || EMPTY.updatedAt,
    videos: stored.videos,
  };
}

// Writes the list at rev+1. Callers must have already compared the client's
// rev against the freshly-read one.
export async function putVideoList(env: Env, videos: Video[], currentRev: number): Promise<VideoList> {
  const next: VideoList = {
    rev: currentRev + 1,
    updatedAt: new Date().toISOString(),
    videos,
  };
  await kvPutJSON(env.LIBRARY_KV, VIDEOS_KEY, next);
  return next;
}

export function newVideoId(): string {
  return uuid();
}

// What the public library page is allowed to see: hidden videos withheld, and
// no internal bookkeeping fields.
export function toPublicVideo(v: Video) {
  return {
    id: v.id,
    title: v.title,
    description: v.description,
    category: v.category,
    embedUrl: v.embedUrl,
    sourceUrl: v.sourceUrl,
    provider: v.provider,
  };
}
