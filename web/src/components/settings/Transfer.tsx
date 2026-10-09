import { useState, type ReactNode } from 'react';
import { api, apiDownload } from '../../api';
import { useApp } from '../../context';
import { Icon } from '../Icon';
import { Modal, useToast } from '../ui';

interface Format {
  id: string;
  /** "qr" shows scannable codes instead of downloading a file. */
  kind?: 'file' | 'qr';
  title: string;
  clients: string;
  description: ReactNode;
  icon: string;
  /** Whether including passwords makes sense for this format. */
  passwords: boolean;
}

export const FORMATS: Format[] = [
  {
    id: 'thunderbird',
    title: 'Thunderbird',
    clients: 'Windows, macOS, Linux',
    icon: 'mail',
    passwords: false,
    description: (
      <>
        A .zip that Thunderbird imports directly: <b>Tools → Import → Import from another Thunderbird installation → Select a profile folder or zip file</b>.
        Accounts are added next to your existing ones. Thunderbird asks for each password on first use, and opens the Google/Microsoft sign-in for those accounts.
      </>
    ),
  },
  {
    id: 'qr',
    kind: 'qr',
    title: 'Thunderbird for Android',
    clients: 'Scan QR codes on the phone',
    icon: 'qr',
    passwords: true,
    description: (
      <>
        The same QR codes as Thunderbird desktop's “Export for Mobile”. In Thunderbird for Android choose <b>Import from Thunderbird desktop</b> while
        setting up (or Settings → Import settings) and scan each code. Without passwords included, the app asks for them.
      </>
    ),
  },
  {
    id: 'k9',
    title: 'K-9 Mail',
    clients: 'K-9 Mail, Thunderbird for Android',
    icon: 'file',
    passwords: true,
    description: (
      <>
        A <code>.k9s</code> settings file. Copy it to the phone, then in the app open <b>Settings → Import settings</b> and pick the file. Accounts
        without a password in the file ask for it after import.
      </>
    ),
  },
  {
    id: 'apple',
    title: 'Apple Mail',
    clients: 'macOS, iPhone, iPad',
    icon: 'mail',
    passwords: true,
    description: (
      <>
        A <code>.mobileconfig</code> profile. Open it on the Mac (System Settings → Profiles) or AirDrop/email it to the iPhone and install it under
        Settings → Profile Downloaded. Google and Microsoft sign-in accounts are skipped: add those in Apple Mail directly.
      </>
    ),
  },
  {
    id: 'autoconfig',
    title: 'Autoconfig XML',
    clients: 'Evolution, KMail, FairEmail, Nextcloud Mail, Thunderbird',
    icon: 'code',
    passwords: false,
    description: (
      <>
        Mozilla's <code>config-v1.1.xml</code> format, which many clients read during account setup. Serve it at{' '}
        <code>autoconfig.yourdomain/mail/config-v1.1.xml</code> or import it where the client supports that.
      </>
    ),
  },
  {
    id: 'sheet',
    title: 'Settings sheet',
    clients: 'Outlook, eM Client, Mailspring, Gmail app, anything',
    icon: 'file',
    passwords: true,
    description: <>A plain-text list of every server, port and username, to type into any client by hand.</>,
  },
  {
    id: 'json',
    title: 'HomeMail backup',
    clients: 'Another HomeMail server or user',
    icon: 'archive',
    passwords: true,
    description: <>JSON with all account settings. Import it below on any HomeMail instance.</>,
  },
];

interface Note {
  label: string;
  reason: string;
}
interface ImportResult {
  created: { label: string }[];
  skipped: Note[];
  notes: Note[];
}

