import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { useApp } from '../../context';
import type { CalendarProviderInfo, CalendarSource, CalendarState } from '../../types';
import { Icon } from '../Icon';
import { Modal, Spinner, formatDate, useAction, useToast } from '../ui';

const KIND_LABEL: Record<CalendarSource['kind'], string> = {
  local: 'This server',
  caldav: 'CalDAV',
  google: 'Google',
  microsoft: 'Microsoft',
  ics: 'Subscription',
};

export function CalendarSettings({ params }: { params: URLSearchParams }) {
  const { navigate } = useApp();
  const toast = useToast();
  const run = useAction();
  const [state, setState] = useState<CalendarState | null>(null);
  const [providers, setProviders] = useState<CalendarProviderInfo[]>([]);
  const [adding, setAdding] = useState<CalendarProviderInfo | 'choose' | null>(params.get('add') ? 'choose' : null);
  const [editing, setEditing] = useState<CalendarSource | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => setState(await api<CalendarState>('GET', '/calendar')), []);

  useEffect(() => {
    run(load);
    api<CalendarProviderInfo[]>('GET', '/calendar/providers').then(setProviders).catch(() => {});
    // Results of the OAuth redirect come back as query parameters.
    const added = params.get('oauth');
    const err = params.get('oauthError');
    if (added === 'added') toast('Calendar account connected. Its calendars will appear in a moment.', 'success');
    if (added === 'reconnected') toast('Calendar account reconnected', 'success');
    if (err) toast(`Sign-in failed: ${err}`, 'error');
    if (added || err) navigate('/settings/calendars');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sync = async (s: CalendarSource) => {
    setBusy(s.id);
    const r = await run(() => api<CalendarState>('POST', `/calendar/sources/${s.id}/sync`));
    setBusy(null);
    if (!r) return;
    setState(r);
    const fresh = r.sources.find((x) => x.id === s.id);
    if (fresh?.lastError) toast(`${s.label}: ${fresh.lastError}`, 'error');
    else toast(`${s.label}: up to date`, 'success');
  };

  const remove = async (s: CalendarSource) => {
    if (!confirm(`Remove "${s.label}" from HomeMail? The calendars stay on ${KIND_LABEL[s.kind] === 'Subscription' ? 'the website' : 'the server'}; only HomeMail's copy is removed.`)) return;
    const r = await run(() => api<CalendarState>('DELETE', `/calendar/sources/${s.id}`), 'Calendar account removed');
    if (r) setState(r);
  };

  const reconnect = async (s: CalendarSource) => {
    const r = await run(() => api<{ url: string }>('POST', `/oauth/${s.kind}/start`, { purpose: 'calendar', sourceId: s.id }));
    if (r) window.location.href = r.url;
  };

  if (!state) return <Spinner />;

  if (adding) {
    return (
      <AddCalendar
        providers={providers}
        initial={adding === 'choose' ? null : adding}
        onCancel={() => {
          setAdding(null);
          navigate('/settings/calendars');
        }}
        onDone={(s) => {
          setState(s);
          setAdding(null);
          navigate('/settings/calendars');
        }}
      />
    );
  }

  return (
    <div className="settings-section">
      <div className="section-head">
        <h1>Calendars</h1>
        <button className="btn btn-primary" onClick={() => setAdding('choose')}>
          <Icon name="plus" /> Add calendar account
        </button>
      </div>
      <p className="note">
        Calendars from Google, iCloud, Outlook and other services stay in sync both ways: changes you make here are saved to the service, and changes made elsewhere
        show up within a few minutes, or straight away with the sync button in the Calendar tab.
      </p>
      <ul className="account-cards">
        {state.sources.map((s) => {
          const cals = state.calendars.filter((c) => c.sourceId === s.id);
          return (
            <li key={s.id} className="card account-card">
              <div className="account-card-main">
                <div className="account-title">
                  <strong>{s.label}</strong>
                  <span className="tag">{KIND_LABEL[s.kind]}</span>
                </div>
                <div className="muted small">
                  {s.kind === 'local' ? 'Stored in HomeMail' : s.kind === 'ics' ? s.url : [s.username, s.kind === 'caldav' && s.url ? new URL(s.url).host : null].filter(Boolean).join(' · ')}
                </div>
                {cals.length > 0 && (
                  <div className="cal-chips">
                    {cals.map((c) => (
                      <span key={c.id} className="cal-chip">
                        <span className="cal-swatch" style={{ background: c.color }} /> {c.name}
                        {c.readOnly && s.kind !== 'ics' && <span className="muted"> (read-only)</span>}
                      </span>
                    ))}
                  </div>
                )}
                {!s.connected && <div className="warn-text small">Not signed in. Click "Reconnect".</div>}
                {s.lastError && s.connected && <div className="error-text small">Last error: {s.lastError}</div>}
                {s.kind !== 'local' && s.lastSync && !s.lastError && <div className="muted small">Synced {formatDate(new Date(s.lastSync).toISOString())}</div>}
              </div>
              {s.kind !== 'local' && (
                <div className="account-card-actions">
                  {(s.kind === 'google' || s.kind === 'microsoft') && (
                    <button className="btn btn-sm" onClick={() => reconnect(s)}>
                      Reconnect
                    </button>
                  )}
                  <button className="btn btn-sm" onClick={() => sync(s)} disabled={busy === s.id}>
                    {busy === s.id ? 'Syncing…' : 'Sync now'}
                  </button>
                  <button className="btn btn-sm" onClick={() => setEditing(s)}>
                    Edit
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => remove(s)}>
                    Remove
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {editing && (
        <EditSource
          source={editing}
          onClose={() => setEditing(null)}
          onSaved={(s) => {
            setState(s);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function AddCalendar({
  providers,
  initial,
  onCancel,
  onDone,
}: {
  providers: CalendarProviderInfo[];
  initial: CalendarProviderInfo | null;
  onCancel: () => void;
  onDone: (s: CalendarState) => void;
}) {
  const [preset, setPreset] = useState<CalendarProviderInfo | null>(initial);
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [label, setLabel] = useState('');
  const [insecure, setInsecure] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = (p: CalendarProviderInfo) => {
    setPreset(p);
    setUrl(p.url ?? '');
    setError(null);
  };

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ url: string }>('POST', `/oauth/${preset!.kind}/start`, { purpose: 'calendar' });
      window.location.href = r.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api<CalendarState>('POST', '/calendar/sources', {
        provider: preset!.id,
        url: url.trim() || undefined,
        username: username.trim() || undefined,
        password: password || undefined,
        label: label.trim() || undefined,
        allowInsecureTls: insecure,
      });
      onDone(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  if (!preset) {
    return (
      <div className="settings-section narrow">
        <div className="section-head">
          <h1>Add a calendar</h1>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
        <div className="provider-grid">
          {providers.map((p) => (
            <button key={p.id} className="provider-chip" onClick={() => choose(p)}>
              <strong>{p.name}</strong>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const oauth = preset.kind === 'google' || preset.kind === 'microsoft';
  return (
    <div className="settings-section narrow">
      <div className="section-head">
        <h1>{preset.name}</h1>
        <button className="btn" onClick={() => (initial ? onCancel() : setPreset(null))}>
          Back
        </button>
      </div>
      <p className="note">
        {preset.notes}{' '}
        {preset.helpUrl && (
          <a href={preset.helpUrl} target="_blank" rel="noopener noreferrer">
            How to <Icon name="external" size={12} />
          </a>
        )}
      </p>
      {error && <div className="form-error">{error}</div>}
      {oauth ? (
        preset.available ? (
          <div className="oauth-box">
            <button className="btn btn-primary" onClick={signIn} disabled={busy}>
              {busy ? 'Opening…' : `Sign in with ${preset.kind === 'google' ? 'Google' : 'Microsoft'}`}
            </button>
            <p className="note">
              {preset.kind === 'google'
                ? 'The Google Cloud project behind this server needs the Google Calendar API enabled.'
                : 'Microsoft asks you to allow HomeMail to read and write your calendars.'}
            </p>
          </div>
        ) : (
          <div className="card warn">
            <p>
              Sign-in with {preset.kind === 'google' ? 'Google' : 'Microsoft'} isn't set up on this server. An admin needs to set{' '}
              <code>{preset.kind === 'google' ? 'GOOGLE_CLIENT_ID' : 'MICROSOFT_CLIENT_ID'}</code> (see the README).
            </p>
            {preset.kind === 'google' && <p>Alternatively, add a Google calendar read-only with "Subscribe by URL" and its secret iCal address.</p>}
          </div>
        )
      ) : (
        <form className="stack" onSubmit={submit}>
          {(preset.kind === 'ics' || !preset.url) && (
            <label>
              {preset.kind === 'ics' ? 'Calendar address' : 'Server address'}
              <input type="text" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={preset.urlHint} required autoFocus />
            </label>
          )}
          {preset.kind === 'caldav' && (
            <>
              <label>
                Username
                <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={preset.usernameHint} autoComplete="username" required autoFocus={!!preset.url} />
              </label>
              <label>
                {preset.id === 'icloud' || preset.id === 'fastmail' || preset.id === 'yahoo' ? 'App password' : 'Password'}
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              </label>
            </>
          )}
          {preset.kind === 'ics' &&
            (showAuth ? (
              <div className="grid-2">
                <label>
                  Username
                  <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
                </label>
                <label>
                  Password
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
                </label>
              </div>
            ) : (
              <button type="button" className="link-btn" onClick={() => setShowAuth(true)}>
                This address needs a password
              </button>
            ))}
          <label>
            Name <span className="muted">(optional)</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={preset.kind === 'ics' ? 'Taken from the calendar' : preset.name} />
          </label>
          {(preset.id === 'caldav' || preset.id === 'nextcloud' || preset.kind === 'ics') && (
            <label className="inline">
              <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} /> Allow self-signed certificates
            </label>
          )}
          <div className="form-actions">
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Connecting…' : preset.kind === 'ics' ? 'Subscribe' : 'Connect'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function EditSource({ source, onClose, onSaved }: { source: CalendarSource; onClose: () => void; onSaved: (s: CalendarState) => void }) {
  const [label, setLabel] = useState(source.label);
  const [url, setUrl] = useState(source.url ?? '');
  const [username, setUsername] = useState(source.username ?? '');
  const [password, setPassword] = useState('');
  const [insecure, setInsecure] = useState(source.allowInsecureTls);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const credentials = source.kind === 'caldav' || source.kind === 'ics';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { label: label.trim() };
    if (credentials) {
      if (url.trim() !== (source.url ?? '')) body.url = url.trim();
      if (username.trim() !== (source.username ?? '')) body.username = username.trim();
      if (password) body.password = password;
      if (insecure !== source.allowInsecureTls) body.allowInsecureTls = insecure;
    }
    try {
      onSaved(await api<CalendarState>('PUT', `/calendar/sources/${source.id}`, body));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Edit ${source.label}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="source-form" disabled={busy}>
            {busy ? 'Checking…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="source-form" className="stack" onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}
        <label>
          Name
          <input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={100} />
        </label>
        {credentials && (
          <>
            <label>
              {source.kind === 'ics' ? 'Calendar address' : 'Server address'}
              <input value={url} onChange={(e) => setUrl(e.target.value)} required />
            </label>
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required={source.kind === 'caldav'} />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={source.hasPassword ? 'Unchanged' : ''} autoComplete="current-password" />
            </label>
            <label className="inline">
              <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} /> Allow self-signed certificates
            </label>
          </>
        )}
        {!credentials && <p className="note">To change which account this is, remove it and sign in again.</p>}
      </form>
    </Modal>
  );
}
