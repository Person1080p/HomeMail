import dns from 'node:dns/promises';
import { XMLParser } from 'fast-xml-parser';
import { config } from './config.js';
import { externalServer, mailDomain, mailMode } from './server-settings.js';

export type Security = 'tls' | 'starttls' | 'none';
export interface ServerSettings {
  host: string;
  port: number;
  security: Security;
}

export interface ProviderPreset {
  id: string;
  name: string;
  /** Domains matched exactly, or regexes for families like hotmail.* */
  domains: (string | RegExp)[];
  imap?: ServerSettings;
  pop3?: ServerSettings;
  smtp?: ServerSettings;
  authMethods: ('password' | 'oauth2')[];
  oauthProvider?: 'google' | 'microsoft';
  /** The provider files messages sent over SMTP in Sent by itself, so we must not append a copy. */
  smtpSavesSent?: boolean;
  allowInsecureTls?: boolean;
  supported: boolean;
  /** Short guidance shown in the add-account form. */
  notes: string;
  helpUrl?: string;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: 'gmail',
    name: 'Gmail / Google Workspace',
    domains: ['gmail.com', 'googlemail.com'],
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
    pop3: { host: 'pop.gmail.com', port: 995, security: 'tls' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    authMethods: ['password', 'oauth2'],
    oauthProvider: 'google',
    smtpSavesSent: true,
    supported: true,
    notes:
      'Use "Sign in with Google" if your admin configured it. Otherwise turn on 2-Step Verification and create an app password, then use it here instead of your normal password.',
    helpUrl: 'https://myaccount.google.com/apppasswords',
  },
  {
    id: 'outlook',
    name: 'Outlook.com / Hotmail / Live',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'passport.com', /^(outlook|hotmail|live|windowslive)\.[a-z.]+$/],
    imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
    pop3: { host: 'outlook.office365.com', port: 995, security: 'tls' },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' },
    authMethods: ['oauth2'],
    oauthProvider: 'microsoft',
    smtpSavesSent: true,
    supported: true,
    notes:
      'Microsoft no longer accepts passwords (or app passwords) for Outlook.com over IMAP/SMTP. You need "Sign in with Microsoft", which your HomeMail admin must configure (see README).',
    helpUrl: 'https://support.microsoft.com/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040',
  },
  {
    id: 'office365',
    name: 'Microsoft 365 (work / school)',
    domains: [],
    imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
    pop3: { host: 'outlook.office365.com', port: 995, security: 'tls' },
    smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
    authMethods: ['oauth2'],
    oauthProvider: 'microsoft',
    smtpSavesSent: true,
    supported: true,
    notes:
      'Requires "Sign in with Microsoft". Your organisation must allow IMAP and authenticated SMTP for your mailbox.',
  },
  {
    id: 'yahoo',
    name: 'Yahoo Mail',
    domains: ['ymail.com', 'rocketmail.com', /^yahoo\.[a-z.]+$/],
    imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'tls' },
    pop3: { host: 'pop.mail.yahoo.com', port: 995, security: 'tls' },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'tls' },
    authMethods: ['password'],
    supported: true,
    notes: 'Yahoo requires an app password: Account Info → Account Security → Generate app password.',
    helpUrl: 'https://login.yahoo.com/account/security',
  },
  {
    id: 'aol',
    name: 'AOL Mail',
    domains: ['aol.com', 'aim.com'],
    imap: { host: 'imap.aol.com', port: 993, security: 'tls' },
    pop3: { host: 'pop.aol.com', port: 995, security: 'tls' },
    smtp: { host: 'smtp.aol.com', port: 465, security: 'tls' },
    authMethods: ['password'],
    supported: true,
    notes: 'AOL requires an app password: Account Security → Generate app password.',
    helpUrl: 'https://login.aol.com/account/security',
  },
  {
    id: 'icloud',
    name: 'iCloud Mail (Apple)',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    authMethods: ['password'],
    supported: true,
    notes:
      'Apple requires an app-specific password: sign in at account.apple.com → Sign-In and Security → App-Specific Passwords. iCloud does not offer POP3.',
    helpUrl: 'https://support.apple.com/102654',
  },
  {
    id: 'proton',
    name: 'Proton Mail (via Proton Mail Bridge)',
    domains: ['proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me'],
    imap: { host: 'protonmail-bridge', port: 143, security: 'starttls' },
    smtp: { host: 'protonmail-bridge', port: 25, security: 'starttls' },
    authMethods: ['password'],
    smtpSavesSent: true,
    allowInsecureTls: true,
    supported: true,
    notes:
      'Proton Mail is only reachable over IMAP/SMTP through Proton Mail Bridge (paid Proton plan). Run the Bridge in your homelab (see README / docker-compose.yml) and use the username and password the Bridge shows you, not your Proton password. Bridge uses a self-signed certificate.',
    helpUrl: 'https://proton.me/mail/bridge',
  },
  {
    id: 'tuta',
    name: 'Tuta (Tutanota)',
    domains: ['tuta.com', 'tuta.io', 'tutanota.com', 'tutanota.de', 'tutamail.com', 'keemail.me'],
    authMethods: [],
    supported: false,
    notes:
      'Tuta does not offer IMAP, POP3 or SMTP access and there is no official bridge, so no third-party mail client (including Thunderbird) can connect to it. Use the Tuta app, or set up forwarding from Tuta to another mailbox.',
    helpUrl: 'https://tuta.com/support#imap',
  },
  {
    id: 'fastmail',
    name: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm', 'messagingengine.com'],
    imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
    pop3: { host: 'pop.fastmail.com', port: 995, security: 'tls' },
    smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
    authMethods: ['password'],
    supported: true,
    notes: 'Create an app password in Fastmail: Settings → Privacy & Security → App passwords.',
  },
  {
    id: 'zoho',
    name: 'Zoho Mail',
    domains: ['zoho.com', 'zohomail.com'],
    imap: { host: 'imap.zoho.com', port: 993, security: 'tls' },
    pop3: { host: 'pop.zoho.com', port: 995, security: 'tls' },
    smtp: { host: 'smtp.zoho.com', port: 465, security: 'tls' },
    authMethods: ['password'],
    supported: true,
    notes: 'Enable IMAP access in Zoho Mail settings. If you use 2FA, create an app-specific password. EU accounts use imap.zoho.eu / smtp.zoho.eu.',
  },
  {
    id: 'gmx',
    name: 'GMX',
    domains: ['gmx.com', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch'],
    imap: { host: 'imap.gmx.com', port: 993, security: 'tls' },
    pop3: { host: 'pop.gmx.com', port: 995, security: 'tls' },
    smtp: { host: 'mail.gmx.com', port: 587, security: 'starttls' },
    authMethods: ['password'],
    supported: true,
    notes: 'Enable "POP3/IMAP access" in GMX settings first. German accounts (gmx.de/.net) use imap.gmx.net / mail.gmx.net.',
  },
  {
    id: 'imap',
    name: 'Other (IMAP)',
    domains: [],
    imap: { host: '', port: 993, security: 'tls' },
    smtp: { host: '', port: 587, security: 'starttls' },
    authMethods: ['password'],
    supported: true,
    notes: 'Enter the IMAP and SMTP server details from your provider.',
  },
  {
    id: 'pop3',
    name: 'Other (POP3)',
    domains: [],
    pop3: { host: '', port: 995, security: 'tls' },
    smtp: { host: '', port: 587, security: 'starttls' },
    authMethods: ['password'],
    supported: true,
    notes: 'POP3 downloads mail into HomeMail. Choose whether to leave copies on the server.',
  },
];

