# Grocery List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared, offline-capable grocery list to the Household Inventory PWA — build it from inventory items or custom entries, check items off in the store, and sync between both phones.

**Architecture:** A new `grocery_list_items` Supabase table (household-scoped, realtime) mirrored into IndexedDB. All mutations are optimistic and write locally first with a `_dirty` flag; a sync engine pushes dirty rows and pulls server rows with last-write-wins on `updated_at`. Check-off is a soft delete (`deleted_at`) purged after 1 day. A new "List" screen and nav tab present the list; the Inventory screen gains a cart button per row.

**Tech Stack:** Preact + hooks, Vite, `idb` (IndexedDB), Supabase JS (Postgres + Realtime + Auth), Cloudflare Workers (unaffected by this feature).

**Reference spec:** `docs/superpowers/specs/2026-06-17-grocery-list-design.md`

**Note on testing:** Per the spec, no automated test runner is introduced. Each task is verified with `npm run build` (from `frontend/`) and manual checks. Commit after each task.

---

## File Structure

- **Create:** `supabase/migrations/004_grocery_list.sql` — table, indexes, trigger, RLS, realtime enablement.
- **Modify:** `frontend/src/offline.js` — bump DB version to 2, add `grocery_list` object store + grocery row helpers.
- **Create:** `frontend/src/grocery-sync.js` — local-first mutations, push/pull/merge (LWW), purge, realtime subscribe, household-id cache.
- **Create:** `frontend/src/screens/GroceryList.jsx` — the List screen (add bar, rows, check-off animation, inline rename, quantity steppers).
- **Modify:** `frontend/src/app.jsx` — `#grocery` route + "List" nav tab in 5th position.
- **Modify:** `frontend/src/screens/Inventory.jsx` — cart button per row, on-list indicator, add-to-list handler.
- **Modify:** `frontend/src/app.css` — grocery list styles, check-off animation, cart button, 6-tab nav sizing.
- **Modify:** `SPEC.md` — document the feature.

---

## Task 1: Database migration

**Files:**
- Create: `supabase/migrations/004_grocery_list.sql`

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/004_grocery_list.sql` with this exact content:

```sql
-- ============================================================
-- 004_grocery_list.sql
-- Household Inventory — Grocery List feature
--
-- Run this in the Supabase SQL Editor (not via the CLI).
-- Idempotent: safe to re-run.
-- ============================================================

-- Grocery list items.
-- id is client-generated (crypto.randomUUID) so offline-created rows
-- already hold their final id — no temp-id remapping on sync.
-- deleted_at: soft-delete marker set on check-off so deletions sync
-- through the same path as edits. Purged client-side after 1 day.
CREATE TABLE IF NOT EXISTS grocery_list_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name          text NOT NULL,
  quantity      integer NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  item_id       uuid REFERENCES items(id) ON DELETE SET NULL,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS grocery_list_items_household_id_idx
  ON grocery_list_items(household_id);

CREATE INDEX IF NOT EXISTS grocery_list_items_created_at_idx
  ON grocery_list_items(created_at);

-- Reuse the shared trigger function defined in 001_initial_schema.sql.
DROP TRIGGER IF EXISTS grocery_list_items_updated_at ON grocery_list_items;
CREATE TRIGGER grocery_list_items_updated_at
  BEFORE UPDATE ON grocery_list_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Row Level Security: household-scoped CRUD, same pattern as items.
