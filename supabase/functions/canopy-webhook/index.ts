// ============================================================================
//  Edge Function: canopy-webhook
//  Receives push events from Canopy (e.g. a new document request, or an
//  engagement/workflow status change) and mirrors them into the portal so
//  the client sees them without anyone manually re-entering data.
//
//  ⚠️ CONFIRM BEFORE GOING LIVE
//  - The exact event payload shape (event type names, field names) below is a
//    reasonable guess at a typical practice-management webhook, NOT confirmed
//    against Canopy's real webhook docs. Once you have Canopy API access,
//    check their webhook payload reference and adjust the `switch` below.
//  - Signature verification is stubbed out (CANOPY_WEBHOOK_SECRET) — wire it
//    to whatever verification scheme Canopy actually uses (HMAC header, etc.)
//    before relying on this in production, so random requests can't forge updates.
//
//  Deploy with:  supabase functions deploy canopy-webhook --no-verify-jwt
//  (Canopy calls this directly, without a Supabase user session.)
// ============================================================================
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { db } from "../_shared/canopy.ts";

serve(async (req) => {
  try {
    const body = await req.text();
    // CONFIRM: replace with Canopy's real signature verification once documented.
    const secret = Deno.env.get("CANOPY_WEBHOOK_SECRET");
    if (secret) {
      const sig = req.headers.get("X-Canopy-Signature") || ""; // CONFIRM header name
      if (!sig) return new Response("missing signature", { status: 401 });
      // TODO: verify `sig` against `body` using Canopy's documented scheme.
    }

    let payload: any = {};
    try { payload = JSON.parse(body); } catch { /* ignore malformed body */ }
    const eventType = payload.event || payload.type; // CONFIRM field name
    const canopyClientId = payload.client_id || payload.data?.client_id; // CONFIRM field name
    if (!canopyClientId) return new Response("ok"); // nothing to map to a portal user

    const { data: prof } = await db.from("profiles").select("id").eq("canopy_client_id", String(canopyClientId)).maybeSingle();
    if (!prof?.id) return new Response("ok"); // no matching portal client — nothing to do

    switch (eventType) {
      case "document_request.created": { // CONFIRM event name
        const r = payload.data || payload;
        await db.from("canopy_document_requests").upsert({
          user_id: prof.id,
          canopy_request_id: String(r.id),
          title: r.title || r.name || "Document requested",
          description: r.description || null,
          status: r.status || "pending",
          updated_at: new Date().toISOString(),
        }, { onConflict: "canopy_request_id" });
        await db.from("notifications").insert({
          user_id: prof.id, recipient: "client", type: "canopy",
          text: "Your accountant requested a new document via Canopy.",
        });
        break;
      }
      case "engagement.status_changed": { // CONFIRM event name
        const r = payload.data || payload;
        const text = `📋 Status update: ${r.engagement_name || "Engagement"} — ${r.status || "updated"}`;
        await db.from("updates").insert({ user_id: prof.id, text });
        await db.from("notifications").insert({
          user_id: prof.id, recipient: "client", type: "canopy",
          text: "Your filing status was updated.",
        });
        break;
      }
      default:
        // Unknown event type — ignore quietly rather than erroring the webhook.
        break;
    }
    return new Response("ok");
  } catch (e) {
    return new Response(String(e), { status: 500 });
  }
});
