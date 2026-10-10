import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import type { Security } from '../../types';
import { Icon } from '../Icon';
import { Spinner, formatDate, useAction, useToast } from '../ui';

type MailMode = 'builtin' | 'stalwart' | 'external' | 'off';
type OutboundMode = 'direct' | 'relay' | 'off';
interface HostPort {
  host: string;
  port: number;
  security: Security;
}

interface ServerState {
  chatDomain: string;
  mailDomain: string;
  mailHostname: string;
  mailMode: MailMode;
  mailModes: MailMode[];
  chatFederation: boolean;
  federationAvailable: boolean;
  xmpp: { status: 'off' | 'connecting' | 'online' | 'error'; lastError: string | null; domain: string } | null;
  outboundMode: OutboundMode;
  relay: (HostPort & { username: string; hasPassword: boolean }) | null;
  externalServer: { imap: HostPort; smtp: HostPort } | null;
  builtin: {
    smtp: { listening: boolean; port: number; error: string | null };
    queue: { id: number; from: string; to: string; attempts: number; nextAttempt: number; lastError: string | null; createdAt: number }[];
    dns: { type: string; name: string; value: string; note: string }[];
  } | null;
  stalwart: { configured: boolean; ok?: boolean | null; error?: string | null; dnsZone?: string | null };
  provisionErrors: { username: string; error: string }[];
}

const MODE_INFO: Record<MailMode, { title: string; text: string }> = {
  builtin: {
    title: 'Built-in mail server',
    text: 'HomeMail gives every user a mailbox and receives mail over SMTP itself. Simple, but mailboxes can only be read in HomeMail (no IMAP for other apps) and there is no spam filter.',
  },
  stalwart: {
    title: 'Stalwart (bundled)',
    text: 'A full mail server running next to HomeMail. Every user gets a real IMAP mailbox that also works in Thunderbird and on phones, with spam filtering and DKIM.',
  },
  external: {
    title: 'Another mail server on this domain',
    text: 'Your domain\'s mail is handled by a server you already run. HomeMail pre-fills its settings when users add their address, but does not create mailboxes.',
  },
  off: { title: 'Off', text: 'HomeMail does not host email. Users only add their outside accounts.' },
};

const SECURITY_LABEL: Record<Security, string> = { tls: 'SSL/TLS', starttls: 'STARTTLS', none: 'None' };