ALTER TABLE grocery_list_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view their household grocery list" ON grocery_list_items;
CREATE POLICY "Members can view their household grocery list"
  ON grocery_list_items FOR SELECT TO authenticated
  USING (
    household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Members can insert grocery list items" ON grocery_list_items;
CREATE POLICY "Members can insert grocery list items"
  ON grocery_list_items FOR INSERT TO authenticated
  WITH CHECK (
    household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Members can update their household grocery list" ON grocery_list_items;
CREATE POLICY "Members can update their household grocery list"
  ON grocery_list_items FOR UPDATE TO authenticated
  USING (
    household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Members can delete their household grocery list" ON grocery_list_items;
CREATE POLICY "Members can delete their household grocery list"
  ON grocery_list_items FOR DELETE TO authenticated
  USING (
    household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  );

-- Realtime: full row image (so RLS row filtering works on changes) and
-- add the table to the realtime publication. Guarded so re-runs don't error.
ALTER TABLE grocery_list_items REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'grocery_list_items'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE grocery_list_items;
  END IF;
END $$;
```

- [ ] **Step 2: Run the migration in Supabase**

Open the Supabase dashboard → SQL Editor → paste the file contents → Run.
Expected: "Success. No rows returned." Re-running must not error (idempotent).

- [ ] **Step 3: Verify the table exists**

In the SQL Editor run:
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'grocery_list_items' ORDER BY ordinal_position;
```
Expected: rows for `id, household_id, name, quantity, item_id, deleted_at, created_at, updated_at`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/004_grocery_list.sql
git commit -m "feat: add grocery_list_items table migration"
```

---

## Task 2: IndexedDB grocery store

**Files:**
- Modify: `frontend/src/offline.js`

- [ ] **Step 1: Bump the DB version and add the store**

In `frontend/src/offline.js`, change the constants and `getDB` upgrade. Replace:

```js
const DB_NAME = 'household-inventory';
const DB_VERSION = 1;
const STORE = 'inventory';

function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    },
  });
}
```

with:

```js
const DB_NAME = 'household-inventory';
const DB_VERSION = 2;
const STORE = 'inventory';
const GROCERY_STORE = 'grocery_list';

function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(GROCERY_STORE)) {
        db.createObjectStore(GROCERY_STORE, { keyPath: 'id' });
      }
    },
  });
}
```

- [ ] **Step 2: Add grocery row helpers**

Append to the end of `frontend/src/offline.js`:

```js
/** Returns all cached grocery rows (including soft-deleted), or [] if empty. */
export async function getGroceryList() {
  try {
    const db = await getDB();
    return await db.getAll(GROCERY_STORE);
  } catch {
    return [];
  }
}

/** Inserts or updates a single grocery row by id. */
export async function putGroceryRow(row) {
  const db = await getDB();
  await db.put(GROCERY_STORE, row);
}

/** Deletes a single grocery row by id. */
export async function deleteGroceryRow(id) {
  const db = await getDB();
  await db.delete(GROCERY_STORE, id);
}

/** Replaces the entire grocery cache with the provided rows array. */
export async function setGroceryList(rows) {
  const db = await getDB();
  const tx = db.transaction(GROCERY_STORE, 'readwrite');
  await tx.store.clear();
  await Promise.all(rows.map((row) => tx.store.put(row)));
  await tx.done;
}
```

- [ ] **Step 3: Build to verify no syntax errors**

Run (from `frontend/`): `npm run build`
Expected: build succeeds ("built in …").

- [ ] **Step 4: Commit**

```bash
git add frontend/src/offline.js
git commit -m "feat: add grocery_list IndexedDB store"
```

---

## Task 3: Sync engine

**Files:**
- Create: `frontend/src/grocery-sync.js`

- [ ] **Step 1: Write the sync module**

Create `frontend/src/grocery-sync.js` with this exact content:

```js
/**
 * Grocery list sync engine.
 *
 * Local-first: every mutation writes to IndexedDB immediately with a
 * `_dirty` flag and a fresh `updated_at`, then (if online) pushes to
 * Supabase. On reconnect / load, `sync()` pushes all dirty rows, then
 * pulls server rows and merges by last-write-wins on `updated_at`.
 *
 * Check-off is a soft delete (`deleted_at` set). `purge()` hard-deletes
 * rows whose `deleted_at` is older than 1 day, after both devices have
 * had time to sync the deletion.
 */

