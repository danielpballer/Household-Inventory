# Household Inventory App — Spec

## Overview
A mobile-first PWA that lets two users (Dan and Abby) maintain a shared household inventory. Primary use cases: (1) quickly check what's at home while at the grocery store, (2) ingest new items from grocery hauls via photo parsing, (3) increment/decrement items as they're bought or used, (4) see what's running low.

The make-or-break UX requirement: **adding items must not require photographing each item individually.** If it's tedious, it won't get used.

## Users
- Dan (danballer13@gmail.com)
- Abby (danabbyballer@gmail.com)
- Single shared household. No other users in v1.
- Signups are disabled in Supabase — accounts can only be created manually via the Supabase dashboard.

## Core User Stories

### At the store (read-mostly, fast, offline-tolerant)
- As Abby, I can open the app and instantly see what we have at home, even on bad cell signal.
- I can search/filter by category to answer "do we have yogurt?" in under 5 seconds.
- I can see a "running low" view showing everything at quantity ≤ 2.
- I can decrement an item if I realize we just used the last one (e.g., "actually we finished the milk this morning").
- I can see recent activity so I know if Dan already updated something.

### At home — ingesting a haul
- I can photograph a receipt (take a new photo or upload from my photo library).
- The app uploads the photo immediately and parses it in the background.
- Parsed results land in a "pending hauls" inbox as drafts — I don't have to review right away.
- Later, I can open a pending haul, review the proposed item list, edit quantities/names/categories, remove junk, add missing items, and commit it to inventory in one tap.

### At home — maintaining inventory
- I can increment (+1) or decrement (−1) any item directly from the inventory screen.
- When an item reaches quantity 0, the decrement button is replaced by a delete (🗑) button to remove the item entirely.
- I can tap the pencil (✎) button next to any item name to rename it inline.
  - If the new name matches an existing item, the two are merged: quantities are summed and the most recent `last_purchased_at` is kept.
- I can manually add an item that didn't come from a photo.

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
- `category` (text) — Produce, Dairy, Pantry, Frozen, Meat, Beverages, Household, Other. Enforced via Postgres CHECK constraint.
- `quantity` (integer, default 1)
- `last_purchased_at` (timestamptz, nullable) — set on every insert or increment; displayed as "Last bought: Apr 10" on the inventory screen
- `created_at`, `updated_at`

