# Grocery List — Design Spec

**Date:** 2026-06-17
**Status:** Approved for planning
**Feature:** A shared grocery list, used in-store, that works fully offline and syncs between Dan's and Abby's phones.

## Overview

Add a Grocery List feature to the Household Inventory PWA. Users build a shopping list by tapping a button on inventory items they need and/or by typing in custom items not tracked in inventory. In the store, they check items off as they put them in the cart; checked-off items are removed from the list. Because it is used where cell signal is poor, the list works fully offline — adds, edits, quantity changes, and check-offs all succeed offline and reconcile when connectivity returns.

The grocery list is **independent** of inventory: checking an item off does not change inventory quantities. Restocking inventory continues to happen through the existing Haul (receipt/counter photo) flow.

## Goals

- Build a shopping list from inventory items in one tap.
- Add ad-hoc items that aren't in inventory.
- Check items off in the store, removing them from the list.
- Rename and adjust quantity of list entries inline.
- Full offline use with automatic sync between both phones.

## Non-Goals

- Feeding check-offs back into inventory quantities (explicitly independent).
- Categorizing or grouping the list (flat list only).
- Logging grocery actions to the Activity feed.
- Multi-list support, sharing outside the household, or store/aisle metadata.

## User Decisions (resolved during brainstorming)

| Decision | Choice |
|---|---|
| Check-off vs inventory | Independent — check-off only removes from the list |
| Entry shape | Name + quantity (−/+ steppers, min 1) |
| List organization | Flat list, ordered by creation (newest at bottom) |
| Custom items | Name only (quantity defaults to 1); no category |
| Re-adding an inventory item already on the list | No-op; button shows green "on list" state |
| Add-to-list button placement | In the inventory row's name row, next to the edit pencil |
| Check-off UX | Strike-through + dim, then fade out and remove |
| Inline rename of list entries | Yes — pencil + inline edit, matching inventory |
| Offline behavior | Full offline with sync |
| Sync engine | Row-state, last-write-wins (LWW) |
| Deletion mechanism | Soft delete (`deleted_at`) + 1-day purge |
| Activity feed | Grocery actions excluded |
| Testing | Manual verification (no test runner introduced) |
| Nav placement | New "List" tab, 5th position: Inventory · + Item · + Haul · Inbox · **List** · Activity |

## Data Model

New table `grocery_list_items`:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | **Client-generated** (`crypto.randomUUID()`) so offline-created rows already hold their final ID — no temp-ID remapping on sync. |
| `household_id` | uuid NOT NULL FK → households(id) ON DELETE CASCADE | Household-scoped, like every table. |
| `name` | text NOT NULL | |
| `quantity` | integer NOT NULL DEFAULT 1 | `CHECK (quantity >= 1)` |
| `item_id` | uuid NULL FK → items(id) ON DELETE SET NULL | Set when added from inventory; null for custom items. Powers the "on list" indicator and dedup. |
| `deleted_at` | timestamptz NULL | Soft-delete marker set on check-off so the deletion syncs uniformly. |
| `created_at` | timestamptz NOT NULL DEFAULT now() | List ordering. |
| `updated_at` | timestamptz NOT NULL DEFAULT now() | Auto-bumped by the existing `update_updated_at_column()` trigger; the LWW comparison key. |

Migration file: `supabase/migrations/004_grocery_list.sql`, following the conventions in `001_initial_schema.sql`:
- `CREATE TABLE IF NOT EXISTS` (idempotent).
- Index on `household_id`; index on `created_at` for ordering.
- `updated_at` trigger reusing `update_updated_at_column()`.
- Enable RLS; four household-scoped policies (SELECT / INSERT / UPDATE / DELETE) using the standard `household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())` pattern.
- Realtime: `REPLICA IDENTITY FULL` and add the table to the `supabase_realtime` publication (the user runs this SQL in the Supabase SQL editor, as with prior realtime tables).

## Offline + Sync Engine

### Local store
Extend `frontend/src/offline.js`:
- Bump `DB_VERSION` from 1 to 2.
- In `upgrade`, add a `grocery_list` object store (`keyPath: 'id'`). The existing `inventory` store is preserved.
- Grocery rows in IndexedDB carry two local-only fields: `_dirty` (boolean — has an un-pushed local change) and the standard `updated_at` (used as the LWW key).

### New module `frontend/src/grocery-sync.js`
Responsibilities:

1. **Optimistic local writes.** Every mutation writes to IndexedDB immediately, sets `_dirty = true`, and bumps the local `updated_at`:
   - Add (from inventory or custom): insert a row with a client UUID.
   - Rename: update `name`.
   - Quantity ±: update `quantity` (floor at 1).
   - Check off: set `deleted_at = now()`.
   When online, the same mutation is also sent to Supabase right away; offline, it stays dirty for the next flush.

2. **Push (on reconnect and on app load).** Find all `_dirty` rows, `upsert` them to Supabase (`id, household_id, name, quantity, item_id, deleted_at, updated_at`), and clear `_dirty` on success. Failed pushes keep `_dirty` for the next attempt.

3. **Pull + merge (LWW).** Fetch all server rows for the household. Merge by `id`: for each row, keep whichever side has the greater `updated_at`. A locally `_dirty` row that is newer than the server copy is preserved (it will be pushed). Write the merged set to IndexedDB and update UI state.