import { supabase } from './db.js';
import {
  getGroceryList,
  putGroceryRow,
  setGroceryList,
} from './offline.js';

const TABLE = 'grocery_list_items';
const PURGE_MS = 24 * 60 * 60 * 1000; // 1 day

let _householdId = null;

/** Fetches and caches the current user's household id. */
export async function getHouseholdId() {
  if (_householdId) return _householdId;
  const { data } = await supabase
    .from('household_members')
    .select('household_id')
    .single();
  _householdId = data?.household_id ?? null;
  return _householdId;
}

/** Strips local-only fields before sending a row to Supabase. */
function toPayload(row) {
  const { _dirty, ...rest } = row;
  return rest;
}

/**
 * Pure last-write-wins merge.
 * Starts from local rows (so dirty/unsynced rows survive), then for each
 * server row takes the newer copy — unless the local copy is still dirty,
 * in which case the local change is kept to be pushed.
 */
export function mergeRows(localRows, serverRows) {
  const byId = new Map();
  for (const r of localRows) byId.set(r.id, r);
  for (const s of serverRows) {
    const local = byId.get(s.id);
    if (!local) {
      byId.set(s.id, { ...s, _dirty: false });
      continue;
    }
    if (local._dirty) continue;
    if (new Date(s.updated_at) >= new Date(local.updated_at)) {
      byId.set(s.id, { ...s, _dirty: false });
    }
  }
  return [...byId.values()];
}

/**
 * Writes a row locally as dirty with a fresh updated_at, then attempts an
 * immediate push if online. Returns the locally-stored row.
 */
async function applyLocal(row) {
  const updated = { ...row, updated_at: new Date().toISOString(), _dirty: true };
  await putGroceryRow(updated);
  if (navigator.onLine) {
    const { error } = await supabase.from(TABLE).upsert(toPayload(updated));
    if (error) {
      console.error('Grocery sync failed:', error.message);
    } else {
      await putGroceryRow({ ...updated, _dirty: false });
    }
  }
  return updated;
}

/** Adds a new grocery row (custom or from inventory). */
export async function addItem({ name, item_id = null }) {
  const householdId = await getHouseholdId();
  const now = new Date().toISOString();
  return applyLocal({
    id: crypto.randomUUID(),
    household_id: householdId,
    name,
    quantity: 1,
    item_id,
    deleted_at: null,
    created_at: now,
  });
}

/** Renames an existing row. */
export async function renameItem(row, name) {
  return applyLocal({ ...row, name });
}

/** Sets quantity, floored at 1. */
export async function setQuantity(row, quantity) {
  return applyLocal({ ...row, quantity: Math.max(1, quantity) });
}

/** Soft-deletes a row (check-off). */
export async function checkOff(row) {
  return applyLocal({ ...row, deleted_at: new Date().toISOString() });
}

/** Pushes all dirty rows to Supabase; clears _dirty on success. */
export async function pushDirty() {
  const rows = await getGroceryList();
  const dirty = rows.filter((r) => r._dirty);
  if (dirty.length === 0) return;
  const { error } = await supabase.from(TABLE).upsert(dirty.map(toPayload));
  if (error) {
    console.error('Grocery push failed:', error.message);
    return;
  }
  for (const r of dirty) await putGroceryRow({ ...r, _dirty: false });
}

/** Pulls server rows and merges into the local cache (LWW). Returns merged rows. */
export async function pull() {
  const { data, error } = await supabase.from(TABLE).select('*');
  if (error) {
    console.error('Grocery pull failed:', error.message);
    return getGroceryList();
  }
  const local = await getGroceryList();
  const merged = mergeRows(local, data);
  await setGroceryList(merged);
  return merged;
}

/** Hard-deletes rows whose deleted_at is older than 1 day, server and local. */
export async function purge() {
  const cutoff = new Date(Date.now() - PURGE_MS).toISOString();
  if (navigator.onLine) {
    await supabase.from(TABLE).delete().not('deleted_at', 'is', null).lt('deleted_at', cutoff);
  }
  const rows = await getGroceryList();
  const keep = rows.filter((r) => !(r.deleted_at && r.deleted_at < cutoff));
  if (keep.length !== rows.length) await setGroceryList(keep);
}

