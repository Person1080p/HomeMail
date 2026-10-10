import { db, now } from '../db.js';
import { HttpError, badRequest, notFound } from '../http.js';
import { isOnline, presence, publish, onlineUserIds } from '../events.js';
import { chatDomain, federationEnabled, userAddress } from '../server-settings.js';

/* ---------- types ---------- */

interface ConvRow {
  id: number;
  kind: 'dm' | 'group';
  name: string;
  created_by: number | null;
  created_at: number;
  last_message_at: number;
}

interface MemberRow {
  id: number;
  conversation_id: number;
  user_id: number | null;
  remote_jid: string | null;
  role: 'owner' | 'member';
  last_read_id: number;
}

interface MessageRow {
  id: number;
  conversation_id: number;
  sender_user_id: number | null;
  sender_jid: string | null;
  kind: 'text' | 'system';
  body: string;
  created_at: number;
  deleted: number;
}

export interface ChatMember {
  userId: number | null;
  jid: string | null;
  username: string | null;
  displayName: string;
  address: string;
  online: boolean;
  role: 'owner' | 'member';
  lastReadId: number;
}

export interface ChatMessage {
  id: number;
  conversationId: number;
  senderUserId: number | null;
  senderJid: string | null;
  kind: 'text' | 'system';
  body: string;
  createdAt: number;
  deleted: boolean;
}

/** Sends chat traffic to people on other servers; registered by the XMPP gateway. */
export interface RemoteTransport {
  /** False when the link to the XMPP server is down. */
  sendMessage(fromUsername: string, toJid: string, body: string, id: string): boolean;
  sendTyping(fromUsername: string, toJid: string, state: 'composing' | 'paused' | 'active'): void;
}
let remote: RemoteTransport | null = null;
export const setRemoteTransport = (t: RemoteTransport | null) => (remote = t);

/* ---------- helpers ---------- */

const userRow = (id: number) =>
  db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(id) as
    | { id: number; username: string; display_name: string }
    | undefined;

function toMessage(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    senderUserId: r.sender_user_id,
    senderJid: r.sender_jid,
    kind: r.kind,
    body: r.deleted ? '' : r.body,
    createdAt: r.created_at,
    deleted: !!r.deleted,
  };
}

function members(convId: number): ChatMember[] {
  const rows = db
    .prepare(
      `SELECT m.*, u.username, u.display_name FROM chat_members m
       LEFT JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? ORDER BY m.id`,
    )
    .all(convId) as (MemberRow & { username: string | null; display_name: string | null })[];
  return rows.map((m) => ({
    userId: m.user_id,
    jid: m.remote_jid,
    username: m.username,
    displayName: m.user_id ? m.display_name || m.username || '' : m.remote_jid!,
    address: m.user_id ? userAddress(m.username!) : m.remote_jid!,
    online: m.user_id ? isOnline(m.user_id) : false,
    role: m.role,
    lastReadId: m.last_read_id,
  }));
}

const localMemberIds = (convId: number) =>
  db.prepare('SELECT user_id FROM chat_members WHERE conversation_id = ? AND user_id IS NOT NULL').pluck().all(convId) as number[];

function membership(userId: number, convId: number): MemberRow {
  const m = db.prepare('SELECT * FROM chat_members WHERE conversation_id = ? AND user_id = ?').get(convId, userId) as MemberRow | undefined;
  if (!m) throw notFound('Conversation not found');
  return m;
}

const conv = (id: number) => db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(id) as ConvRow | undefined;

