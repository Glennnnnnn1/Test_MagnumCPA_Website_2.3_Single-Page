// The real security boundary for injection. Client-side sanitization in
// index.html is UX politeness only — an attacker can always call this Worker
// directly, bypassing the browser entirely, so nothing here may assume the
// client-side pass already ran.

const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const TAG_RE = /<[^>]*>/g;

export function stripControlChars(s: string): string {
  return s.replace(CONTROL_CHARS_RE, '');
}

// Removes any HTML/script tags outright rather than trying to escape and
// re-render them anywhere — this data only ever needs to be plain text
// (stored in KV, sent to Canopy as a note, or read by staff).
export function stripTags(s: string): string {
  return s.replace(TAG_RE, '');
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return stripTags(stripControlChars(raw)).trim();
}

export function sanitizeLeadFields<T extends Record<string, unknown>>(lead: T): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(lead)) {
    out[key] = sanitizeText(lead[key]);
  }
  return out;
}
