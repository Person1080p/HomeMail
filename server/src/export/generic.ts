import crypto from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { type ExportAccount, type ExportFile, SECURITY_LABEL, safeFilename, xmlEscape } from './common.js';

/* ---------- Mozilla autoconfig (config-v1.1.xml) ---------- */

const SOCKET = { tls: 'SSL', starttls: 'STARTTLS', none: 'plain' } as const;

/**
 * Mozilla's autoconfig format, understood by Thunderbird, Evolution, KMail,
 * FairEmail, Nextcloud Mail and others when served from autoconfig.<domain>.
 */
export function autoconfigXml(a: ExportAccount): string {
  const domain = a.email.split('@')[1];
  const auth = a.authType === 'oauth2' ? 'OAuth2' : 'password-cleartext';
  const server = (tag: string, type: string, s: ExportAccount['incoming']) =>
    `    <${tag} type="${type}">
      <hostname>${xmlEscape(s.host)}</hostname>
      <port>${s.port}</port>
      <socketType>${SOCKET[s.security]}</socketType>
      <authentication>${auth}</authentication>
      <username>${xmlEscape(s.username === a.email ? '%EMAILADDRESS%' : s.username)}</username>
    </${tag}>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${xmlEscape(domain)}">
    <domain>${xmlEscape(domain)}</domain>
    <displayName>${xmlEscape(a.label)}</displayName>
    <displayShortName>${xmlEscape(a.label)}</displayShortName>
${server('incomingServer', a.protocol, a.incoming)}
${server('outgoingServer', 'smtp', a.smtp)}
  </emailProvider>
</clientConfig>
`;
}

export function exportAutoconfig(accounts: ExportAccount[]): ExportFile {
  if (accounts.length === 1) {
    return {
      filename: 'config-v1.1.xml',
      contentType: 'application/xml',
      body: Buffer.from(autoconfigXml(accounts[0])),
      skipped: [],
    };
  }
  const files: Record<string, Uint8Array> = {};
  accounts.forEach((a, i) => (files[`${String(i + 1).padStart(2, '0')}-${safeFilename(a.email)}/config-v1.1.xml`] = strToU8(autoconfigXml(a))));
  return { filename: 'autoconfig.zip', contentType: 'application/zip', body: Buffer.from(zipSync(files)), skipped: [] };
}

/* ---------- Apple configuration profile (.mobileconfig) ---------- */

const plistValue = (v: string | number | boolean): string =>
  typeof v === 'boolean' ? (v ? '<true/>' : '<false/>') : typeof v === 'number' ? `<integer>${v}</integer>` : `<string>${xmlEscape(v)}</string>`;

