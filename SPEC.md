# Household Inventory App — Spec

## Overview
A mobile-first PWA that lets two users (Dan and Abby) maintain a shared household inventory. Primary use cases: (1) quickly check what's at home while at the grocery store, (2) ingest new items from grocery hauls via photo parsing, (3) decrement items as they're used, (4) see what's running low.

The make-or-break UX requirement: **adding items must not require photographing each item individually.** If it's tedious, it won't get used.

## Users
- Dan (danballer13@gmail.com)
- Abby (danabbyballer@gmail.com)
- Single shared household. No other users in v1.

## Core User Stories

### At the store (read-mostly, fast, offline-tolerant)
- As Abby, I can open the app and instantly see what we have at home, even on bad cell signal.
- I can search/filter by category to answer "do we have yogurt?" in under 5 seconds.
- I can see a "running low" view showing everything at quantity ≤ 2.
- I can decrement an item if I realize we just used the last one (e.g., "actually we finished the milk this morning").
- I can see recent activity so I know if Dan already updated something.

### At home — ingesting a haul
- I can photograph a receipt OR lay items on the counter and take 2–3 photos.
- The app uploads photos immediately and parses them in the background.
- Parsed results land in a "pending hauls" inbox as drafts — I don't have to review right away.
- Later, I can open a pending haul, review the proposed item list, edit quantities/names/categories, remove junk, and commit it to inventory in one tap.

