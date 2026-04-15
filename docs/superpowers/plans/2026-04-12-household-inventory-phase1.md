# Household Inventory — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a usable end-to-end household inventory PWA for Dan and Abby — receipt scanning → parsed haul → committed inventory → quick lookup at the store.

**Architecture:** Preact PWA (Vite build) on GitHub Pages → Cloudflare Worker (JWT auth, spend cap, Anthropic proxy) → Supabase (Postgres + Auth + Storage). The Worker is the only place that touches the Anthropic API key and the service_role key. The PWA talks to Supabase directly for all inventory reads/writes (via RLS-enforced anon key) and to the Worker only for parse requests.

**Tech Stack:** Preact, Vite, Supabase JS client v2, Cloudflare Workers (ES modules), Wrangler CLI, Anthropic API (Haiku for receipts), idb (IndexedDB wrapper), hand-rolled service worker (no Workbox), GitHub Actions (deploy).

---

## Pre-Build Decisions (all locked in)

| # | Decision | Chosen approach |
|---|----------|-----------------|
| D1 | Realtime activity feed in Phase 1? | **No.** Poll on page load and after writes. Realtime is Phase 2. |
| D2 | Rate limit storage: KV or Postgres? | **Worker KV** for sliding window rate limit (no DB round-trip on hot path). `usage_meter` Postgres table for daily cost tracking only. |
| D3 | Frontend env injection | **Vite `import.meta.env.VITE_*`** pattern. Local dev: gitignored `frontend/.env.local`. Production: GitHub Actions injects from GitHub Secrets at Vite build time. Never committed. |
| D4 | Category field type | **Postgres CHECK constraint** on text column. |
| D5 | Category list | **Confirmed:** Produce, Dairy, Pantry, Frozen, Meat, Beverages, Household, Other. Freezer removed. |
| D6 | Decrement to 0 behavior | **Items stay at quantity=0**, show in Running Low view. Not auto-deleted. |
| D7 | Supabase Auth hook for allowlist | **Skip.** Signups are already disabled. Worker allowlist check is the real enforcement. |
| D8 | Counter photo UI in Phase 1 | **Show the button, disable it** with a "Coming soon" tooltip. |
| D9 | IndexedDB API | **Use `idb` npm package** (typed async wrapper, ~1.1kb). |
| D10 | Frontend framework | **Preact + Vite.** Preact (3kb) gives component model for 9 screens without framework overhead. Vite handles build, env injection, and dev server. |
| D11 | Haul commit behavior | **Increment** existing inventory quantity. Milk qty=1 + haul Milk qty=2 → Milk qty=3. |
| D12 | Receipt parsing | Few-shot prompt with examples from Whole Foods, Costco, Trader Joe's. Dan gathers real receipts before Step 7. Prompt caching deferred to Phase 2. |

---

## Folder Structure

