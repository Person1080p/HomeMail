import dns from 'node:dns/promises';
import net from 'node:net';
import type { ParsedMail } from 'mailparser';
import { HttpError, badRequest } from '../http.js';
import { db, now } from '../db.js';

/*
 * One-click unsubscribe. Uses the List-Unsubscribe headers (RFC 2369) and, when the
 * sender supports it, RFC 8058 one-click: HomeMail's server sends the POST itself.
 * Without headers, an "unsubscribe" link in the message body is offered instead.
 */

export interface UnsubscribeInfo {
  /** HTTPS URL accepting an RFC 8058 one-click POST. */
  oneClick: string | null;
  /** Web page to open (from the header, or from the body when fromBody is set). */
  web: string | null;
  /** mailto: URI from the header. */
  mailto: string | null;
  /** Only a link in the message body was found, no List-Unsubscribe header. */
  fromBody: boolean;
  /** What we remember an unsubscribe by: the List-Id, or else the sender address. */
  listKey: string;
  listName: string;
}

function headerValue(m: ParsedMail, name: string): string | null {
  const line = m.headerLines.find((l) => l.key === name);
  if (!line) return null;
  // Unfold continuation lines and drop the "Name:" prefix.
  return line.line.replace(/\r?\n[ \t]+/g, ' ').replace(/^[^:]*:\s*/, '');
}

const UNSUB_TEXT = /unsubscribe|opt[\s-]?out|stop (receiving|these|getting)|manage (your )?(email |subscription |communication )?preferences|abmelden|désabonner|desinscri|darse de baja|annulla l'iscrizione|afmelden/i;

/** Finds an unsubscribe link in sanitised message HTML. */
function bodyLink(html: string | null): string | null {
  if (!html) return null;
  const links = [...html.matchAll(/<a\b[^>]*?\bhref="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map(([, href, inner]) => ({
    href: href.replace(/&amp;/g, '&'),
    text: inner.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|\s+/g, ' ').trim(),
  }));
  return (links.find((l) => UNSUB_TEXT.test(l.text)) ?? links.find((l) => /unsub|opt-?out/i.test(l.href)))?.href ?? null;
}

export function unsubscribeInfo(m: ParsedMail, sanitizedHtml: string | null): UnsubscribeInfo | null {
  const header = headerValue(m, 'list-unsubscribe');
  const entries = header ? [...header.matchAll(/<\s*([^>]+?)\s*>/g)].map((x) => x[1]) : [];
  const http = entries.find((e) => /^https:\/\//i.test(e)) ?? entries.find((e) => /^http:\/\//i.test(e)) ?? null;
  const mailto = entries.find((e) => /^mailto:/i.test(e)) ?? null;
  const oneClickHeader = /List-Unsubscribe=One-Click/i.test(headerValue(m, 'list-unsubscribe-post') ?? '');
  const fromBody = !http && !mailto ? bodyLink(sanitizedHtml) : null;
  if (!http && !mailto && !fromBody) return null;

  const listId = headerValue(m, 'list-id');
  const listIdKey = listId?.match(/<([^>]+)>/)?.[1] ?? listId?.trim();
  const from = m.from?.value[0];
  return {
    oneClick: oneClickHeader && http?.toLowerCase().startsWith('https://') ? http : null,
    web: http ?? fromBody,
    mailto,
    fromBody: !!fromBody,
    listKey: (listIdKey || from?.address || 'unknown').toLowerCase(),
    listName: listId?.replace(/<[^>]*>/, '').replace(/^"|"$/g, '').trim() || from?.name || from?.address || 'this sender',
  };
}

/* ---------- RFC 8058 one-click POST ---------- */

// Never let a link in an email make HomeMail talk to the homelab network.
const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(addr, prefix, 'ipv6');

function isPublic(ip: string): boolean {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return !blocked.check(mapped, 'ipv4');
  return !blocked.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

async function oneClickPost(url: string): Promise<number> {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw badRequest('One-click unsubscribe needs an https link');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new HttpError(502, `Could not find ${host}`);
  if (!addrs.every((a) => isPublic(a.address))) throw badRequest('The unsubscribe link points to a private network address; HomeMail will not follow it');
  const res = await fetch(u, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'HomeMail' },
    body: 'List-Unsubscribe=One-Click',
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  }).catch((err) => {
    throw new HttpError(502, `The sender's unsubscribe server did not respond (${(err as Error).message})`);
  });
  // RFC 8058 expects a 2xx; many senders answer with a redirect to a "you're unsubscribed" page.
  if (res.status >= 400) throw new HttpError(502, `The sender's unsubscribe server answered ${res.status}`);
  return res.status;
}

/* ---------- actions and memory ---------- */

export type UnsubscribeMethod = 'one-click' | 'mailto' | 'web';

/** Parses mailto:addr?subject=..&body=.. into what to send. */
export function parseMailto(uri: string): { to: string; subject: string; body: string } {
  const u = new URL(uri);
  const to = decodeURIComponent(u.pathname).trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(to)) throw badRequest('The unsubscribe address is not valid');
  return {
    to,
    subject: u.searchParams.get('subject')?.slice(0, 500) || 'unsubscribe',
    body: u.searchParams.get('body')?.slice(0, 2000) || 'unsubscribe',
  };
}

export async function unsubscribeOneClick(info: UnsubscribeInfo): Promise<void> {
  await oneClickPost(info.oneClick!);
}

export function recordUnsubscribe(userId: number, info: UnsubscribeInfo, method: UnsubscribeMethod): void {
  db.prepare(
    `INSERT INTO unsubscribes (user_id, list_key, list_name, method, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, list_key) DO UPDATE SET method = excluded.method, created_at = excluded.created_at`,
  ).run(userId, info.listKey, info.listName, method, now());
}

export function unsubscribedAt(userId: number, listKey: string): number | null {
  const row = db.prepare('SELECT created_at FROM unsubscribes WHERE user_id = ? AND list_key = ?').get(userId, listKey) as { created_at: number } | undefined;
  return row?.created_at ?? null;
}
