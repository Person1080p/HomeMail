import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import type { Account, DetectResult, Provider, Security, ServerSettings } from '../../types';
import { Icon } from '../Icon';
import { Spinner, useToast } from '../ui';

interface Server extends ServerSettings {
  username: string;
}

interface FormState {
  label: string;
  provider: string;
  email: string;
  displayName: string;
  protocol: 'imap' | 'pop3';
  incoming: Server;
  smtp: Server;
  password: string;
  smtpPassword: string;
  allowInsecureTls: boolean;
  leaveOnServer: boolean;
  saveSent: boolean;
  signature: string;
}

const STANDARD_PORTS: Record<string, Record<Security, number>> = {
  imap: { tls: 993, starttls: 143, none: 143 },
  pop3: { tls: 995, starttls: 110, none: 110 },
  smtp: { tls: 465, starttls: 587, none: 25 },
};

const PASSWORD_LABEL: Record<string, string> = {
  gmail: 'App password',
  yahoo: 'App password',
  aol: 'App password',
  icloud: 'App-specific password',
  fastmail: 'App password',
  proton: 'Bridge password',
};

const blankServer = (): Server => ({ host: '', port: 993, security: 'tls', username: '' });

function fromAccount(a: Account): FormState {
  return {
    label: a.label,
    provider: a.provider,
    email: a.email,
    displayName: a.displayName,
    protocol: a.protocol,
    incoming: { ...a.incoming },
    smtp: { ...a.smtp },
    password: '',
    smtpPassword: '',
    allowInsecureTls: a.allowInsecureTls,
    leaveOnServer: a.leaveOnServer,
    saveSent: a.saveSent,
    signature: a.signature,
  };
}

function ServerFields({ title, value, onChange, kind }: { title: string; value: Server; onChange: (s: Server) => void; kind: 'imap' | 'pop3' | 'smtp' }) {
  const setSecurity = (security: Security) => {
    const ports = Object.values(STANDARD_PORTS[kind]);
    // Follow the standard port for the new security mode unless a custom port was typed.
    const port = ports.includes(value.port) ? STANDARD_PORTS[kind][security] : value.port;
    onChange({ ...value, security, port });
  };
  return (
    <fieldset className="server-fields">
      <legend>{title}</legend>
      <label className="grow">
        Server
        <input value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value })} placeholder={kind === 'smtp' ? 'smtp.example.com' : `${kind}.example.com`} required />
      </label>
      <label className="port">
        Port
        <input type="number" min={1} max={65535} value={value.port} onChange={(e) => onChange({ ...value, port: Number(e.target.value) })} required />
      </label>
      <label>
        Security
        <select value={value.security} onChange={(e) => setSecurity(e.target.value as Security)}>
          <option value="tls">SSL/TLS</option>
          <option value="starttls">STARTTLS</option>
          <option value="none">None (insecure)</option>
        </select>
      </label>
      <label className="grow">
        Username
        <input value={value.username} onChange={(e) => onChange({ ...value, username: e.target.value })} placeholder={kind === 'smtp' ? 'empty = no authentication' : 'usually your email address'} />
      </label>
    </fieldset>
  );
}

