import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useApp } from '../../context';
import type { Account } from '../../types';
import { Icon } from '../Icon';
import { formatDate, useAction, useToast } from '../ui';
import { AccountForm } from './AccountForm';

export function AccountsSettings({ params }: { params: URLSearchParams }) {
  const { accounts, reloadAccounts, navigate } = useApp();
  const toast = useToast();
  const run = useAction();
  const [editing, setEditing] = useState<Account | 'new' | null>(params.get('add') ? 'new' : null);
  const [testing, setTesting] = useState<number | null>(null);

  // Results of the OAuth redirect come back as query parameters.
  useEffect(() => {
    const added = params.get('oauth');
    const err = params.get('oauthError');
    if (added === 'added') toast('Account connected', 'success');
    if (added === 'reconnected') toast('Account reconnected', 'success');
    if (err) toast(`Sign-in failed: ${err}`, 'error');
    if (added || err) {
      reloadAccounts();
      navigate('/settings/accounts');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const test = async (a: Account) => {
    setTesting(a.id);
    const r = await run(() => api<{ incoming: string | null; smtp: string | null }>('POST', `/accounts/${a.id}/test`));
    setTesting(null);
    if (!r) return;
    if (!r.incoming && !r.smtp) toast(`${a.label}: connection OK`, 'success');
    else toast([r.incoming && `Incoming: ${r.incoming}`, r.smtp && `Outgoing: ${r.smtp}`].filter(Boolean).join(' · '), 'error');
    reloadAccounts();
  };

  const remove = async (a: Account) => {
    const local = a.protocol === 'pop3' ? ' Messages downloaded into HomeMail for this POP3 account will be deleted too.' : ' Mail on the server is not affected.';
    if (!confirm(`Remove "${a.label}" from HomeMail?${local}`)) return;
    await run(() => api('DELETE', `/accounts/${a.id}`), 'Account removed');
    reloadAccounts();
  };

  const move = async (index: number, delta: number) => {
    const ids = accounts.map((a) => a.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + delta, 0, id);
    await run(() => api('POST', '/accounts/reorder', { ids }));
    reloadAccounts();
  };

  const reconnect = async (a: Account) => {
    const r = await run(() => api<{ url: string }>('POST', `/oauth/${a.oauthProvider}/start`, { accountId: a.id }));
    if (r) window.location.href = r.url;
  };

  if (editing) {
    return (
      <AccountForm
        account={editing === 'new' ? null : editing}
        onDone={() => {
          setEditing(null);
          navigate('/settings/accounts');
          reloadAccounts();
        }}
      />
    );
  }

  return (
    <div className="settings-section">
      <div className="section-head">
        <h1>Mail accounts</h1>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <Icon name="plus" /> Add account
        </button>
      </div>
      {accounts.length === 0 && <p className="muted">No accounts yet.</p>}
      <ul className="account-cards">
        {accounts.map((a, i) => {
          const needsAuth = a.authType === 'oauth2' ? !a.oauthConnected : !a.hasPassword;
          return (
            <li key={a.id} className="card account-card">
              <div className="account-card-main">
                <div className="account-title">
                  <strong>{a.label}</strong>
                  <span className="tag">{a.protocol.toUpperCase()}</span>
                  {a.authType === 'oauth2' && <span className="tag">{a.oauthProvider === 'google' ? 'Google sign-in' : 'Microsoft sign-in'}</span>}
                </div>
                <div className="muted small">
                  {a.displayName ? `${a.displayName} · ` : ''}
                  {a.email} · {a.incoming.host}:{a.incoming.port}
                </div>
                {needsAuth && (
                  <div className="warn-text small">
                    {a.authType === 'oauth2' ? 'Not signed in. Click "Reconnect".' : 'No password saved. Click "Edit" to add it.'}
                  </div>
                )}
                {a.lastError && !needsAuth && <div className="error-text small">Last error: {a.lastError}</div>}
                {a.protocol === 'pop3' && a.lastSync && <div className="muted small">Last checked {formatDate(new Date(a.lastSync).toISOString())}</div>}
              </div>
              <div className="account-card-actions">
                <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up" title="Move up">
                  <Icon name="arrowUp" />
                </button>
                <button className="icon-btn" disabled={i === accounts.length - 1} onClick={() => move(i, 1)} aria-label="Move down" title="Move down">
                  <Icon name="arrowDown" />
                </button>
                {a.authType === 'oauth2' && (
                  <button className="btn btn-sm" onClick={() => reconnect(a)}>
                    Reconnect
                  </button>
                )}
                <button className="btn btn-sm" onClick={() => test(a)} disabled={testing === a.id}>
                  {testing === a.id ? 'Testing…' : 'Test'}
                </button>
                <button className="btn btn-sm" onClick={() => setEditing(a)}>
                  Edit
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => remove(a)}>
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
