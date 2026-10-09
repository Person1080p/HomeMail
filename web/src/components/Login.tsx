import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { AuthState } from '../types';

export function Login({ auth, onDone }: { auth: AuthState; onDone: () => Promise<void> }) {
  const [mode, setMode] = useState<'login' | 'register'>(auth.needsSetup ? 'register' : 'login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (mode === 'register' && password !== confirm) return setError('Passwords do not match');
    setBusy(true);
    try {
      if (mode === 'login') await api('POST', '/auth/login', { username, password });
      else await api('POST', '/auth/register', { username, password, displayName: displayName || undefined });
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="brand brand-lg">
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <span>HomeMail</span>
        </div>
        {auth.needsSetup ? (
          <p className="muted">Welcome! Create the first user. It becomes the administrator who can add other people.</p>
        ) : (
          <p className="muted">{mode === 'login' ? 'Sign in to your mailboxes.' : 'Create your HomeMail user.'}</p>
        )}
        <label>
          Username
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        {mode === 'register' && (
          <label>
            Display name <span className="muted">(optional)</span>
            <input autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
        )}
        <label>
          Password
          <input
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={mode === 'register' ? 10 : undefined}
            required
          />
        </label>
        {mode === 'register' && (
          <label>
            Confirm password
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </label>
        )}
        {error && <div className="form-error">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : auth.needsSetup ? 'Create admin user' : 'Create user'}
        </button>
        {!auth.needsSetup && auth.registrationOpen && (
          <button type="button" className="link-btn" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'New here? Create a user' : 'Already have a user? Sign in'}
          </button>
        )}
      </form>
    </div>
  );
}