```
household-inventory/
├── .github/
│   └── workflows/
│       └── deploy.yml              # GitHub Actions: build + deploy to Pages
├── frontend/
│   ├── index.html                  # Vite entry point
│   ├── vite.config.js              # Vite config (@preact/preset-vite plugin)
│   ├── package.json                # preact, idb, @supabase/supabase-js, vite
│   ├── .env.local                  # GITIGNORED — local dev VITE_* values
│   ├── .env.example                # Committed — variable names, empty values
│   ├── public/
│   │   ├── manifest.json           # PWA manifest
│   │   ├── sw.js                   # Service worker (app shell cache + offline)
│   │   └── icons/                  # PWA icons (192px, 512px PNG)
│   └── src/
│       ├── main.jsx                # Preact render entry point
│       ├── app.jsx                 # Hash-based router + auth guard
│       ├── db.js                   # Supabase client singleton (reads import.meta.env)
│       ├── offline.js              # IndexedDB mirror via idb
│       ├── components/
│       │   └── NavBar.jsx          # Bottom navigation bar
│       └── screens/
│           ├── SignIn.jsx          # Magic link sign-in
│           ├── Inventory.jsx       # Inventory list screen
│           ├── Activity.jsx        # Activity feed screen
│           ├── AddItem.jsx         # Manual add screen
│           ├── AddHaul.jsx         # Photo capture + upload screen
│           ├── HaulsInbox.jsx      # Pending hauls inbox
│           └── ReviewHaul.jsx      # Review + commit haul
├── worker/
│   ├── wrangler.toml               # Worker config (no secrets)
│   ├── package.json
│   └── src/
│       ├── index.js                # Worker entry — route dispatcher
│       ├── auth.js                 # JWT verification + allowlist
│       ├── spend-cap.js            # Daily spend cap check + usage_meter writes
│       ├── rate-limit.js           # KV-based sliding window rate limit
│       └── parse-haul.js           # /parse-haul route handler
├── supabase/
│   └── migrations/
│       └── 001_initial_schema.sql  # All tables + RLS policies
├── docs/
│   └── superpowers/
│       └── plans/
│           └── 2026-04-12-household-inventory-phase1.md  # This file
├── .gitignore
├── .env.example                    # Root-level example (for Worker secrets reminder)
├── README.md
└── SPEC.md
```

---

## Build Order Summary

| Step | What gets built | User provides | ~Time |
|---|---|---|---|
| **1** | Repo scaffold: .gitignore, folder structure, .env.example | Nothing | 15 min |
| **2** | Supabase schema migration (all tables + RLS + constraints) | Confirm categories; run SQL in Supabase editor | 45 min |
| **3** | Supabase seed: household + link Dan + Abby | Your user UUIDs from Supabase Auth dashboard; run seed SQL | 15 min |
| **4** | Cloudflare Worker scaffold (/health stub, KV namespace) | `wrangler kv:namespace create RATE_LIMIT`; note workers.dev URL | 30 min |
| **5** | Worker JWT verification + allowlist middleware | `wrangler secret put` for 4 secrets | 45 min |
| **6** | Worker spend cap + rate limiting | Nothing new | 45 min |
| **7** | Worker /parse-haul (Anthropic integration) | 2–3 real receipt photos before this step | 60 min |
| **8** | Frontend scaffold: Vite + Preact + PWA shell | Create `.env.local` with Supabase + Worker values; placeholder icons | 45 min |
| **9** | Auth flow (magic link sign-in, session guard) | Test with your own email | 45 min |
| **10** | Inventory screen (search, filter chip, decrement) | A few test items seeded | 75 min |
| **11** | Manual add item | Nothing | 30 min |
| **12** | Add Haul screen (upload → Worker → pending haul) | A receipt photo for testing | 60 min |
| **13** | Pending Hauls inbox | Nothing | 30 min |
| **14** | Review Haul (edit + commit to inventory) | Nothing | 60 min |
| **15** | Activity Feed | Nothing | 30 min |
| **16** | GitHub Actions deploy workflow | Add 3 GitHub Secrets; set Pages source to "GitHub Actions" | 30 min |
| **17** | Deploy + mobile verification | Enable Pages in GitHub repo settings | 20 min |

**Total estimated build time:** 9–11 hours across multiple sessions.

Each step ends in a commit. No step requires the following step to be in a working state.

---

## Step 1: Repo scaffold and .gitignore

**Files:**
- Create: `.gitignore`
- Create: `.env.example` (root — Worker secret names only)
- Create: `frontend/.env.example` (frontend VITE_* names only)
- Create all empty directories per the folder structure above (with `.gitkeep` files where needed)
- Update: `README.md` with project description

**User provides:** Nothing.

**Verification:** `git status` shows the expected structure; `git diff --cached` after staging shows no `.env*` files with real values.

---

## Step 2: Supabase schema migration

**Files:**
- Create: `supabase/migrations/001_initial_schema.sql`

