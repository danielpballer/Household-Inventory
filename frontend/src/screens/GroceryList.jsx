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
