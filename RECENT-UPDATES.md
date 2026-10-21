# Magnum CPA Website — Recent Updates

**Prepared:** August 11, 2026
**Period covered:** June–July 2026

---

## Overview

The Magnum CPA website received a major upgrade this period. The headline change:
**the "Request a Consultation" form now has a real, secure backend.**

Previously, anyone filling out the form was sent straight to the scheduling
calendar — no validation, no spam filtering, no record of the lead. Now every
submission is checked, cleaned, screened for spam, and stored before the
visitor ever reaches the calendar.

Alongside that, we simplified the technology behind the site by removing a
database platform that was adding complexity without delivering value.

---

## 1. Secure Lead Capture (Live)

**The problem:** The consultation form was cosmetic. It collected a name, email,
and phone number, then handed the visitor off to the scheduler. Bots could
submit freely, duplicate submissions weren't caught, and no lead record was kept.

**What we built:** A secure lead-capture service that sits between the form and
the calendar. Every submission now passes through a series of checks:

1. **Basic validation** — required fields, valid email, valid US phone number
2. **Bot challenge** — an invisible Cloudflare Turnstile check
3. **Hidden trap field** — catches bots that auto-fill every field on a page
4. **Submission limits** — no more than 5 submissions from one visitor per 10 minutes
5. **Spam scoring** — flags disposable email addresses, known spam phrases, and link-stuffed messages
6. **Duplicate detection** — same email or phone within 24 hours, same name within 10 minutes
7. **Lead stored** — the clean lead is saved durably
8. **Calendar revealed** — only now does the visitor see the scheduler

**Result:** Only real, verified, non-duplicate leads reach the calendar. Spam
and bot submissions are quietly logged and set aside for review rather than
cluttering the pipeline.

### A richer form

The form now collects considerably more useful information up front:

| Field | Status |
|-------|--------|
| First name, Last name | Required (existing) |
| Business email | Required (existing) |
| Phone number | Required (existing) |
| **State** | **Required (new)** |
| **Business name** | **Optional (new)** |
| **Preferred contact method** | **New** — Email / Phone / Text |
| **Best time to call** | **New** — Morning / Afternoon / Evening / Anytime |
| **Message** | **Optional (new)** |
| Service needed | Existing |
| Approximate annual revenue | Existing |

Visitors now get clear, friendly error messages next to any field they missed,
instead of a generic browser warning.

### Built to fail safely

If anything goes wrong on the backend, the visitor sees a polite message asking
them to try again or call the office directly. The page never breaks, and the
form never lets an unverified submission through to scheduling.

---

## 2. Simplified Technology Stack

We removed **Supabase**, a database and backend platform that had been added to
power a client portal, real-time chat, and admin-managed testimonials.

**Why:** The complexity and ongoing maintenance weren't justified by what it
delivered. The client portal has been returned to its earlier, simpler working
version, and the testimonials slider went back to fixed content.

**Result:** Roughly 2,400 lines of code removed. Fewer moving parts, fewer
external dependencies, less to maintain and secure.

---

## 3. Canopy Tax Integration (Built, Not Yet Connected)

**Goal:** New leads from the website should flow automatically into Canopy Tax,
the firm's practice-management system — no manual re-entry.

**Status:** The connection is written and ready, but **not switched on**. It
needs Canopy developer API credentials, and the exact technical details of
Canopy's API need to be confirmed against their official documentation before
we enable it.

**Important:** No leads are being lost in the meantime. Every clean lead is
saved and held in a queue. The moment Canopy is connected, the system
automatically works through that backlog and sends everything across —
including anything captured before the connection existed.

---

## 4. Fixes

- **Bot-check configuration error.** A single mistyped character in the security
  key was causing the bot check to fail on every real submission. Found and
  fixed the same day the funnel went live.
- **Security housekeeping.** A password-like credential had been pasted into a
  configuration comment. It was caught and removed before it was ever saved into
  the project's history.

---

## Current Status

| Item | Status |
|------|--------|
| Secure lead capture | ✅ Live |
| Upgraded consultation form | ✅ Live |
| Bot / spam / duplicate protection | ✅ Live |
| Lead storage and audit trail | ✅ Live |
| Supabase removal | ✅ Complete |
| Canopy Tax auto-sync | ⏸️ Built, awaiting credentials |
| Domain move to Cloudflare | ⏸️ Deferred by choice |

---

## Recommended Next Steps

1. **Obtain Canopy developer API access.** This is the one remaining piece to
   make lead intake fully hands-off. Once we have credentials and their API
   documentation, connecting it is a short piece of work.

2. **Plan the domain move to Cloudflare.** The domain is currently registered
   with GoDaddy. Moving it to Cloudflare would unlock stronger, network-level
   protection for the whole site. This is a higher-stakes change that should be
   scheduled deliberately, at a low-traffic time, with a rollback plan — not
   done casually.

3. **Review the spam log periodically.** The system records why each submission
   was flagged. Reviewing that occasionally lets us tighten the filters based on
   the spam actually being received rather than guesswork.

---

## Also Updated This Period (June)

Visual and layout refinements to the single-page site:

- **Hero section** — redesigned and refined through several rounds: new
  background image, adjusted framing and crop, and finally sized to a banner so
  the page isn't excessively tall
- **Navigation** — menu items kept on a single clean row
- **Page layout** — reordered the About Us and "Why Get Tax Help" sections;
  moved to a solid navy page background
- **Trust badges** — added transparent BBB and Ramsey Trusted logos
- **Achievements** — added interactive BBB / Best Business Rate / Ramsey
  Trusted plaque cards

---

## Where Things Live

| File / Folder | Purpose |
|---------------|---------|
| `index.html` | The main single-page website, including the consultation form |
| `worker/` | The secure lead-capture service |
| `SETUP-CLOUDFLARE.md` | Setup and maintenance reference for that service |
| Client portal | Handled by Canopy — the website no longer has its own portal or admin login |
| `financial-calculators.html` | Financial calculator tools |
| `RECENT-UPDATES.md` | This document |
