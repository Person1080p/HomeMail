import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { simpleParser } from 'mailparser';
import { db } from '../db.js';
import { type AccountRow, accountMailDir, getAccountById, setAccountStatus } from '../accounts.js';
import { resolveAuth } from '../oauth.js';
import { badRequest, notFound, describeMailError } from '../http.js';
import { Pop3Client } from './pop3.js';
import type { FlagChange, Folder, ListOptions, ListResult, MailBackend, MessageSummary, SpecialUse } from './types.js';

/** Fixed folders for accounts whose mail lives on this server. */
const LOCAL_FOLDERS: { path: string; name: string; use: SpecialUse }[] = [
  { path: 'INBOX', name: 'Inbox', use: '\\Inbox' },
  { path: 'Drafts', name: 'Drafts', use: '\\Drafts' },
  { path: 'Sent', name: 'Sent', use: '\\Sent' },
  { path: 'Trash', name: 'Trash', use: '\\Trash' },
];
const isLocalFolder = (p: string) => LOCAL_FOLDERS.some((f) => f.path === p);

interface LocalRow {
  id: number;
  uidl: string | null;
  folder: string;
  file: string | null;
  size: number;
  date: number;
  from_name: string;
  from_addr: string;
  to_addr: string;
  subject: string;
  seen: number;
  flagged: number;
  answered: number;
  has_attachments: number;
}

const toSummary = (r: LocalRow): MessageSummary => ({
  id: r.id,
  subject: r.subject,
  from: r.from_addr || r.from_name ? { name: r.from_name, address: r.from_addr } : null,
  to: r.to_addr ? r.to_addr.split(', ').map((address) => ({ name: '', address })) : [],
  date: new Date(r.date).toISOString(),
  seen: !!r.seen,
  flagged: !!r.flagged,
  answered: !!r.answered,
  draft: r.folder === 'Drafts',
  hasAttachments: !!r.has_attachments,
  size: r.size,
});

/** Writes a raw message to disk and indexes it. */
export async function storeLocal(
  accountId: number,
  folder: string,
  raw: Buffer,
  opts: { uidl?: string; seen?: boolean } = {},
): Promise<number> {
  const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
  const dir = accountMailDir(accountId);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.eml`;
  fs.writeFileSync(path.join(dir, file), raw);
  const from = parsed.from?.value[0];
  const to = (Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : []).flatMap((a) => a.value.map((v) => v.address || ''));
  const info = db
    .prepare(
      `INSERT INTO local_messages (account_id, uidl, folder, file, size, date, from_name, from_addr, to_addr, subject, seen, has_attachments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      accountId,
      opts.uidl ?? null,
      folder,
      file,
      raw.length,
      (parsed.date ?? new Date()).getTime(),
      from?.name || '',
      from?.address || '',
      to.filter(Boolean).join(', '),
      parsed.subject || '',
      opts.seen ? 1 : 0,
      parsed.attachments.some((a) => a.contentDisposition === 'attachment' || !a.related) ? 1 : 0,
    );
  return Number(info.lastInsertRowid);
}

const syncs = new Map<number, Promise<{ fetched: number }>>();
const MAX_PER_SYNC = 500;

/** Downloads new messages from a POP3 server into the local store. */
export function syncPop3(accountId: number): Promise<{ fetched: number }> {
  let p = syncs.get(accountId);
  if (!p) {
    p = runPop3Sync(accountId).finally(() => syncs.delete(accountId));
    syncs.set(accountId, p);
  }
  return p;
}

export async function connectPop3(account: AccountRow): Promise<Pop3Client> {
  const auth = await resolveAuth(account, 'incoming');
  const client = await Pop3Client.connect({
    host: account.in_host,
    port: account.in_port,
    security: account.in_security,
    rejectUnauthorized: !account.allow_insecure_tls,
  });
  try {
    if (auth.accessToken) await client.loginOAuth(auth.user, auth.accessToken);
    else await client.login(auth.user, auth.pass ?? '');
    return client;
  } catch (err) {
    client.destroy();
    throw err;
  }
}

async function runPop3Sync(accountId: number): Promise<{ fetched: number }> {
  const account = getAccountById(accountId);
  if (!account) throw notFound();
  let client: Pop3Client | undefined;
  let fetched = 0;
  try {
    client = await connectPop3(account);
    const list = await client.uidl();
    const known = new Set(
      (db.prepare('SELECT uidl FROM local_messages WHERE account_id = ? AND uidl IS NOT NULL').pluck().all(accountId) as string[]),
    );
    // Newest first, so a big first sync shows recent mail right away.
    const fresh = list.filter((m) => !known.has(m.uid)).reverse().slice(0, MAX_PER_SYNC);
    for (const m of fresh) {
      const raw = await client.retr(m.n);
      await storeLocal(accountId, 'INBOX', raw, { uidl: m.uid });
      known.add(m.uid);
      fetched++;
    }
    if (!account.leave_on_server) {
      for (const m of list) if (known.has(m.uid)) await client.dele(m.n);
    }
    await client.quit();
    setAccountStatus(accountId, null, true);
    return { fetched };
  } catch (err) {
    client?.destroy();
    setAccountStatus(accountId, describeMailError(err), true);
    throw err;
  }
}

export class LocalBackend implements MailBackend {
  constructor(private account: AccountRow) {}