/** The conversation as seen by one user (unread count, display title). */
export function conversationView(userId: number, convId: number) {
  const c = conv(convId)!;
  const ms = members(convId);
  const me = ms.find((m) => m.userId === userId);
  const last = db
    .prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1')
    .get(convId) as MessageRow | undefined;
  const unread = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ? AND id > ? AND kind = 'text'
         AND (sender_user_id IS NULL OR sender_user_id != ?)`,
      )
      .get(convId, me?.lastReadId ?? 0, userId) as { n: number }
  ).n;
  const other = c.kind === 'dm' ? ms.find((m) => m.userId !== userId) : undefined;
  return {
    id: c.id,
    kind: c.kind,
    title: c.kind === 'group' ? c.name : (other?.displayName ?? 'Unknown'),
    name: c.name,
    members: ms,
    lastMessage: last ? toMessage(last) : null,
    lastMessageAt: c.last_message_at,
    unread,
    remote: ms.some((m) => m.jid),
  };
}
export type ConversationView = ReturnType<typeof conversationView>;

function broadcastConversation(convId: number, extraUserIds: number[] = []) {
  for (const uid of new Set([...localMemberIds(convId), ...extraUserIds])) {
    publish(uid, 'chat.conversation', conversationView(uid, convId));
  }
}

function insertMessage(convId: number, m: { userId?: number; jid?: string; kind?: 'text' | 'system'; body: string; stanzaId?: string }): ChatMessage {
  const ts = now();
  const info = db
    .prepare(
      'INSERT INTO chat_messages (conversation_id, sender_user_id, sender_jid, kind, body, created_at, stanza_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(convId, m.userId ?? null, m.jid ?? null, m.kind ?? 'text', m.body, ts, m.stanzaId ?? null);
  db.prepare('UPDATE chat_conversations SET last_message_at = ? WHERE id = ?').run(ts, convId);
  const msg = toMessage(db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(info.lastInsertRowid) as MessageRow);
  publish(localMemberIds(convId), 'chat.message', msg);
  return msg;
}

/* ---------- addresses ---------- */

export type Peer = { userId: number } | { jid: string };

const JID_RE = /^[^\s@/"&'<>:]+@[a-z0-9.-]+\.[a-z0-9-]+$/i;

/** Resolves "bob", "bob@home.mail" or "someone@other.server" to a local user or remote address. */
export function resolveAddress(input: string): Peer {
  const addr = input.trim().toLowerCase().replace(/^xmpp:/, '');
  const at = addr.lastIndexOf('@');
  const local = at < 0 ? addr : addr.slice(0, at);
  const domain = at < 0 ? chatDomain() : addr.slice(at + 1);
  if (domain === chatDomain()) {
    const u = db.prepare('SELECT id FROM users WHERE username = ? AND disabled = 0').get(local) as { id: number } | undefined;
    if (!u) throw notFound(`No user called "${local}" on this server`);
    return { userId: u.id };
  }
  if (!federationEnabled()) throw badRequest(`Chatting with other servers is turned off, so ${addr} can't be reached`);
  if (!JID_RE.test(addr)) throw badRequest(`"${input}" is not a valid chat address`);
  return { jid: addr };
}

export function directory(userId: number) {
  const rows = db.prepare('SELECT id, username, display_name FROM users WHERE disabled = 0 AND id != ? ORDER BY username').all(userId) as {
    id: number;
    username: string;
    display_name: string;
  }[];
  return rows.map((u) => ({ userId: u.id, username: u.username, displayName: u.display_name || u.username, address: userAddress(u.username), online: isOnline(u.id) }));
}

/* ---------- conversations ---------- */

export function listConversations(userId: number) {
  const ids = db
    .prepare(
      `SELECT c.id FROM chat_conversations c JOIN chat_members m ON m.conversation_id = c.id
       WHERE m.user_id = ? ORDER BY c.last_message_at DESC`,
    )
    .pluck()
    .all(userId) as number[];
  return ids.map((id) => conversationView(userId, id));
}

export function getConversation(userId: number, convId: number) {
  membership(userId, convId);
  return conversationView(userId, convId);
}

function findDm(userId: number, peer: Peer): number | undefined {
  const sql =
    'userId' in peer
      ? `SELECT c.id FROM chat_conversations c
         JOIN chat_members a ON a.conversation_id = c.id AND a.user_id = ?
         JOIN chat_members b ON b.conversation_id = c.id AND b.user_id = ?
         WHERE c.kind = 'dm'`
      : `SELECT c.id FROM chat_conversations c
         JOIN chat_members a ON a.conversation_id = c.id AND a.user_id = ?
         JOIN chat_members b ON b.conversation_id = c.id AND b.remote_jid = ?
         WHERE c.kind = 'dm'`;
  return db.prepare(sql).pluck().get(userId, 'userId' in peer ? peer.userId : peer.jid) as number | undefined;
}

