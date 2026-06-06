import { useState, useEffect, useRef } from 'preact/hooks';
import { supabase } from '../db.js';
import { getInventory, setInventory } from '../offline.js';

// Extracted so each row has its own ref to the name input.
// The input is always in the DOM (just readOnly when not editing) so we can
// call focus() synchronously inside the pencil-button click handler — the
// only way to reliably open the mobile keyboard without a user re-tap.
function ItemRow({ item, isEditing, editingName, setEditingName, onStartEdit, onCancelEdit, onSaveEdit, onUpdateQuantity, onDeleteItem, online }) {
  const nameRef = useRef(null);

  function handleEditClick() {
    if (nameRef.current) {
      // Remove readOnly and focus synchronously — still inside the tap gesture.
      nameRef.current.readOnly = false;
      nameRef.current.focus();
      nameRef.current.select();
    }
    onStartEdit(item);
  }

  return (
    <div class="item-row">
      <div class="item-info">
        <div class="item-name-row">
          <input
            ref={nameRef}
            type="text"
            class={`item-name-input ${isEditing ? '' : 'item-name-offscreen'}`}
            value={isEditing ? editingName : item.name}
            readOnly={!isEditing}
            onInput={(e) => isEditing && setEditingName(e.target.value)}
            onKeyDown={(e) => {
              if (!isEditing) return;
              if (e.key === 'Enter') onSaveEdit(item);
              if (e.key === 'Escape') onCancelEdit();
            }}
            onBlur={() => isEditing && onSaveEdit(item)}
          />
          {!isEditing && <span class="item-name-display">{item.name}</span>}
          {online && (
            <button
              class="edit-name-btn"
              onClick={handleEditClick}
              aria-label={`Edit ${item.name}`}
              title="Edit name"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9.5 1.5l3 3-7 7L2 12l.5-2.5 7-7z"/>
                <path d="M8 3l3 3"/>
              </svg>
            </button>
          )}
        </div>
        {item.last_purchased_at && (
          <span class="item-date">
            Last bought: {new Date(item.last_purchased_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>
      <div class="item-controls">
        {item.quantity === 0 && online ? (
          <button
            class="delete-item-btn"
            onClick={() => onDeleteItem(item)}
            aria-label={`Delete ${item.name}`}
            title="Remove from inventory"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2 4h12M5 4V2.5h6V4M3.5 4l1 10h7l1-10M6.5 7v4.5M9.5 7v4.5"/>
            </svg>
          </button>
        ) : (
          <button
            class="qty-btn"
            onClick={() => onUpdateQuantity(item, -1)}
            disabled={!online || item.quantity === 0}
            title={!online ? 'Offline — changes disabled' : '−1'}
            aria-label={`Decrease ${item.name}`}
          >
            −
          </button>
        )}
        <span class={`item-qty ${item.quantity <= 2 ? 'low' : ''}`}>
          {item.quantity}
        </span>
        <button
          class="qty-btn"
          onClick={() => onUpdateQuantity(item, 1)}
          disabled={!online}
          title={!online ? 'Offline — changes disabled' : '+1'}
          aria-label={`Increase ${item.name}`}
        >
          +
        </button>
      </div>
    </div>
  );
}

export function Inventory({ session }) {
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [showLowOnly, setShowLowOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(navigator.onLine);
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState('');
  const [copyFeedback, setCopyFeedback] = useState(false);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    async function load() {
      const cached = await getInventory();
      if (cached.length > 0) {
        setItems(cached);
        setLoading(false);
      }
      if (!navigator.onLine) {
        setLoading(false);
        return;
      }
      const { data, error } = await supabase
        .from('items')
        .select('*')
        .order('name');
      if (!error && data) {
        setItems(data);
        await setInventory(data);
      }
      setLoading(false);
    }
    load();
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel('inventory-sync')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'items' }, (payload) => {
        setItems((prev) => {
          if (prev.some((i) => i.id === payload.new.id)) return prev;
          const updated = [...prev, payload.new].sort((a, b) => a.name.localeCompare(b.name));
          setInventory(updated);
          return updated;
        });
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'items' }, (payload) => {
        setItems((prev) => {
          const updated = prev.map((i) => (i.id === payload.new.id ? payload.new : i));
          setInventory(updated);
          return updated;
        });
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'items' }, (payload) => {
        setItems((prev) => {
          const updated = prev.filter((i) => i.id !== payload.old.id);
          setInventory(updated);
          return updated;
        });
      })
      .subscribe();

    return () => channel.unsubscribe();
  }, []);

  async function deleteItem(item) {
    if (!online) return;

    setItems((prev) => prev.filter((i) => i.id !== item.id));

    const { error } = await supabase.from('items').delete().eq('id', item.id);

    if (error) {
      setItems((prev) => {
        const restored = [...prev, item].sort((a, b) => a.name.localeCompare(b.name));
        setInventory(restored);
        return restored;
      });
      console.error('Delete failed:', error.message);
      return;
    }

    await supabase.from('activity_log').insert({
      household_id: item.household_id,
      item_id: item.id,
      item_name_snapshot: item.name,
      user_id: session.user.id,
      action: 'deleted',
      quantity_delta: 0,
    });

    setItems((prev) => {
      setInventory(prev);
      return prev;
    });
  }

  async function updateQuantity(item, delta) {
    if (!online) return;
    const newQty = Math.max(0, item.quantity + delta);
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, quantity: newQty } : i)));
    const { error } = await supabase.from('items').update({ quantity: newQty }).eq('id', item.id);
    if (error) {
      setItems((prev) => prev.map((i) => (i.id === item.id ? item : i)));
      console.error('Update failed:', error.message);
      return;
    }
    await supabase.from('activity_log').insert({
      household_id: item.household_id,
      item_id: item.id,
      item_name_snapshot: item.name,
      user_id: session.user.id,
      action: delta < 0 ? 'decremented' : 'edited',
      quantity_delta: delta,
    });
    setItems((prev) => {
      const updated = prev.map((i) => (i.id === item.id ? { ...i, quantity: newQty } : i));
      setInventory(updated);
      return updated;
    });
  }

  function startEdit(item) {
    setEditingId(item.id);
    setEditingName(item.name);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingName('');
  }

  async function saveEdit(item) {
    const newName = editingName.trim();
    if (!newName || newName === item.name) {
      cancelEdit();
      return;
    }

    const duplicate = items.find(
      (i) => i.id !== item.id && i.name.toLowerCase() === newName.toLowerCase()
    );

    if (duplicate) {
      const mergedQty = duplicate.quantity + item.quantity;
      const aDate = item.last_purchased_at ? new Date(item.last_purchased_at) : null;
      const bDate = duplicate.last_purchased_at ? new Date(duplicate.last_purchased_at) : null;
      const mergedDate = !aDate ? duplicate.last_purchased_at
        : !bDate ? item.last_purchased_at
        : aDate > bDate ? item.last_purchased_at
        : duplicate.last_purchased_at;

      const { error: mergeError } = await supabase
        .from('items')
        .update({ quantity: mergedQty, last_purchased_at: mergedDate })
        .eq('id', duplicate.id);

      if (mergeError) {
        console.error('Merge failed:', mergeError.message);
        cancelEdit();
        return;
      }

      await supabase.from('items').delete().eq('id', item.id);

      await supabase.from('activity_log').insert({
        household_id: item.household_id,
        item_id: duplicate.id,
        item_name_snapshot: duplicate.name,
        user_id: session.user.id,
        action: 'edited',
        quantity_delta: item.quantity,
      });

      setItems((prev) => {
        const updated = prev
          .filter((i) => i.id !== item.id)
          .map((i) => (i.id === duplicate.id ? { ...i, quantity: mergedQty, last_purchased_at: mergedDate } : i));
        setInventory(updated);
        return updated;
      });
    } else {
      const { error } = await supabase
        .from('items')
        .update({ name: newName })
        .eq('id', item.id);

      if (error) {
        console.error('Rename failed:', error.message);
        cancelEdit();
        return;
      }

      await supabase.from('activity_log').insert({
        household_id: item.household_id,
        item_id: item.id,
        item_name_snapshot: newName,
        user_id: session.user.id,
        action: 'edited',
        quantity_delta: 0,
      });

      setItems((prev) => {
        const updated = prev.map((i) => (i.id === item.id ? { ...i, name: newName } : i));
        setInventory(updated);
        return updated;
      });
    }

    cancelEdit();
  }

  async function shareInventory() {
    const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const allGrouped = {};
    for (const item of items) {
      if (!allGrouped[item.category]) allGrouped[item.category] = [];
      allGrouped[item.category].push(item);
    }
    const lines = [`Household Inventory — ${date}`, ''];
    for (const cat of Object.keys(allGrouped).sort()) {
      const catItems = allGrouped[cat].sort((a, b) => a.name.localeCompare(b.name));
      lines.push(`${cat}`);
      for (const item of catItems) {
        lines.push(`• ${item.name} — qty ${item.quantity}`);
      }
      lines.push('');
    }
    lines.push(`Total: ${items.length} item${items.length !== 1 ? 's' : ''}`);
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

  // Apply search and filter
  let visible = items;
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    visible = visible.filter((i) => i.name.toLowerCase().includes(q));
  }
  if (showLowOnly) {
    visible = visible.filter((i) => i.quantity <= 2);
  }

  // Group by category, sorted alphabetically
  const grouped = {};
  for (const item of visible) {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push(item);
  }
  const categories = Object.keys(grouped).sort();

  if (loading && items.length === 0) {
    return <div class="loading-screen">Loading inventory…</div>;
  }

  return (
    <div class="inventory">
      <div class="inventory-header">
        <input
          type="search"
          class="search-input"
          placeholder="Search items…"
          value={search}
          onInput={(e) => setSearch(e.target.value)}
        />
        <button
          class={`filter-chip ${showLowOnly ? 'active' : ''}`}
          onClick={() => setShowLowOnly((v) => !v)}
        >
          <span class="chip-dot" aria-hidden="true" />
          Running Low
        </button>
        {items.length > 0 && (
          <button class="filter-chip" onClick={shareInventory}>
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

      {!online && (
        <div class="offline-banner">
          Offline — showing cached inventory. Changes are disabled.
        </div>
      )}

      {categories.length === 0 ? (
        <div class="empty-state">
          <svg class="empty-state-icon" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"/>
          </svg>
          <span>
            {search.trim()
              ? 'No items match your search.'
              : showLowOnly
              ? 'Nothing running low right now.'
              : 'No items yet — add some from the + Haul or + Item screens.'}
          </span>
        </div>
      ) : (
        categories.map((category) => (
          <div key={category} class="category-group">
            <h3 class="category-heading">{category}</h3>
            {grouped[category].map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                isEditing={editingId === item.id}
                editingName={editingName}
                setEditingName={setEditingName}
                onStartEdit={startEdit}
                onCancelEdit={cancelEdit}
                onSaveEdit={saveEdit}
                onUpdateQuantity={updateQuantity}
                onDeleteItem={deleteItem}
                online={online}
              />
            ))}
          </div>
        ))
      )}
    </div>
  );
}
