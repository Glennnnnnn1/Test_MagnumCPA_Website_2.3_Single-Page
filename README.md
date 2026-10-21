# Magnum CPA Website — Setup Guide

## Your File Structure

```
single page magnum/
├── index.html                  ← Main single-page website (incl. consultation form)
├── financial-calculators.html  ← Financial calculator tools
├── images/                     ← All image assets
├── file/                       ← Downloadable files (e.g. tax organizer PDF)
├── worker/                     ← Cloudflare Worker (lead-form backend) — NOT published on the site
├── _config.yml                 ← Tells GitHub Pages which files to keep off the live site
├── sync.bat                    ← Double-click to push to GitHub
└── README.md                   ← This file
```

The client portal is **Canopy** — this website does not have its own login,
admin area, or client portal.

---

## Hosting

- **Domain:** `magnumcpa.com` is registered at **GoDaddy**, which also holds the DNS.
- **Website:** hosted free on **GitHub Pages** from the `main` branch of
  [github.com/Glennnnnnn1/Test_MagnumCPA_Website_2.3_Single-Page](https://github.com/Glennnnnnn1/Test_MagnumCPA_Website_2.3_Single-Page).
- **Email:** Google Workspace (MX records at GoDaddy point to Google). Never edit
  the MX or TXT records when changing website settings.
- **Lead form backend:** Cloudflare Worker — see `SETUP-CLOUDFLARE.md`.

### GitHub Pages settings
Repo → **Settings** → **Pages**: Source **Deploy from a branch**, Branch **main**,
folder **/ (root)**. Custom domain: `www.magnumcpa.com`, **Enforce HTTPS** on.

---

## Updating the Website

1. Save your changes
2. **Double-click `sync.bat`**
3. The live site updates within 1–2 minutes

Or use Terminal:
```
cd "C:\Users\Glenn\Documents\Claude\single page magnum"
git add -A && git commit -m "update" && git push
```

Changes inside `worker/` are **not** deployed by this — run `npx wrangler deploy`
from the `worker/` folder (see `SETUP-CLOUDFLARE.md`).

---

## Security Rules

- The GitHub repo is public: **never** put passwords, API keys, or client data in any file.
  Worker secrets are set with `npx wrangler secret put <NAME>` and stay in Cloudflare.
- Keep 2-factor authentication on for GitHub, GoDaddy, Cloudflare, and Google Workspace.

---

## Need Help?

- GitHub Pages docs: [docs.github.com/pages](https://docs.github.com/en/pages)
- Custom domain on GitHub Pages: [docs.github.com/pages/configuring-a-custom-domain-for-your-github-pages-site](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site)
