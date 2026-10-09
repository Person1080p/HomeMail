import fs from 'node:fs';
import path from 'node:path';
import { db, now } from './db.js';
import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { notFound } from './http.js';
import type { Security } from './providers.js';

export interface AccountRow {
  id: number;
  user_id: number;
  label: string;
  provider: string;
  email: string;
  display_name: string;
  protocol: 'imap' | 'pop3';
  in_host: string;
  in_port: number;
  in_security: Security;
  in_username: string;
  smtp_host: string;
  smtp_port: number;
  smtp_security: Security;
  smtp_username: string;
  auth_type: 'password' | 'oauth2';
  oauth_provider: 'google' | 'microsoft' | null;
  secret: string | null;
  allow_insecure_tls: number;
  leave_on_server: number;
  save_sent: number;
  signature: string;
  sort_order: number;
  last_error: string | null;
  last_sync: number | null;
  created_at: number;
}

export interface AccountSecret {
  password?: string;
  /** Only when the SMTP password differs from the incoming one. */
  smtpPassword?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

export type AccountInput = Omit<AccountRow, 'id' | 'user_id' | 'secret' | 'last_error' | 'last_sync' | 'created_at' | 'sort_order'>;

const COLUMNS: (keyof AccountInput)[] = [
  'label', 'provider', 'email', 'display_name', 'protocol',
  'in_host', 'in_port', 'in_security', 'in_username',
  'smtp_host', 'smtp_port', 'smtp_security', 'smtp_username',
  'auth_type', 'oauth_provider', 'allow_insecure_tls', 'leave_on_server', 'save_sent', 'signature',
];

export function listAccounts(userId: number): AccountRow[] {
  return db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY sort_order, id').all(userId) as AccountRow[];
}

/** Loads an account, enforcing that it belongs to the user. */
export function getAccount(userId: number, id: number): AccountRow {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(id, userId) as AccountRow | undefined;
  if (!row) throw notFound('Account not found');
  return row;
}

export function getAccountById(id: number): AccountRow | undefined {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
}

export function createAccount(userId: number, input: AccountInput, secret: AccountSecret): AccountRow {
  const order = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM accounts WHERE user_id = ?').get(userId) as { n: number }).n;
  const cols = [...COLUMNS, 'user_id', 'secret', 'sort_order', 'created_at'];
  const info = db
    .prepare(`INSERT INTO accounts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...COLUMNS.map((c) => input[c]), userId, encrypt(secret), order, now());
  return getAccount(userId, Number(info.lastInsertRowid));
}

export function updateAccount(userId: number, id: number, input: Partial<AccountInput>, secret?: AccountSecret): AccountRow {
  getAccount(userId, id);
  const keys = COLUMNS.filter((c) => input[c] !== undefined);
  const sets = keys.map((k) => `${k} = ?`);
  const values: unknown[] = keys.map((k) => input[k]);
  if (secret) {
    sets.push('secret = ?');
    values.push(encrypt(secret));
  }
  if (sets.length) db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...values, id, userId);
  return getAccount(userId, id);
}

export function deleteAccount(userId: number, id: number): void {
  getAccount(userId, id);
  db.prepare('DELETE FROM accounts WHERE id = ? AND user_id = ?').run(id, userId);
  fs.rmSync(accountMailDir(id), { recursive: true, force: true });
}

export function setAccountStatus(id: number, error: string | null, synced = false): void {
  if (synced) db.prepare('UPDATE accounts SET last_error = ?, last_sync = ? WHERE id = ?').run(error, now(), id);
  else db.prepare('UPDATE accounts SET last_error = ? WHERE id = ?').run(error, id);
}

export function readSecret(account: AccountRow): AccountSecret {
  return account.secret ? decrypt<AccountSecret>(account.secret) : {};
}

export function writeSecret(id: number, secret: AccountSecret): void {
  db.prepare('UPDATE accounts SET secret = ? WHERE id = ?').run(encrypt(secret), id);
}

export const accountMailDir = (id: number) => path.join(config.mailDir, String(id));

/** The shape sent to the browser: never includes secrets. */
export function publicAccount(a: AccountRow) {
  const s = readSecret(a);
  return {
    id: a.id,
    label: a.label,
    provider: a.provider,
    email: a.email,
    displayName: a.display_name,
    protocol: a.protocol,
    incoming: { host: a.in_host, port: a.in_port, security: a.in_security, username: a.in_username },
    smtp: { host: a.smtp_host, port: a.smtp_port, security: a.smtp_security, username: a.smtp_username },
    authType: a.auth_type,
    oauthProvider: a.oauth_provider,
    hasPassword: !!s.password,
    hasSeparateSmtpPassword: !!s.smtpPassword,
    oauthConnected: !!s.refreshToken,
    allowInsecureTls: !!a.allow_insecure_tls,
    leaveOnServer: !!a.leave_on_server,
    saveSent: !!a.save_sent,
    signature: a.signature,
    sortOrder: a.sort_order,
    lastError: a.last_error,
    lastSync: a.last_sync,
  };
}
