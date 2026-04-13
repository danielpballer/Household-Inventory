import { useState, useEffect } from 'preact/hooks';
import { supabase } from './db.js';
import { SignIn } from './screens/SignIn.jsx';
import { Inventory } from './screens/Inventory.jsx';
import { AddItem } from './screens/AddItem.jsx';
import { AddHaul } from './screens/AddHaul.jsx';

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
        <a href="#add-item"    class={route === '#add-item'     ? 'active' : ''}>+ Item</a>
        <a href="#add-haul"    class={route === '#add-haul'     ? 'active' : ''}>+ Haul</a>
        <a href="#hauls-inbox" class={route === '#hauls-inbox'  ? 'active' : ''}>Inbox</a>
        <a href="#activity"    class={route === '#activity'     ? 'active' : ''}>Activity</a>
      </nav>
    </div>
  );
}

function Screen({ route, session }) {
  if (route === '#inventory') return <Inventory session={session} />;
  if (route === '#add-item')  return <AddItem session={session} />;
  if (route === '#add-haul')  return <AddHaul session={session} />;

  // Remaining screens wired up in Steps 11–15
  return (
    <div style={{ padding: '1.5rem' }}>
      <p style={{ color: '#6b7280', fontSize: '0.9rem' }}>
        Screen <code>{route}</code> coming soon.
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
