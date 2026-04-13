import { useState, useEffect } from 'preact/hooks';
import { supabase } from '../db.js';

const CATEGORIES = [
  'Beverages', 'Dairy', 'Frozen', 'Household',
  'Meat', 'Other', 'Pantry', 'Produce',
];

export function AddItem({ session }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [householdId, setHouseholdId] = useState(null);

  useEffect(() => {
    supabase
      .from('household_members')
      .select('household_id')
      .single()
      .then(({ data }) => {
        if (data) setHouseholdId(data.household_id);
      });
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!householdId) return;
    setSaving(true);
    setError(null);

    const trimmedName = name.trim();

    // Check if an item with the same name already exists in this household
    const { data: existing } = await supabase
      .from('items')
      .select('id, quantity')
      .eq('household_id', householdId)
      .ilike('name', trimmedName)
      .maybeSingle();

    let item;

    if (existing) {
      // Increment existing item
      const newQty = existing.quantity + quantity;
      const { data: updated, error: updateError } = await supabase
        .from('items')
        .update({ quantity: newQty })
        .eq('id', existing.id)
        .select()
        .single();

      if (updateError) {
        setError(updateError.message);
        setSaving(false);
        return;
      }
      item = updated;
    } else {
      // Insert new item
      const { data: inserted, error: insertError } = await supabase
        .from('items')
        .insert({ household_id: householdId, name: trimmedName, category, quantity })
        .select()
        .single();

      if (insertError) {
        setError(insertError.message);
        setSaving(false);
        return;
      }
      item = inserted;
    }

    await supabase.from('activity_log').insert({
      household_id: householdId,
      item_id: item.id,
      item_name_snapshot: item.name,
      user_id: session.user.id,
      action: 'added',
      quantity_delta: quantity,
    });

    window.location.hash = '#inventory';
  }

  return (
    <div class="add-item">
      <div class="screen-header">
        <a href="#inventory" class="back-link">← Back</a>
        <h2>Add Item</h2>
      </div>

      <form class="add-item-form" onSubmit={handleSubmit}>
        <label class="field-label">
          Name
          <input
            type="text"
            class="field-input"
            placeholder="e.g. Organic Whole Milk"
            value={name}
            onInput={(e) => setName(e.target.value)}
            required
            disabled={saving}
            autoFocus
          />
        </label>

        <label class="field-label">
          Category
          <select
            class="field-input"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            required
            disabled={saving}
          >
            <option value="">Select a category…</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>

        <label class="field-label">
          Quantity
          <input
            type="number"
            class="field-input"
            value={quantity}
            onInput={(e) => setQuantity(Number(e.target.value))}
            min="1"
            required
            disabled={saving}
          />
        </label>

        {error && <p class="form-error">{error}</p>}

        <button type="submit" class="btn-primary" disabled={saving || !householdId}>
          {saving ? 'Saving…' : 'Add to Inventory'}
        </button>
      </form>
    </div>
  );
}
