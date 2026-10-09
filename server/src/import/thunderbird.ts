import type { Security } from '../providers.js';
import type { ImportAccount } from '../routes/transfer.js';

type PrefValue = string | number | boolean;

/** Reads user_pref("name", value); lines from a Thunderbird prefs.js. */
export function parsePrefs(text: string): Map<string, PrefValue> {
  const prefs = new Map<string, PrefValue>();
  const re = /^\s*user_pref\(\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*"|-?\d+|true|false)\s*\)\s*;/gm;
  for (const m of text.matchAll(re)) {
    try {
      prefs.set(JSON.parse(m[1]), JSON.parse(m[2]));
    } catch {
      /* skip prefs with escapes JSON can't read */
    }
  }
  return prefs;
}

const SECURITY: Record<number, Security> = { 0: 'none', 1: 'starttls', 2: 'starttls', 3: 'tls' };
const OAUTH_HOSTS: [RegExp, 'google' | 'microsoft'][] = [
  [/(^|\.)gmail\.com$|(^|\.)googlemail\.com$/i, 'google'],
  [/(^|\.)office365\.com$|(^|\.)outlook\.com$/i, 'microsoft'],
];

export interface ThunderbirdImport {
  accounts: ImportAccount[];
  notes: { label: string; reason: string }[];
}

/**
 * Turns Thunderbird's account prefs into HomeMail accounts. Passwords live encrypted
 * in logins.json/key4.db and can't be read, so every password account needs its password re-entered.
 */
export function accountsFromPrefs(text: string): ThunderbirdImport {
  const p = parsePrefs(text);
  const str = (k: string) => (typeof p.get(k) === 'string' ? (p.get(k) as string) : undefined);
  const num = (k: string) => (typeof p.get(k) === 'number' ? (p.get(k) as number) : undefined);
  const bool = (k: string) => (typeof p.get(k) === 'boolean' ? (p.get(k) as boolean) : undefined);

  const accounts: ImportAccount[] = [];
  const notes: ThunderbirdImport['notes'] = [];
  const accountKeys = (str('mail.accountmanager.accounts') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const defaultSmtp = str('mail.smtp.defaultserver') ?? (str('mail.smtpservers') ?? '').split(',')[0];

  for (const acc of accountKeys) {
    const serverKey = str(`mail.account.${acc}.server`);
    if (!serverKey) continue;
    const s = `mail.server.${serverKey}.`;
    const type = str(`${s}type`);
    const host = str(`${s}realhostname`) ?? str(`${s}hostname`);
    const label = str(`${s}name`) ?? host ?? acc;
    if (type !== 'imap' && type !== 'pop3') {
      if (type && type !== 'none') notes.push({ label, reason: `${type === 'nntp' ? 'Newsgroup' : type.toUpperCase()} accounts are not supported` });
      continue;
    }
    if (!host) continue;

    const identityKey = (str(`mail.account.${acc}.identities`) ?? '').split(',')[0];
    const id = `mail.identity.${identityKey}.`;
    const email = (str(`${id}useremail`) ?? '').trim().toLowerCase();
    if (!email.includes('@')) {
      notes.push({ label, reason: 'No email address found for this account' });
      continue;
    }

    const socket = SECURITY[num(`${s}socketType`) ?? 0] ?? 'none';
    const inPort = num(`${s}port`) ?? (type === 'imap' ? (socket === 'tls' ? 993 : 143) : socket === 'tls' ? 995 : 110);
    const smtpKey = str(`${id}smtpServer`) || defaultSmtp;
    const o = `mail.smtpserver.${smtpKey}.`;
    const smtpHost = str(`${o}hostname`);
    const smtpSecurity = SECURITY[num(`${o}try_ssl`) ?? 0] ?? 'none';
    const smtpPort = num(`${o}port`) || (smtpSecurity === 'tls' ? 465 : 25);
    if (!smtpHost) notes.push({ label, reason: 'No outgoing (SMTP) server found; set it up after importing' });

    const usesOAuth = num(`${s}authMethod`) === 10;
    const oauthProvider = usesOAuth ? (OAUTH_HOSTS.find(([re]) => re.test(host))?.[1] ?? null) : null;
    if (usesOAuth && !oauthProvider) {
      notes.push({ label, reason: 'Thunderbird signs in to this provider with OAuth, which HomeMail only supports for Google and Microsoft. Add an app password after importing.' });
    }
    const signature = str(`${id}htmlSigText`) ?? '';

    accounts.push({
      label,
      email,
      displayName: str(`${id}fullName`) ?? '',
      provider: type,
      protocol: type,
      incoming: { host, port: inPort, security: socket, username: str(`${s}realuserName`) ?? str(`${s}userName`) ?? email },
      smtp: {
        host: smtpHost ?? '',
        port: smtpPort,
        security: smtpSecurity,
        username: num(`${o}authMethod`) === 1 ? '' : (str(`${o}username`) ?? email),
      },
      authType: oauthProvider ? 'oauth2' : 'password',
      oauthProvider,
      leaveOnServer: bool(`${s}leave_on_server`) ?? false,
      // HTML signatures are reduced to text; HomeMail signatures are plain text.
      signature: bool(`${id}htmlSigFormat`) ? signature.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim() : signature,
      allowInsecureTls: false,
    });
  }
  return { accounts, notes };
}
