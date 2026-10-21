// The pure half of analytics: key encoding, referrer bucketing, and counter
// merging. No KV, no env, no imports — so it is directly unit-testable and the
// I/O half (analytics.ts) stays thin enough to read in one sitting.

export const BUCKET_MS = 15 * 60 * 1000; // must match the cron interval

export type EventType = 'play' | 'cta' | 'filter' | 'lead';

export interface StatsDoc {
  plays: Record<string, number>;
  catPlays: Record<string, number>;
  filters: Record<string, number>;
  cta: Record<string, number>;
  sources: Record<string, number>;
  leads: number;
}

export function emptyStats(): StatsDoc {
  return { plays: {}, catPlays: {}, filters: {}, cta: {}, sources: {}, leads: 0 };
}

export function bucketOf(ms: number): number {
  return Math.floor(ms / BUCKET_MS);
}

export function dayOf(bucket: number): string {
  return new Date(bucket * BUCKET_MS).toISOString().slice(0, 10); // YYYY-MM-DD
}

export function monthOf(bucket: number): string {
  return new Date(bucket * BUCKET_MS).toISOString().slice(0, 7); // YYYY-MM
}

// Targets are embedded in a KV key name, so they're restricted to a safe
// character set — a colon in particular would corrupt the key structure that
// parseEventKey relies on. Anything else is dropped rather than escaped.
const SAFE_TARGET = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeTarget(s: string): boolean {
  return SAFE_TARGET.test(s);
}

// Referrers are bucketed to a fixed set before they are ever used as a key.
// Storing raw hosts would let anyone who can reach the gate page mint
// unbounded new KV keys just by linking to it from a domain they control.
const SOURCE_PATTERNS: Array<[RegExp, string]> = [
  [/(^|\.)canopytax\.com$/i, 'canopy'],
  [/(^|\.)google\./i, 'google'],
  [/(^|\.)(facebook|fb)\.com$/i, 'facebook'],
  [/(^|\.)linkedin\.com$/i, 'linkedin'],
  [/(^|\.)instagram\.com$/i, 'instagram'],
  [/(^|\.)(twitter|x)\.com$/i, 'x'],
  [/(^|\.)youtube\.com$/i, 'youtube'],
  [/(^|\.)bing\.com$/i, 'bing'],
  [/(^|\.)github\.io$/i, 'website'],
  [/(^|\.)magnumcpa\.com$/i, 'website'],
];

export function bucketReferrer(referrer: string): string {
  const raw = (referrer || '').trim();
  if (!raw) return 'direct';
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return 'other';
  }
  for (const [re, label] of SOURCE_PATTERNS) {
    if (re.test(host)) return label;
  }
  return 'other';
}

export interface ParsedEvent {
  bucket: number;
  type: EventType;
  target: string;
}

// Key shape: ev:{bucket}:{type}:{target}:{uuid}
export function parseEventKey(name: string): ParsedEvent | null {
  const parts = name.split(':');
  if (parts.length !== 5 || parts[0] !== 'ev') return null;
  const bucket = Number(parts[1]);
  if (!Number.isInteger(bucket)) return null;
  const type = parts[2] as EventType;
  if (type !== 'play' && type !== 'cta' && type !== 'filter' && type !== 'lead') return null;
  if (!SAFE_TARGET.test(parts[3])) return null;
  return { bucket, type, target: parts[3] };
}

export function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] || 0) + by;
}

export function mergeInto(target: StatsDoc, src: StatsDoc): void {
  for (const k of Object.keys(src.plays)) bump(target.plays, k, src.plays[k]);
  for (const k of Object.keys(src.catPlays)) bump(target.catPlays, k, src.catPlays[k]);
  for (const k of Object.keys(src.filters)) bump(target.filters, k, src.filters[k]);
  for (const k of Object.keys(src.cta)) bump(target.cta, k, src.cta[k]);
  for (const k of Object.keys(src.sources)) bump(target.sources, k, src.sources[k]);
  target.leads += src.leads;
}

// Folds one parsed event into a stats document. `categoryOf` resolves a video
// id to its category so "top categories" reflects what was actually watched,
// not just which filter buttons were clicked.
export function applyEvent(
  doc: StatsDoc,
  ev: ParsedEvent,
  categoryOf: (videoId: string) => string | undefined
): void {
  switch (ev.type) {
    case 'play': {
      bump(doc.plays, ev.target);
      const cat = categoryOf(ev.target);
      if (cat) bump(doc.catPlays, cat);
      break;
    }
    case 'cta':
      bump(doc.cta, ev.target);
      break;
    case 'filter':
      bump(doc.filters, ev.target);
      break;
    case 'lead':
      doc.leads += 1;
      bump(doc.sources, ev.target);
      break;
  }
}