4. **Realtime.** When online, subscribe to `postgres_changes` on `grocery_list_items` (INSERT / UPDATE / DELETE), same pattern as `Inventory.jsx`, to keep both phones live. UPDATE events that carry a non-null `deleted_at` remove the row from view.

5. **Purge.** On app load, hard-`DELETE` server rows where `deleted_at < now() - interval '1 day'`, and drop the corresponding local rows. The 1-day delay guarantees both devices have already synced the soft-delete before the row is physically removed.

### UI consequence
The Grocery List page is fully interactive offline — no "changes disabled" banner. When `navigator.onLine` is false, show a subtle "Offline — changes will sync" hint instead.

## Screens & Components

### New: `frontend/src/screens/GroceryList.jsx`
- Header: "Grocery List".
- Add bar: text input ("Add an item…") + green `+` button. Submitting inserts a custom row (name, quantity 1, `item_id` null).
- Flat list ordered by `created_at`. Each row:
  - Check-off circle (left). Tapping animates strike-through + dim, then removes (sets `deleted_at`).
  - Name, with an edit pencil for inline rename (reuse the off-screen-input pattern from `Inventory.jsx` so the mobile keyboard opens synchronously on tap).
  - Quantity steppers (−/+, min 1) on the right.
- Empty state when the list has no active rows.

### Modified: `frontend/src/screens/Inventory.jsx`
- In `ItemRow`, add a cart button in the name row, immediately after the edit pencil.
- The button reflects an **on-list** state: green/filled when a `grocery_list_items` row with `item_id === item.id` (and `deleted_at` null) exists; otherwise the default outline.
- Tapping when not on the list adds the item (name + `item_id`, quantity 1). Tapping when already on the list is a no-op.
- Inventory needs awareness of current grocery-list membership — a set of `item_id`s on the list, sourced from `grocery-sync` (kept current via the same realtime/local state).

### Modified: `frontend/src/app.jsx`
- Add route `#grocery` → `<GroceryList session={session} />`.
- Add the "List" nav tab in 5th position with a checklist/clipboard icon (distinct from the cart icon used for the add-to-list action). Final order: Inventory · + Item · + Haul · Inbox · List · Activity.

### Modified: `frontend/src/app.css`
- Grocery list row, check-off circle (default + done states), strike-through/fade-out animation, add bar, offline hint.
- Cart button styles (default + on-list green state) in the inventory name row.
- Nav adjustments to accommodate 6 tabs at the 480px max width (smaller label sizing / spacing as needed).

### Modified: `SPEC.md`
- Document the Grocery List screen, the `grocery_list_items` table, the offline-sync model, and the new nav order. Add the feature to the appropriate build phase.

## Data Flow Examples

**Add from inventory (online):** Tap cart on "Milk" → `grocery-sync.add({name:'Milk', item_id})` writes locally (`_dirty`) and upserts to Supabase → realtime echoes to the other phone → cart shows green on both.

**Check off (offline):** Tap circle on "Bananas" → `deleted_at` set locally, row animates out, `_dirty` stays true → later, signal returns → push upserts the soft-deleted row → other phone's realtime UPDATE hides it → next day, purge hard-deletes it.

**Concurrent quantity edit (offline, both phones):** Each sets a different quantity offline. On reconnect, both push; the upsert with the later `updated_at` wins. Acceptable for a two-person list.

## Error Handling

- **Failed push:** row keeps `_dirty`; retried on next reconnect/app load. No user-facing error for transient network failures.
- **Upsert against a row the other person already purged:** re-creates the row (rare; only if one device sat offline for >1 day after a delete). Acceptable edge case.
- **Quantity floor:** decrement stops at 1; removing an item is done via check-off, not by decrementing to 0.
- **RLS / auth failure:** surfaces as a console error and leaves the row dirty; consistent with how `Inventory.jsx` handles write failures today.

## Testing (manual)

No test runner is introduced. Verification checklist:
1. Add an item from inventory → appears on the list; cart turns green.
2. Re-tap the green cart → no duplicate, no change.
3. Add a custom item via the add bar → appears with quantity 1.
4. Adjust quantity with −/+ → floors at 1.
5. Rename a list entry inline → persists; keyboard opens on first tap (mobile).
6. Check off an item → strike-through, fade, removed.
7. Two-phone sync (online): changes on one appear on the other within a second.
8. Offline scenario: enable airplane mode, add/check/rename/quantity, confirm all work locally; re-enable, confirm everything syncs and matches on the second phone.
9. Purge: a checked-off item is gone from the table after the 1-day window (or via a temporarily shortened interval during testing).

## Files Touched

- **New:** `frontend/src/screens/GroceryList.jsx`
- **New:** `frontend/src/grocery-sync.js`
- **New:** `supabase/migrations/004_grocery_list.sql`
- **Modified:** `frontend/src/offline.js` (add `grocery_list` store, bump DB version)
- **Modified:** `frontend/src/app.jsx` (route + 5th nav tab)
- **Modified:** `frontend/src/screens/Inventory.jsx` (cart button, on-list indicator, add handler)
- **Modified:** `frontend/src/app.css` (list styles, cart button, 6-tab nav)
- **Modified:** `SPEC.md` (document the feature)