  private row(id: number): LocalRow {
    const r = db.prepare('SELECT * FROM local_messages WHERE id = ? AND account_id = ? AND file IS NOT NULL').get(id, this.account.id) as
      | LocalRow
      | undefined;
    if (!r) throw notFound('Message not found');
    return r;
  }

  async listFolders(): Promise<Folder[]> {
    const counts = db
      .prepare(
        `SELECT folder, COUNT(*) AS total, SUM(seen = 0) AS unseen FROM local_messages
         WHERE account_id = ? AND file IS NOT NULL GROUP BY folder`,
      )
      .all(this.account.id) as { folder: string; total: number; unseen: number }[];
    return LOCAL_FOLDERS.map((f) => {
      const c = counts.find((x) => x.folder === f.path);
      return { path: f.path, name: f.name, delimiter: '/', specialUse: f.use, unseen: c?.unseen ?? 0, total: c?.total ?? 0, selectable: true };
    });
  }

  async specialFolder(use: SpecialUse): Promise<string | null> {
    return LOCAL_FOLDERS.find((f) => f.use === use)?.path ?? null;
  }

  async listMessages(folder: string, opts: ListOptions): Promise<ListResult> {
    const where = ['account_id = ?', 'folder = ?', 'file IS NOT NULL'];
    const args: unknown[] = [this.account.id, folder];
    if (opts.query) {
      where.push("(subject LIKE ? ESCAPE '\\' OR from_addr LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\' OR to_addr LIKE ? ESCAPE '\\')");
      const like = `%${opts.query.replace(/[\\%_]/g, '\\$&')}%`;
      args.push(like, like, like, like);
    }
    if (opts.unreadOnly) where.push('seen = 0');
    if (opts.flaggedOnly) where.push('flagged = 1');
    const w = where.join(' AND ');
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM local_messages WHERE ${w}`).get(...args) as { n: number }).n;
    const rows = db
      .prepare(`SELECT * FROM local_messages WHERE ${w} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, opts.pageSize, opts.page * opts.pageSize) as LocalRow[];
    return { total, page: opts.page, pageSize: opts.pageSize, messages: rows.map(toSummary) };
  }

  async getSource(_folder: string, id: number): Promise<Buffer> {
    const r = this.row(id);
    return fs.promises.readFile(path.join(accountMailDir(this.account.id), r.file!));
  }

  async setFlags(_folder: string, ids: number[], change: FlagChange): Promise<void> {
    const stmt = (col: string) => db.prepare(`UPDATE local_messages SET ${col} = ? WHERE id = ? AND account_id = ?`);
    db.transaction(() => {
      for (const id of ids) {
        if (change.seen !== undefined) stmt('seen').run(change.seen ? 1 : 0, id, this.account.id);
        if (change.flagged !== undefined) stmt('flagged').run(change.flagged ? 1 : 0, id, this.account.id);
        if (change.answered !== undefined) stmt('answered').run(change.answered ? 1 : 0, id, this.account.id);
      }
    })();
  }

  async move(_folder: string, ids: number[], dest: string): Promise<void> {
    if (!isLocalFolder(dest)) throw badRequest('Unknown folder');
    const stmt = db.prepare('UPDATE local_messages SET folder = ? WHERE id = ? AND account_id = ?');
    db.transaction(() => ids.forEach((id) => stmt.run(dest, id, this.account.id)))();
  }

  private purge(ids: number[]) {
    const dir = accountMailDir(this.account.id);
    for (const id of ids) {
      const r = db.prepare('SELECT file, uidl FROM local_messages WHERE id = ? AND account_id = ?').get(id, this.account.id) as
        | Pick<LocalRow, 'file' | 'uidl'>
        | undefined;
      if (!r) continue;
      if (r.file) fs.rmSync(path.join(dir, r.file), { force: true });
      // Keep a tombstone for POP3 messages so they aren't downloaded again.
      if (r.uidl) db.prepare('UPDATE local_messages SET file = NULL WHERE id = ?').run(id);
      else db.prepare('DELETE FROM local_messages WHERE id = ?').run(id);
    }
  }

  async remove(folder: string, ids: number[], permanent = false): Promise<void> {
    if (permanent || folder === 'Trash') this.purge(ids);
    else await this.move(folder, ids, 'Trash');
  }

  async emptyFolder(path: string): Promise<void> {
    const ids = db.prepare('SELECT id FROM local_messages WHERE account_id = ? AND folder = ? AND file IS NOT NULL').pluck().all(this.account.id, path) as number[];
    this.purge(ids);
  }

  async storeSent(raw: Buffer): Promise<void> {
    await storeLocal(this.account.id, 'Sent', raw, { seen: true });
  }

  async saveDraft(raw: Buffer): Promise<{ folder: string; id: number | null }> {
    return { folder: 'Drafts', id: await storeLocal(this.account.id, 'Drafts', raw, { seen: true }) };
  }

  async createFolder(): Promise<void> {
    throw badRequest('POP3 accounts have fixed local folders');
  }
  async renameFolder(): Promise<void> {
    throw badRequest('POP3 accounts have fixed local folders');
  }
  async deleteFolder(): Promise<void> {
    throw badRequest('POP3 accounts have fixed local folders');
  }

  sync() {
    return syncPop3(this.account.id);
  }
}
