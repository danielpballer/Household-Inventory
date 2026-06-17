/**
 * IndexedDB mirror of the inventory list via the `idb` library.
 *
 * Used to show inventory instantly on load (before the network response)
 * and to serve the inventory when the device is offline.
 *
 * Only the inventory item list is mirrored here. Activity feed, hauls,
 * and other data are always fetched from the network.
 */

import { openDB } from 'idb';

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

/** Returns all cached inventory items, or [] if the cache is empty. */
export async function getInventory() {
  try {
    const db = await getDB();
    return await db.getAll(STORE);
  } catch {
    return [];
  }
}

/** Replaces the entire inventory cache with the provided items array. */
export async function setInventory(items) {
  const db = await getDB();
  const tx = db.transaction(STORE, 'readwrite');
  await tx.store.clear();
  await Promise.all(items.map((item) => tx.store.put(item)));
  await tx.done;
}

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
