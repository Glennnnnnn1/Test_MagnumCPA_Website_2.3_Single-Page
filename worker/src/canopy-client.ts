// Dormant-until-configured Canopy Tax client — successor to the old
// Supabase-based supabase/functions/_shared/canopy.ts (retired; that scaffold
// served a different feature, the client document portal, and depended on
// Supabase infrastructure that no longer exists on this site).
//
// ⚠️ CONFIRM BEFORE GOING LIVE
// The token URL, API base, auth grant type, and "create prospect" endpoint
// below are placeholders in the shape a typical OAuth2 + REST practice-
// management API takes — NOT confirmed against Canopy's real developer docs.
// Every value marked CONFIRM must be verified once real API access exists.
// This mirrors the same honest caveat the retired scaffold carried.
import type { Env } from './kv';

export function canopyConfigured(env: Env): boolean {
  return !!(env.CANOPY_CLIENT_ID && env.CANOPY_CLIENT_SECRET);
}

export interface NormalizedLead {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  businessName: string;
  state: string;
  serviceNeeded: string;
  revenue: string;
  preferredContact: string;
  bestTimeToCall: string;
  message: string;
  submittedAt: string;
}

async function getToken(env: Env): Promise<string> {
  const tokenUrl = env.CANOPY_TOKEN_URL || 'https://app.canopytax.com/oauth/token'; // CONFIRM
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', // CONFIRM — Canopy may require a different grant
      client_id: env.CANOPY_CLIENT_ID!,
      client_secret: env.CANOPY_CLIENT_SECRET!,
    }),
  });
  if (!resp.ok) throw new Error(`Canopy token request failed: ${resp.status}`);
  const data = await resp.json() as { access_token: string };
  return data.access_token;
}

// Throws on any failure — caller is responsible for falling back to the
// pending-KV queue so a lead is never lost just because Canopy is
// unreachable or a call fails transiently.
export async function createProspect(env: Env, lead: NormalizedLead): Promise<{ canopyId: string }> {
  if (!canopyConfigured(env)) throw new Error('canopy_not_configured');

  const apiBase = env.CANOPY_API_BASE || 'https://app.canopytax.com/api/v2'; // CONFIRM
  const token = await getToken(env);

  // CONFIRM: exact "create prospect" endpoint + payload shape/field names.
  const resp = await fetch(`${apiBase}/prospects`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      first_name: lead.firstName,
      last_name: lead.lastName,
      email: lead.email,
      phone: lead.phone,
      company_name: lead.businessName || undefined,
      state: lead.state || undefined,
      notes: [
        `Lead source: Magnum CPA website — Request a Consultation form`,
        `Submitted: ${lead.submittedAt}`,
        `Service needed: ${lead.serviceNeeded}`,
        lead.revenue ? `Annual revenue (approx.): ${lead.revenue}` : null,
        `Preferred contact: ${lead.preferredContact || 'not specified'}`,
        `Best time to call: ${lead.bestTimeToCall || 'not specified'}`,
        lead.message ? `Message: ${lead.message}` : null,
      ].filter(Boolean).join('\n'),
    }),
  });
  if (!resp.ok) throw new Error(`Canopy prospect creation failed: ${resp.status}`);
  const data = await resp.json() as { id: string };
  return { canopyId: data.id };
}