export function AccountForm({ account, onDone }: { account: Account | null; onDone: () => void }) {
  const toast = useToast();
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [step, setStep] = useState<'email' | 'details'>(account ? 'details' : 'email');
  const [f, setF] = useState<FormState>(() =>
    account
      ? fromAccount(account)
      : {
          label: '',
          provider: 'imap',
          email: '',
          displayName: '',
          protocol: 'imap',
          incoming: blankServer(),
          smtp: { host: '', port: 587, security: 'starttls', username: '' },
          password: '',
          smtpPassword: '',
          allowInsecureTls: false,
          leaveOnServer: true,
          saveSent: true,
          signature: '',
        },
  );
  const [showServers, setShowServers] = useState(false);
  const [busy, setBusy] = useState<'detect' | 'test' | 'save' | 'oauth' | null>(null);
  const [testResult, setTestResult] = useState<{ incoming: string | null; smtp: string | null } | null>(null);
  const [detectNote, setDetectNote] = useState('');

  useEffect(() => {
    api<Provider[]>('GET', '/providers').then(setProviders).catch((e) => toast(e.message, 'error'));
  }, [toast]);

  const preset = providers?.find((p) => p.id === f.provider);
  const isOAuth = account?.authType === 'oauth2';
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setF((s) => ({ ...s, [k]: v }));
    setTestResult(null);
  };

  /** Applies a provider's server presets, keeping what the user typed for identity. */
  const applyPreset = (p: Provider, protocol: 'imap' | 'pop3' = p.imap ? 'imap' : 'pop3', email = f.email) => {
    const incoming = (protocol === 'pop3' ? p.pop3 : p.imap) ?? (protocol === 'pop3' ? { host: '', port: 995, security: 'tls' as Security } : { host: '', port: 993, security: 'tls' as Security });
    const smtp = p.smtp ?? { host: '', port: 587, security: 'starttls' as Security };
    setF((s) => ({
      ...s,
      provider: p.id,
      protocol,
      incoming: { ...incoming, username: email },
      smtp: { ...smtp, username: email },
      allowInsecureTls: p.allowInsecureTls,
    }));
    setShowServers(p.id === 'imap' || p.id === 'pop3');
    setTestResult(null);
  };

  const detect = async (e: FormEvent) => {
    e.preventDefault();
    if (!providers) return;
    setBusy('detect');
    try {
      const r = await api<DetectResult>('POST', '/autodetect', { email: f.email });
      const p = providers.find((x) => x.id === r.presetId)!;
      if (r.source === 'known-domain' || r.source === 'mx') {
        applyPreset(p, r.protocol, f.email);
        setDetectNote(r.source === 'mx' ? `Your domain's mail is hosted by ${p.name}.` : '');
      } else {
        // ISPDB result or a guess: fill in servers but keep them visible for review.
        setF((s) => ({
          ...s,
          provider: r.protocol,
          protocol: r.protocol,
          incoming: { ...(r.incoming ?? blankServer()), username: r.username },
          smtp: { ...(r.smtp ?? { host: '', port: 587, security: 'starttls' }), username: r.username },
        }));
        setShowServers(true);
        setDetectNote(r.source === 'ispdb' ? 'Settings found in the Thunderbird provider database (ISPDB).' : 'Could not find settings automatically. These are guesses; please check them.');
      }
      setStep('details');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const body = () => ({
    label: f.label || undefined,
    provider: f.provider,
    email: f.email,
    displayName: f.displayName,
    protocol: f.protocol,
    incoming: f.incoming,
    smtp: f.smtp,
    password: f.password || undefined,
    smtpPassword: f.smtpPassword || undefined,
    allowInsecureTls: f.allowInsecureTls,
    leaveOnServer: f.leaveOnServer,
    saveSent: f.saveSent,
    signature: f.signature,
  });

  const runTest = async () => {
    // Editing without retyping the password: test the stored credentials.
    if (account && !f.password) return api<{ incoming: string | null; smtp: string | null }>('POST', `/accounts/${account.id}/test`);
    return api<{ incoming: string | null; smtp: string | null }>('POST', '/accounts/test', body());
  };

  const test = async () => {
    setBusy('test');
    try {
      setTestResult(await runTest());
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const save = async (e: FormEvent, force = false) => {
    e.preventDefault();
    setBusy('save');
    try {
      if (!force && !isOAuth && (!account || f.password)) {
        const r = await runTest();
        setTestResult(r);
        if (r.incoming || r.smtp) return;
      }
      if (account) await api('PUT', `/accounts/${account.id}`, body());
      else await api('POST', '/accounts', body());
      toast(account ? 'Account updated' : 'Account added', 'success');
      onDone();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const oauth = async () => {
    if (!preset?.oauthProvider) return;
    setBusy('oauth');
    try {
      const r = await api<{ url: string }>('POST', `/oauth/${preset.oauthProvider}/start`, {
        accountId: account?.id,
        protocol: f.protocol,
        displayName: f.displayName || undefined,
      });
      window.location.href = r.url;
    } catch (err) {
      toast((err as Error).message, 'error');
      setBusy(null);
    }
  };

  if (!providers) return <Spinner label="Loading…" />;

  /* ---------- step 1: identity ---------- */
  if (step === 'email') {
    return (
      <form className="settings-section narrow" onSubmit={detect}>
        <h1>Add a mail account</h1>
        <p className="muted">Enter your address and HomeMail will look up the server settings, the same way Thunderbird does.</p>
        <label>
          Your name <span className="muted">(shown to recipients)</span>
          <input value={f.displayName} onChange={(e) => set('displayName', e.target.value)} autoComplete="name" />
        </label>
        <label>
          Email address
          <input type="email" value={f.email} onChange={(e) => set('email', e.target.value.trim())} required autoFocus />
        </label>
        <div className="form-actions">
          <button className="btn btn-primary" disabled={busy === 'detect'}>
            {busy === 'detect' ? 'Looking up settings…' : 'Continue'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onDone}>
            Cancel
          </button>
        </div>
        <h2 className="sub">Or pick your provider</h2>
        <div className="provider-grid">
          {providers.map((p) => (
            <button
              type="button"
              key={p.id}
              className={`provider-chip ${p.supported ? '' : 'unsupported'}`}
              onClick={() => {
                applyPreset(p);
                setStep('details');
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      </form>
    );
  }

  /* ---------- step 2: details ---------- */
  const canPassword = !isOAuth && (preset?.authMethods.includes('password') ?? true);
  const canOAuth = !!preset?.oauthProvider && (isOAuth || preset.authMethods.includes('oauth2'));
  const oauthLabel = preset?.oauthProvider === 'google' ? 'Sign in with Google' : 'Sign in with Microsoft';
  const hasBoth = !!(preset?.imap && preset?.pop3) || preset?.id === 'imap' || preset?.id === 'pop3';

  return (
    <form className="settings-section narrow" onSubmit={(e) => save(e)}>
      <h1>{account ? `Edit ${account.label}` : 'Add a mail account'}</h1>

      {!account && (
        <label>
          Provider
          <select
            value={f.provider}
            onChange={(e) => {
              const p = providers.find((x) => x.id === e.target.value)!;
              applyPreset(p, p.imap ? 'imap' : 'pop3');
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {detectNote && <p className="note">{detectNote}</p>}

      {preset && (
        <div className={`card provider-note ${preset.supported ? '' : 'warn'}`}>
          <p>{preset.notes}</p>
          {preset.helpUrl && (
            <a href={preset.helpUrl} target="_blank" rel="noopener noreferrer">
              Provider instructions <Icon name="external" size={12} />
            </a>
          )}
        </div>
      )}

      {preset && !preset.supported ? (
        <div className="form-actions">
          <button type="button" className="btn" onClick={() => setStep('email')}>
            Back
          </button>
        </div>
      ) : (
        <>
          {!isOAuth && (
            <>
              <label>
                Email address
                <input type="email" value={f.email} onChange={(e) => set('email', e.target.value.trim())} required={canPassword} disabled={!canPassword} />
              </label>
              <label>
                Your name
                <input value={f.displayName} onChange={(e) => set('displayName', e.target.value)} />
              </label>
            </>
          )}

          {canOAuth && (
            <div className="oauth-box">
              {preset!.oauthAvailable ? (
                <button type="button" className="btn btn-primary" onClick={oauth} disabled={busy === 'oauth'}>
                  <Icon name="key" /> {isOAuth ? 'Reconnect' : oauthLabel}
                </button>
              ) : (
                <p className="warn-text small">
                  {oauthLabel} is not set up on this HomeMail server. An admin needs to add {preset!.oauthProvider === 'google' ? 'GOOGLE_CLIENT_ID' : 'MICROSOFT_CLIENT_ID'} (see README).
                  {canPassword ? ' You can use an app password below instead.' : ''}
                </p>
              )}
              {canPassword && <div className="or">or</div>}
            </div>
          )}

          {canPassword && (
            <label>
              {PASSWORD_LABEL[f.provider] ?? 'Password'}
              {account && <span className="muted"> (leave empty to keep the saved one)</span>}
              <input type="password" autoComplete="new-password" value={f.password} onChange={(e) => set('password', e.target.value)} required={!account} />
            </label>
          )}

          {(canPassword || isOAuth) && (
            <>
              <label>
                Account name <span className="muted">(shown in the folder list)</span>
                <input value={f.label} onChange={(e) => set('label', e.target.value)} placeholder={f.email} />
              </label>

              {hasBoth && !isOAuth && (
                <div className="radio-row" role="radiogroup" aria-label="Protocol">
                  <label className="inline">
                    <input type="radio" checked={f.protocol === 'imap'} onChange={() => (preset && preset.imap ? applyPreset(preset, 'imap') : set('protocol', 'imap'))} />
                    IMAP <span className="muted small">(mail stays on the server, synced everywhere)</span>
                  </label>
                  <label className="inline">
                    <input type="radio" checked={f.protocol === 'pop3'} onChange={() => (preset && preset.pop3 ? applyPreset(preset, 'pop3') : set('protocol', 'pop3'))} />
                    POP3 <span className="muted small">(download into HomeMail)</span>
                  </label>
                </div>
              )}

              {f.protocol === 'pop3' && (
                <label className="inline">
                  <input type="checkbox" checked={f.leaveOnServer} onChange={(e) => set('leaveOnServer', e.target.checked)} />
                  Leave messages on the server after downloading
                </label>
              )}

              <label>
                Signature
                <textarea rows={3} value={f.signature} onChange={(e) => set('signature', e.target.value)} placeholder="Optional, added below new messages" />
              </label>

              {!isOAuth && (
                <>
                  <button type="button" className="link-btn" onClick={() => setShowServers(!showServers)}>
                    <Icon name={showServers ? 'chevronDown' : 'chevronRight'} size={14} /> Server settings
                  </button>
                  {showServers && (
                    <div className="server-settings">
                      <ServerFields title={`Incoming (${f.protocol.toUpperCase()})`} kind={f.protocol} value={f.incoming} onChange={(v) => set('incoming', v)} />
                      <ServerFields title="Outgoing (SMTP)" kind="smtp" value={f.smtp} onChange={(v) => set('smtp', v)} />
                      <label>
                        Separate SMTP password <span className="muted">(only if different)</span>
                        <input type="password" autoComplete="new-password" value={f.smtpPassword} onChange={(e) => set('smtpPassword', e.target.value)} />
                      </label>
                      <label className="inline">
                        <input type="checkbox" checked={f.allowInsecureTls} onChange={(e) => set('allowInsecureTls', e.target.checked)} />
                        Allow self-signed certificates <span className="muted small">(e.g. Proton Mail Bridge, a server on your LAN)</span>
                      </label>
                      <label className="inline">
                        <input type="checkbox" checked={f.saveSent} onChange={(e) => set('saveSent', e.target.checked)} />
                        Save a copy of sent messages in Sent
                      </label>
                    </div>
                  )}
                </>
              )}

              {testResult && (
                <div className={`card test-result ${testResult.incoming || testResult.smtp ? 'warn' : 'ok'}`}>
                  {!testResult.incoming && !testResult.smtp ? (
                    <p>
                      <Icon name="check" /> Incoming and outgoing servers accepted the login.
                    </p>
                  ) : (
                    <>
                      <p>
                        <strong>Incoming:</strong> {testResult.incoming ?? 'OK'}
                      </p>
                      <p>
                        <strong>Outgoing:</strong> {testResult.smtp ?? 'OK'}
                      </p>
                      <button type="button" className="link-btn" onClick={(e) => save(e, true)}>
                        Save anyway
                      </button>
                    </>
                  )}
                </div>
              )}

              <div className="form-actions">
                <button className="btn btn-primary" disabled={!!busy}>
                  {busy === 'save' ? 'Checking…' : account ? 'Save' : 'Test & add account'}
                </button>
                {!isOAuth && (
                  <button type="button" className="btn" onClick={test} disabled={!!busy}>
                    {busy === 'test' ? 'Testing…' : 'Test connection'}
                  </button>
                )}
                <button type="button" className="btn btn-ghost" onClick={() => (account ? onDone() : setStep('email'))}>
                  {account ? 'Cancel' : 'Back'}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </form>
  );
}
