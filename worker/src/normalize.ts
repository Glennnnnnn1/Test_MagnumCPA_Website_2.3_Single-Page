export function normalizeName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(w => (w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// US/Canada-only NANP normalization to E.164 (+1XXXXXXXXXX). Good enough for
// a US-focused CPA firm's contact form; a full international phone library
// would be overkill here and isn't justified by the spec's "US phone number
// format" requirement.
export function normalizePhoneE164(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return raw.trim(); // already failed validate.ts's format check if malformed
}
