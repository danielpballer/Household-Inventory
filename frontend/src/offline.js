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