**Tables created:**
- `households`: `id` (uuid pk), `name` (text), `created_at`
- `household_members`: `household_id` (fk→households), `user_id` (fk→auth.users), `created_at`, PRIMARY KEY (household_id, user_id)
- `items`: `id` (uuid pk), `household_id` (fk), `name` (text), `category` (text + CHECK constraint), `quantity` (integer default 1), `created_at`, `updated_at`
- `activity_log`: `id` (uuid pk), `household_id` (fk), `item_id` (fk nullable), `item_name_snapshot` (text), `user_id` (fk), `action` (text + CHECK), `quantity_delta` (integer nullable), `created_at`
- `pending_hauls`: `id` (uuid pk), `household_id` (fk), `user_id` (fk), `source` (text + CHECK: receipt, counter_photo), `status` (text + CHECK: parsing, ready, committed, failed), `photo_urls` (text[]), `parsed_items` (jsonb), `created_at`, `committed_at`
- `usage_meter`: `id` (uuid pk), `user_id` (fk), `date` (date), `parse_count` (integer default 0), `estimated_cost_usd` (numeric default 0)

RLS enabled on all tables. Policies: users can read/write rows where `household_id` IN (SELECT household_id FROM household_members WHERE user_id = auth.uid()).

Supabase Storage bucket: `haul-photos` (private).

**User provides:**
1. Confirm the category list is final (Produce, Dairy, Pantry, Frozen, Meat, Beverages, Household, Other)
2. Run the migration SQL in the Supabase SQL Editor
3. Create the `haul-photos` Storage bucket in the Supabase dashboard (Storage → New bucket → name: `haul-photos`, private)

**Verification:**
```sql
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;
SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';
```
Six tables returned; `rowsecurity = true` for all.

---

## Step 3: Supabase seed data

**Files:**
- Create: `supabase/migrations/002_seed_household.sql` (NOT committed with real UUIDs — add to .gitignore or run manually and discard)

**What gets created:** One `households` row named "Baller Household". Two `household_members` rows linking Dan and Abby's auth.users UUIDs to it.

**User provides:**
1. Dan's UUID: Supabase Dashboard → Authentication → Users → click Dan's row → copy UUID
2. Abby's UUID: same
3. Run the seed SQL manually in the SQL Editor (do not commit the file with real UUIDs)

**Verification:**
```sql
SELECT u.email, hm.household_id
FROM auth.users u
JOIN household_members hm ON u.id = hm.user_id;
```
Returns both emails with the same `household_id`.

---

## Step 4: Cloudflare Worker scaffold

**Files:**
- Create: `worker/wrangler.toml`
- Create: `worker/package.json`
- Create: `worker/src/index.js` — route dispatcher with stub handlers
- Create: `worker/src/auth.js` — empty placeholder

**What gets created:** A deployable Worker with:
- `GET /health` → `{ok: true, ts: <timestamp>}`
- `POST /parse-haul` → `{error: "not implemented"}` (stub)
- KV namespace binding for rate limiting

**User provides:**
1. Run: `cd worker && wrangler kv:namespace create RATE_LIMIT`
2. Copy the output namespace ID into `wrangler.toml` under `[[kv_namespaces]]`
3. Run: `wrangler deploy`
4. Note the `*.workers.dev` URL — needed for `frontend/.env.local` in Step 8

**Verification:** `curl https://<your-worker>.workers.dev/health` returns `{"ok":true}`.

---

## Step 5: Worker — JWT verification + allowlist middleware

**Files:**
- Modify: `worker/src/auth.js` — full JWT verification
- Modify: `worker/src/index.js` — apply `requireAuth()` to all routes except `/health`

**What gets created:** Every non-health request is validated: valid Supabase JWT (verified with SUPABASE_JWT_SECRET)? Email in the hardcoded allowlist? Reject with 401 otherwise. On success, attaches `{userId, email}` to the request context for downstream handlers.

