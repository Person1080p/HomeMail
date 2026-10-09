import { type AccountRow, readSecret } from '../accounts.js';
import { presetById, type Security } from '../providers.js';

export interface ExportServer {
  host: string;
  port: number;
  security: Security;
  username: string;
}

/** Client-neutral description of an account, the input to every exporter. */
export interface ExportAccount {
  label: string;
  email: string;
  displayName: string;
  provider: string;
  protocol: 'imap' | 'pop3';
  incoming: ExportServer;
  smtp: ExportServer;
  authType: 'password' | 'oauth2';
  oauthProvider: 'google' | 'microsoft' | null;
  password?: string;
  smtpPassword?: string;
  leaveOnServer: boolean;
  signature: string;
  /** The provider stores sent mail itself; clients should not save another copy. */
  providerSavesSent: boolean;
  allowInsecureTls: boolean;
}

export interface ExportFile {
  filename: string;
  contentType: string;
  body: Buffer;
  /** Accounts the format cannot represent, with the reason. */
  skipped: { label: string; reason: string }[];
}

export function toExportAccount(a: AccountRow, includePasswords: boolean): ExportAccount {
  const secret = includePasswords && a.auth_type === 'password' ? readSecret(a) : {};
  return {
    label: a.label,
    email: a.email,
    displayName: a.display_name,
    provider: a.provider,
    protocol: a.protocol,
    incoming: { host: a.in_host, port: a.in_port, security: a.in_security, username: a.in_username },
    smtp: { host: a.smtp_host, port: a.smtp_port, security: a.smtp_security, username: a.smtp_username },
    authType: a.auth_type,
    oauthProvider: a.oauth_provider,
    password: secret.password,
    smtpPassword: secret.smtpPassword,
    leaveOnServer: !!a.leave_on_server,
    signature: a.signature,
    providerSavesSent: !!presetById(a.provider)?.smtpSavesSent,
    allowInsecureTls: !!a.allow_insecure_tls,
  };
}

export const xmlEscape = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

export const SECURITY_LABEL: Record<Security, string> = { tls: 'SSL/TLS', starttls: 'STARTTLS', none: 'None (unencrypted)' };

export const safeFilename = (s: string) => s.replace(/[^a-zA-Z0-9._@-]+/g, '_').slice(0, 80);