### `activity_log`
- `id` (uuid, pk)
- `household_id` (fk)
- `item_id` (fk, nullable — nullable so deletes don't orphan)
- `item_name_snapshot` (text) — preserved for display after item deletion
- `user_id` (fk)
- `action` (enum: added, decremented, edited, deleted)
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

- **Frontend:** Preact PWA, built with Vite (no router library — hash-based routing in app.jsx). Service worker for offline caching of inventory list. IndexedDB mirror of inventory for instant load via `idb` library. Installable to home screen. SW registered using `import.meta.env.BASE_URL` so the path is correct for both local dev and GitHub Pages.
- **Hosting (frontend):** GitHub Pages at `https://danielpballer.github.io/Household-Inventory/`. Built with `--base=/Household-Inventory/`. Manifest and HTML use relative paths (`./`) so the PWA install and icons work correctly under the sub-path.
- **Backend:** Cloudflare Workers (one Worker, multiple routes). Holds the Anthropic API key. All vision API calls proxied through here.
- **Database & Auth:** Supabase. Postgres + Supabase Auth (email/password) + Realtime subscriptions (Phase 2: live activity feed sync between Dan's and Abby's phones).
- **Image storage:** Supabase Storage bucket `haul-photos` (private). Auto-delete after 30 days.

### Database Security (RLS)
- Row Level Security is enabled on all tables in the public schema.
- Every table has explicit RLS policies scoped to the user's household — a user can only read and write rows where `household_id` matches a household they belong to.
- `household_members` policy uses `USING (user_id = auth.uid())` directly (not a subquery into itself) to prevent infinite recursion.
- The `service_role` key (used only in the Cloudflare Worker) bypasses RLS and is used only for operations that legitimately need cross-user access (spend cap meter, fetching haul photos for parsing).

### Secrets Management
- No secrets are ever committed to the repo. `.env` and `.env.*` files are gitignored.
- **Cloudflare Worker secrets** are managed via `wrangler secret put <NAME>`. The Worker needs:
  - `ANTHROPIC_API_KEY`
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
- **Frontend env vars** use Vite's `import.meta.env.VITE_*` pattern:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`
  - `VITE_WORKER_URL`
  - **Local dev:** values live in a gitignored `frontend/.env.local` file.
  - **Production:** GitHub Actions injects them from GitHub repository Secrets at Vite build time.
- The Anthropic API key has a hard monthly spend limit of $10 set in the Anthropic console.

### Request flow for a photo parse
1. PWA uploads photo to Supabase Storage.
2. PWA creates a `pending_hauls` row with `status='parsing'`.
3. PWA calls Cloudflare Worker `/parse-haul` with the haul ID and JWT.
4. Worker verifies JWT (ES256, via JWKS endpoint at `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`), checks email allowlist, checks daily spend cap and per-user rate limit.
5. Worker fetches photo from Supabase Storage, calls Anthropic Haiku, normalises item names (strips brand prefixes and leading "Organic"), updates `pending_hauls` with `status='ready'` and `parsed_items`. Returns 200 to the PWA.
6. PWA receives the 200 response and navigates to the Pending Hauls inbox.

## Authentication & Authorization

- **Method:** Supabase Auth with **email and password**. No magic links.
- **Account creation:** Disabled for public signups. Accounts for Dan and Abby are created manually via the Supabase dashboard (Authentication → Users → Add user).
- **Allowlist:** Only `danballer13@gmail.com` and `danabbyballer@gmail.com` can use the parse endpoint. Enforced at the Cloudflare Worker: every API call verifies the email on the JWT against a hardcoded allowlist.
- **Session persistence:** Supabase session stored in browser localStorage with automatic refresh. After first sign-in on a device, the user stays signed in unless they explicitly sign out or clear browser data.
- **JWT verification in Worker:** ES256 signature verified using the public key from Supabase's JWKS endpoint. Keys are cached in the Worker module for the lifetime of the Worker instance.

## Cost Controls (mandatory, in Worker)

### Hard daily spend cap
- Track estimated cost per day in `usage_meter` table.
- **If daily total ≥ $0.50, refuse all parse requests** with `{"error": "Daily spend cap reached, try again tomorrow"}`.
- Configurable via Worker env var `DAILY_SPEND_CAP_USD`.

### Per-user rate limit
- Max **20 photo parses per user per hour**, sliding window tracked in KV store.
- Returns 429 with `Retry-After` header when exceeded.

### Model selection
- **Receipts → Claude Haiku 4.5.** Structured text, no need for Sonnet.
- **Counter photos → Claude Sonnet 4.6** (Phase 2).
- Target: under $1/week at normal usage (1–2 hauls/week).

### Receipt parsing quality
- Few-shot system prompt with examples from real receipts.
- Post-processing `normalizeItemName()` in the Worker strips known brand prefixes (Kirkland, Vital Farms, 365, etc.) and leading "Organic" to produce clean generic names (e.g., "Kirkland Organic Butter" → "Butter").

## Screens

1. **Inventory (home screen)** — searchable list grouped by category. Each row: name (with ✎ edit button), last purchased date, quantity, −/+ buttons. Delete button (🗑) replaces − when quantity = 0. "Running Low" filter chip shows items at quantity ≤ 2.
2. **Activity Feed** — reverse-chronological list of recent adds/decrements/edits with user attribution.
3. **Add Haul** — two buttons: "Take Photo" (opens camera) and "Upload Photo" (opens file picker). Receipt tab active; Counter Photos tab disabled (Phase 2). Upload progress and parse spinner shown inline.
4. **Pending Hauls Inbox** — list of hauls with status badges (Parsing / Ready to review / Failed / Committed) and relative timestamps.
5. **Review Haul** — editable list of parsed items (name, category, quantity, delete). "+ Add missing item" button appends a blank row. "Commit" button merges into inventory.
6. **Add Item** — manual add form (name, category, quantity). Checks for existing item by name (case-insensitive) and increments quantity rather than creating a duplicate.
7. **Sign In** — email + password form. Displayed when no active session exists.

## Build Phases

### Phase 1 — MVP ✅ Complete
- Supabase setup: schema, auth, RLS
- Cloudflare Worker: JWT verification (ES256), spend cap, rate limit, `/parse-haul` endpoint with brand/Organic normalisation
- PWA shell: install to home screen, service worker, offline inventory cache
- Inventory screen: search, filter, increment/decrement, inline rename with merge, delete at zero, last purchased date
- Manual add with duplicate detection
- Receipt photo ingestion → parse → pending haul → review (with add missing item) → commit
- Activity feed
- Email/password sign-in
- GitHub Actions deploy to GitHub Pages

### Phase 2 — Polish
- Counter photo ingestion (Sonnet path)
- Pantry audit mode
- "Mark out" decrement option
- Running Low as a dedicated screen
- Realtime sync between Dan's and Abby's phones
- Prompt caching for the `/parse-haul` endpoint

### Phase 3 — Later (explicitly out of scope for v1)
- "How long things last" analytics
- Par levels / auto-shopping-list generation
- Expiration tracking
- Family/multi-user expansion
- Barcode scanning fallback

## Decisions Resolved During Build

- **Authentication:** Changed from magic link to email/password. Magic link redirects don't work reliably on GitHub Pages sub-paths; email/password is simpler for a two-person private app.
- **JWT algorithm:** Supabase uses ES256 (not HS256). Worker verifies using JWKS public key endpoint rather than the JWT secret.
- **RLS household_members policy:** Uses `user_id = auth.uid()` directly to prevent infinite recursion (a subquery into the same table caused a `42P17` error).
- **Category list:** Produce, Dairy, Pantry, Frozen, Meat, Beverages, Household, Other. "Freezer" removed as redundant with Frozen.
- **Decrement to 0:** Items stay at quantity=0 with a delete button (🗑). Not auto-deleted.
- **Haul commit behavior:** Matching items (same name, case-insensitive) are incremented, not overwritten.
- **Inline merge:** Renaming an item to match an existing item merges them (summed quantity, most recent last_purchased_at kept).
- **PWA paths:** `manifest.json` and `index.html` use relative paths (`./`) so start_url, icons, and the manifest link all resolve correctly under the `/Household-Inventory/` base path.

## Success Criteria
- Abby uses it for 2 consecutive weeks without prompting.
- Inventory screen loads in under 1 second on her phone at the store.
- A grocery haul goes from "photos taken" to "committed to inventory" in under 5 minutes of her time.
- Weekly Anthropic API spend stays under $1.
