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
    // Adopt the server-written row so our local updated_at matches the value
    // the DB trigger set — keeps last-write-wins converging on server time.
    const { data, error } = await supabase.from(TABLE).upsert(toPayload(updated)).select().single();
    if (error) {
      console.error('Grocery sync failed:', error.message);
    } else {
      await putGroceryRow({ ...data, _dirty: false });
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
  const { data, error } = await supabase.from(TABLE).upsert(dirty.map(toPayload)).select();
  if (error) {
    console.error('Grocery push failed:', error.message);
    return;
  }
  // Adopt the server-written rows (canonical updated_at) and clear _dirty.
  await Promise.all((data ?? []).map((r) => putGroceryRow({ ...r, _dirty: false })));
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
    const householdId = await getHouseholdId();
    await supabase.from(TABLE).delete()
      .eq('household_id', householdId)
      .not('deleted_at', 'is', null)
      .lt('deleted_at', cutoff);
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
