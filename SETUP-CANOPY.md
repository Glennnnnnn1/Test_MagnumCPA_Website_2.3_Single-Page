# Canopy Tax integration — readiness scaffold

You told me you don't have Canopy API access yet, so this is built as a
**complete, dormant scaffold**: every piece the portal needs is in place, and
the portal works exactly as it does today whether or not Canopy is connected.
Nothing here is "live" — there are no real calls to Canopy yet. When you get
API access, this becomes a config-and-confirm job instead of a rebuild.

## What's already wired

| Piece | Where | Status |
|---|---|---|
| Link a portal client to their Canopy record | `profiles.canopy_client_id` column; editable field on each client's admin page (Details tab) | ✅ ready |
| Mirror a shared file into Canopy when the admin uploads one | `Magnum.canopyPushDocument()` → `canopy-sync` Edge Function | ✅ scaffolded, no-ops until deployed |
| Show Canopy's open document requests to the client | `canopy_document_requests` table + a "Document Requests" card on the client dashboard (hidden when empty) | ✅ ready to receive data |
| Auto-post an Account Update when a Canopy engagement's status changes | `canopy-webhook` Edge Function → inserts into `updates` + notifies the client | ✅ scaffolded |
| Secure OAuth token storage | `canopy_oauth_tokens` table (RLS on, no policies — invisible to every browser, only the Edge Functions can touch it via the service-role key) | ✅ ready |

## What's NOT done yet (needs your Canopy Developer access)

Canopy's exact API paths, auth flow, and webhook payload shapes are **placeholders**
in the code, clearly marked `CONFIRM`, in:
- `supabase/functions/_shared/canopy.ts` (token URL, API base URL, grant type)
- `supabase/functions/canopy-sync/index.ts` (document + document-request endpoints)
- `supabase/functions/canopy-webhook/index.ts` (event names, field names, signature header)

I did **not** guess these with false confidence — tax/practice-management APIs
change their exact surface over time, and I don't want stale or wrong endpoint
paths silently breaking things later. When you're ready, do this:

### Step 1 — Get Canopy API access
1. Log into Canopy → look for **Settings → Integrations/API** (or contact Canopy
   support — API access on practice management platforms is sometimes gated to
   certain plans and needs to be enabled by them).
2. Create a **Developer / API app**. You should get:
   - a **Client ID** and **Client Secret** (or an API key — tell me which)
   - Canopy's **API base URL** and **OAuth token URL**
   - their **API reference docs** (endpoints for clients, documents, document
     requests, engagements/workflows)
   - whether they support **webhooks**, and if so, the signature/verification
     scheme and the event payload format

### Step 2 — Send me those docs/details
Paste me the relevant doc pages (or a link, if public) for:
- the auth flow (is it client_credentials, like assumed, or something else?)
- the "create a document" and "list document requests" endpoints
- webhook event names + payload shape, if they have webhooks

I'll update the three files above to match exactly, so the placeholders become
real, tested calls.

### Step 3 — Set the secrets & deploy
```
supabase secrets set CANOPY_CLIENT_ID=xxxx
supabase secrets set CANOPY_CLIENT_SECRET=xxxx
supabase secrets set CANOPY_API_BASE=https://...        # from Canopy's docs
supabase secrets set CANOPY_TOKEN_URL=https://...        # from Canopy's docs
supabase functions deploy canopy-sync
supabase functions deploy canopy-webhook --no-verify-jwt
```
If Canopy supports webhooks, register the webhook URL
(`https://nnvqdmdrhruqlhellnyw.supabase.co/functions/v1/canopy-webhook`) in
their dashboard, and set `CANOPY_WEBHOOK_SECRET` if they give you a signing
secret.

### Step 4 — Run the schema (if you haven't already)
```sql
-- paste the full contents of canopy-integration.sql into Supabase → SQL Editor → Run
```

### Step 5 — Link your first client
On that client's admin page → **Details** tab → **Canopy Tax Link** → paste their
Canopy Client ID → Save. From then on:
- uploading a shared file for them also (best-effort) mirrors it to Canopy
- their dashboard will show any document requests once a sync or webhook
  populates `canopy_document_requests`

Nothing above needs to happen for the site to keep working today — it's all
additive and silent until you switch it on.
