import { component, xml, type Component, type XmlElement } from '@xmpp/component';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { isOnline, presence } from '../events.js';
import { chatDomain, federationEnabled } from '../server-settings.js';
import { localUserByName, receiveRemoteMessage, receiveRemoteTyping, setRemoteTransport } from './service.js';

/*
 * Chat federation over XMPP. HomeMail connects to Prosody as an external component
 * (XEP-0114) for the chat domain. Prosody handles server-to-server connections,
 * TLS and DNS; HomeMail answers for every user@<chat domain> address.
 */

const NS_CHATSTATES = 'http://jabber.org/protocol/chatstates';
const NS_STANZAS = 'urn:ietf:params:xml:ns:xmpp-stanzas';
const RESOURCE = 'homemail';

let xmpp: Component | null = null;
let domain = '';
let status: 'off' | 'connecting' | 'online' | 'error' = 'off';
let lastError: string | null = null;

export const xmppStatus = () => ({ status, lastError, domain: domain || chatDomain() });

const bare = (j: string | undefined) => (j ?? '').split('/')[0].toLowerCase();
const localPart = (j: string | undefined) => {
  const b = bare(j);
  const at = b.indexOf('@');
  return at > 0 && b.slice(at + 1) === domain ? b.slice(0, at) : null;
};
const fullJid = (username: string) => `${username.toLowerCase()}@${domain}/${RESOURCE}`;

function send(stanza: XmlElement): boolean {
  if (!xmpp || status !== 'online') return false;
  xmpp.send(stanza).catch((err) => console.warn('[xmpp] send failed:', err.message));
  return true;
}

function sendPresence(username: string, to: string, type?: string) {
  const online = type ? false : isOnline(localUserByName(username)?.id ?? -1);
  send(xml('presence', { from: type ? `${username}@${domain}` : fullJid(username), to, type: type ?? (online ? undefined : 'unavailable') }));
}

function handleMessage(st: XmlElement) {
  const from = bare(st.attrs.from);
  const user = localPart(st.attrs.to);
  if (st.attrs.type === 'error' || st.attrs.type === 'groupchat' || !from) return;
  const local = user ? localUserByName(user) : undefined;
  const body = st.getChildText('body');
  if (!local) {
    if (body) {
      send(
        xml('message', { type: 'error', from: st.attrs.to, to: st.attrs.from, id: st.attrs.id }, xml('error', { type: 'cancel' }, xml('item-not-found', { xmlns: NS_STANZAS }))),
      );
    }
    return;
  }
  if (body?.trim()) receiveRemoteMessage(local.id, from, body.slice(0, 10_000), st.attrs.id);
  const state = st.getChildElements().find((c) => c.attrs.xmlns === NS_CHATSTATES);
  if (state) receiveRemoteTyping(local.id, from, state.name === 'composing');
}

function handlePresence(st: XmlElement) {
  const from = bare(st.attrs.from);
  const user = localPart(st.attrs.to);
  const local = user ? localUserByName(user) : undefined;
  if (!local || !from) return;
  switch (st.attrs.type) {
    case 'subscribe':
      // Anyone may see whether a HomeMail user is online, like an open roster.
      db.prepare('INSERT OR IGNORE INTO xmpp_subscribers (user_id, jid, created_at) VALUES (?, ?, ?)').run(local.id, from, now());
      send(xml('presence', { from: `${local.username}@${domain}`, to: from, type: 'subscribed' }));
      sendPresence(local.username, from);
      break;
    case 'unsubscribe':
      db.prepare('DELETE FROM xmpp_subscribers WHERE user_id = ? AND jid = ?').run(local.id, from);
      send(xml('presence', { from: `${local.username}@${domain}`, to: from, type: 'unsubscribed' }));
      break;
    case 'probe':
      sendPresence(local.username, from);
      break;
  }
}

function registerIq(c: Component) {
  c.iqCallee.get('http://jabber.org/protocol/disco#info', 'query', (ctx) => {
    const isUser = !!localPart(ctx.stanza.attrs.to);
    if (isUser && !localUserByName(localPart(ctx.stanza.attrs.to)!)) return xml('error', { type: 'cancel' }, xml('item-not-found', { xmlns: NS_STANZAS }));
    const features = ['http://jabber.org/protocol/disco#info', 'urn:xmpp:ping', ...(isUser ? [NS_CHATSTATES] : ['jabber:iq:version'])];
    return xml(
      'query',
      { xmlns: 'http://jabber.org/protocol/disco#info', node: ctx.element.attrs.node },
      isUser ? xml('identity', { category: 'account', type: 'registered' }) : xml('identity', { category: 'server', type: 'im', name: 'HomeMail' }),
      ...features.map((f) => xml('feature', { var: f })),
    );
  });
  c.iqCallee.get('http://jabber.org/protocol/disco#items', 'query', () => xml('query', { xmlns: 'http://jabber.org/protocol/disco#items' }));
  c.iqCallee.get('urn:xmpp:ping', 'ping', () => true);
  c.iqCallee.get('jabber:iq:version', 'query', () => xml('query', { xmlns: 'jabber:iq:version' }, xml('name', {}, 'HomeMail')));
}

presence.on('presence', (userId: number, online: boolean) => {
  if (status !== 'online') return;
  const u = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
  if (!u) return;
  const subs = db.prepare('SELECT jid FROM xmpp_subscribers WHERE user_id = ?').pluck().all(userId) as string[];
  for (const jid of subs) send(xml('presence', { from: fullJid(u.username), to: jid, type: online ? undefined : 'unavailable' }));
});

export async function stopXmpp() {
  setRemoteTransport(null);
  const c = xmpp;
  xmpp = null;
  status = 'off';
  if (c) await c.stop().catch(() => {});
}

/** (Re)connects according to the current settings. Safe to call after every settings change. */
export async function startXmpp(): Promise<void> {
  await stopXmpp();
  if (!config.xmpp || !federationEnabled()) return;
  domain = chatDomain();
  status = 'connecting';
  lastError = null;
  const c = component({ service: config.xmpp.service, domain, password: config.xmpp.secret });
  xmpp = c;
  c.on('error', (err) => {
    lastError = err.message;
    if (xmpp === c) status = 'error';
    console.warn(`[xmpp] ${err.message}`);
  });
  c.on('online', () => {
    status = 'online';
    lastError = null;
    console.log(`[xmpp] federation online as ${domain}`);
  });
  c.on('offline', () => {
    if (xmpp === c && status === 'online') status = 'connecting';
  });
  c.on('stanza', (st) => {
    try {
      if (st.is('message')) handleMessage(st);
      else if (st.is('presence')) handlePresence(st);
    } catch (err) {
      console.warn('[xmpp] failed to handle stanza:', (err as Error).message);
    }
  });
  registerIq(c);
  setRemoteTransport({
    sendMessage(fromUsername, toJid, body, id) {
      return send(xml('message', { type: 'chat', from: fullJid(fromUsername), to: toJid, id }, xml('body', {}, body), xml('active', { xmlns: NS_CHATSTATES })));
    },
    sendTyping(fromUsername, toJid, state) {
      send(xml('message', { type: 'chat', from: fullJid(fromUsername), to: toJid }, xml(state, { xmlns: NS_CHATSTATES })));
    },
  });
  // xmpp.js keeps reconnecting on its own after the first attempt.
  c.start().catch((err) => {
    lastError = err.message;
    status = 'error';
    console.warn(`[xmpp] could not connect to ${config.xmpp!.service}: ${err.message}`);
  });
}
