import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { useApp } from '../../context';
import { Icon } from '../Icon';
import { Modal, formatDate, useAction } from '../ui';

interface AdminUser {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
  disabled: boolean;
  createdAt: number;
  accountCount: number;
}

interface AdminSettings {
  registrationOpen: boolean;
  oauth: { google: boolean; microsoft: boolean };
  publicUrl: string;
}

export function Admin() {
  const { auth } = useApp();
  const run = useAction();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ username: '', displayName: '', password: '', isAdmin: false });

  const load = useCallback(async () => {
    const [u, s] = await Promise.all([api<AdminUser[]>('GET', '/admin/users'), api<AdminSettings>('GET', '/admin/settings')]);
    setUsers(u);
    setSettings(s);
  }, []);

  useEffect(() => {
    run(load);
  }, [load, run]);

  const patch = async (u: AdminUser, body: Record<string, unknown>, msg: string) => {
    await run(() => api('PATCH', `/admin/users/${u.id}`, body), msg);
    load();
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() => api('POST', '/admin/users', { ...form, displayName: form.displayName || undefined }), 'User created');
    if (ok !== undefined) {
      setCreating(false);
      setForm({ username: '', displayName: '', password: '', isAdmin: false });
      load();
    }
  };

  const resetPassword = (u: AdminUser) => {
    const pw = prompt(`New password for ${u.username} (at least 10 characters). They will be signed out everywhere.`);
    if (pw) patch(u, { password: pw }, 'Password reset');
  };

  const remove = async (u: AdminUser) => {
    if (!confirm(`Delete user "${u.username}" and their ${u.accountCount} mail account(s) from HomeMail? Mail on the servers is not affected.`)) return;
    await run(() => api('DELETE', `/admin/users/${u.id}`), 'User deleted');
    load();
  };

  return (
    <div className="settings-section">
      <div className="section-head">
        <h1>Users</h1>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> Add user
        </button>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Accounts</th>
              <th>Created</th>
              <th>Role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.disabled ? 'muted' : ''}>
                <td>
                  <strong>{u.username}</strong>
                  {u.displayName !== u.username && <div className="muted small">{u.displayName}</div>}
                  {u.disabled && <span className="tag">disabled</span>}
                </td>
                <td>{u.accountCount}</td>
                <td>{formatDate(new Date(u.createdAt).toISOString())}</td>
                <td>{u.isAdmin ? 'Admin' : 'User'}</td>
                <td className="row-actions">
                  {u.id !== auth.user!.id && (
                    <>
                      <button className="btn btn-sm" onClick={() => patch(u, { isAdmin: !u.isAdmin }, 'Role updated')}>
                        {u.isAdmin ? 'Make user' : 'Make admin'}
                      </button>
                      <button className="btn btn-sm" onClick={() => patch(u, { disabled: !u.disabled }, u.disabled ? 'User enabled' : 'User disabled')}>
                        {u.disabled ? 'Enable' : 'Disable'}
                      </button>
                    </>
                  )}
                  <button className="btn btn-sm" onClick={() => resetPassword(u)}>
                    Reset password
                  </button>
                  {u.id !== auth.user!.id && (
                    <button className="btn btn-sm btn-danger" onClick={() => remove(u)}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {settings && (
        <>
          <h1 className="section-gap">Server settings</h1>
          <label className="inline">
            <input
              type="checkbox"
              checked={settings.registrationOpen}
              onChange={async (e) => {
                await run(() => api('PUT', '/admin/settings', { registrationOpen: e.target.checked }), 'Saved');
                load();
              }}
            />
            Anyone who can reach this server may create a user (open registration)
          </label>

          <h2 className="sub">Google / Microsoft sign-in</h2>
          <ul className="oauth-status">
            <li>
              <strong>Google (Gmail):</strong> {settings.oauth.google ? 'configured' : 'not configured'}. Redirect URI: <code>{settings.publicUrl}/api/oauth/google/callback</code>
            </li>
            <li>
              <strong>Microsoft (Outlook.com / Microsoft 365):</strong> {settings.oauth.microsoft ? 'configured' : 'not configured'}. Redirect URI:{' '}
              <code>{settings.publicUrl}/api/oauth/microsoft/callback</code>
            </li>
          </ul>
          <p className="muted small">Set the client IDs and secrets as environment variables. The README explains how to register the apps.</p>
        </>
      )}

      {creating && (
        <Modal
          title="Add user"
          onClose={() => setCreating(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" form="create-user">
                Create
              </button>
            </>
          }
        >
          <form id="create-user" className="stack" onSubmit={create}>
            <label>
              Username
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required autoFocus />
            </label>
            <label>
              Display name
              <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
            </label>
            <label>
              Initial password <span className="muted">(at least 10 characters)</span>
              <input type="password" autoComplete="new-password" minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
            </label>
            <label className="inline">
              <input type="checkbox" checked={form.isAdmin} onChange={(e) => setForm({ ...form, isAdmin: e.target.checked })} />
              Administrator
            </label>
          </form>
        </Modal>
      )}
    </div>
  );
}
