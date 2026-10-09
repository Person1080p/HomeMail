import { ImapFlow, type FetchMessageObject, type ListResponse, type MessageStructureObject, type SearchObject } from 'imapflow';
import type { AccountRow } from '../accounts.js';
import { resolveAuth } from '../oauth.js';
import { notFound } from '../http.js';
import type { Addr, FlagChange, Folder, ListOptions, ListResult, MailBackend, MessageSummary, SpecialUse } from './types.js';

interface PoolEntry {
  client?: ImapFlow;
  connecting?: Promise<ImapFlow>;
  lastUsed: number;
  folders?: { at: number; list: ListResponse[] };
}

const pool = new Map<number, PoolEntry>();
const IDLE_CLOSE_MS = 5 * 60_000;

setInterval(() => {
  const t = Date.now();
  for (const [id, e] of pool) {
    if (e.client && t - e.lastUsed > IDLE_CLOSE_MS) {
      pool.delete(id);
      e.client.logout().catch(() => e.client?.close());
    }
  }
}, 60_000).unref();

export async function createImapClient(account: AccountRow): Promise<ImapFlow> {
  const auth = await resolveAuth(account, 'incoming');
  return new ImapFlow({
    host: account.in_host,
    port: account.in_port,
    secure: account.in_security === 'tls',
    doSTARTTLS: account.in_security === 'starttls' ? true : account.in_security === 'none' ? false : undefined,
    auth: auth.accessToken ? { user: auth.user, accessToken: auth.accessToken } : { user: auth.user, pass: auth.pass ?? '' },
    tls: { rejectUnauthorized: !account.allow_insecure_tls },
    logger: false,
    clientInfo: { name: 'HomeMail' },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 5 * 60_000,
    disableAutoIdle: true,
  });
}

async function getClient(account: AccountRow): Promise<ImapFlow> {
  const existing = pool.get(account.id);
  if (existing?.client?.usable) {
    existing.lastUsed = Date.now();
    return existing.client;
  }
  if (existing?.connecting) return existing.connecting;

  const entry: PoolEntry = { lastUsed: Date.now() };
  entry.connecting = (async () => {
    const client = await createImapClient(account);
    const drop = () => {
      if (pool.get(account.id)?.client === client) pool.delete(account.id);
    };
    client.on('error', (err: Error) => {
      console.warn(`[imap ${account.id}] ${err.message}`);
      drop();
    });
    client.on('close', drop);
    await client.connect();
    return client;
  })();
  pool.set(account.id, entry);
  try {
    entry.client = await entry.connecting;
    return entry.client;
  } catch (err) {
    pool.delete(account.id);
    throw err;
  } finally {
    entry.connecting = undefined;
  }
}

export function closeImap(accountId: number): void {
  const e = pool.get(accountId);
  pool.delete(accountId);
  e?.client?.logout().catch(() => e.client?.close());
}

const isConnectionError = (err: unknown) => {
  const code = (err as { code?: string })?.code;
  return code === 'NoConnection' || code === 'EConnectionClosed' || code === 'ECONNRESET' || code === 'EPIPE';
};

/** Runs fn with a connected client, reconnecting once if a pooled connection went stale. */
async function withClient<T>(account: AccountRow, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  try {
    return await fn(await getClient(account));
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    closeImap(account.id);
    return fn(await getClient(account));
  }
}

/** Selects a mailbox exclusively for the duration of fn. */
function withMailbox<T>(account: AccountRow, path: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  return withClient(account, async (client) => {
    const lock = await client.getMailboxLock(path);
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  });
}

const addr = (a?: { name?: string; address?: string }): Addr => ({ name: a?.name || '', address: a?.address || '' });

function hasAttachment(node?: MessageStructureObject): boolean {
  if (!node) return false;
  if (node.childNodes?.length) return node.childNodes.some(hasAttachment);
  if (node.disposition === 'attachment') return true;
  const filename = node.dispositionParameters?.filename || node.parameters?.name;
  return !!filename && !node.type.startsWith('text/');
}