export function openDm(userId: number, peer: Peer): number {
  if ('userId' in peer && peer.userId === userId) throw badRequest("You can't start a chat with yourself");
  const existing = findDm(userId, peer);
  if (existing) return existing;
  const ts = now();
  const id = db.transaction(() => {
    const convId = Number(
      db.prepare("INSERT INTO chat_conversations (kind, created_by, created_at, last_message_at) VALUES ('dm', ?, ?, ?)").run(userId, ts, ts)
        .lastInsertRowid,
    );
    const add = db.prepare('INSERT INTO chat_members (conversation_id, user_id, remote_jid, role, joined_at) VALUES (?, ?, ?, ?, ?)');
    add.run(convId, userId, null, 'member', ts);
    if ('userId' in peer) add.run(convId, peer.userId, null, 'member', ts);
    else add.run(convId, null, peer.jid, 'member', ts);
    return convId;
  })();
  broadcastConversation(id);
  return id;
}

export function createGroup(userId: number, name: string, memberIds: number[]): number {
  const ts = now();
  const ids = [...new Set(memberIds.filter((m) => m !== userId))];
  for (const m of ids) if (!userRow(m)) throw badRequest('Unknown user in member list');
  const id = db.transaction(() => {
    const convId = Number(
      db.prepare("INSERT INTO chat_conversations (kind, name, created_by, created_at, last_message_at) VALUES ('group', ?, ?, ?, ?)").run(name, userId, ts, ts)
        .lastInsertRowid,
    );
    const add = db.prepare('INSERT INTO chat_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)');
    add.run(convId, userId, 'owner', ts);
    for (const m of ids) add.run(convId, m, 'member', ts);
    return convId;
  })();
  insertMessage(id, { kind: 'system', body: `${userRow(userId)!.display_name || userRow(userId)!.username} created the group "${name}"` });
  broadcastConversation(id);
  return id;
}

const displayName = (uid: number) => {
  const u = userRow(uid);
  return u ? u.display_name || u.username : 'Someone';
};

function requireGroupOwner(userId: number, convId: number) {
  const c = conv(convId);
  if (c?.kind !== 'group') throw badRequest('Only group chats can be changed');
  if (membership(userId, convId).role !== 'owner') throw new HttpError(403, 'Only the group owner can do that');
}

export function renameGroup(userId: number, convId: number, name: string) {
  requireGroupOwner(userId, convId);
  db.prepare('UPDATE chat_conversations SET name = ? WHERE id = ?').run(name, convId);
  insertMessage(convId, { kind: 'system', body: `${displayName(userId)} renamed the group to "${name}"` });
  broadcastConversation(convId);
}

export function addMembers(userId: number, convId: number, memberIds: number[]) {
  requireGroupOwner(userId, convId);
  const existing = new Set(localMemberIds(convId));
  const add = db.prepare("INSERT INTO chat_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)");
  const added = memberIds.filter((m) => !existing.has(m) && userRow(m));
  for (const m of added) add.run(convId, m, now());
  if (added.length) {
    insertMessage(convId, { kind: 'system', body: `${displayName(userId)} added ${added.map(displayName).join(', ')}` });
    broadcastConversation(convId);
  }
}

export function removeMember(userId: number, convId: number, memberUserId: number) {
  const self = memberUserId === userId;
  if (!self) requireGroupOwner(userId, convId);
  else if (conv(convId)?.kind !== 'group') throw badRequest('You can only leave group chats');
  membership(memberUserId, convId);
  db.prepare('DELETE FROM chat_members WHERE conversation_id = ? AND user_id = ?').run(convId, memberUserId);
  publish(memberUserId, 'chat.removed', { conversationId: convId });
  const remaining = localMemberIds(convId);
  if (!remaining.length) {
    db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(convId);
    return;
  }
  // A group always keeps an owner.
  const hasOwner = db.prepare("SELECT 1 FROM chat_members WHERE conversation_id = ? AND role = 'owner'").get(convId);
  if (!hasOwner) db.prepare("UPDATE chat_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?").run(convId, remaining[0]);
  insertMessage(convId, { kind: 'system', body: self ? `${displayName(userId)} left` : `${displayName(userId)} removed ${displayName(memberUserId)}` });
  broadcastConversation(convId);
}

