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

export function HaulsInbox() {
  const [hauls, setHauls] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('pending_hauls')
        .select('*')
        .order('created_at', { ascending: false });

      if (!error && data) setHauls(data);
      setLoading(false);
    }
    load();
  }, []);

  if (loading) {
    return <div class="loading-screen">Loading…</div>;
  }

  return (
    <div class="inbox">
      <div class="screen-header">
        <h2>Hauls Inbox</h2>
      </div>

      {hauls.length === 0 ? (
        <p class="empty-state">No hauls yet — add one from the + Haul screen.</p>
      ) : (
        <ul class="haul-list">
          {hauls.map((haul) => (
            <HaulRow key={haul.id} haul={haul} />
          ))}
        </ul>
      )}
    </div>
  );
}

function HaulRow({ haul }) {
  const label = haul.source === 'receipt' ? 'Receipt' : 'Counter Photos';

  if (haul.status === 'ready') {
    return (
      <li class="haul-row haul-row--ready">
        <a href={`#review-haul?id=${haul.id}`} class="haul-row-link">
          <div class="haul-row-main">
            <span class="haul-source">{label}</span>
            <span class="haul-badge haul-badge--ready">Ready to review →</span>
          </div>
          <span class="haul-time">{timeAgo(haul.created_at)}</span>
        </a>
      </li>
    );
  }

  if (haul.status === 'parsing') {
    return (
      <li class="haul-row">
        <div class="haul-row-main">
          <span class="haul-source">{label}</span>
          <span class="haul-badge haul-badge--parsing">
            <span class="spinner spinner--sm" /> Parsing…
          </span>
        </div>
        <span class="haul-time">{timeAgo(haul.created_at)}</span>
      </li>
    );
  }

  if (haul.status === 'failed') {
    return (
      <li class="haul-row">
        <div class="haul-row-main">
          <span class="haul-source">{label}</span>
          <span class="haul-badge haul-badge--failed">Failed</span>
        </div>
        <span class="haul-time">{timeAgo(haul.created_at)}</span>
      </li>
    );
  }

  // committed
  return (
    <li class="haul-row haul-row--committed">
      <div class="haul-row-main">
        <span class="haul-source">{label}</span>
        <span class="haul-badge haul-badge--committed">Committed</span>
      </div>
      <span class="haul-time">{timeAgo(haul.created_at)}</span>
    </li>
  );
}