function HostPortFields({ value, onChange, label }: { value: HostPort; onChange: (v: HostPort) => void; label: string }) {
  return (
    <fieldset className="server-fields">
      <legend>{label}</legend>
      <label className="grow">
        Server
        <input value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value })} required />
      </label>
      <label className="port">
        Port
        <input type="number" min={1} max={65535} value={value.port} onChange={(e) => onChange({ ...value, port: Number(e.target.value) })} required />
      </label>
      <label>
        Security
        <select value={value.security} onChange={(e) => onChange({ ...value, security: e.target.value as Security })}>
          {(Object.keys(SECURITY_LABEL) as Security[]).map((s) => (
            <option key={s} value={s}>
              {SECURITY_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}

const StatusDot = ({ ok, warn }: { ok: boolean; warn?: boolean }) => <span className={`status-dot ${ok ? 'ok' : warn ? 'warn' : 'bad'}`} aria-hidden="true" />;

export function ServerSettings() {
  const run = useAction();
  const toast = useToast();
  const [state, setState] = useState<ServerState | null>(null);
  const [domains, setDomains] = useState({ chatDomain: '', mailDomain: '', mailHostname: '' });
  const [mode, setMode] = useState<MailMode>('builtin');
  const [outbound, setOutbound] = useState<OutboundMode>('direct');
  const [relay, setRelay] = useState<HostPort & { username: string; password: string }>({ host: '', port: 587, security: 'starttls', username: '', password: '' });
  const [external, setExternal] = useState<{ imap: HostPort; smtp: HostPort }>({
    imap: { host: '', port: 993, security: 'tls' },
    smtp: { host: '', port: 465, security: 'tls' },
  });
  const [saving, setSaving] = useState(false);

  const apply = useCallback((s: ServerState) => {
    setState(s);
    setDomains({ chatDomain: s.chatDomain, mailDomain: s.mailDomain, mailHostname: s.mailHostname });
    setMode(s.mailMode);
    setOutbound(s.outboundMode);
    if (s.relay) setRelay({ ...s.relay, password: '' });
    if (s.externalServer) setExternal(s.externalServer);
  }, []);

  const load = useCallback(async () => apply(await api<ServerState>('GET', '/admin/server')), [apply]);
  useEffect(() => {
    run(load);
  }, [load, run]);

  const save = async (body: Record<string, unknown>, message = 'Saved') => {
    setSaving(true);
    const s = await run(() => api<ServerState>('PUT', '/admin/server', body), message);
    setSaving(false);
    if (s) apply(s);
  };

  if (!state) return <Spinner label="Loading…" />;

  const saveDomains = (e: FormEvent) => {
    e.preventDefault();
    const changedMail = domains.mailDomain !== state.mailDomain;
    if (changedMail && !confirm(`Change the mail domain to ${domains.mailDomain}? Everyone's mailbox address changes to user@${domains.mailDomain}.`)) return;
    save(domains);
  };

  const saveMail = (e: FormEvent) => {
    e.preventDefault();
    if (mode !== state.mailMode && !confirm(`Switch the mail server to "${MODE_INFO[mode].title}"? Mailboxes of the current mode are kept, but users will start using new ones.`)) return;
    save({
      mailMode: mode,
      ...(mode === 'builtin' ? { outboundMode: outbound, relay: outbound === 'relay' ? { ...relay, password: relay.password || undefined } : undefined } : {}),
      ...(mode === 'external' ? { externalServer: external } : {}),
    });
  };

  const xmppOk = state.xmpp?.status === 'online';

  return (
    <div className="settings-section">
      <h1>Server</h1>

      <form className="card stack" onSubmit={saveDomains}>
        <h2 className="card-title">Domains</h2>
        <p className="muted small">
          Users get <span className="mono">username@chat domain</span> for chat and <span className="mono">username@mail domain</span> for email. Use a domain you own if
          you want to reach people outside this server.
        </p>
        <div className="grid-2">
          <label>
            Chat domain
            <input value={domains.chatDomain} onChange={(e) => setDomains({ ...domains, chatDomain: e.target.value })} required />
          </label>
          <label>
            Mail domain
            <input value={domains.mailDomain} onChange={(e) => setDomains({ ...domains, mailDomain: e.target.value })} required />
          </label>
          <label>
            Mail host name <span className="muted">(MX / SMTP greeting)</span>
            <input value={domains.mailHostname} onChange={(e) => setDomains({ ...domains, mailHostname: e.target.value })} required />
          </label>
        </div>
        <div className="form-actions">
          <button className="btn btn-primary" disabled={saving}>
            Save domains
          </button>
        </div>
      </form>

      <section className="card stack">
        <h2 className="card-title">Chat with other servers (XMPP federation)</h2>
        {state.federationAvailable ? (
          <>
            <label className="inline">
              <input type="checkbox" checked={state.chatFederation} disabled={saving} onChange={(e) => save({ chatFederation: e.target.checked }, e.target.checked ? 'Federation on' : 'Federation off')} />
              Let people on other XMPP servers chat with users here
            </label>
            {state.chatFederation && (
              <p className="small">
                <StatusDot ok={xmppOk} warn={state.xmpp?.status === 'connecting'} /> Link to the XMPP server: <strong>{state.xmpp?.status}</strong>
                {state.xmpp?.lastError && <span className="error-text"> · {state.xmpp.lastError}</span>}
              </p>
            )}
            <p className="muted small">
              The Prosody container must be configured for <span className="mono">{state.chatDomain}</span> (HOMEMAIL_CHAT_DOMAIN). For the public XMPP network,
              publish <span className="mono">_xmpp-server._tcp.{state.chatDomain}</span> (SRV, port 5269), open port 5269, and give Prosody a certificate for the domain.
            </p>
          </>
        ) : (
          <p className="muted small">Not available: start HomeMail with the bundled Prosody (Docker Compose) or set XMPP_COMPONENT_SERVICE.</p>
        )}
      </section>

      <form className="card stack" onSubmit={saveMail}>
        <h2 className="card-title">Mail server</h2>
        <div className="mode-list" role="radiogroup">
          {(['builtin', 'stalwart', 'external', 'off'] as MailMode[]).map((m) => {
            const available = state.mailModes.includes(m);
            return (
              <label key={m} className={`mode-option ${mode === m ? 'selected' : ''} ${available ? '' : 'disabled'}`}>
                <input type="radio" name="mode" checked={mode === m} disabled={!available} onChange={() => setMode(m)} />
                <span>
                  <strong>{MODE_INFO[m].title}</strong>
                  {state.mailMode === m && <span className="tag">current</span>}
                  <span className="muted small block">{available ? MODE_INFO[m].text : 'Not available: start HomeMail with the bundled Stalwart (Docker Compose) or set STALWART_URL.'}</span>
                </span>
              </label>
            );
          })}
        </div>

        {mode === 'builtin' && (
          <div className="stack">
            <h3 className="sub">Sending to other domains</h3>
            <div className="radio-row">
              {(
                [
                  ['direct', 'Deliver directly to the recipient\'s server', 'Needs outgoing port 25, which many home internet connections block.'],
                  ['relay', 'Send through a relay (smarthost)', 'e.g. your ISP, SMTP2GO, Mailgun, Amazon SES. Most reliable from home.'],
                  ['off', 'Only mail between users on this server', ''],
                ] as const
              ).map(([v, title, note]) => (
                <label key={v} className="inline">
                  <input type="radio" name="outbound" checked={outbound === v} onChange={() => setOutbound(v)} />
                  <span>
                    {title}
                    {note && <span className="muted small"> · {note}</span>}
                  </span>
                </label>
              ))}
            </div>
            {outbound === 'relay' && (
              <div className="server-settings">
                <HostPortFields label="Relay server" value={relay} onChange={(v) => setRelay({ ...relay, ...v })} />
                <div className="grid-2">
                  <label>
                    Username
                    <input value={relay.username} onChange={(e) => setRelay({ ...relay, username: e.target.value })} autoComplete="off" />
                  </label>
                  <label>
                    Password {state.relay?.hasPassword && <span className="muted">(leave empty to keep)</span>}
                    <input type="password" value={relay.password} onChange={(e) => setRelay({ ...relay, password: e.target.value })} autoComplete="new-password" />
                  </label>
                </div>
              </div>
            )}
          </div>
        )}

        {mode === 'external' && (
          <div className="server-settings">
            <p className="muted small">Shown to users who add an address @{state.mailDomain}.</p>
            <HostPortFields label="Incoming (IMAP)" value={external.imap} onChange={(imap) => setExternal({ ...external, imap })} />
            <HostPortFields label="Outgoing (SMTP)" value={external.smtp} onChange={(smtp) => setExternal({ ...external, smtp })} />
          </div>
        )}

        <div className="form-actions">
          <button className="btn btn-primary" disabled={saving}>
            {saving ? 'Applying…' : 'Save mail settings'}
          </button>
          {(state.mailMode === 'builtin' || state.mailMode === 'stalwart') && (
            <button type="button" className="btn" disabled={saving} onClick={() => run(async () => apply(await api<ServerState>('POST', '/admin/server/provision')), 'Mailboxes checked')}>
              <Icon name="refresh" /> Set up missing mailboxes
            </button>
          )}
        </div>

        {state.provisionErrors.length > 0 && (
          <div className="card warn">
            <strong>Mailboxes that could not be set up</strong>
            <ul>
              {state.provisionErrors.map((p) => (
                <li key={p.username}>
                  <strong>{p.username}</strong>: {p.error}
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>

      {state.mailMode === 'builtin' && state.builtin && (
        <section className="card stack">
          <h2 className="card-title">Built-in server status</h2>
          <p className="small">
            <StatusDot ok={state.builtin.smtp.listening} /> Incoming SMTP{' '}
            {state.builtin.smtp.listening ? (
              <>
                listening on port <strong>{state.builtin.smtp.port}</strong>. Forward port 25 from the internet to it to receive outside mail.
              </>
            ) : (
              <span className="error-text">not running{state.builtin.smtp.error ? `: ${state.builtin.smtp.error}` : ''}</span>
            )}
          </p>
          <h3 className="sub">DNS records to publish</h3>
          <div className="table-wrap">
            <table className="table dns-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Name</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {state.builtin.dns.map((r) => (
                  <tr key={r.type + r.name}>
                    <td>{r.type}</td>
                    <td className="mono">{r.name}</td>
                    <td>
                      <span className="mono break">{r.value}</span>
                      <div className="muted small">{r.note}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="sub">Outgoing queue</h3>
          {state.builtin.queue.length === 0 ? (
            <p className="muted small">Empty: all outgoing mail has been delivered.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>To</th>
                    <th>Queued</th>
                    <th>Attempts / last error</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {state.builtin.queue.map((q) => (
                    <tr key={q.id}>
                      <td>
                        {q.to}
                        <div className="muted small">from {q.from}</div>
                      </td>
                      <td>{formatDate(new Date(q.createdAt).toISOString())}</td>
                      <td>
                        {q.attempts}
                        {q.lastError && <div className="error-text small">{q.lastError}</div>}
                        <div className="muted small">next try {formatDate(new Date(q.nextAttempt).toISOString())}</div>
                      </td>
                      <td className="row-actions">
                        <button className="btn btn-sm" onClick={() => run(() => api('POST', `/admin/server/queue/${q.id}/retry`).then(load), 'Retrying')}>
                          Retry now
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => confirm('Drop this message without delivering it?') && run(() => api('DELETE', `/admin/server/queue/${q.id}`).then(load))}>
                          Drop
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {state.mailMode === 'stalwart' && (
        <section className="card stack">
          <h2 className="card-title">Stalwart status</h2>
          <p className="small">
            <StatusDot ok={!!state.stalwart.ok} /> {state.stalwart.ok ? `Connected; serving @${state.mailDomain}.` : <span className="error-text">{state.stalwart.error}</span>}
          </p>
          {state.stalwart.dnsZone && (
            <>
              <h3 className="sub">DNS records to publish</h3>
              <p className="muted small">Generated by Stalwart for {state.mailDomain}. Spam filtering, relays and certificates are configured in Stalwart's own admin page.</p>
              <div className="zone-wrap">
                <button className="icon-btn icon-btn-sm zone-copy" title="Copy" aria-label="Copy DNS records" onClick={() => navigator.clipboard?.writeText(state.stalwart.dnsZone!).then(() => toast('Copied', 'success'))}>
                  <Icon name="copy" size={13} />
                </button>
                <pre className="zone">{state.stalwart.dnsZone}</pre>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
