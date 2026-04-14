import { useState, useEffect } from 'preact/hooks';
import { supabase } from '../db.js';

const CATEGORIES = [
  'Beverages', 'Dairy', 'Frozen', 'Household',
  'Meat', 'Other', 'Pantry', 'Produce',
];

export function ReviewHaul({ haulId, session }) {
  const [rows, setRows] = useState(null); // null = loading
  const [householdId, setHouseholdId] = useState(null);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!haulId) return;
    async function load() {
      const [{ data: membership }, { data: haul }] = await Promise.all([
        supabase.from('household_members').select('household_id').single(),
        supabase.from('pending_hauls').select('*').eq('id', haulId).single(),
      ]);

      if (membership) setHouseholdId(membership.household_id);

      if (haul?.parsed_items) {
        setRows(
          haul.parsed_items.map((item, i) => ({
            _key: i,
            name: item.name || '',
            category: item.category || 'Other',
            quantity: item.quantity || 1,
          }))
        );
      } else {
        setRows([]);
      }
    }
    load();
  }, [haulId]);

  function updateRow(key, field, value) {
    setRows((prev) =>
      prev.map((r) => (r._key === key ? { ...r, [field]: value } : r))
    );
  }

  function deleteRow(key) {
    setRows((prev) => prev.filter((r) => r._key !== key));
  }

  function addRow() {
    setRows((prev) => [
      ...prev,
      { _key: Date.now(), name: '', category: 'Other', quantity: 1 },
    ]);
  }

  async function commitAll() {
    if (!householdId || !rows.length) return;
    setCommitting(true);
    setError(null);

    for (const row of rows) {
      const trimmedName = row.name.trim();
      if (!trimmedName) continue;

      // Check if item already exists in this household
      const { data: existing } = await supabase
        .from('items')
        .select('id, quantity')
        .eq('household_id', householdId)
        .ilike('name', trimmedName)
        .maybeSingle();

      let itemId;

      if (existing) {
        const newQty = existing.quantity + row.quantity;
        const { data: updated, error: updateError } = await supabase
          .from('items')
          .update({ quantity: newQty, last_purchased_at: new Date().toISOString() })
          .eq('id', existing.id)
          .select('id')
          .single();

        if (updateError) {
          setError(`Failed to update ${trimmedName}: ${updateError.message}`);
          setCommitting(false);
          return;
        }
        itemId = updated.id;

        await supabase.from('activity_log').insert({
          household_id: householdId,
          item_id: itemId,
          item_name_snapshot: trimmedName,
          user_id: session.user.id,
          action: 'edited',
          quantity_delta: row.quantity,
        });
      } else {
        const { data: inserted, error: insertError } = await supabase
          .from('items')
          .insert({
            household_id: householdId,
            name: trimmedName,
            category: row.category,
            quantity: row.quantity,
            last_purchased_at: new Date().toISOString(),
          })
          .select('id')
          .single();

        if (insertError) {
          setError(`Failed to add ${trimmedName}: ${insertError.message}`);
          setCommitting(false);
          return;
        }
        itemId = inserted.id;

        await supabase.from('activity_log').insert({
          household_id: householdId,
          item_id: itemId,
          item_name_snapshot: trimmedName,
          user_id: session.user.id,
          action: 'added',
          quantity_delta: row.quantity,
        });
      }
    }

    // Mark haul as committed
    await supabase
      .from('pending_hauls')
      .update({ status: 'committed', committed_at: new Date().toISOString() })
      .eq('id', haulId);

    window.location.hash = '#inventory';
  }

  if (!haulId) {
    return <div class="loading-screen">No haul selected.</div>;
  }

  if (rows === null) {
    return <div class="loading-screen">Loading haul…</div>;
  }

  return (
    <div class="review-haul">
      <div class="screen-header">
        <a href="#hauls-inbox" class="back-link">← Inbox</a>
        <h2>Review Haul</h2>
      </div>

      {rows.length === 0 ? (
        <p class="empty-state">No items parsed from this haul.</p>
      ) : (
        <>
          <p class="review-hint">
            Edit names, categories, or quantities before committing. Tap the trash icon to remove an item.
          </p>

          <ul class="review-list">
            {rows.map((row) => (
              <li key={row._key} class="review-row">
                <div class="review-row-fields">
                  <input
                    type="text"
                    class="field-input review-name"
                    value={row.name}
                    onInput={(e) => updateRow(row._key, 'name', e.target.value)}
                    disabled={committing}
                  />
                  <div class="review-row-bottom">
                    <select
                      class="field-input review-category"
                      value={row.category}
                      onChange={(e) => updateRow(row._key, 'category', e.target.value)}
                      disabled={committing}
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                    <input
                      type="number"
                      class="field-input review-qty"
                      value={row.quantity}
                      onInput={(e) => updateRow(row._key, 'quantity', Number(e.target.value))}
                      min="1"
                      disabled={committing}
                    />
                    <button
                      class="delete-row-btn"
                      onClick={() => deleteRow(row._key)}
                      disabled={committing}
                      aria-label={`Remove ${row.name}`}
                    >
                      🗑
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {error && <p class="form-error" style={{ padding: '0 1rem' }}>{error}</p>}

          <div class="review-footer">
            <button
              class="btn-secondary"
              onClick={addRow}
              disabled={committing}
            >
              + Add missing item
            </button>
            <button
              class="btn-primary"
              onClick={commitAll}
              disabled={committing || rows.length === 0}
            >
              {committing ? 'Committing…' : `Commit ${rows.length} item${rows.length !== 1 ? 's' : ''}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
