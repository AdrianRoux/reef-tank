# Reef Tank App — Cloudflare Setup Guide

The app now lives on Cloudflare Workers instead of GitHub Pages. This gives it a
small backend: a database that lets your phone and PC share one set of readings.
You do the setup below once; future updates are a single `npm run deploy`.

All commands run in **Command Prompt** (not PowerShell) from inside the
`reef-tank` folder:

```
cd "C:\Users\adria\Documents\B. Interests\Aquaculture\reef-tank"
```

---

## Step 0 — Install the new dependency

```
npm install
```

This adds `wrangler`, Cloudflare's deployment tool, listed in the updated
package.json.

---

## Step 1 — Sign in to Cloudflare

```
npx wrangler login
```

A browser window opens; sign in with the same Cloudflare account you use for
the pastoral system and click **Allow**.

---

## Step 2 — Create the database

```
npx wrangler d1 create reef-tank
```

The output includes a `database_id` (a long string of letters, numbers, and
hyphens). Copy it, open `wrangler.jsonc` in the project folder, and replace
`REPLACE_WITH_DATABASE_ID` with it. Save the file.

---

## Step 3 — Set the sync token

```
npx wrangler secret put SYNC_TOKEN
```

When prompted, type (or paste) a passphrase of your choosing — treat it like a
password; anyone who has it can read and write your tank data. You will enter
this same passphrase once in the app on each device.

If wrangler complains that the Worker doesn't exist yet, run Step 4 first, then
come back and repeat this step.

---

## Step 4 — Deploy

```
npm run deploy
```

This builds the app and publishes it. The output ends with your new permanent
URL, something like:

```
https://reef-tank.YOUR-SUBDOMAIN.workers.dev
```

Bookmark it. Every future update is just `npm run deploy` again — same as before.

---

## Step 5 — Connect each device

1. Open the new URL on your PC. Go to **Settings → Cross-device sync**, paste
   the sync token, and press **Sync now**. Your existing readings upload to the
   server (they migrate automatically from the old local storage).
2. Open the same URL on your phone. In Chrome, use **Add to Home screen** to
   install it as an app (the old home-screen icon points at the retired GitHub
   Pages address — remove it). Enter the same token in Settings and press
   **Sync now**.

From then on the two devices share one dataset. The dot in the top-right corner
of the header shows sync state: green = synced, amber = syncing, red = offline
or error, grey = not connected.

If your phone has readings the PC doesn't (or vice versa), sync merges them —
nothing is overwritten or lost.

---

## Step 6 — Commit the changes

Good housekeeping, and it keeps GitHub as an off-site copy of the code:

```
git add -A
git commit -m "Move to Cloudflare Workers with D1 sync; dose logging, ratios, history"
git push
```

---

## The old GitHub Pages site

`https://AdrianRoux.github.io/reef-tank/` still serves the old version. Its
data lives only in that browser's storage; once you've confirmed the new site
has everything (export a JSON backup first if you want belt and braces), you
can retire it: on GitHub go to the repository → Settings → Pages → set the
source to **None**.

---

## Troubleshooting

**"You must use a real database in the database_id configuration"** — Step 2's
id wasn't pasted into wrangler.jsonc, or the quotes got mangled.

**Red dot / "Sync token rejected"** — the token in the app doesn't match the
secret. Re-run Step 3, or re-enter the token in Settings on the device.

**Deploy succeeds but the page is blank** — hard-refresh (Ctrl+F5). If it
persists, check that `vite.config.js` still has `base: "/"`.
