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
        <div class="sign-in-icon">🥫</div>
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
