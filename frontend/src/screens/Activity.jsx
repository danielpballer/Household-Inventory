import { useState, useEffect } from 'preact/hooks';
import { supabase } from '../db.js';

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function nameFromEmail(email) {
  if (!email) return 'Someone';
  const prefix = email.split('@')[0].toLowerCase();
  if (prefix.includes('dan') && !prefix.includes('abby')) return 'Dan';
  if (prefix.includes('abby')) return 'Abby';
  // Fallback: capitalise the local part before any dots/numbers
  return prefix.replace(/[^a-z]/g, ' ').trim().split(' ')[0];
}

function describeAction(entry) {
  const { action, item_name_snapshot, quantity_delta } = entry;
  switch (action) {
    case 'added':
      return `added ${item_name_snapshot}${quantity_delta > 1 ? ` (qty ${quantity_delta})` : ''}`;
    case 'decremented':
      return `used ${item_name_snapshot}`;
    case 'edited':
      return quantity_delta > 0
        ? `restocked ${item_name_snapshot} (+${quantity_delta})`
        : `renamed item to ${item_name_snapshot}`;
    case 'deleted':
      return `deleted ${item_name_snapshot}`;
    case 'audited':
      return `audited ${item_name_snapshot}`;
    default:
      return `${action} ${item_name_snapshot}`;
  }
}

export function Activity() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      // Join activity_log with auth.users via a Supabase RPC isn't available
      // on the anon key, so we fetch the log and resolve emails separately.
      const { data: log, error } = await supabase
        .from('activity_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (error || !log) {
        setLoading(false);
        return;
      }

      // Fetch the current user's own email for attribution
      const { data: { user } } = await supabase.auth.getUser();
      const emailMap = {};
      if (user) emailMap[user.id] = user.email;

      // Attach email to each entry (unknown users fall back gracefully)
      const enriched = log.map((entry) => ({
        ...entry,
        user_email: emailMap[entry.user_id] ?? null,
      }));

      setEntries(enriched);
      setLoading(false);
    }
    load();
  }, []);

  if (loading) {
    return <div class="loading-screen">Loading activity…</div>;
  }

  return (
    <div class="activity">
      <div class="screen-header">
        <h2>Activity</h2>
      </div>

      {entries.length === 0 ? (
        <p class="empty-state">No activity yet.</p>
      ) : (
        <ul class="activity-list">
          {entries.map((entry) => (
            <li key={entry.id} class="activity-row">
              <div class="activity-main">
                <span class="activity-who">{nameFromEmail(entry.user_email)}</span>
                <span class="activity-desc">{describeAction(entry)}</span>
              </div>
              <span class="activity-time">{timeAgo(entry.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
