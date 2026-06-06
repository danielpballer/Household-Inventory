import { useState } from 'preact/hooks';
import { supabase } from '../db.js';

export function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    setLoading(false);
    if (error) {
      setError('Invalid email or password.');
    }
  }

  return (
    <div class="sign-in">
      <div class="sign-in-card">
        <div class="sign-in-icon" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"/>
          </svg>
        </div>
        <h1>Pantry</h1>
        <p>Sign in to your household inventory.</p>
        <form onSubmit={handleSubmit}>
          <input
            type="email"
            placeholder="your@email.com"
            value={email}
            onInput={(e) => setEmail(e.target.value)}
            required
            autocomplete="email"
            disabled={loading}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onInput={(e) => setPassword(e.target.value)}
            required
            autocomplete="current-password"
            disabled={loading}
          />
          <button type="submit" class="btn-primary" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        {error && <p class="sign-in-error">{error}</p>}
      </div>
    </div>
  );
}
