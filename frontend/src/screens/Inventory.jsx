import { useState, useEffect, useCallback } from 'preact/hooks';
import { supabase } from '../db.js';
import { getInventory, setInventory } from '../offline.js';

export function Inventory({ session }) {
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [showLowOnly, setShowLowOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(navigator.onLine);
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState('');

  // Callback ref fires synchronously on mount — keeps us inside the tap gesture
  // so the mobile keyboard opens automatically.
  const editInputRef = useCallback((node) => {
    if (node) {
      node.focus();
      node.select();
    }
  }, []);

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

    // Check if another item with the new name already exists
    const duplicate = items.find(
      (i) => i.id !== item.id && i.name.toLowerCase() === newName.toLowerCase()
    );

    if (duplicate) {
      // Merge: sum quantities into the duplicate, delete the current item.
      // Keep the more recent last_purchased_at of the two.
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
      // Simple rename
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
          🔴 Running Low
        </button>
      </div>

      {!online && (
        <div class="offline-banner">
          Offline — showing cached inventory. Changes are disabled.
        </div>
      )}

      {categories.length === 0 ? (
        <p class="empty-state">
          {search.trim()
            ? 'No items match your search.'
            : showLowOnly
            ? 'Nothing running low right now.'
            : 'No items yet — add some from the + Haul or Add Item screens.'}
        </p>
      ) : (
        categories.map((category) => (
          <div key={category} class="category-group">
            <h3 class="category-heading">{category}</h3>
            {grouped[category].map((item) => (
              <div key={item.id} class="item-row">
                <div class="item-info">
                  {editingId === item.id ? (
                    <input
                      ref={editInputRef}
                      type="text"
                      class="item-name-input"
                      value={editingName}
                      onInput={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveEdit(item);
                        if (e.key === 'Escape') cancelEdit();
                      }}
                      onBlur={() => saveEdit(item)}
                    />
                  ) : (
                    <div class="item-name-row">
                      <span class="item-name">{item.name}</span>
                      {online && (
                        <button
                          class="edit-name-btn"
                          onClick={() => startEdit(item)}
                          aria-label={`Edit ${item.name}`}
                          title="Edit name"
                        >
                          ✎
                        </button>
                      )}
                    </div>
                  )}
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
                      onClick={() => deleteItem(item)}
                      aria-label={`Delete ${item.name}`}
                      title="Remove from inventory"
                    >
                      🗑
                    </button>
                  ) : (
                    <button
                      class="decrement-btn"
                      onClick={() => updateQuantity(item, -1)}
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
                    class="decrement-btn"
                    onClick={() => updateQuantity(item, 1)}
                    disabled={!online}
                    title={!online ? 'Offline — changes disabled' : '+1'}
                    aria-label={`Increase ${item.name}`}
                  >
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
