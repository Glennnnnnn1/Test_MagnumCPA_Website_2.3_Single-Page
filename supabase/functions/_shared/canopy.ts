// ============================================================================
//  Shared Canopy Tax API helper — used by canopy-sync and canopy-webhook.
//
//  ⚠️ CONFIRM BEFORE GOING LIVE
//  The exact token URL, API base URL, and endpoint paths below are placeholders
//  in the *standard shape* Canopy's Developer API is documented to use (OAuth2
//  client-credentials + a REST API), but you must confirm the precise values
//  against Canopy's current developer docs (https://developer.canopytax.com or
//  your Canopy Developer app dashboard) once you have API access — tax/practice
//  software APIs change their exact paths over time, and this file must not be
//  trusted blindly. Everywhere you see CONFIRM, that's a value to verify.
//
//  Required Supabase secrets (Edge Functions → Secrets):
//    CANOPY_CLIENT_ID
//    CANOPY_CLIENT_SECRET
//    CANOPY_API_BASE     e.g. https://app.canopytax.com/api/v2   (CONFIRM)
//    CANOPY_TOKEN_URL     e.g. https://app.canopytax.com/oauth/token (CONFIRM)
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID     = Deno.env.get("CANOPY_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("CANOPY_CLIENT_SECRET") || "";
const API_BASE       = Deno.env.get("CANOPY_API_BASE") || "https://app.canopytax.com/api/v2"; // CONFIRM
const TOKEN_URL       = Deno.env.get("CANOPY_TOKEN_URL") || "https://app.canopytax.com/oauth/token"; // CONFIRM

const db = createClient(SUPABASE_URL, SERVICE_ROLE);

export function canopyConfigured(): boolean {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

// Returns a valid access token, refreshing/re-fetching as needed. Tokens are
// cached in public.canopy_oauth_tokens so every function invocation doesn't
// re-authenticate.
export async function getCanopyToken(): Promise<string> {
  if (!canopyConfigured()) throw new Error("Canopy is not configured yet (missing CANOPY_CLIENT_ID/SECRET).");

  const { data: row } = await db.from("canopy_oauth_tokens").select("*").eq("id", "default").maybeSingle();
  const stillValid = row?.access_token && row?.expires_at && new Date(row.expires_at).getTime() - Date.now() > 60_000;
  if (stillValid) return row.access_token as string;

  // CONFIRM: client_credentials is the standard grant for a server-to-server
  // practice-management integration; Canopy may instead require an
  // authorization_code flow with a stored refresh_token — adjust this fetch
  // to match whatever your Canopy Developer app is configured for.
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!resp.ok) throw new Error(`Canopy token request failed: ${resp.status} ${await resp.text()}`);
  const tok = await resp.json();
  const expiresAt = new Date(Date.now() + (tok.expires_in ? tok.expires_in * 1000 : 3600_000)).toISOString();

  await db.from("canopy_oauth_tokens").upsert({
    id: "default",
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || null,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  });
  return tok.access_token as string;
}

// Thin wrapper for authenticated Canopy REST calls.
export async function canopyFetch(path: string, init: RequestInit = {}) {
  const token = await getCanopyToken();
  const resp = await fetch(API_BASE + path, {
    ...init,
    headers: {
      ...(init.headers || {}),
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!resp.ok) throw new Error(`Canopy API ${path} failed: ${resp.status} ${await resp.text()}`);
  return resp.status === 204 ? null : await resp.json();
}

export { db };