function summarize(msg: FetchMessageObject): MessageSummary {
  const env = msg.envelope ?? {};
  const flags = msg.flags ?? new Set<string>();
  const date = env.date || msg.internalDate;
  return {
    id: msg.uid,
    subject: env.subject || '',
    from: env.from?.[0] ? addr(env.from[0]) : null,
    to: (env.to ?? []).map(addr),
    date: date ? new Date(date).toISOString() : new Date(0).toISOString(),
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    draft: flags.has('\\Draft'),
    hasAttachments: hasAttachment(msg.bodyStructure),
    size: msg.size ?? 0,
  };
}

const FETCH_QUERY = { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true } as const;

/** In-memory cache of recently opened message sources, so attachment downloads don't refetch. */
const sourceCache = new Map<string, Buffer>();
let sourceCacheBytes = 0;
function cacheSource(key: string, buf: Buffer) {
  if (buf.length > 30 * 1024 * 1024) return;
  sourceCache.set(key, buf);
  sourceCacheBytes += buf.length;
  for (const [k, v] of sourceCache) {
    if (sourceCacheBytes <= 150 * 1024 * 1024 && sourceCache.size <= 100) break;
    sourceCache.delete(k);
    sourceCacheBytes -= v.length;
  }
}

export class ImapBackend implements MailBackend {
  constructor(private account: AccountRow) {}

  private async rawFolders(force = false): Promise<ListResponse[]> {
    const entry = pool.get(this.account.id);
    if (!force && entry?.folders && Date.now() - entry.folders.at < 60_000) return entry.folders.list;
    const list = await withClient(this.account, (c) => c.list({ statusQuery: { messages: true, unseen: true } }));
    const e = pool.get(this.account.id);
    if (e) e.folders = { at: Date.now(), list };
    return list;
  }

  async listFolders(): Promise<Folder[]> {
    const list = await this.rawFolders(true);
    return list.map((f) => ({
      path: f.path,
      name: f.name,
      delimiter: f.delimiter,
      specialUse: (f.path.toUpperCase() === 'INBOX' ? '\\Inbox' : f.specialUse || null) as SpecialUse | null,
      unseen: f.status?.unseen ?? 0,
      total: f.status?.messages ?? 0,
      selectable: !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent'),
    }));
  }

  async specialFolder(use: SpecialUse): Promise<string | null> {
    if (use === '\\Inbox') return 'INBOX';
    const list = await this.rawFolders();
    return list.find((f) => f.specialUse === use)?.path ?? null;
  }

  listMessages(folder: string, opts: ListOptions): Promise<ListResult> {
    const { page, pageSize } = opts;
    return withMailbox(this.account, folder, async (client) => {
      const exists = client.mailbox ? client.mailbox.exists : 0;
      const filtered = !!(opts.query || opts.unreadOnly || opts.flaggedOnly);
      let range: string;
      let total = exists;
      if (filtered) {
        const q: SearchObject = {};
        if (opts.query) {
          const t = opts.query;
          q.or = [{ subject: t }, { from: t }, { to: t }, { body: t }];
        }
        if (opts.unreadOnly) q.seen = false;
        if (opts.flaggedOnly) q.flagged = true;
        const uids = ((await client.search(q, { uid: true })) || []).sort((a, b) => b - a);
        total = uids.length;
        const slice = uids.slice(page * pageSize, (page + 1) * pageSize);
        if (!slice.length) return { total, page, pageSize, messages: [] };
        range = slice.join(',');
      } else {
        const end = exists - page * pageSize;
        if (end < 1) return { total, page, pageSize, messages: [] };
        range = `${Math.max(1, end - pageSize + 1)}:${end}`;
      }
      const rows: { seq: number; s: MessageSummary }[] = [];
      for await (const msg of client.fetch(range, FETCH_QUERY, { uid: filtered })) rows.push({ seq: msg.seq, s: summarize(msg) });
      rows.sort((a, b) => b.seq - a.seq);
      return { total, page, pageSize, messages: rows.map((r) => r.s) };
    });
  }

