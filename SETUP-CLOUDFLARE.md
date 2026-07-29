# Secure Lead Funnel — Cloudflare Worker setup

This is the account-level setup only you can do — I can't create Cloudflare
accounts or secrets on your behalf. Follow this once, in order. Nothing here
touches your GoDaddy domain or DNS — the Worker runs on Cloudflare's free
`*.workers.dev` subdomain, so there's zero risk to the live site while you
set this up.

## What's already built (in this repo)
- `index.html`'s "Request a Consultation" form now has the full field set,
  client-side validation, a honeypot field, and a Turnstile widget — it
  currently POSTs to a placeholder URL and will show a friendly error until
  you complete the steps below and I wire in your real Worker URL.
- `worker/` — the complete Cloudflare Worker source (validation, sanitization,
  spam/duplicate detection, rate limiting, Turnstile verification, a dormant
  Canopy client, audit logging). Nothing here has been deployed yet.

## Step 1 — Create a Cloudflare account (if you don't have one)
1. Go to [cloudflare.com](https://cloudflare.com) → **Sign Up** → free plan is fine.
2. You do **not** need to add your domain to Cloudflare for this step — the
   Worker will live on `*.workers.dev` for now.

## Step 2 — Create a Turnstile widget
1. Cloudflare dashboard → **Turnstile** → **Add widget**.
2. Widget name: anything, e.g. "Magnum CPA — Request Consultation."
3. Domain: add `glendley.github.io` (and your custom domain later, if/when
   you migrate DNS).
4. Widget mode: **Managed** (recommended default).
5. Copy the **Site Key** and **Secret Key** — you'll need both below.

## Step 3 — Install and log in to Wrangler (Cloudflare's CLI)
```bash
npm install -g wrangler
wrangler login
```
This opens a browser window to authorize the CLI against your Cloudflare account.

## Step 4 — Create the KV namespace
```bash
cd worker
wrangler kv namespace create LEADS_KV
```
This prints an `id`. Open `worker/wrangler.toml` and replace
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with that id.

## Step 5 — Set secrets
```bash
wrangler secret put TURNSTILE_SECRET_KEY
```
Paste the Secret Key from Step 2 when prompted. (Leave `CANOPY_CLIENT_ID`
etc. unset for now — the Worker safely skips Canopy and stores leads in KV
until you have real Canopy API access; see the "Canopy" section below.)

## Step 6 — Deploy
```bash
wrangler deploy
```
This prints your Worker's live URL, something like:
```
https://magnum-cpa-lead-worker.YOUR-SUBDOMAIN.workers.dev
```

## Step 7 — Wire the real URLs into the site
Send me:
1. The deployed Worker URL from Step 6.
2. The Turnstile **Site Key** from Step 2.

I'll update `index.html` (`LEAD_API_URL` and the `data-sitekey` attribute) and
push — that's the point the live form actually goes live with real
validation, spam protection, and Turnstile.

## Testing before you consider it done
```bash
wrangler dev
```
Then, in another terminal, try a few requests against `http://localhost:8787/lead`:
- A valid lead → should return `{"ok":true}`.
- Missing required fields → `{"ok":false,"error":"validation","fields":{...}}`.
- The same email twice in a row → the second should be silently flagged
  (still `{"ok":true}` to the caller, but check `wrangler tail` or
  `wrangler kv key list --binding=LEADS_KV --prefix=audit:` to see the
  `duplicate_email` reason logged).
- A body over 50KB → `413`.

Once deployed for real, submit one genuine test lead through the live form
and confirm a `pending:*` KV key was created (`wrangler kv key list
--binding=LEADS_KV --prefix=pending:`) — that's your proof the lead was
captured durably even though Canopy isn't connected yet.

## What this does NOT do yet
- **No custom domain / DNS cutover.** Your GoDaddy-registered domain isn't
  touched at all. Moving nameservers to Cloudflare (needed for native
  Cloudflare Rate Limiting Rules and page-level response-header hardening)
  is a separate, higher-stakes step — schedule it deliberately, ideally at a
  low-traffic time, and let's do it as its own effort with a rollback plan.
- **No Canopy connection yet.** Leads are captured and held safely in KV
  (`pending:*`) until you have real Canopy Developer API credentials. See
  `worker/src/canopy-client.ts` — every endpoint in there is marked `CONFIRM`
  because Canopy's exact API shape hasn't been verified. When you get API
  access, send me their docs and I'll wire it up for real.
- **Free-tier limits**: Cloudflare's exact current Workers/KV free-tier
  request and operation limits change over time — check the current numbers
  on Cloudflare's pricing page or your dashboard before assuming this scales
  beyond a normal contact-form volume without upgrading.
