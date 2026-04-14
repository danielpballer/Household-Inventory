import { useState } from 'preact/hooks';
import { supabase } from '../db.js';

export function SignIn() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        // Redirect back to wherever the app is running (localhost in dev,
        // GitHub Pages URL in prod). Must be in Supabase's allowed redirect URLs.
        redirectTo: window.location.origin + window.location.pathname,
      },
    });

    setLoading(false);
    if (error) {
      setError(error.message);
    } else {
      setSent(true);
    }
  }

  if (sent) {
    return (
      <div class="sign-in">
        <div class="sign-in-card">
          <div class="sign-in-icon">📬</div>
          <h2>Check your email</h2>
          <p>
            We sent a sign-in link to <strong>{email}</strong>.
            <br />
            Click the link to sign in — it expires in 1 hour.
          </p>
          <button class="btn-secondary" onClick={() => setSent(false)}>
            Use a different email
          </button>
        </div>
      </div>
    );
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
          <button type="submit" class="btn-primary" disabled={loading}>
            {loading ? 'Sending…' : 'Send sign-in link'}
          </button>
        </form>
        {error && <p class="sign-in-error">{error}</p>}
      </div>
    </div>
  );
}