**User provides:** Run these commands (you'll be prompted to paste each value):
```
cd worker
wrangler secret put SUPABASE_JWT_SECRET
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put ANTHROPIC_API_KEY
```
Values from: Supabase Dashboard → Settings → API. The JWT Secret is labeled "JWT Secret" (not the anon key).

**Verification:**
- `curl -X POST https://<worker>.workers.dev/parse-haul` (no token) → `401 Unauthorized`
- Get a real JWT: sign in to Supabase in a browser, then in the browser console run `(await supabase.auth.getSession()).data.session.access_token`. Use that token:
- `curl -X POST https://<worker>.workers.dev/parse-haul -H "Authorization: Bearer <token>"` → `{"error":"not implemented"}` (stub, but auth passed)

---

## Step 6: Worker — spend cap and rate limiting

**Files:**
- Create: `worker/src/spend-cap.js`
- Create: `worker/src/rate-limit.js`
- Modify: `worker/src/index.js` — apply spend cap + rate limit checks after auth, before route handler

**spend-cap.js:** Queries `usage_meter` via Supabase REST (`/rest/v1/usage_meter?user_id=eq.<id>&date=eq.<today>`) using the service_role key. If `estimated_cost_usd >= DAILY_SPEND_CAP_USD` (env var, default `0.50`), return `429 {"error": "Daily spend cap reached, try again tomorrow"}`.

**rate-limit.js:** KV sliding window. Key: `rate:<userId>:<current-hour-bucket>`. Stores count of requests in the current hour. If count >= 20, return `429` with `Retry-After: <seconds-until-next-hour>` header.

**User provides:** Optionally: `wrangler secret put DAILY_SPEND_CAP_USD` with value `0.50` (or just rely on the hardcoded default).

**Verification:**
- Manually insert a `usage_meter` row with `estimated_cost_usd = 0.51` for today's date → `POST /parse-haul` returns 429 spend cap error. Delete the row → proceeds to "not implemented."
- Use KV dashboard or wrangler to set a rate limit counter to 20 → next request returns 429 with Retry-After header.

---

## Step 7: Worker — /parse-haul endpoint (Anthropic integration)

**Files:**
- Create: `worker/src/parse-haul.js`
- Modify: `worker/src/index.js` — wire up real handler

**What gets created:**
1. Validate request body: `{haul_id}` present
2. Fetch the `pending_hauls` row; confirm it belongs to the requesting user's household (prevents IDOR)
3. Confirm `status == 'parsing'` (idempotency guard)
4. Download each photo from Supabase Storage using a signed URL (service_role key bypasses bucket auth)
5. Convert photos to base64 for Anthropic vision API
6. Call Anthropic Haiku (`claude-haiku-4-5-20251001`) with a few-shot system prompt + the receipt image(s)
7. Parse the JSON response into `[{name, category, quantity, confidence}]` — handle malformed responses gracefully (mark haul as `failed` with an error note in `parsed_items`)
8. Update `pending_hauls`: `status='ready'`, `parsed_items=[...]`
9. Write to `usage_meter`: increment `parse_count`, add estimated cost (calculate from input/output token counts in the API response)

**User provides:**
1. **Before starting this step:** gather 2–3 real receipts from stores Abby shops at (Whole Foods, Costco, Trader Joe's). The few-shot prompt examples will be written from these.
2. Nothing else (all secrets already set in Step 5).

**Verification:** End-to-end test:
1. Upload a real receipt to the `haul-photos` Supabase Storage bucket manually (Supabase dashboard → Storage)
2. Insert a `pending_hauls` row manually with `status='parsing'`, `photo_urls=['<storage-path>']`
3. Call `POST /parse-haul` with `{haul_id: "<id>"}` and a valid JWT
4. Confirm the `pending_hauls` row now has `status='ready'` and `parsed_items` is a non-empty array with reasonable item names
5. Confirm `usage_meter` has a new row for today

---

## Step 8: Frontend scaffold — Vite + Preact + PWA shell

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.js`
- Create: `frontend/index.html`
- Create: `frontend/.env.example`
- Create: `frontend/.env.local` (GITIGNORED — values filled by you, never committed)
- Create: `frontend/public/manifest.json`
- Create: `frontend/public/sw.js`
- Create: `frontend/public/icons/` (placeholder 192px and 512px PNGs)
- Create: `frontend/src/main.jsx`
- Create: `frontend/src/app.jsx` (hash router stub — renders "Inventory" placeholder)
- Create: `frontend/src/db.js` (Supabase client, reads `import.meta.env.VITE_*`)
- Create: `frontend/src/offline.js` (IndexedDB via idb — `getInventory()`, `setInventory()`)

**What gets created:** A runnable Vite + Preact app. `vite.config.js` uses `@preact/preset-vite`. `db.js` exports a single Supabase client instance constructed from `import.meta.env.VITE_SUPABASE_URL` and `import.meta.env.VITE_SUPABASE_ANON_KEY`. `app.jsx` reads `window.location.hash` to decide which screen to render (a pattern we'll expand in each screen step). `sw.js` caches the built app shell assets for offline load.

**User provides:**
1. Create `frontend/.env.local` with your local values:
   ```
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJ...
   VITE_WORKER_URL=https://your-worker.workers.dev
   ```
   (Supabase values: Dashboard → Settings → API. Worker URL: from Step 4.)
2. Two placeholder icon PNGs — any image resized to 192×192 and 512×512 works for now.

**Verification:**
```bash
cd frontend
npm install
npm run dev
```
Open `http://localhost:5173` in Chrome. DevTools → Application:
- Manifest tab: no errors, icons resolve
- Service Workers tab: worker registered
- Simulate offline (Network tab → Offline): page still loads from cache

---

## Step 9: Auth flow

**Files:**
- Create: `frontend/src/screens/SignIn.jsx`
- Modify: `frontend/src/app.jsx` — wrap all screen rendering in an auth guard; redirect to `#sign-in` if no session

**What gets created:** Sign-in screen with an email input. Submitting calls `supabase.auth.signInWithOtp({email})`. Shows a "Check your email" confirmation state. After the user clicks the magic link, Supabase redirects back to the app with the session token in the URL hash; the Supabase JS client handles parsing it automatically. Auth guard in `app.jsx` checks `supabase.auth.getSession()` on mount; if no session, renders `<SignIn />` regardless of hash. Session stored in localStorage by the Supabase client with a 1-year expiry.

**User provides:** Test by sending a real magic link to `danballer13@gmail.com`.

**Verification:**
- Open app without a session → Sign-in screen appears
- Enter email → "Check your email" message appears
- Click the magic link → redirected back to app, signed in, placeholder inventory screen visible
- Refresh the page → still signed in (no sign-in screen)
- Open an incognito window → sign-in screen (no session)

---

## Step 10: Inventory screen

**Files:**
- Create: `frontend/src/screens/Inventory.jsx`
- Create: `frontend/src/components/NavBar.jsx`
- Modify: `frontend/src/app.jsx` — wire up `#inventory` route + render NavBar

**What gets created:**
- On mount: check IndexedDB for cached inventory → render immediately if present. Then fetch from Supabase `items` table (RLS ensures only the user's household items return). Merge with cache and re-render.
- Display: items grouped by category (alphabetical within group). Each row: name, quantity, "−" button.
- Decrement "−" button: `UPDATE items SET quantity = quantity - 1, updated_at = now() WHERE id = ?`. Then insert into `activity_log` (action='decremented', quantity_delta=-1). Re-render the row optimistically.
- Search input: client-side filter on `name` (case-insensitive substring match).
- "Running Low" filter chip: toggles between showing all items and only items with `quantity <= 2`.
- After fetching from network, write full item list to IndexedDB via `offline.js`.
- When offline: load from IndexedDB; decrement button shows a disabled state with tooltip "Offline — changes will sync when reconnected." (Do not attempt offline writes in Phase 1.)

**User provides:** A few test items seeded in Supabase (manually insert 3–4 rows via the SQL editor, or use Manual Add in Step 11 first — do Step 11 before Step 10 if preferred).

**Verification:**
- Items appear grouped by category
- Search "milk" filters correctly; clearing search restores all items
- "Running Low" chip shows only items with qty ≤ 2
- Decrement button updates qty in Supabase and re-renders the row in place
- Simulate offline: items load from IndexedDB; decrement button is disabled

---

## Step 11: Manual add item

**Files:**
- Create: `frontend/src/screens/AddItem.jsx`
- Modify: `frontend/src/app.jsx` — wire up `#add-item` route
- Modify: `frontend/src/components/NavBar.jsx` — add "+" nav item

**What gets created:** Form with:
- Name (text input, required)
- Category (select with all 8 categories, required)
- Quantity (number input, default 1, min 1)

On submit: `INSERT INTO items (household_id, name, category, quantity)`. Then `INSERT INTO activity_log (action='added', item_name_snapshot=name, quantity_delta=quantity)`. On success: navigate to `#inventory`.

**User provides:** Nothing.

**Verification:** Add "Greek yogurt" category Dairy quantity 3. Navigate to Inventory → appears under Dairy with qty 3. Supabase Table Editor confirms the row.

---

## Step 12: Add Haul screen

**Files:**
- Create: `frontend/src/screens/AddHaul.jsx`
- Modify: `frontend/src/app.jsx` — wire up `#add-haul` route
- Modify: `frontend/src/components/NavBar.jsx` — add camera icon nav item

**What gets created:**
- Two buttons: "Receipt" (active) and "Counter photos" (disabled, with tooltip "Coming soon in Phase 2").
- Receipt flow: file input (`accept="image/*" capture="environment"`). On file select:
  1. Upload file to Supabase Storage bucket `haul-photos` at path `{userId}/{uuid}.jpg` using the Supabase storage client (anon key — bucket policies permit users to upload to their own path).
  2. `INSERT INTO pending_hauls (household_id, user_id, source='receipt', status='parsing', photo_urls=[path])`.
  3. `POST` to `VITE_WORKER_URL/parse-haul` with body `{haul_id}` and `Authorization: Bearer <access_token>`.
  4. Show a loading spinner while waiting for the Worker response.
  5. On success (Worker returns 200): navigate to `#hauls-inbox`.
  6. On error: display the error message from the Worker (spend cap, rate limit, parse failed).

**User provides:** A real receipt photo for testing.

**Verification:** Photograph a receipt. Loading spinner appears. After ~5–15 seconds, navigates to inbox. `pending_hauls` row in Supabase shows `status='ready'` with populated `parsed_items`.

---

## Step 13: Pending Hauls inbox

**Files:**
- Create: `frontend/src/screens/HaulsInbox.jsx`
- Modify: `frontend/src/app.jsx` — wire up `#hauls-inbox` route
- Modify: `frontend/src/components/NavBar.jsx` — add inbox nav item with badge for unreviewed count

**What gets created:** Fetches `pending_hauls` for the user's household ordered by `created_at DESC`. Displays each haul with:
- Source (Receipt / Counter photos)
- Status badge: "Parsing…" (spinner) / "Ready to review" / "Failed" / "Committed"
- Relative timestamp ("2 min ago")

Tapping a "ready" haul navigates to `#review-haul?id=<haul_id>`. "Failed" hauls show an error hint. "Committed" hauls are shown grayed out.

**User provides:** Nothing.

**Verification:** After uploading a receipt (Step 12), haul appears in inbox with "Ready to review" status. Tapping navigates to the Review Haul screen.

---

## Step 14: Review Haul screen

**Files:**
- Create: `frontend/src/screens/ReviewHaul.jsx`
- Modify: `frontend/src/app.jsx` — wire up `#review-haul` route (reads `?id=` from hash)

**What gets created:**
- Fetch the `pending_hauls` row by `id` from the URL hash.
- Render `parsed_items` as an editable list. Each row:
  - Name: text input (pre-filled from parsed value)
  - Category: select (pre-filled from parsed value, defaulting to "Other" if confidence is low)
  - Quantity: number input
  - Delete button (removes the row from local state only — not committed yet)
- "Commit all" button: for each remaining row in local state:
  - Check if an item with the same `name` + `category` already exists in `items` for this household
  - If exists: `UPDATE items SET quantity = quantity + <parsed_qty>, updated_at = now()`
  - If not: `INSERT INTO items (name, category, quantity)`
  - Insert into `activity_log` for each item (action='added' for inserts, action='edited' for increments)
  - `UPDATE pending_hauls SET status='committed', committed_at=now()`
  - Navigate to `#inventory`

**User provides:** Nothing.

**Verification:**
- Open a ready haul. Parsed items appear pre-filled.
- Edit one item name. Delete one junk item.
- Tap "Commit all."
- Navigate to Inventory — committed items appear with correct quantities.
- If a matching item already existed, its quantity is incremented (not overwritten).
- Activity feed (Step 15) shows the add/edit entries.

---

## Step 15: Activity Feed screen

**Files:**
- Create: `frontend/src/screens/Activity.jsx`
- Modify: `frontend/src/app.jsx` — wire up `#activity` route
- Modify: `frontend/src/components/NavBar.jsx` — add activity nav item

**What gets created:** Fetch `activity_log` for the user's household, ordered by `created_at DESC`, limit 100. Join on `user_id` to get the email (Supabase doesn't expose display names directly — derive "Dan" / "Abby" from the email prefix). Render reverse-chronological list. Each entry shows:
- User name (Dan / Abby)
- Action: "added Milk (qty 2)", "decremented Eggs", "committed haul (8 items)", etc.
- Relative timestamp ("3 min ago", "yesterday")

No realtime subscription — loads on mount only (Phase 2 will add live updates).

**User provides:** Nothing.

**Verification:** After adding items, decrementing, and committing a haul: all actions appear in the feed with correct user attribution and human-readable descriptions.

---

## Step 16: GitHub Actions deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

**What gets created:** A GitHub Actions workflow triggered on push to `main`. Steps:
1. Checkout repo
2. Setup Node.js
3. `npm install` in `frontend/`
4. `npm run build` in `frontend/` — Vite reads `VITE_*` env vars injected from GitHub Secrets
5. Deploy `frontend/dist/` to GitHub Pages using the official `actions/deploy-pages` action

**User provides:**
1. In GitHub repo Settings → Secrets and variables → Actions → New repository secret, add:
   - `VITE_SUPABASE_URL` — your Supabase project URL
   - `VITE_SUPABASE_ANON_KEY` — your Supabase anon key
   - `VITE_WORKER_URL` — your Worker's `*.workers.dev` URL
2. In GitHub repo Settings → Pages → Source: change to **"GitHub Actions"** (not a branch)

**Verification:** Push a trivial change to `main` (e.g., update README). Go to Actions tab — the `deploy` workflow should run and succeed. Pages deploys automatically. Visit the GitHub Pages URL to confirm the app loads.

---

## Step 17: Deploy + mobile verification ✅

**Files:** No new files — just testing.

**User provides:** Nothing new.

**Verification (on your actual phones):**
- Open the GitHub Pages URL in Chrome on Android or Safari on iOS
- Sign in with email + password
- On Android/Chrome: browser prompts "Add to Home Screen" or use browser menu
- On iOS/Safari: Share → "Add to Home Screen"
- Verify the app icon appears on the home screen
- Open the installed app — it should load in standalone mode (no browser chrome)
- Test the full haul flow on mobile: photograph a receipt → pending → review → commit → see in inventory
- Test offline: enable airplane mode → inventory still loads from IndexedDB

---

## Open Questions — Resolved

1. **Receipt parsing prompt:** Resolved during Step 7. Few-shot examples written from real receipts; post-processing normalizer added to Worker to strip brand prefixes and "Organic" prefix.
2. **Bucket policies for Supabase Storage:** Confirmed working — authenticated users can upload to their own `{userId}/*` path; Worker service_role key reads any path.

---

## What's Explicitly NOT in This Plan (Phase 2+)

- Counter photo ingestion (Sonnet path)
- Pantry audit mode
- "Mark out" decrement option
- Running Low as a dedicated screen (it's a filter chip in Phase 1)
- Realtime sync between phones
- Prompt caching for /parse-haul
- Usage/analytics screens beyond the basic Settings page

---

## Changes Made During Build

These are deviations from the original plan that reflect what was actually built.

### Authentication (Step 9) — Magic link replaced with email/password
**Original plan:** `signInWithOtp` magic link with `redirectTo` pointing back to the app.
**What happened:** Supabase magic link redirects don't work reliably for GitHub Pages project sub-paths (`/Household-Inventory/`). The redirect consistently landed at the root domain. After exhausting URL configuration options, switched to `signInWithPassword`. Public signups are disabled in Supabase; accounts created manually via the dashboard (SQL: `UPDATE auth.users SET encrypted_password = crypt('password', gen_salt('bf')) WHERE email = '...'`).

### JWT verification (Step 5) — ES256 via JWKS, not HS256
**Original plan:** Verify JWT using `SUPABASE_JWT_SECRET` (HS256).
**What happened:** Supabase projects use ES256. The Worker was rewritten to fetch the public key from `{SUPABASE_URL}/auth/v1/.well-known/jwks.json` and verify using `crypto.subtle.verify` with ECDSA/SHA-256. Keys are cached at module level.

### RLS policy (Step 2) — household_members simplified
**Original plan:** `household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())`.
**What happened:** This caused infinite recursion (`42P17`) on `household_members` itself (the policy queries the same table it protects). Fixed by changing the `household_members` policy to `USING (user_id = auth.uid())` directly.

### Inventory screen (Step 10) — Additional features added
Beyond the original plan:
- **Increment (+1) button** alongside the decrement button
- **Inline name editing** — pencil (✎) button; Enter to save, Escape to cancel, blur saves
- **Duplicate merge on rename** — if the new name matches an existing item, quantities are summed and the most recent `last_purchased_at` is kept
- **Delete button (🗑)** replaces the decrement button when quantity = 0
- **`last_purchased_at` display** — "Last bought: Apr 10" shown under item name; set on every add/increment

### Review Haul (Step 14) — "Add missing item" button
Added a "+ Add missing item" button that appends a blank editable row to the parsed items list, so items that weren't recognised in the receipt photo can be added before committing.

### Receipt parsing (Step 7) — Brand/Organic normalisation
Added post-processing `normalizeItemName()` function in the Worker that strips known brand prefixes (Kirkland, Vital Farms, 365 Whole Foods Market, etc.) and a leading "Organic" word from parsed item names. Also updated the few-shot prompt rules to instruct the model to use generic names. Both layers together produce consistently clean names.

### Add Haul (Step 12) — Two upload buttons
Added separate "Take Photo" (`capture="environment"`, opens camera) and "Upload Photo" (no `capture`, opens file picker) buttons. Both use the same upload handler.

### NavBar — Inlined into app.jsx
**Original plan:** `frontend/src/components/NavBar.jsx` as a separate component.
**What happened:** Nav bar rendered inline in `app.jsx`. The `components/` directory was not created.

### PWA icons — Designed pantry can icon
**Original plan:** Placeholder icons.
**What happened:** Designed a custom SVG icon (green background, white labelled can matching `#2d6a4f` theme colour). SVG source kept at `frontend/scripts/icon.svg`; PNGs generated via `sharp` script at `frontend/scripts/gen-icons.mjs`.

### PWA manifest and HTML paths — Relative paths required
**Original plan:** Absolute paths (`/icons/icon-192.png`, `start_url: "/"`).
**What happened:** Absolute paths resolve to the GitHub Pages root (`danielpballer.github.io/`) rather than the app sub-path. All paths changed to relative (`./`) in `manifest.json` and `index.html`. SW registration changed to `import.meta.env.BASE_URL + 'sw.js'`.