/** Full sync: push dirty, pull+merge, purge. Returns merged rows. */
export async function sync() {
  await pushDirty();
  const merged = await pull();
  await purge();
  return merged;
}

/** Subscribes to realtime changes. `onChange` is called for any change. */
export function subscribeGrocery(onChange) {
  const channel = supabase
    .channel('grocery-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, onChange)
    .subscribe();
  return () => channel.unsubscribe();
}

/** Convenience: active (not soft-deleted) rows sorted oldest-first. */
export function activeRows(rows) {
  return rows
    .filter((r) => !r.deleted_at)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}
```

- [ ] **Step 2: Build to verify**

Run (from `frontend/`): `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/grocery-sync.js
git commit -m "feat: add grocery list sync engine"
```

---

## Task 4: Grocery List screen

**Files:**
- Create: `frontend/src/screens/GroceryList.jsx`
- Modify: `frontend/src/app.css` (append grocery styles)

- [ ] **Step 1: Write the screen**

Create `frontend/src/screens/GroceryList.jsx` with this exact content:

```jsx
import { useState, useEffect, useRef } from 'preact/hooks';
import {
  getGroceryList,
  addItem,
  renameItem,
  setQuantity,
  checkOff,
  sync,
  subscribeGrocery,
  pull,
  activeRows,
} from '../grocery-sync.js';

// Row with inline rename. The name input is always in the DOM (off-screen
// when not editing) so focus() works synchronously on tap — required for the
// iOS keyboard to open without a second tap. Mirrors Inventory's ItemRow.
function GroceryRow({ row, removing, onCheck, onRename, onQuantity }) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(row.name);
  const nameRef = useRef(null);

  function startEdit() {
    setDraft(row.name);
    setIsEditing(true);
    if (nameRef.current) {
      nameRef.current.readOnly = false;
      nameRef.current.focus();
      nameRef.current.select();
    }
  }

  function commit() {
    const trimmed = draft.trim();
    setIsEditing(false);
    if (trimmed && trimmed !== row.name) onRename(row, trimmed);
  }

  return (
    <div class={`grocery-row ${removing ? 'removing' : ''}`}>
      <button
        class="grocery-check"
        onClick={() => onCheck(row)}
        aria-label={`Check off ${row.name}`}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2.5 7.5l3 3 6-7"/>
        </svg>
      </button>

      <div class="grocery-name-wrap">
        <input
          ref={nameRef}
          type="text"
          class={`grocery-name-input ${isEditing ? '' : 'item-name-offscreen'}`}
          value={isEditing ? draft : row.name}
          readOnly={!isEditing}
          onInput={(e) => isEditing && setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (!isEditing) return;
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setIsEditing(false);
          }}
          onBlur={() => isEditing && commit()}
        />
        {!isEditing && <span class="grocery-name">{row.name}</span>}
        <button class="edit-name-btn" onClick={startEdit} aria-label={`Edit ${row.name}`} title="Edit name">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9.5 1.5l3 3-7 7L2 12l.5-2.5 7-7z"/>
            <path d="M8 3l3 3"/>
          </svg>
        </button>
      </div>

      <div class="item-controls">
        <button class="qty-btn" onClick={() => onQuantity(row, row.quantity - 1)} disabled={row.quantity <= 1} aria-label={`Decrease ${row.name}`}>−</button>
        <span class="item-qty">{row.quantity}</span>
        <button class="qty-btn" onClick={() => onQuantity(row, row.quantity + 1)} aria-label={`Increase ${row.name}`}>+</button>
      </div>
    </div>
  );
}

