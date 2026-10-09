import crypto from 'node:crypto';
import type { Security } from '../providers.js';
import { type ExportAccount, type ExportFile, xmlEscape } from './common.js';

/*
 * K-9 Mail / Thunderbird for Android settings file (.k9s), "Settings → Import settings".
 * Mirrors the minimal file the Android app writes for its own QR-code import
 * (settings version 99, file format 1); older versions' settings are upgraded on import.
 */
const SETTINGS_VERSION = 99;
const FILE_FORMAT_VERSION = 1;

const SECURITY: Record<Security, string> = { none: 'NONE', starttls: 'STARTTLS_REQUIRED', tls: 'SSL_TLS_REQUIRED' };

const el = (name: string, value: string, indent: string) => `${indent}<${name}>${xmlEscape(value)}</${name}>`;

function server(tag: string, type: string, s: ExportAccount['incoming'], auth: string, password: string | undefined, indent: string) {
  return [
    `${indent}<${tag} type="${type}">`,
    el('host', s.host, indent + '  '),
    el('port', String(s.port), indent + '  '),
    el('connection-security', SECURITY[s.security], indent + '  '),
    el('authentication-type', auth, indent + '  '),
    el('username', s.username, indent + '  '),
    ...(password ? [el('password', password, indent + '  ')] : []),
    `${indent}</${tag}>`,
  ].join('\n');
}

export function k9SettingsXml(accounts: ExportAccount[]): string {
  const body = accounts.map((a) => {
    const auth = a.authType === 'oauth2' ? 'XOAUTH2' : 'PLAIN';
    // IMAP: deleting in the app deletes on the server. POP3: honour "leave on server".
    const deletePolicy = a.protocol === 'imap' || !a.leaveOnServer ? 'DELETE' : 'NEVER';
    return [
      `    <account uuid="${crypto.randomUUID()}">`,
      el('name', a.label, '      '),
      '      <settings>',
      `        <value key="deletePolicy">${deletePolicy}</value>`,
      '      </settings>',
      server('incoming-server', a.protocol === 'imap' ? 'IMAP' : 'POP3', a.incoming, auth, a.password, '      '),
      server('outgoing-server', 'SMTP', a.smtp, a.smtp.username ? auth : 'NONE', a.smtpPassword ?? a.password, '      '),
      '      <identities>',
      '        <identity>',
      el('name', a.displayName, '          '),
      el('email', a.email, '          '),
      ...(a.signature.trim()
        ? ['          <settings>', `            <value key="signature">${xmlEscape(a.signature)}</value>`, '            <value key="signatureUse">true</value>', '          </settings>']
        : []),
      '        </identity>',
      '      </identities>',
      '    </account>',
    ].join('\n');
  });
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<k9settings version="${SETTINGS_VERSION}" format="${FILE_FORMAT_VERSION}">
  <accounts>
${body.join('\n')}
  </accounts>
</k9settings>
`;
}

export function exportK9(accounts: ExportAccount[]): ExportFile {
  return { filename: 'homemail-accounts.k9s', contentType: 'application/xml', body: Buffer.from(k9SettingsXml(accounts)), skipped: [] };
}
