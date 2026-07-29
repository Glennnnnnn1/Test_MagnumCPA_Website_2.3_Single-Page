# Canopy Tax integration — readiness scaffold

**Update:** the site's Supabase integration (login, chat, file storage, reviews)
was removed and the client/admin portal reverted to its original browser-only
(`localStorage`) version. This file and the 4 files below it are kept exactly
as requested — untouched — so Canopy work isn't lost, but the ground they were
built on top of (a shared Supabase-backed portal) no longer exists on the live
site. Read this section before doing anything else in the steps further down.

## What's still here (untouched)
- `canopy-integration.sql` — the Canopy-specific database tables (client-id
  link, document requests, OAuth token storage)
- `supabase/functions/_shared/canopy.ts` — OAuth token helper
- `supabase/functions/canopy-sync/index.ts` — push/pull document sync
- `supabase/functions/canopy-webhook/index.ts` — receiver for Canopy events
- this file

## What was removed
`supabase.js`, `supabase-schema.sql`, `shared-files.sql`, `enable-realtime.sql`,
`app-settings.sql`, `finalize-portal.sql`, `SETUP-SUPABASE.md`,
`SETUP-FUNCTIONS.md`, and the `notify-client` / `asana-webhook` Edge Functions.
`client-portal.html`, `dashboard.html`, `admin.html`, `admin-client.html`, and
`admin-login.html` no longer call Supabase at all — they're back to the
original localStorage version, and `index.html`'s embedded portal
popup/login was removed too (the nav's "Client Portal" / "Admin Login" links
go straight to those standalone pages again).

## Why this matters for Canopy
The Canopy scaffold was designed assuming:
- a Supabase **Auth** user per client (`auth.users` / `profiles.id`) to attach
  a `canopy_client_id` to,
- and Edge Functions with a **service-role** key to talk to Canopy securely.

None of that exists on the live site right now. So "turning Canopy on" isn't
just a matter of API credentials anymore — **you'll also need to decide how
client identity is going to work** before this can go live. When you're ready,
the realistic options are:

1. **Reintroduce Supabase** (or an equivalent backend) for the portal, so each
   client has a stable server-side identity to hang `canopy_client_id` off of,
   then wire these existing Canopy files back in. This is the path all the
   current Canopy code assumes.
2. **A lighter, standalone Canopy connector** that doesn't require rebuilding
   the whole portal — e.g. a small admin-only tool/script that looks up a
   client by email in Canopy directly, without needing a shared database.
   Simpler, but the client wouldn't see Canopy document requests inside their
   own portal automatically the way the current scaffold intends.

Tell me which direction you want when you're ready, and whether you have
Canopy API access yet — I'll pick this back up from here either way.

---

## Original steps (still accurate for the Canopy API side)

Canopy's exact API paths, auth flow, and webhook payload shapes are
**placeholders** in the code, clearly marked `CONFIRM`, in:
- `supabase/functions/_shared/canopy.ts` (token URL, API base URL, grant type)
- `supabase/functions/canopy-sync/index.ts` (document + document-request endpoints)
- `supabase/functions/canopy-webhook/index.ts` (event names, field names, signature header)

I did **not** guess these with false confidence — tax/practice-management APIs
change their exact surface over time, and I don't want stale or wrong endpoint
paths silently breaking things later.

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
real, tested calls — once we've also settled the client-identity question above.