export function GroceryList() {
  const [rows, setRows] = useState([]);
  const [newName, setNewName] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [removingIds, setRemovingIds] = useState(() => new Set());

  async function refresh() {
    const all = await getGroceryList();
    setRows(activeRows(all));
  }

  // Initial load: show local cache instantly, then sync if online.
  useEffect(() => {
    (async () => {
      await refresh();
      if (navigator.onLine) {
        await sync();
        await refresh();
      }
    })();
  }, []);

  // Online/offline handling — sync when we regain connectivity.
  useEffect(() => {
    const onOnline = async () => { setOnline(true); await sync(); await refresh(); };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // Realtime: on any remote change, pull+merge and refresh.
  useEffect(() => {
    const unsubscribe = subscribeGrocery(async () => {
      await pull();
      await refresh();
    });
    return unsubscribe;
  }, []);

  async function handleAdd(e) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setNewName('');
    await addItem({ name });
    await refresh();
  }

  // Check-off: animate out, then soft-delete after the transition.
  function handleCheck(row) {
    setRemovingIds((prev) => new Set(prev).add(row.id));
    setTimeout(async () => {
      await checkOff(row);
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
      await refresh();
    }, 350);
  }

  async function handleRename(row, name) {
    await renameItem(row, name);
    await refresh();
  }

  async function handleQuantity(row, quantity) {
    await setQuantity(row, quantity);
    await refresh();
  }

  return (
    <div class="grocery">
      <div class="screen-header">
        <h2>Grocery List</h2>
      </div>

      <div class="grocery-body">
        {!online && (
          <div class="offline-banner">Offline — changes will sync when you're back online.</div>
        )}

        <form class="grocery-add" onSubmit={handleAdd}>
          <input
            type="text"
            class="grocery-add-input"
            placeholder="Add an item…"
            value={newName}
            onInput={(e) => setNewName(e.target.value)}
          />
          <button type="submit" class="grocery-add-btn" aria-label="Add item">+</button>
        </form>

        {rows.length === 0 ? (
          <div class="empty-state">
            <svg class="empty-state-icon" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="5" y="3" width="14" height="18" rx="2"/>
              <path d="M9 3.5h6V5H9zM8.5 10l1.5 1.5L13 8.5M8.5 15l1.5 1.5L13 13.5"/>
            </svg>
            <span>Your grocery list is empty. Add items here or tap the cart icon on the Inventory screen.</span>
          </div>
        ) : (
          rows.map((row) => (
            <GroceryRow
              key={row.id}
              row={row}
              removing={removingIds.has(row.id)}
              onCheck={handleCheck}
              onRename={handleRename}
              onQuantity={handleQuantity}
            />
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append grocery styles to `frontend/src/app.css`**

Add to the end of `frontend/src/app.css`:

```css
/* ============================================================
   Grocery List
   ============================================================ */
.grocery-body {
  padding: 16px;
}

.grocery-add {
  display: flex;
  gap: 8px;
  margin-bottom: 18px;
}

.grocery-add-input {
  flex: 1;
  padding: 10px 14px;
  border: 1.5px solid var(--border-input);
  border-radius: 10px;
  font-size: 0.9375rem;
  color: var(--ink);
  background: var(--surface);
  outline: none;
  transition: border-color var(--t), box-shadow var(--t);
  -webkit-appearance: none;
}

.grocery-add-input:focus {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px rgba(45, 106, 79, 0.08);
}

.grocery-add-btn {
  width: 44px;
  flex-shrink: 0;
  border: none;
  border-radius: 10px;
  background: var(--brand);
  color: #fff;
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
  transition: background var(--t);
}

.grocery-add-btn:hover {
  background: var(--brand-dark);
}

.grocery-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
  transition: opacity 0.3s ease, transform 0.3s ease;
}

.grocery-row.removing {
  opacity: 0;
  transform: translateX(12px);
}

.grocery-check {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 2px solid var(--border-input);
  background: none;
  color: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background var(--t), border-color var(--t), color var(--t);
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.grocery-check:hover {
  border-color: var(--brand);
}

.grocery-row.removing .grocery-check {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
}

.grocery-name-wrap {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  gap: 2px;
}

.grocery-name {
  flex: 1;
  font-size: 1rem;
  color: var(--ink);
  line-height: 1.4;
  word-break: break-word;
  overflow-wrap: break-word;
}

.grocery-row.removing .grocery-name {
  text-decoration: line-through;
  color: var(--ink-3);
}

.grocery-name-input {
  font-size: 1rem;
  font-weight: 400;
  color: var(--ink);
  border: 1.5px solid var(--brand);
  border-radius: 6px;
  padding: 3px 8px;
  width: 100%;
  outline: none;
  background: var(--surface);
  line-height: 1.4;
}
```

- [ ] **Step 3: Build to verify**

Run (from `frontend/`): `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/screens/GroceryList.jsx frontend/src/app.css
git commit -m "feat: add Grocery List screen"
```

---

## Task 5: Routing + nav tab

**Files:**
- Modify: `frontend/src/app.jsx`
- Modify: `frontend/src/app.css` (nav sizing for 6 tabs)

- [ ] **Step 1: Import the screen**

In `frontend/src/app.jsx`, add the import after the `Activity` import (line 9):

```js
import { GroceryList } from './screens/GroceryList.jsx';
```

- [ ] **Step 2: Add the nav tab in 5th position**

In `frontend/src/app.jsx`, insert this anchor between the `#hauls-inbox` anchor and the `#activity` anchor (i.e. after the closing `</a>` of the Inbox link, before the Activity `<a>`):

```jsx
        <a href="#grocery" class={route === '#grocery' ? 'active' : ''}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="4" y="3" width="12" height="15" rx="1.5"/>
            <path d="M7.5 3.5h5V5h-5z"/>
            <path d="M7 9l1.3 1.3L11 7.5M7 13l1.3 1.3L11 11.5"/>
          </svg>
          <span>List</span>
        </a>
```

- [ ] **Step 3: Add the route**

In `frontend/src/app.jsx`, in the `Screen` function, add this line after the `#activity` route line:

```jsx
  if (route === '#grocery') return <GroceryList session={session} />;
```

- [ ] **Step 4: Tighten nav sizing for 6 tabs**

In `frontend/src/app.css`, change the `.nav-bar a` rule's horizontal padding and font so six tabs fit at the 480px max width. Replace:

```css
  gap: 3px;
  padding: 8px 4px 10px;
  min-height: 56px;
  font-size: 11px;
```

with:

```css
  gap: 3px;
  padding: 8px 2px 10px;
  min-height: 56px;
  font-size: 10px;
```

- [ ] **Step 5: Build to verify**

Run (from `frontend/`): `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Manual check**

Run (from `frontend/`): `npm run dev`, open the local URL, sign in.
Expected: a "List" tab appears 5th in the bottom nav (Inventory · + Item · + Haul · Inbox · List · Activity). Tapping it shows the Grocery List screen with the add bar and empty state. All six labels fit without wrapping.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app.jsx frontend/src/app.css
git commit -m "feat: wire up Grocery List route and nav tab"
```

---

## Task 6: Inventory cart button + on-list indicator

**Files:**
- Modify: `frontend/src/screens/Inventory.jsx`
- Modify: `frontend/src/app.css` (cart button styles)

- [ ] **Step 1: Import grocery helpers**

In `frontend/src/screens/Inventory.jsx`, add after the existing `offline.js` import (line 3):

```js
import { getGroceryList, addItem, subscribeGrocery, pull } from '../grocery-sync.js';
```

- [ ] **Step 2: Add the cart button to `ItemRow`**

In `ItemRow`, update the signature to accept the new props. Replace:

```jsx
function ItemRow({ item, isEditing, editingName, setEditingName, onStartEdit, onCancelEdit, onSaveEdit, onUpdateQuantity, onDeleteItem, onChangeCategory, online }) {
```

with:

```jsx
function ItemRow({ item, isEditing, editingName, setEditingName, onStartEdit, onCancelEdit, onSaveEdit, onUpdateQuantity, onDeleteItem, onChangeCategory, onAddToList, isOnList, online }) {
```

Then, in `ItemRow`'s returned JSX, add the cart button immediately after the edit pencil button's closing `</button>` (the one inside `item-name-row`, after the `</svg>`-containing edit button). Insert:

```jsx
          {online && (
            <button
              class={`add-list-btn ${isOnList ? 'on' : ''}`}
              onClick={() => !isOnList && onAddToList(item)}
              aria-label={isOnList ? `${item.name} is on the grocery list` : `Add ${item.name} to grocery list`}
              title={isOnList ? 'On the grocery list' : 'Add to grocery list'}
            >
              <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="6.5" cy="15" r="1"/>
                <circle cx="13.5" cy="15" r="1"/>
                <path d="M1.5 2h2l1.8 9h8.2l1.5-6.5H4.2"/>
                {isOnList && <path d="M7 6l1.5 1.5L11.5 4" stroke-width="1.8"/>}
              </svg>
            </button>
          )}
```

- [ ] **Step 3: Track on-list item ids in `Inventory`**

In the `Inventory` component, add state after the existing `categoryFilter` state line:

```js
  const [onListIds, setOnListIds] = useState(() => new Set());
```

Add this effect after the existing realtime `useEffect` (the one that subscribes to `inventory-sync`):

```js
  useEffect(() => {
    async function refreshOnList() {
      const all = await getGroceryList();
      setOnListIds(new Set(all.filter((r) => !r.deleted_at && r.item_id).map((r) => r.item_id)));
    }
    refreshOnList();
    const unsubscribe = subscribeGrocery(async () => {
      await pull();
      await refreshOnList();
    });
    return unsubscribe;
  }, []);
```

- [ ] **Step 4: Add the add-to-list handler**

In `Inventory`, add this function alongside the other handlers (e.g. after `changeCategory`):

```js
  async function addToList(item) {
    if (onListIds.has(item.id)) return;
    setOnListIds((prev) => new Set(prev).add(item.id));
    await addItem({ name: item.name, item_id: item.id });
  }
```

- [ ] **Step 5: Pass the new props to `ItemRow`**

In the `ItemRow` render call, add the two new props alongside the existing ones (e.g. after `onChangeCategory={changeCategory}`):

```jsx
                onAddToList={addToList}
                isOnList={onListIds.has(item.id)}
```

- [ ] **Step 6: Add cart button styles to `frontend/src/app.css`**

Append to the end of `frontend/src/app.css`:

```css
/* Add-to-grocery-list button (inventory rows) */
.add-list-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  background: none;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  color: var(--ink-3);
  transition: color var(--t), background var(--t);
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.add-list-btn:hover {
  color: var(--brand);
  background: var(--brand-bg);
}

.add-list-btn.on {
  color: var(--brand);
  background: var(--brand-bg);
  cursor: default;
}
```

- [ ] **Step 7: Build to verify**

Run (from `frontend/`): `npm run build`
Expected: build succeeds.

- [ ] **Step 8: Manual check**

Run `npm run dev`. On the Inventory screen, each row shows a cart button next to the pencil. Tapping it turns it green; the item appears on the List screen. Re-tapping the green cart does nothing (no duplicate on the list).

- [ ] **Step 9: Commit**

```bash
git add frontend/src/screens/Inventory.jsx frontend/src/app.css
git commit -m "feat: add to grocery list from inventory rows"
```

---

## Task 7: Update SPEC.md

**Files:**
- Modify: `SPEC.md`

- [ ] **Step 1: Add the data model entry**

In `SPEC.md`, after the `### pending_hauls` block (ends before `### usage_meter`), insert:

```markdown
### `grocery_list_items`
- `id` (uuid, pk) — client-generated so offline-created rows keep their id
- `household_id` (fk)
- `name` (text)
- `quantity` (integer, default 1, CHECK ≥ 1)
- `item_id` (fk → items, nullable) — set when added from inventory; null for custom items
- `deleted_at` (timestamptz, nullable) — soft-delete set on check-off; purged after 1 day
- `created_at`, `updated_at`
```

- [ ] **Step 2: Add the screen description**

In `SPEC.md`, in the `## Screens` list, add a new numbered entry after the Activity Feed entry:

```markdown
8. **Grocery List** — a flat shopping list, shared and realtime, that works fully offline. Each row has a check-off circle, the item name (inline-renamable via pencil), and −/+ quantity steppers (min 1). An add bar at the top creates custom items. Checking an item off strikes it through, fades it out, and removes it (soft-delete). Items are added from the Inventory screen via a cart button, or typed in directly here. Independent of inventory — checking off does not change inventory quantities.
```

- [ ] **Step 3: Document the nav order and offline model**

In `SPEC.md`, in the Architecture section's Frontend bullet, append this sentence:

```markdown
 The bottom nav has six tabs: Inventory · + Item · + Haul · Inbox · List · Activity. The Grocery List is mirrored to IndexedDB and uses an optimistic, last-write-wins sync engine (`grocery-sync.js`) so it is fully usable offline; all other writes still require connectivity.
```

- [ ] **Step 4: Add to build phases**

In `SPEC.md`, under `### Phase 2 — Polish`, add:

```markdown
- Grocery list (shared, offline-capable, add-from-inventory, check-off) ✅
```

- [ ] **Step 5: Commit**

```bash
git add SPEC.md
git commit -m "docs: document grocery list feature in SPEC"
```

---

## Task 8: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Production build**

Run (from `frontend/`): `npm run build`
Expected: build succeeds with no errors.

- [ ] **Step 2: Manual verification checklist**

Run `npm run dev` and verify each:
1. Add an item from Inventory → appears on the List; cart turns green.
2. Re-tap the green cart → no duplicate, no change.
3. Add a custom item via the add bar → appears with quantity 1.
4. Quantity −/+ → floors at 1; never reaches 0.
5. Rename a list entry inline → persists; on mobile the keyboard opens on first tap.
6. Check off an item → strikes through, fades, removed from the list.
7. Two-device sync (online): a change on one device appears on the other within ~1s.
8. Offline: in browser devtools set Network to Offline. Add / check / rename / change quantity — all work locally and the "Offline — changes will sync" banner shows. Set back to Online — changes sync and match on the second device.
9. On-list cart state survives a reload (reflects current list membership).

- [ ] **Step 3: Push the branch**

```bash
git push
```

---

## Self-Review Notes

- **Spec coverage:** independent check-off (Task 1 schema + Task 4 handler), name+quantity (Task 4), flat list ordered by created_at (`activeRows`, Task 3), custom add (Task 4), add-from-inventory with no-op re-add + on-list indicator (Task 6), check-off strike-through→remove (Task 4 `handleCheck` + CSS), inline rename (Task 4 `GroceryRow`), full offline + LWW sync + soft-delete + purge (Tasks 2–3), realtime (Tasks 3–4, 6), nav 5th position (Task 5), activity feed excluded (no activity_log writes anywhere), manual testing (Task 8), SPEC update (Task 7). All covered.
- **Type/name consistency:** sync exports (`addItem`, `renameItem`, `setQuantity`, `checkOff`, `sync`, `pull`, `subscribeGrocery`, `activeRows`, `getHouseholdId`, `mergeRows`, `pushDirty`, `purge`) and offline exports (`getGroceryList`, `putGroceryRow`, `deleteGroceryRow`, `setGroceryList`) are referenced consistently across Tasks 3, 4, and 6. `deleteGroceryRow` is defined for completeness though the soft-delete flow doesn't call it directly.
- **No placeholders:** every code step contains complete code.
```