export function Transfer() {
  const { accounts, reloadAccounts } = useApp();
  const toast = useToast();
  const [format, setFormat] = useState<Format | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [includePasswords, setIncludePasswords] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState<{ label: string; reason: string }[]>([]);
  const [qrCodes, setQrCodes] = useState<{ part: number; count: number; dataUrl: string; accounts: string[] }[] | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const open = (f: Format) => {
    setFormat(f);
    setChosen(new Set(accounts.map((a) => a.id)));
    setIncludePasswords(false);
    setCurrentPassword('');
    setSkipped([]);
    setQrCodes(null);
  };

  const doExport = async () => {
    if (!format) return;
    setBusy(true);
    const body = {
      format: format.id,
      accountIds: [...chosen],
      includePasswords,
      currentPassword: includePasswords ? currentPassword : undefined,
    };
    try {
      if (format.kind === 'qr') {
        const r = await api<{ codes: { part: number; count: number; dataUrl: string; accounts: string[] }[]; skipped: { label: string; reason: string }[] }>('POST', '/export/qr', body);
        setQrCodes(r.codes);
        setSkipped(r.skipped);
        return;
      }
      const s = await apiDownload('/export', body);
      setSkipped(s);
      if (!s.length) setFormat(null);
      toast('Export downloaded', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const doc = JSON.parse(await file.text());
      const r = await api<ImportResult>('POST', '/import/json', doc);
      setImportResult(r);
      reloadAccounts();
    } catch (e) {
      toast(e instanceof SyntaxError ? 'That file is not valid JSON' : (e as Error).message, 'error');
    }
  };

  const importThunderbird = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 10_000_000) return toast('That file is too large to be prefs.js', 'error');
    try {
      const r = await api<ImportResult>('POST', '/import/thunderbird', { prefs: await file.text() });
      setImportResult(r);
      reloadAccounts();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="settings-section">
      <h1>Export accounts</h1>
      <p className="muted">
        Take your account settings to another mail client. Exports contain server settings and usernames; mail passwords are only included if you ask for them.
      </p>
      <div className="format-grid">
        {FORMATS.map((f) => (
          <button key={f.id} className="card format-card" onClick={() => open(f)} disabled={!accounts.length}>
            <Icon name={f.icon} size={22} />
            <strong>{f.title}</strong>
            <span className="muted small">{f.clients}</span>
          </button>
        ))}
      </div>

      <h1 className="section-gap">Import accounts</h1>
      <div className="card import-card">
        <div>
          <strong>From Thunderbird (prefs.js)</strong>
          <p className="muted small">
            In Thunderbird open <b>Help → Troubleshooting Information → Profile Folder → Open Folder</b> and pick the <code>prefs.js</code> file there. Server settings,
            names and signatures come across; passwords are stored encrypted by Thunderbird, so you'll enter them (or app passwords) afterwards.
          </p>
        </div>
        <label className="btn">
          <Icon name="upload" /> Choose prefs.js
          <input type="file" accept=".js,text/javascript" hidden onChange={(e) => (importThunderbird(e.target.files?.[0]), (e.target.value = ''))} />
        </label>
      </div>
      <div className="card import-card">
        <div>
          <strong>HomeMail backup (.json)</strong>
          <p className="muted small">Accounts that already exist are skipped. Accounts without a password, or with Google/Microsoft sign-in, need to be completed afterwards.</p>
        </div>
        <label className="btn">
          <Icon name="upload" /> Choose file
          <input type="file" accept=".json,application/json" hidden onChange={(e) => (importFile(e.target.files?.[0]), (e.target.value = ''))} />
        </label>
      </div>

      {format && (
        <Modal
          wide={!!qrCodes}
          title={`Export for ${format.title}`}
          onClose={() => setFormat(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setFormat(null)}>
                Close
              </button>
              <button className="btn btn-primary" onClick={doExport} disabled={busy || !chosen.size || (includePasswords && !currentPassword)}>
                <Icon name={format.kind === 'qr' ? 'qr' : 'download'} /> {busy ? 'Preparing…' : format.kind === 'qr' ? 'Show QR codes' : 'Download'}
              </button>
            </>
          }
        >
          <p className="muted">{format.description}</p>
          <fieldset className="checklist">
            <legend>Accounts</legend>
            {accounts.map((a) => (
              <label key={a.id} className="inline">
                <input
                  type="checkbox"
                  checked={chosen.has(a.id)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    e.target.checked ? next.add(a.id) : next.delete(a.id);
                    setChosen(next);
                  }}
                />
                {a.label} <span className="muted small">{a.email}</span>
              </label>
            ))}
          </fieldset>
          {format.passwords && (
            <>
              <label className="inline">
                <input type="checkbox" checked={includePasswords} onChange={(e) => setIncludePasswords(e.target.checked)} />
                Include mail passwords
              </label>
              {includePasswords && (
                <>
                  <p className="warn-text small">Anyone with the exported file can read these passwords. Delete it after use.</p>
                  <label>
                    Confirm with your HomeMail password
                    <input type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
                  </label>
                </>
              )}
            </>
          )}
          {qrCodes && (
            <div className="qr-grid">
              {qrCodes.map((c) => (
                <figure key={c.part}>
                  <img src={c.dataUrl} alt={`QR code ${c.part} of ${c.count}`} />
                  <figcaption className="small">
                    {c.part} of {c.count}: {c.accounts.join(', ')}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
          {skipped.length > 0 && (
            <div className="card warn">
              <strong>Not included:</strong>
              <ul>
                {skipped.map((s) => (
                  <li key={s.label}>
                    <strong>{s.label}</strong>: {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Modal>
      )}

      {importResult && (
        <Modal title="Import finished" onClose={() => setImportResult(null)}>
          <p>
            Added {importResult.created.length} account{importResult.created.length === 1 ? '' : 's'}.
          </p>
          {importResult.notes.length > 0 && (
            <>
              <p>Needs attention:</p>
              <ul>
                {importResult.notes.map((s, i) => (
                  <li key={i}>
                    <strong>{s.label}</strong>: {s.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
          {importResult.skipped.length > 0 && (
            <>
              <p>Skipped:</p>
              <ul>
                {importResult.skipped.map((s, i) => (
                  <li key={i}>
                    <strong>{s.label}</strong>: {s.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="muted small">
            Check <a href="#/settings/accounts">Mail accounts</a> for accounts that still need a password or sign-in.
          </p>
        </Modal>
      )}
    </div>
  );
}
