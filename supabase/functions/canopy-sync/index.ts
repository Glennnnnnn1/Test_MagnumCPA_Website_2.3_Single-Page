// ============================================================================
//  Edge Function: canopy-sync
//  Callable from the portal (Magnum.canopyPushDocument / Magnum.canopyPullRequests).
//  Safe to deploy now — every action no-ops with a clear message until
//  CANOPY_CLIENT_ID / CANOPY_CLIENT_SECRET secrets are set.
//
//  Actions (POST body: { action, ... }):
//    push_document   { user_id, path, file_name }   — mirror a shared file into Canopy
//    pull_requests    { user_id }                     — fetch open document requests from
//                                                        Canopy and upsert them into
//                                                        public.canopy_document_requests
// ============================================================================
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { canopyConfigured, canopyFetch, db } from "../_shared/canopy.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON         = Deno.env.get("SUPABASE_ANON_KEY")!;
const ADMIN_EMAIL  = "ask@magnumcpa.com";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // Caller must be a signed-in admin OR the client themselves (for their own file).
    const authHeader = req.headers.get("Authorization") || "";
    const asUser = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: ures } = await asUser.auth.getUser();
    if (!ures?.user) return json({ error: "Not authenticated" }, 401);

    const body = await req.json();
    const { action, user_id } = body;
    if (!action || !user_id) return json({ error: "action and user_id required" }, 400);

    const { data: caller } = await asUser.from("profiles").select("role,email").eq("id", ures.user.id).maybeSingle();
    const isAdmin = caller && (caller.role === "admin" || (caller.email || "").toLowerCase() === ADMIN_EMAIL);
    const isSelf  = ures.user.id === user_id;
    if (!isAdmin && !isSelf) return json({ error: "Not authorized" }, 403);

    if (!canopyConfigured()) {
      // Not an error — the portal keeps working normally; Canopy is just not connected yet.
      return json({ ok: false, reason: "canopy_not_configured" });
    }

    if (action === "push_document") {
      const { path, file_name } = body;
      const { data: prof } = await db.from("profiles").select("canopy_client_id").eq("id", user_id).maybeSingle();
      if (!prof?.canopy_client_id) return json({ ok: false, reason: "no_canopy_client_id" });

      // CONFIRM: exact endpoint + payload shape for creating/uploading a document
      // against a Canopy client record. This assumes a documents endpoint scoped
      // to the client id, taking a file reference; adjust to match Canopy's API.
      const signed = await db.storage.from("documents").createSignedUrl(path, 600);
      const result = await canopyFetch(`/clients/${prof.canopy_client_id}/documents`, {
        method: "POST",
        body: JSON.stringify({ name: file_name, source_url: signed?.data?.signedUrl }),
      });
      return json({ ok: true, canopy_document_id: result?.id || null });
    }

    if (action === "pull_requests") {
      const { data: prof } = await db.from("profiles").select("canopy_client_id").eq("id", user_id).maybeSingle();
      if (!prof?.canopy_client_id) return json({ ok: false, reason: "no_canopy_client_id" });

      // CONFIRM: exact endpoint for a client's open document requests.
      const list = await canopyFetch(`/clients/${prof.canopy_client_id}/document-requests`);
      const rows = (list?.data || list || []).map((r: any) => ({
        user_id,
        canopy_request_id: String(r.id),
        title: r.title || r.name || "Document requested",
        description: r.description || null,
        status: r.status || "pending",
        updated_at: new Date().toISOString(),
      }));
      if (rows.length) {
        await db.from("canopy_document_requests").upsert(rows, { onConflict: "canopy_request_id" });
      }
      return json({ ok: true, count: rows.length });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
