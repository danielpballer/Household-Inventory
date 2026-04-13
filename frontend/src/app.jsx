import { useState, useEffect } from 'preact/hooks';
import { supabase } from './db.js';
import { SignIn } from './screens/SignIn.jsx';

function getHash() {
  return window.location.hash || '#inventory';
}

export function App() {
  // undefined = still checking session, null = no session, object = signed in
  const [session, setSession] = useState(undefined);
  const [hash, setHash] = useState(getHash);

  useEffect(() => {
    // Check for an existing session on load
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session ?? null);
    });

    // React to sign-in, sign-out, and token refresh events
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session ?? null);
      // After clicking a magic link, Supabase puts tokens in the URL hash.
      // Reset to #inventory so the router isn't confused by those tokens.
      if (event === 'SIGNED_IN') {
        window.location.hash = '#inventory';
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const onHashChange = () => setHash(getHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Still checking session — show nothing to avoid flash of sign-in screen
  if (session === undefined) {
    return <div class="loading-screen">Loading…</div>;
  }

  // Not signed in — show sign-in screen regardless of hash
  if (!session) {
    return <SignIn />;
  }

  // Signed in — render the app shell with nav
  const route = hash.split('?')[0];
  return (
    <div class="app">
      <main class="screen">
        <Screen route={route} session={session} />
      </main>
      <nav class="nav-bar">
        <a href="#inventory"   class={route === '#inventory'    ? 'active' : ''}>Inventory</a>
        <a href="#add-haul"    class={route === '#add-haul'     ? 'active' : ''}>+ Haul</a>
        <a href="#hauls-inbox" class={route === '#hauls-inbox'  ? 'active' : ''}>Inbox</a>
        <a href="#activity"    class={route === '#activity'     ? 'active' : ''}>Activity</a>
      </nav>
    </div>
  );
}

// Placeholder dispatcher — each real screen is wired up in Steps 10–15
function Screen({ route, session }) {
  return (
    <div style={{ padding: '1.5rem' }}>
      <h2>Pantry</h2>
      <p style={{ marginTop: '0.5rem', color: '#374151' }}>
        Signed in as <strong>{session.user.email}</strong>
      </p>
      <p style={{ marginTop: '1rem', color: '#6b7280', fontSize: '0.9rem' }}>
        Current screen: <code>{route}</code>
      </p>
      <p style={{ marginTop: '0.5rem', color: '#6b7280', fontSize: '0.9rem' }}>
        Real screens are wired up in Steps 10–15.
      </p>
      <button
        style={{ marginTop: '2rem', color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        onClick={() => supabase.auth.signOut()}
      >
        Sign out
      </button>
    </div>
  );
}
