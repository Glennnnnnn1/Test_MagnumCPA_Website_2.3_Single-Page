// Cloudflare's Turnstile siteverify endpoint — this one IS a stable,
// documented Cloudflare API (unlike the Canopy endpoints elsewhere in this
// project, which are placeholders). https://developers.cloudflare.com/turnstile/
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(secretKey: string, token: string, remoteIp: string): Promise<boolean> {
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: secretKey, response: token, remoteip: remoteIp });
    const resp = await fetch(SITEVERIFY_URL, { method: 'POST', body });
    const data = await resp.json() as { success?: boolean };
    return data.success === true;
  } catch {
    // Network/parse failure — fail closed (treat as not verified) rather
    // than silently letting an unverifiable request through.
    return false;
  }
}
