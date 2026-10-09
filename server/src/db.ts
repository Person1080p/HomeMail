import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from './config.js';

export const db = new Database(path.join(config.dataDir, 'homemail.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const migrations: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    provider TEXT NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    protocol TEXT NOT NULL CHECK (protocol IN ('imap', 'pop3')),
    in_host TEXT NOT NULL,
    in_port INTEGER NOT NULL,
    in_security TEXT NOT NULL CHECK (in_security IN ('tls', 'starttls', 'none')),
    in_username TEXT NOT NULL,
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL,
    smtp_security TEXT NOT NULL CHECK (smtp_security IN ('tls', 'starttls', 'none')),
    smtp_username TEXT NOT NULL,
    auth_type TEXT NOT NULL CHECK (auth_type IN ('password', 'oauth2')),
    oauth_provider TEXT,
    secret TEXT,
    allow_insecure_tls INTEGER NOT NULL DEFAULT 0,
    leave_on_server INTEGER NOT NULL DEFAULT 1,
    save_sent INTEGER NOT NULL DEFAULT 1,
    signature TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_sync INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX accounts_user ON accounts(user_id);
  -- Messages stored on this server: everything for POP3 accounts.
  -- A row with file = NULL is a tombstone that remembers a deleted POP3 UIDL.
  CREATE TABLE local_messages (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    uidl TEXT,
    folder TEXT NOT NULL,
    file TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    date INTEGER NOT NULL,
    from_name TEXT NOT NULL DEFAULT '',
    from_addr TEXT NOT NULL DEFAULT '',
    to_addr TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    seen INTEGER NOT NULL DEFAULT 0,
    flagged INTEGER NOT NULL DEFAULT 0,
    answered INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX local_uidl ON local_messages(account_id, uidl) WHERE uidl IS NOT NULL;
  CREATE INDEX local_folder ON local_messages(account_id, folder, date);
  CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

const current = db.pragma('user_version', { simple: true }) as number;
for (let v = current; v < migrations.length; v++) {
  db.transaction(() => {
    db.exec(migrations[v]);
    db.pragma(`user_version = ${v + 1}`);
  })();
}

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export const now = () => Date.now();