const plistDict = (entries: [string, string | number | boolean | undefined][], indent: string) =>
  `${indent}<dict>\n${entries
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${indent}  <key>${k}</key>\n${indent}  ${plistValue(v!)}`)
    .join('\n')}\n${indent}</dict>`;

/**
 * Configuration profile for Apple Mail on macOS, iPhone and iPad. Apple's "UseSSL"
 * covers both implicit TLS and STARTTLS. OAuth accounts are skipped: Apple Mail
 * signs in to Google and Microsoft through its own built-in account types.
 */
export function exportMobileconfig(accounts: ExportAccount[]): ExportFile {
  const skipped: ExportFile['skipped'] = [];
  const payloads: string[] = [];
  const rootId = 'local.homemail.accounts';
  for (const a of accounts) {
    if (a.authType === 'oauth2') {
      skipped.push({
        label: a.label,
        reason: `Apple profiles cannot carry ${a.oauthProvider === 'google' ? 'Google' : 'Microsoft'} sign-in. Add it in Apple Mail via "Add Account" → ${a.oauthProvider === 'google' ? 'Google' : 'Microsoft Exchange / Outlook.com'}.`,
      });
      continue;
    }
    const uuid = crypto.randomUUID().toUpperCase();
    payloads.push(
      plistDict(
        [
          ['EmailAccountDescription', a.label],
          ['EmailAccountName', a.displayName || undefined],
          ['EmailAccountType', a.protocol === 'imap' ? 'EmailTypeIMAP' : 'EmailTypePOP'],
          ['EmailAddress', a.email],
          ['IncomingMailServerAuthentication', 'EmailAuthPassword'],
          ['IncomingMailServerHostName', a.incoming.host],
          ['IncomingMailServerPortNumber', a.incoming.port],
          ['IncomingMailServerUseSSL', a.incoming.security !== 'none'],
          ['IncomingMailServerUsername', a.incoming.username],
          ['IncomingPassword', a.password],
          ['OutgoingMailServerAuthentication', a.smtp.username ? 'EmailAuthPassword' : 'EmailAuthNone'],
          ['OutgoingMailServerHostName', a.smtp.host],
          ['OutgoingMailServerPortNumber', a.smtp.port],
          ['OutgoingMailServerUseSSL', a.smtp.security !== 'none'],
          ['OutgoingMailServerUsername', a.smtp.username],
          ['OutgoingPassword', a.smtpPassword],
          ['OutgoingPasswordSameAsIncomingPassword', !a.smtpPassword && a.smtp.username !== ''],
          ['PayloadDisplayName', `Mail: ${a.label}`],
          ['PayloadIdentifier', `${rootId}.mail.${uuid}`],
          ['PayloadType', 'com.apple.mail.managed'],
          ['PayloadUUID', uuid],
          ['PayloadVersion', 1],
        ],
        '    ',
      ),
    );
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
${payloads.join('\n')}
  </array>
  <key>PayloadDescription</key>
  <string>Email accounts exported from HomeMail</string>
  <key>PayloadDisplayName</key>
  <string>HomeMail accounts</string>
  <key>PayloadIdentifier</key>
  <string>${rootId}.${crypto.randomUUID().toUpperCase()}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${crypto.randomUUID().toUpperCase()}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
  return { filename: 'homemail-accounts.mobileconfig', contentType: 'application/x-apple-aspen-config', body: Buffer.from(body), skipped };
}

/* ---------- HomeMail JSON (backup / move between HomeMail servers) ---------- */

export const JSON_FORMAT = 'homemail-accounts';

export function exportJson(accounts: ExportAccount[]): ExportFile {
  const doc = { format: JSON_FORMAT, version: 1, exportedAt: new Date().toISOString(), accounts };
  return { filename: 'homemail-accounts.json', contentType: 'application/json', body: Buffer.from(JSON.stringify(doc, null, 2)), skipped: [] };
}

/* ---------- Human-readable settings sheet for any client ---------- */

export function exportSheet(accounts: ExportAccount[]): ExportFile {
  const lines: string[] = [
    'HomeMail - email account settings',
    `Exported ${new Date().toUTCString()}`,
    '',
    'Use these values in any mail client (Outlook, eM Client, Mailspring, Evolution, Gmail app, ...).',
    '',
  ];
  for (const a of accounts) {
    const auth =
      a.authType === 'oauth2'
        ? `OAuth2 / "Sign in with ${a.oauthProvider === 'google' ? 'Google' : 'Microsoft'}" (most clients do this automatically)`
        : 'Normal password' + (a.password ? '' : ' (not included in this export)');
    lines.push(
      '='.repeat(64),
      a.label,
      '='.repeat(64),
      `Name:            ${a.displayName}`,
      `Email address:   ${a.email}`,
      `Authentication:  ${auth}`,
      '',
      `Incoming (${a.protocol.toUpperCase()})`,
      `  Server:        ${a.incoming.host}`,
      `  Port:          ${a.incoming.port}`,
      `  Security:      ${SECURITY_LABEL[a.incoming.security]}`,
      `  Username:      ${a.incoming.username}`,
      ...(a.password ? [`  Password:      ${a.password}`] : []),
      ...(a.protocol === 'pop3' ? [`  Leave on server: ${a.leaveOnServer ? 'yes' : 'no'}`] : []),
      '',
      'Outgoing (SMTP)',
      `  Server:        ${a.smtp.host}`,
      `  Port:          ${a.smtp.port}`,
      `  Security:      ${SECURITY_LABEL[a.smtp.security]}`,
      `  Username:      ${a.smtp.username || '(no authentication)'}`,
      ...(a.smtpPassword ? [`  Password:      ${a.smtpPassword}`] : []),
      ...(a.allowInsecureTls ? ['', 'Note: this server uses a self-signed certificate; your client must be told to trust it.'] : []),
      ...(a.providerSavesSent ? ['', 'Note: the provider saves sent mail itself; turn off "save a copy in Sent" to avoid duplicates.'] : []),
      '',
    );
  }
  return { filename: 'homemail-account-settings.txt', contentType: 'text/plain; charset=utf-8', body: Buffer.from(lines.join('\n')), skipped: [] };
}