export const presetById = (id: string) => PRESETS.find((p) => p.id === id);

function presetForDomain(domain: string): ProviderPreset | undefined {
  return PRESETS.find((p) => p.domains.some((d) => (typeof d === 'string' ? d === domain : d.test(domain))));
}

/** MX host suffixes of hosted mail services, for custom domains. */
const MX_HINTS: [RegExp, string][] = [
  [/(^|\.)(google|googlemail)\.com$/, 'gmail'],
  [/\.mail\.protection\.outlook\.com$/, 'office365'],
  [/(^|\.)protonmail\.ch$/, 'proton'],
  [/(^|\.)icloud\.com$/, 'icloud'],
  [/(^|\.)yahoodns\.net$/, 'yahoo'],
  [/(^|\.)tutanota\.de$/, 'tuta'],
  [/(^|\.)messagingengine\.com$/, 'fastmail'],
  [/(^|\.)zoho\.(com|eu)$/, 'zoho'],
];

export interface DetectResult {
  presetId: string;
  source: 'known-domain' | 'mx' | 'ispdb' | 'guess' | 'server';
  protocol: 'imap' | 'pop3';
  incoming?: ServerSettings;
  smtp?: ServerSettings;
  username: string;
}

function fromPreset(p: ProviderPreset, email: string, source: DetectResult['source']): DetectResult {
  return {
    presetId: p.id,
    source,
    protocol: p.imap ? 'imap' : 'pop3',
    incoming: p.imap ?? p.pop3,
    smtp: p.smtp,
    username: email,
  };
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', isArray: (n) => ['incomingServer', 'outgoingServer'].includes(n) });

interface IspdbServer {
  '@type': string;
  hostname: string;
  port: number | string;
  socketType: string;
  username?: string;
}

function expandUsername(tpl: string | undefined, email: string) {
  const [local, domain] = email.split('@');
  return (tpl || '%EMAILADDRESS%')
    .replace('%EMAILADDRESS%', email)
    .replace('%EMAILLOCALPART%', local)
    .replace('%EMAILDOMAIN%', domain);
}

const socket = (s: string): Security => (s === 'SSL' ? 'tls' : s === 'STARTTLS' ? 'starttls' : 'none');

/** Queries Mozilla's ISPDB, the database Thunderbird's account wizard uses. */
async function lookupIspdb(domain: string, email: string): Promise<DetectResult | null> {
  if (!/^[a-z0-9.-]+$/i.test(domain)) return null;
  const res = await fetch(`https://autoconfig.thunderbird.net/v1.1/${domain}`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const doc = xml.parse(await res.text());
  const prov = doc?.clientConfig?.emailProvider;
  if (!prov) return null;
  const ins: IspdbServer[] = prov.incomingServer || [];
  const imap = ins.find((s) => s['@type'] === 'imap');
  const incoming = imap ?? ins.find((s) => s['@type'] === 'pop3');
  const out: IspdbServer | undefined = (prov.outgoingServer || [])[0];
  if (!incoming) return null;
  return {
    presetId: imap ? 'imap' : 'pop3',
    source: 'ispdb',
    protocol: imap ? 'imap' : 'pop3',
    incoming: { host: incoming.hostname, port: Number(incoming.port), security: socket(incoming.socketType) },
    smtp: out ? { host: out.hostname, port: Number(out.port), security: socket(out.socketType) } : undefined,
    username: expandUsername(incoming.username, email),
  };
}

export async function autodetect(email: string): Promise<DetectResult> {
  const domain = email.split('@')[1]?.toLowerCase().trim() || '';
  // The admin's own mail server (Settings → Server → "external server").
  const ext = mailMode() === 'external' ? externalServer() : null;
  if (ext && domain === mailDomain()) {
    return { presetId: 'imap', source: 'server', protocol: 'imap', incoming: ext.imap, smtp: ext.smtp, username: email };
  }
  const known = presetForDomain(domain);
  if (known) return fromPreset(known, email, 'known-domain');

  let mxHosts: string[] = [];
  try {
    mxHosts = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((m) => m.exchange.toLowerCase());
  } catch {
    /* no MX: fall through */
  }
  for (const mx of mxHosts) {
    for (const [re, id] of MX_HINTS) if (re.test(mx)) return fromPreset(presetById(id)!, email, 'mx');
  }

  if (config.autodetectOnline) {
    try {
      const r = await lookupIspdb(domain, email);
      if (r) return r;
      // Hosted domains are often listed under their mail host's domain instead.
      const mxDomain = mxHosts[0]?.split('.').slice(-2).join('.');
      if (mxDomain && mxDomain !== domain) {
        const r2 = await lookupIspdb(mxDomain, email);
        if (r2) return r2;
      }
    } catch {
      /* offline or blocked: fall back to a guess */
    }
  }

  return {
    presetId: 'imap',
    source: 'guess',
    protocol: 'imap',
    incoming: { host: `imap.${domain}`, port: 993, security: 'tls' },
    smtp: { host: `smtp.${domain}`, port: 587, security: 'starttls' },
    username: email,
  };
}