### At home — maintaining inventory
- I can decrement items three ways (we'll learn which sticks):
  1. Tap → −1 (fast path)
  2. Tap → "mark out" (sets to 0)
  3. "Pantry audit" mode — rapid tap-to-update across a category
- I can manually add an item that didn't come from a photo.
- I can edit any item's name, category, or quantity.

## Data Model

### `households`
- `id` (uuid, pk)
- `name` (text)
- `created_at`

### `users` (managed by Supabase Auth)
- Linked to a household via `household_members` join table.

### `items`
- `id` (uuid, pk)
- `household_id` (fk)
- `name` (text) — e.g., "Chobani yogurt"
- `category` (text) — Produce, Dairy, Pantry, Frozen, Meat, Beverages, Household, Other. Enforced via Postgres CHECK constraint. (Freezer removed — redundant with Frozen.)
- `quantity` (integer, default 1)
- `created_at`, `updated_at`

### `activity_log`
- `id` (uuid, pk)
- `household_id` (fk)
- `item_id` (fk, nullable — nullable so deletes don't orphan)
- `item_name_snapshot` (text) — preserved for display after item deletion
- `user_id` (fk)
- `action` (enum: added, decremented, marked_out, edited, deleted, audited)
- `quantity_delta` (integer, nullable)
- `created_at`

### `pending_hauls`
- `id` (uuid, pk)
- `household_id` (fk)
- `user_id` (fk)
- `source` (enum: receipt, counter_photo)
- `status` (enum: parsing, ready, committed, failed)
- `photo_urls` (text[])
- `parsed_items` (jsonb) — array of `{name, category, quantity, confidence}`
- `created_at`, `committed_at`

### `usage_meter` (for spend cap + rate limiting)
- `id` (uuid, pk)
- `user_id` (fk)
- `date` (date)
- `parse_count` (integer)
- `estimated_cost_usd` (numeric)

## Architecture

- **Frontend:** Preact PWA, built with Vite (no router library — hash-based routing in app.jsx). Service worker for offline caching of inventory list. IndexedDB mirror of inventory for instant load via `idb` library. Installable to home screen.
- **Hosting (frontend):** GitHub Pages.
- **Backend:** Cloudflare Workers (one Worker, multiple routes). Holds the Anthropic API key. All vision API calls proxied through here.
- **Database & Auth:** Supabase. Postgres + Supabase Auth (magic link email) + Realtime subscriptions (Phase 2: live activity feed sync between Dan's and Abby's phones).
- **Image storage:** Supabase Storage bucket for haul photos. Auto-delete after 30 days.

### Database Security (RLS)
- Row Level Security is enabled on all tables in the public schema (Supabase "automatic RLS" setting is on).
- Every table must have explicit RLS policies scoped to the user's household — a user can only read and write rows where `household_id` matches a household they belong to.
- RLS policies must be created as part of the schema migration, not added later. Tables without policies will be inaccessible from the frontend.
- The `service_role` key (used only in the Cloudflare Worker) bypasses RLS and should be used sparingly — only for operations that legitimately need cross-user access, like the spend cap meter.

### Secrets Management
- No secrets are ever committed to the repo. `.env` and `.env.*` files are gitignored.
- **Cloudflare Worker secrets** are managed via `wrangler secret put <NAME>` and stored in Cloudflare's secret store. Never placed in `wrangler.toml`. The Worker needs:
  - `ANTHROPIC_API_KEY` — Anthropic API key for vision calls
  - `SUPABASE_URL` — Supabase project URL
  - `SUPABASE_SERVICE_ROLE_KEY` — Supabase service_role key (used only for cross-user operations like the spend meter; all user-scoped queries go through the frontend with RLS)
  - `SUPABASE_JWT_SECRET` — used to verify JWTs on incoming requests
- **Frontend env vars** use Vite's standard `import.meta.env.VITE_*` pattern. These are non-sensitive but not committed to the repo — even "public-by-design" keys are kept out of git to avoid scraping bots and to enable env switching if staging is ever added:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY` (public by design — RLS enforces access control, but not committed)
  - `VITE_WORKER_URL` (the deployed Cloudflare Worker endpoint)
  - **Local dev:** values live in a gitignored `frontend/.env.local` file.
  - **Production:** GitHub Actions injects them from GitHub repository Secrets at Vite build time. No values are ever committed to the repo.
- A `frontend/.env.example` file is committed showing variable names with empty values so future-me knows what to set.
- The Anthropic API key has a hard monthly spend limit of $10 set in the Anthropic console as a last-resort cap, independent of the Worker's $0.50/day cap.

### Request flow for a photo parse
1. PWA uploads photo(s) to Supabase Storage.
2. PWA creates a `pending_hauls` row with status=`parsing`.
3. PWA calls Cloudflare Worker `/parse-haul` with the haul ID and JWT.
4. Worker verifies JWT, checks email allowlist, checks daily spend cap and per-user rate limit.
5. Worker fetches photos from Supabase Storage, calls Anthropic API (Haiku for receipts, Sonnet for counter photos), updates `pending_hauls` with parsed results and status=`ready`. Returns 200 to the PWA.
6. PWA receives the 200 response and navigates to the Pending Hauls inbox. (Phase 1: synchronous response. Phase 2: Worker returns 202 immediately and PWA subscribes to realtime status updates on the `pending_hauls` row.)

## Authentication & Authorization

- **Method:** Supabase Auth with **magic link to email**. No passwords.
- **Allowlist:** Only `danballer13@gmail.com` and `danabbyballer@gmail.com` can sign in. Enforced at the Cloudflare Worker: every API call re-verifies the email on the JWT against a hardcoded allowlist. (A Supabase Auth hook for signup rejection is unnecessary since public signups are disabled in the Supabase dashboard.)
- **Session persistence:** Supabase session stored in browser local storage, set to 1-year expiry with automatic refresh. After first sign-in on a device, the user never sees a login screen again unless they sign out or clear browser data.
- **JWT verification in Worker:** Every Worker request must include a valid Supabase JWT. Worker validates signature, checks expiry, checks email against allowlist. No valid token = 401, no Anthropic API call.

## Cost Controls (mandatory, in Worker)

### Hard daily spend cap
- Track estimated cost per day in `usage_meter` table.
- Estimate cost per call based on model + image count + rough token estimate.
- **If daily total ≥ $0.50, refuse all parse requests** with a clear error message ("Daily spend cap reached, try again tomorrow").
- Configurable via Worker env var `DAILY_SPEND_CAP_USD`.

### Per-user rate limit
- Max **20 photo parses per user per hour**, sliding window.
- Tracked in `usage_meter` or KV store on the Worker.
- Returns 429 with retry-after header when exceeded.

### Model selection (cost optimization)
- **Receipts → Claude Haiku 4.5.** Structured text, no need for Sonnet.
- **Counter photos → Claude Sonnet 4.6.** Visual reasoning matters.
- Target: under $1/week at normal usage (1–2 hauls/week).

## Screens

1. **Inventory (home screen)** — searchable, filterable list grouped by category. Each row: name, quantity, decrement button. Sticky "Running Low" filter chip at top.
2. **Running Low** — filtered view of items at quantity ≤ 2.
3. **Activity Feed** — reverse-chronological list of recent adds/decrements/edits with user attribution.
4. **Add Haul** — camera interface, choice of "receipt" or "counter photos," upload progress, redirects to inbox.
5. **Pending Hauls Inbox** — list of drafts awaiting review.
6. **Review Haul** — editable list of parsed items, per-row edit/delete, "Commit all" button.
7. **Pantry Audit** — category-by-category rapid update mode.
8. **Manual Add** — form to add an item without a photo.
9. **Settings** — sign out, view usage meter (today's parses + estimated spend).

## Build Phases

### Phase 1 — MVP (target: usable end-to-end)
- Supabase setup: schema, auth, magic link, allowlist
- Cloudflare Worker: JWT verification, spend cap, rate limit, `/parse-haul` endpoint
- PWA shell: install, service worker, offline inventory cache
- Inventory screen with search, filter, decrement
- Manual add
- Receipt photo ingestion → parse → pending haul → review → commit
- Activity feed
- Magic-link sign-in flow

### Phase 2 — Polish
- Counter photo ingestion (Sonnet path)
- Pantry audit mode
- "Mark out" decrement option
- Running Low view as a dedicated screen
- Realtime sync between Dan's and Abby's phones
- Prompt caching for the `/parse-haul` endpoint (reduces API costs once the parse flow is stable — the system prompt is identical across calls, making it a good caching candidate)

### Phase 3 — Later (explicitly out of scope for v1)
- "How long things last" analytics (requires the event log we're already building, so easy to add later)
- Par levels / auto-shopping-list generation
- Expiration tracking
- Family/multi-user expansion
- Barcode scanning fallback

## Decisions Resolved During Planning

- **Category list:** Produce, Dairy, Pantry, Frozen, Meat, Beverages, Household, Other. "Freezer" removed as redundant with Frozen. Confirmed.
- **Decrement to 0:** Items stay at quantity=0 and remain visible in the Running Low view. Not auto-deleted. User must explicitly remove.
- **Haul commit behavior:** When a parsed haul item matches an existing inventory item (same name + category), **increment** the existing quantity rather than overwrite it. Example: existing Milk qty=1 + haul Milk qty=2 → Milk qty=3.

## Open Questions to Resolve During Build

- **Receipt parsing prompt:** Needs a few-shot prompt with real examples from stores Abby shops at (Whole Foods, Costco, Trader Joe's). Dan will gather 2–3 sample receipts before Step 7 (parse-haul endpoint). Goal is to handle store-specific abbreviations (e.g., "CHOB PLN YGT 5.3OZ").

## Success Criteria
- Abby uses it for 2 consecutive weeks without prompting.
- Inventory screen loads in under 1 second on her phone at the store.
- A grocery haul goes from "photos taken" to "committed to inventory" in under 5 minutes of her time.
- Weekly Anthropic API spend stays under $1.
