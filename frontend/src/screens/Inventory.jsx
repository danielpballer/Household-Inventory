import { useState, useEffect } from 'preact/hooks';
import { supabase } from '../db.js';
import { getInventory, setInventory } from '../offline.js';

export function Inventory({ session }) {
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [showLowOnly, setShowLowOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(navigator.onLine);

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
      // Show cached data immediately so the screen isn't blank
      const cached = await getInventory();
      if (cached.length > 0) {
        setItems(cached);
        setLoading(false);
      }

      if (!navigator.onLine) {
        setLoading(false);
        return;
      }

      // Fetch fresh data from Supabase (RLS scopes to the user's household)
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

  async function decrement(item) {
    if (!online) return;

    const newQty = Math.max(0, item.quantity - 1);

    // Optimistic update — update UI immediately before the network call
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, quantity: newQty } : i)));

    const { error } = await supabase
      .from('items')
      .update({ quantity: newQty })
      .eq('id', item.id);

    if (error) {
      // Revert optimistic update on failure
      setItems((prev) => prev.map((i) => (i.id === item.id ? item : i)));
      console.error('Decrement failed:', error.message);
      return;
    }

    // Log the activity
    await supabase.from('activity_log').insert({
      household_id: item.household_id,
      item_id: item.id,
      item_name_snapshot: item.name,
      user_id: session.user.id,
      action: 'decremented',
      quantity_delta: -1,
    });

    // Update IndexedDB cache with the new quantity
    setItems((prev) => {
      const updated = prev.map((i) => (i.id === item.id ? { ...i, quantity: newQty } : i));
      setInventory(updated);
      return updated;
    });
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
                <span class="item-name">{item.name}</span>
                <div class="item-controls">
                  <span class={`item-qty ${item.quantity <= 2 ? 'low' : ''}`}>
                    {item.quantity}
                  </span>
                  <button
                    class="decrement-btn"
                    onClick={() => decrement(item)}
                    disabled={!online || item.quantity === 0}
                    title={!online ? 'Offline — changes disabled' : '−1'}
                    aria-label={`Decrease ${item.name}`}
                  >
                    −
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