/** Deletes a DM and its history for both people. Groups use removeMember. */
export function deleteDm(userId: number, convId: number) {
  if (conv(convId)?.kind !== 'dm') throw badRequest('Use "Leave group" for group chats');
  membership(userId, convId);
  const members = localMemberIds(convId);
  db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(convId);
  publish(members, 'chat.removed', { conversationId: convId });
}

/* ---------- messages ---------- */

export function listMessages(userId: number, convId: number, beforeId: number | undefined, limit: number): ChatMessage[] {
  membership(userId, convId);
  const rows = db
    .prepare(`SELECT * FROM chat_messages WHERE conversation_id = ? ${beforeId ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`)
    .all(...(beforeId ? [convId, beforeId, limit] : [convId, limit])) as MessageRow[];
  return rows.reverse().map(toMessage);
}

export function sendMessage(userId: number, convId: number, body: string): ChatMessage {
  membership(userId, convId);
  const msg = insertMessage(convId, { userId, body });
  markRead(userId, convId, msg.id);
  const remoteMembers = db.prepare('SELECT remote_jid FROM chat_members WHERE conversation_id = ? AND remote_jid IS NOT NULL').pluck().all(convId) as string[];
  if (remoteMembers.length) {
    const username = userRow(userId)!.username;
    const sent = !!remote && federationEnabled() && remoteMembers.every((jid) => remote!.sendMessage(username, jid, body, `hm-${msg.id}`));
    if (!sent) throw new HttpError(503, 'Saved here, but it could not be delivered: the connection to other chat servers is down');
  }
  return msg;
}

export function deleteMessage(userId: number, messageId: number) {
  const m = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(messageId) as MessageRow | undefined;
  if (!m || m.sender_user_id !== userId) throw notFound('Message not found');
  db.prepare('UPDATE chat_messages SET deleted = 1 WHERE id = ?').run(messageId);
  publish(localMemberIds(m.conversation_id), 'chat.message', toMessage({ ...m, deleted: 1 }));
}

export function markRead(userId: number, convId: number, messageId: number) {
  const m = membership(userId, convId);
  if (messageId <= m.last_read_id) return;
  db.prepare('UPDATE chat_members SET last_read_id = ? WHERE id = ?').run(messageId, m.id);
  publish(localMemberIds(convId), 'chat.read', { conversationId: convId, userId, lastReadId: messageId });
}

export function typing(userId: number, convId: number, active: boolean) {
  membership(userId, convId);
  const others = localMemberIds(convId).filter((id) => id !== userId);
  publish(others, 'chat.typing', { conversationId: convId, userId, name: displayName(userId), active });
  if (remote && federationEnabled()) {
    const jids = db.prepare('SELECT remote_jid FROM chat_members WHERE conversation_id = ? AND remote_jid IS NOT NULL').pluck().all(convId) as string[];
    for (const jid of jids) remote.sendTyping(userRow(userId)!.username, jid, active ? 'composing' : 'paused');
  }
}

/* ---------- incoming from other servers ---------- */

export function localUserByName(username: string) {
  return db.prepare('SELECT id, username, display_name FROM users WHERE username = ? AND disabled = 0').get(username.toLowerCase()) as
    | { id: number; username: string; display_name: string }
    | undefined;
}

export function receiveRemoteMessage(toUserId: number, fromJid: string, body: string, stanzaId?: string) {
  const convId = openDm(toUserId, { jid: fromJid });
  if (stanzaId) {
    const dup = db.prepare('SELECT 1 FROM chat_messages WHERE conversation_id = ? AND sender_jid = ? AND stanza_id = ?').get(convId, fromJid, stanzaId);
    if (dup) return;
  }
  insertMessage(convId, { jid: fromJid, body, stanzaId });
  broadcastConversation(convId);
}

export function receiveRemoteTyping(toUserId: number, fromJid: string, active: boolean) {
  const convId = findDm(toUserId, { jid: fromJid });
  if (convId) publish(toUserId, 'chat.typing', { conversationId: convId, jid: fromJid, name: fromJid, active });
}

/* ---------- presence ---------- */

presence.on('presence', (userId: number, online: boolean) => {
  publish(onlineUserIds(), 'presence', { userId, online });
});
