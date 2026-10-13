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
  `
  -- v2: built-in mailboxes ("local" protocol), server-managed accounts, chat, outbound queue.
  CREATE TABLE accounts_v2 (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    provider TEXT NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    protocol TEXT NOT NULL CHECK (protocol IN ('imap', 'pop3', 'local')),
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
    created_at INTEGER NOT NULL,
    -- 'builtin' or 'stalwart' when HomeMail created this mailbox for the user.
    managed TEXT
  );
  INSERT INTO accounts_v2 SELECT *, NULL FROM accounts;
  DROP TABLE accounts;
  ALTER TABLE accounts_v2 RENAME TO accounts;
  CREATE INDEX accounts_user ON accounts(user_id);
  CREATE UNIQUE INDEX accounts_managed ON accounts(user_id, managed) WHERE managed IS NOT NULL;

  CREATE TABLE chat_conversations (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
    name TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    last_message_at INTEGER NOT NULL
  );
  -- A member is either a local user or (for federated DMs) a remote XMPP address.
  CREATE TABLE chat_members (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    remote_jid TEXT,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    last_read_id INTEGER NOT NULL DEFAULT 0,
    joined_at INTEGER NOT NULL,
    CHECK ((user_id IS NULL) <> (remote_jid IS NULL))
  );
  CREATE UNIQUE INDEX chat_members_user ON chat_members(conversation_id, user_id) WHERE user_id IS NOT NULL;
  CREATE UNIQUE INDEX chat_members_remote ON chat_members(conversation_id, remote_jid) WHERE remote_jid IS NOT NULL;
  CREATE INDEX chat_members_by_user ON chat_members(user_id);
  CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sender_jid TEXT,
    kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'system')),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    stanza_id TEXT
  );
  CREATE INDEX chat_messages_conv ON chat_messages(conversation_id, id);
  -- Remote XMPP contacts that asked to see a local user's online status.
  CREATE TABLE xmpp_subscribers (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    jid TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, jid)
  );

  -- Built-in mail server: messages waiting for delivery to other domains.
  CREATE TABLE outbound_queue (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    mail_from TEXT NOT NULL,
    rcpt_to TEXT NOT NULL,
    file TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX outbound_due ON outbound_queue(next_attempt);
  `,
  `
  -- v3: calendars. A source is one connection (this server, a CalDAV account,
  -- Google, Microsoft or a subscribed .ics feed) holding one or more calendars.
  CREATE TABLE calendar_sources (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('local', 'caldav', 'google', 'microsoft', 'ics')),
    provider TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL,
    url TEXT,
    username TEXT,
    secret TEXT,
    allow_insecure_tls INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    last_sync INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX calendar_sources_user ON calendar_sources(user_id);
  CREATE UNIQUE INDEX calendar_sources_local ON calendar_sources(user_id) WHERE kind = 'local';
  CREATE TABLE calendars (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES calendar_sources(id) ON DELETE CASCADE,
    -- CalDAV collection URL, Google or Microsoft calendar id; unique per source.
    remote_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    read_only INTEGER NOT NULL DEFAULT 0,
    visible INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    -- CalDAV ctag or Google sync token: unchanged means nothing to fetch.
    sync_state TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE (source_id, remote_id)
  );
  -- One stored iCalendar object. Usually all of an event's data, but Google keeps
  -- each changed occurrence separately, so rows are grouped by UID when expanded.
  CREATE TABLE calendar_objects (
    id INTEGER PRIMARY KEY,
    calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    -- CalDAV href, Google or Microsoft event id, or the UID for local and feed events.
    remote_id TEXT NOT NULL,
    etag TEXT,
    uid TEXT NOT NULL,
    -- Google and Microsoft: id of the series an occurrence belongs to.
    series_id TEXT,
    ics TEXT NOT NULL,
    -- Span the event can appear in (UTC ms); range_end NULL means it repeats forever.
    range_start INTEGER NOT NULL,
    range_end INTEGER,
    UNIQUE (calendar_id, remote_id)
  );
  CREATE INDEX calendar_objects_uid ON calendar_objects(calendar_id, uid);
  CREATE INDEX calendar_objects_range ON calendar_objects(calendar_id, range_start);
  `,
];

const current = db.pragma('user_version', { simple: true }) as number;
if (current < migrations.length) {
  // Table rebuilds need foreign keys off; the pragma can't change inside a transaction.
  db.pragma('foreign_keys = OFF');
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]);
      const broken = db.pragma('foreign_key_check') as unknown[];
      if (broken.length) throw new Error(`Migration ${v + 1} left ${broken.length} broken foreign keys`);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  db.pragma('foreign_keys = ON');
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
