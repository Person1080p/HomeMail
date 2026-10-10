import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { useApp } from '../../context';
import type { MyAddresses } from '../../types';
import { Icon } from '../Icon';
import { useAction, useToast } from '../ui';

const SECURITY = { tls: 'SSL/TLS', starttls: 'STARTTLS', none: 'None' } as const;

/** The user's own chat address and mailbox on this server, with settings for other apps. */
function MyAddressesSection() {
  const run = useAction();
  const toast = useToast();
  const [info, setInfo] = useState<MyAddresses | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  useEffect(() => {
    api<MyAddresses>('GET', '/me/addresses').then(setInfo).catch(() => {});
  }, []);
  if (!info) return null;
  const mb = info.mailbox;
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast('Copied', 'success'));

  return (
    <>
      <h1>My addresses</h1>
      <div className="card stack">
        <div>
          <strong>Chat</strong>
          <p className="muted small">
            <span className="mono">{info.chat.address}</span>
            {info.chat.federation ? ' · reachable from other XMPP servers and apps' : ' · people on this server only'}
          </p>
        </div>
        <div>
          <strong>Email on this server</strong>
          {mb.address ? (
            <p className="muted small">
              <span className="mono">{mb.address}</span>
              {mb.mode === 'builtin' ? ' · built into HomeMail; it appears in your Mail tab' : ' · it appears in your Mail tab'}
            </p>
          ) : (
            <p className="muted small">{mb.mode === 'off' ? 'This server does not host email.' : mb.mode === 'external' ? 'Email for this domain is hosted on another server. Add it under Mail accounts with the password you got from your admin.' : (mb.error ?? 'Not set up yet.')}</p>
          )}
          {mb.error && mb.address && <p className="error-text small">{mb.error}</p>}
        </div>
        {mb.clients && (
          <div>
            <strong>Use this mailbox in Thunderbird, phones and other apps</strong>
            <table className="kv small">
              <tbody>
                <tr>
                  <th>Username</th>
                  <td className="mono">{mb.clients.username}</td>
                </tr>
                <tr>
                  <th>Incoming (IMAP)</th>
                  <td className="mono">
                    {mb.clients.imap.host}:{mb.clients.imap.port} · {SECURITY[mb.clients.imap.security]}
                  </td>
                </tr>
                <tr>
                  <th>Outgoing (SMTP)</th>
                  <td className="mono">
                    {mb.clients.smtp.host}:{mb.clients.smtp.port} · {SECURITY[mb.clients.smtp.security]}
                  </td>
                </tr>
              </tbody>
            </table>
            {password ? (
              <div className="card warn">
                <p>
                  Your new mailbox password (shown only now):{' '}
                  <span className="mono">{password}</span>{' '}
                  <button className="icon-btn icon-btn-sm" onClick={() => copy(password)} aria-label="Copy password">
                    <Icon name="copy" size={13} />
                  </button>
                </p>
                <p className="small">Apps already using the old password need this one.</p>
              </div>
            ) : (
              <button
                className="btn"
                onClick={async () => {
                  if (!confirm('Create a new mailbox password? Other apps using the current one will stop working until you update them.')) return;
                  const r = await run(() => api<{ password: string }>('POST', '/me/mailbox-password'));
                  if (r) setPassword(r.password);
                }}
              >
                <Icon name="key" /> Get a password for other apps
              </button>
            )}
          </div>
        )}
        {mb.mode === 'builtin' && mb.address && (
          <p className="muted small">The built-in mail server has no IMAP access, so this mailbox can only be read in HomeMail.</p>
        )}
      </div>
    </>
  );
}

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
      <MyAddressesSection />
      <h1 className="section-gap">Profile</h1>
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
