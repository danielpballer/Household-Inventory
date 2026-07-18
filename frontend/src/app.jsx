import { useState, useEffect } from 'preact/hooks';
import { supabase } from './db.js';
import { SignIn } from './screens/SignIn.jsx';
import { Inventory } from './screens/Inventory.jsx';
import { AddItem } from './screens/AddItem.jsx';
import { AddHaul } from './screens/AddHaul.jsx';
import { HaulsInbox } from './screens/HaulsInbox.jsx';
import { ReviewHaul } from './screens/ReviewHaul.jsx';
import { Activity } from './screens/Activity.jsx';
import { GroceryList } from './screens/GroceryList.jsx';

const NAV_ROUTES = ['#inventory', '#add-item', '#add-haul', '#hauls-inbox', '#grocery', '#activity'];
const LAST_ROUTE_KEY = 'last-route';

function getHash() {
  if (window.location.hash) return window.location.hash;
  // Fresh launch (home-screen opens land on start_url with no hash):
  // restore the last-visited nav tab.
  const saved = localStorage.getItem(LAST_ROUTE_KEY);
  return NAV_ROUTES.includes(saved) ? saved : '#inventory';
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

  // On a fresh launch, put the restored tab in the URL bar so it matches
  // what getHash() already rendered (replaceState doesn't re-fire routing).
  useEffect(() => {
    if (!window.location.hash) {
      const saved = localStorage.getItem(LAST_ROUTE_KEY);
      if (NAV_ROUTES.includes(saved)) window.history.replaceState(null, '', saved);
    }
  }, []);

  // Remember the current tab for the next launch. Only nav tabs are saved —
  // deep links like #review-haul?id=… shouldn't be restored later.
  useEffect(() => {
    const route = hash.split('?')[0];
    if (NAV_ROUTES.includes(route)) localStorage.setItem(LAST_ROUTE_KEY, route);
  }, [hash]);

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
        <Screen route={route} hash={hash} session={session} />
      </main>
      <nav class="nav-bar">
        <a href="#inventory" class={route === '#inventory' ? 'active' : ''}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true">
            <path d="M3 6h14M3 10h14M3 14h14"/>
          </svg>
          <span>Inventory</span>
        </a>
        <a href="#add-item" class={route === '#add-item' ? 'active' : ''}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true">
            <circle cx="10" cy="10" r="7"/>
            <path d="M10 7v6M7 10h6"/>
          </svg>
          <span>+ Item</span>
        </a>
        <a href="#add-haul" class={route === '#add-haul' ? 'active' : ''}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2 9a1 1 0 011-1h1.5l.75-1.5h9.5L15.5 8H17a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1V9z"/>
            <circle cx="10" cy="12" r="2.5"/>
          </svg>
          <span>+ Haul</span>
        </a>
        <a href="#hauls-inbox" class={route === '#hauls-inbox' ? 'active' : ''}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2" y="3" width="16" height="14" rx="1.5"/>
            <path d="M2 13h4l1.5 3h5l1.5-3h4"/>
          </svg>
          <span>Inbox</span>
        </a>
        <a href="#grocery" class={route === '#grocery' ? 'active' : ''}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="4" y="3" width="12" height="15" rx="1.5"/>
            <path d="M7.5 3.5h5V5h-5z"/>
            <path d="M7 9l1.3 1.3L11 7.5M7 13l1.3 1.3L11 11.5"/>
          </svg>
          <span>List</span>
        </a>
        <a href="#activity" class={route === '#activity' ? 'active' : ''}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true">
            <circle cx="10" cy="10" r="7.5"/>
            <path d="M10 6.5V10.5L13 13"/>
          </svg>
          <span>Activity</span>
        </a>
      </nav>
    </div>
  );
}

function Screen({ route, hash, session }) {
  if (route === '#inventory')   return <Inventory session={session} />;
  if (route === '#add-item')    return <AddItem session={session} />;
  if (route === '#add-haul')    return <AddHaul session={session} />;
  if (route === '#hauls-inbox') return <HaulsInbox />;
  if (route === '#review-haul') {
    const haulId = new URLSearchParams(hash.split('?')[1] || '').get('id');
    return <ReviewHaul haulId={haulId} session={session} />;
  }
  if (route === '#activity') return <Activity session={session} />;
  if (route === '#grocery') return <GroceryList session={session} />;

  // Remaining screens wired up in Steps 11–15
  return (
    <div style={{ padding: '1.5rem' }}>
      <p style={{ color: 'var(--ink-2)', fontSize: '0.9rem' }}>
        Screen <code>{route}</code> coming soon.
      </p>
      <button
        style={{ marginTop: '2rem', color: 'var(--destructive)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        onClick={() => supabase.auth.signOut()}
      >
        Sign out
      </button>
    </div>
  );
}
