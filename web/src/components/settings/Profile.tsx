import { useState, type FormEvent } from 'react';
import { api } from '../../api';
import { useApp } from '../../context';
import { useAction } from '../ui';

export function Profile() {
  const { auth, refreshAuth } = useApp();
  const run = useAction();
  const [displayName, setDisplayName] = useState(auth.user!.displayName);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    await run(() => api('PATCH', '/auth/profile', { displayName }), 'Saved');
    refreshAuth();
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return run(() => Promise.reject(new Error('New passwords do not match')));
    const ok = await run(() => api('POST', '/auth/password', { currentPassword: current, newPassword: next }), 'Password changed');
    if (ok !== undefined) {
      setCurrent('');
      setNext('');
      setConfirm('');
    }
  };

  return (
    <div className="settings-section narrow">
      <h1>Profile</h1>
      <form onSubmit={saveName} className="stack">
        <label>
          Username
          <input value={auth.user!.username} disabled />
        </label>
        <label>
          Display name
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        </label>
        <div className="form-actions">
          <button className="btn btn-primary">Save</button>
        </div>
      </form>

      <h1 className="section-gap">Change password</h1>
      <form onSubmit={changePassword} className="stack">
        <label>
          Current password
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label>
          New password <span className="muted">(at least 10 characters)</span>
          <input type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />
        </label>
        <label>
          Confirm new password
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        <div className="form-actions">
          <button className="btn btn-primary">Change password</button>
        </div>
      </form>
    </div>
  );
}
