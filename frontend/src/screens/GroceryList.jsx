import { useState, useEffect, useRef } from 'preact/hooks';
import { supabase } from '../db.js';
import { getInventory } from '../offline.js';
import {
  getGroceryList,
  addItem,
  renameItem,
  setQuantity,
  checkOff,
  restoreItem,
  reorderItem,
  orderOf,
  sync,
  subscribeGrocery,
  pull,
  activeRows,
} from '../grocery-sync.js';

// Row with inline rename. The name input is always in the DOM (off-screen
// when not editing) so focus() works synchronously on tap — required for the
// iOS keyboard to open without a second tap. Mirrors Inventory's ItemRow.
function GroceryRow({ row, removing, dragging, onCheck, onRename, onQuantity, onDragStart, onDragMove, onDragEnd }) {
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
    <div class={`grocery-row ${removing ? 'removing' : ''} ${dragging ? 'dragging' : ''}`} data-id={row.id}>
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
        <button
          class="drag-handle"
          aria-label={`Reorder ${row.name}`}
          title="Drag to reorder"
          onPointerDown={(e) => onDragStart(e, row)}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true">
            <path d="M3 5h10M3 8h10M3 11h10"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

export function GroceryList() {
  const [rows, setRows] = useState([]);
  const [newName, setNewName] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [removingIds, setRemovingIds] = useState(() => new Set());
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [invItems, setInvItems] = useState([]);
  const [lastChecked, setLastChecked] = useState(null);
  const [dragId, setDragId] = useState(null);
  const mountedRef = useRef(true);
  const dragRef = useRef(null); // { id, startIndex } while a drag is active
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Inventory for the add-bar suggestions: cached mirror first (instant,
  // works offline), then a fresh fetch when online. State only — the
  // Inventory screen owns writing the IndexedDB mirror.
  useEffect(() => {
    (async () => {
      const cached = await getInventory();
      if (mountedRef.current) setInvItems(cached);
      if (navigator.onLine) {
        const { data, error } = await supabase.from('items').select('*').order('name');
        if (!error && data && mountedRef.current) setInvItems(data);
      }
    })();
  }, []);

  async function refresh() {
    if (dragRef.current) return; // don't fight an in-progress drag
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
    const raw = newName.trim();
    if (!raw) return;
    // If the entry ends with a number, treat it as the quantity
    // (e.g. "Blueberries 3" → name "Blueberries", quantity 3).
    let name = raw;
    let quantity = 1;
    const match = raw.match(/^(.*\S)\s+(\d+)$/);
    if (match) {
      name = match[1];
      quantity = Math.max(1, parseInt(match[2], 10));
    }
    setNewName('');

    // Link to the matching inventory item (if any) so the Inventory
    // screen's cart button shows it as on the list.
    const inv = invItems.find((i) => i.name.toLowerCase() === name.toLowerCase());
    await addItem({ name: inv ? inv.name : name, item_id: inv ? inv.id : null, quantity });
    await refresh();
  }

  // Check-off: animate out, then soft-delete once the transition finishes.
  // The timeout matches the .grocery-row CSS transition (0.3s).
  function handleCheck(row) {
    if (removingIds.has(row.id)) return; // ignore a second tap mid-animation
    setRemovingIds((prev) => new Set(prev).add(row.id));
    setTimeout(async () => {
      await checkOff(row);
      if (!mountedRef.current) return; // navigated away mid-animation
      setLastChecked(row); // remember for the Undo bar
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
      await refresh();
    }, 300);
  }

  async function handleUndo() {
    if (!lastChecked) return;
    setLastChecked(null);
    await restoreItem(lastChecked);
    await refresh();
  }

  // ---- Drag to reorder ----
  // The ≡ handle captures the pointer; while dragging we live-reorder the
  // local rows array, and on drop persist a single fractional sort_order
  // (midpoint of the new neighbors) so only the moved row syncs.

  function handleDragStart(e, row) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id: row.id, startIndex: rows.findIndex((r) => r.id === row.id) };
    setDragId(row.id);
  }

  function handleDragMove(e) {
    if (!dragRef.current) return;

    // Nudge the scroll container when dragging near the viewport edges.
    const scroller = document.querySelector('.screen');
    if (scroller) {
      if (e.clientY < 130) scroller.scrollTop -= 10;
      else if (e.clientY > window.innerHeight - 130) scroller.scrollTop += 10;
    }

    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.grocery-row');
    const overId = over?.dataset?.id;
    if (!overId || overId === dragRef.current.id) return;
    setRows((prev) => {
      const from = prev.findIndex((r) => r.id === dragRef.current.id);
      const to = prev.findIndex((r) => r.id === overId);
      if (from < 0 || to < 0 || from === to) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  async function handleDragEnd() {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragId(null);
    if (!drag) return;

    const idx = rows.findIndex((r) => r.id === drag.id);
    if (idx < 0 || idx === drag.startIndex) return; // dropped where it started

    const before = rows[idx - 1];
    const after = rows[idx + 1];
    let newOrder;
    if (before && after) newOrder = (orderOf(before) + orderOf(after)) / 2;
    else if (before) newOrder = orderOf(before) + 1;
    else if (after) newOrder = orderOf(after) - 1;
    else return; // only row in the list

    await reorderItem(rows[idx], newOrder);
    await refresh();
  }

  async function handleRename(row, name) {
    await renameItem(row, name);
    await refresh();
  }

  async function handleQuantity(row, quantity) {
    await setQuantity(row, quantity);
    await refresh();
  }

  // Share the list as plain text — native share sheet on mobile (e.g. to a
  // messaging app), clipboard on desktop. Mirrors the inventory share button.
  async function shareList() {
    const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const lines = [`Grocery List — ${date}`, ''];
    for (const row of rows) {
      lines.push(`• ${row.name} — qty ${row.quantity}`);
    }
    lines.push('');
    lines.push(`Total: ${rows.length} item${rows.length !== 1 ? 's' : ''}`);
    const text = lines.join('\n').trim();

    const isTouchDevice = navigator.maxTouchPoints > 0;
    if (navigator.share && isTouchDevice) {
      try { await navigator.share({ text }); } catch { /* dismissed */ }
    } else {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    }
  }

  // Inventory suggestions for the add bar. Match on the name with any
  // trailing quantity stripped ("vanilla 2" matches on "vanilla"); hide
  // once the text exactly equals a suggestion (i.e. after tapping one).
  const addTrimmed = newName.trim();
  const addStripped = addTrimmed.match(/^(.*\S)\s+\d+$/);
  const addQuery = (addStripped ? addStripped[1] : addTrimmed).toLowerCase();
  const listItemIds = new Set(rows.filter((r) => r.item_id).map((r) => r.item_id));
  const suggestions = addQuery.length >= 2
    ? invItems
        .filter((i) => i.name.toLowerCase().includes(addQuery) && i.name.toLowerCase() !== addQuery)
        .slice(0, 6)
    : [];

  return (
    <div class="grocery">
      <div class="screen-header">
        <h2>Grocery List</h2>
        {rows.length > 0 && (
          <button class="filter-chip" onClick={shareList}>
            {copyFeedback ? '✓ Copied' : (
              <>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M7 9V2M4.5 4.5L7 2l2.5 2.5M2 10.5V13h10v-2.5"/>
                </svg>
                Share
              </>
            )}
          </button>
        )}
      </div>

      <div class="grocery-body">
        {!online && (
          <div class="offline-banner">Offline — changes will sync when you're back online.</div>
        )}

        {lastChecked && (
          <div class="undo-bar">
            <span class="undo-text">✓ Checked off “{lastChecked.name}”</span>
            <button class="undo-btn" onClick={handleUndo}>Undo</button>
            <button class="undo-dismiss" onClick={() => setLastChecked(null)} aria-label="Dismiss">×</button>
          </div>
        )}

        <form class="grocery-add" onSubmit={handleAdd}>
          <input
            type="text"
            class="grocery-add-input"
            placeholder="Add an item… (e.g. Eggs 2)"
            aria-label="New item name"
            value={newName}
            onInput={(e) => setNewName(e.target.value)}
          />
          <button type="submit" class="grocery-add-btn" aria-label="Add item">+</button>
        </form>

        {suggestions.length > 0 && (
          <div class="grocery-suggestions">
            {suggestions.map((item) => (
              <button
                key={item.id}
                type="button"
                class="suggestion-row"
                onMouseDown={(e) => e.preventDefault()} /* keep the keyboard open */
                onClick={() => setNewName(item.name + ' ')}
              >
                <span class="suggestion-name">{item.name}</span>
                {listItemIds.has(item.id) ? (
                  <span class="suggestion-onlist">✓ On list</span>
                ) : (
                  <span class="suggestion-qty">have {item.quantity}</span>
                )}
              </button>
            ))}
          </div>
        )}

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
              dragging={dragId === row.id}
              onCheck={handleCheck}
              onRename={handleRename}
              onQuantity={handleQuantity}
              onDragStart={handleDragStart}
              onDragMove={handleDragMove}
              onDragEnd={handleDragEnd}
            />
          ))
        )}
      </div>
    </div>
  );
}
