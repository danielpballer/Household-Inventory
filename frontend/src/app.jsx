import { useState, useEffect } from 'preact/hooks';

// Hash-based router. Each screen registers as a '#route' value.
// Auth guard will be added in Step 9.
function getHash() {
  return window.location.hash || '#inventory';
}

export function App() {
  const [hash, setHash] = useState(getHash);

  useEffect(() => {
    const onHashChange = () => setHash(getHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return (
    <div class="app">
      <main class="screen">
        <Screen hash={hash} />
      </main>
      <nav class="nav-bar">
        <a href="#inventory" class={hash === '#inventory' ? 'active' : ''}>Inventory</a>
        <a href="#add-haul" class={hash === '#add-haul' ? 'active' : ''}>+ Haul</a>
        <a href="#hauls-inbox" class={hash === '#hauls-inbox' ? 'active' : ''}>Inbox</a>
        <a href="#activity" class={hash === '#activity' ? 'active' : ''}>Activity</a>
      </nav>
    </div>
  );
}

// Placeholder — each screen component is wired up in Steps 9–15
function Screen({ hash }) {
  const route = hash.split('?')[0]; // strip query params
  return (
    <div style={{ padding: '1rem' }}>
      <h2>Pantry</h2>
      <p>Screen: <code>{route}</code></p>
      <p style={{ color: '#666', fontSize: '0.9rem' }}>
        This placeholder will be replaced with the real screen in the next steps.
      </p>
    </div>
  );
}