  async getSource(folder: string, id: number): Promise<Buffer> {
    const key = `${this.account.id}:${folder}:${id}`;
    const cached = sourceCache.get(key);
    if (cached) return cached;
    const src = await withMailbox(this.account, folder, async (client) => {
      const msg = await client.fetchOne(String(id), { source: true }, { uid: true });
      if (!msg || !msg.source) throw notFound('Message not found (it may have been moved or deleted)');
      return msg.source;
    });
    cacheSource(key, src);
    return src;
  }

  async setFlags(folder: string, ids: number[], change: FlagChange): Promise<void> {
    const add: string[] = [];
    const del: string[] = [];
    for (const [k, flag] of [['seen', '\\Seen'], ['flagged', '\\Flagged'], ['answered', '\\Answered']] as const) {
      if (change[k] === true) add.push(flag);
      if (change[k] === false) del.push(flag);
    }
    await withMailbox(this.account, folder, async (c) => {
      if (add.length) await c.messageFlagsAdd(ids.join(','), add, { uid: true });
      if (del.length) await c.messageFlagsRemove(ids.join(','), del, { uid: true });
    });
  }

  async move(folder: string, ids: number[], dest: string): Promise<void> {
    if (folder === dest) return;
    await withMailbox(this.account, folder, (c) => c.messageMove(ids.join(','), dest, { uid: true }));
  }

  async remove(folder: string, ids: number[], permanent = false): Promise<void> {
    const trash = permanent ? null : await this.specialFolder('\\Trash');
    if (trash && trash !== folder) return this.move(folder, ids, trash);
    await withMailbox(this.account, folder, (c) => c.messageDelete(ids.join(','), { uid: true }));
  }

  async emptyFolder(path: string): Promise<void> {
    await withMailbox(this.account, path, async (c) => {
      if (c.mailbox && c.mailbox.exists > 0) await c.messageDelete('1:*');
    });
  }

  private async findOrCreate(use: SpecialUse, fallbackName: string): Promise<string> {
    const existing = await this.specialFolder(use);
    if (existing) return existing;
    const list = await this.rawFolders(true);
    const byName = list.find((f) => f.name.toLowerCase() === fallbackName.toLowerCase());
    if (byName) return byName.path;
    await withClient(this.account, (c) => c.mailboxCreate(fallbackName));
    await this.rawFolders(true);
    return fallbackName;
  }

  async storeSent(raw: Buffer): Promise<void> {
    const sent = await this.findOrCreate('\\Sent', 'Sent');
    await withClient(this.account, (c) => c.append(sent, raw, ['\\Seen']));
  }

  async saveDraft(raw: Buffer): Promise<{ folder: string; id: number | null }> {
    const drafts = await this.findOrCreate('\\Drafts', 'Drafts');
    const res = await withClient(this.account, (c) => c.append(drafts, raw, ['\\Seen', '\\Draft']));
    return { folder: drafts, id: res && res.uid ? res.uid : null };
  }

  private invalidateFolders() {
    const e = pool.get(this.account.id);
    if (e) e.folders = undefined;
  }

  async createFolder(path: string): Promise<void> {
    await withClient(this.account, (c) => c.mailboxCreate(path));
    this.invalidateFolders();
  }
  async renameFolder(path: string, newPath: string): Promise<void> {
    await withClient(this.account, (c) => c.mailboxRename(path, newPath));
    this.invalidateFolders();
  }
  async deleteFolder(path: string): Promise<void> {
    await withClient(this.account, (c) => c.mailboxDelete(path));
    this.invalidateFolders();
  }
}

/** Connects with fresh credentials and logs out: used by "Test connection". */
export async function testImap(account: AccountRow): Promise<void> {
  const client = await createImapClient(account);
  client.on('error', () => {});
  await client.connect();
  await client.logout();
}
