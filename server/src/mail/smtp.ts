import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import addressparser from 'nodemailer/lib/addressparser';
import type { AccountRow } from '../accounts.js';
import { resolveAuth } from '../oauth.js';
import { presetById } from '../providers.js';
import { badRequest } from '../http.js';
import { attachmentName, sanitizeEmailHtml, parseRaw } from './parse.js';
import { backendFor } from './service.js';
import { withTimeout } from '../util.js';
import { submitFromBuiltin } from '../mailserver/builtin.js';
import type { Addr } from './types.js';

export async function createTransport(account: AccountRow) {
  const auth = await resolveAuth(account, 'smtp');
  return nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: account.smtp_security === 'tls',
    requireTLS: account.smtp_security === 'starttls',
    ignoreTLS: account.smtp_security === 'none',
    auth: auth.accessToken
      ? { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken }
      : auth.user
        ? { user: auth.user, pass: auth.pass ?? '' }
        : undefined,
    tls: { rejectUnauthorized: !account.allow_insecure_tls },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
  });
}

export async function testSmtp(account: AccountRow): Promise<void> {
  if (account.protocol === 'local') return;
  const t = await createTransport(account);
  try {
    await withTimeout(t.verify(), 60_000, 'SMTP connection test');
  } finally {
    t.close();
  }
}

/** Parses "Name <a@b>, c@d" into addresses, rejecting obviously invalid ones. */
export function parseAddresses(input: string | undefined): Addr[] {
  if (!input?.trim()) return [];
  const flat = (list: ReturnType<typeof addressparser>): Addr[] =>
    list.flatMap((a) => ('group' in a && a.group ? flat(a.group) : [{ name: a.name || '', address: (a as { address?: string }).address || '' }]));
  const out = flat(addressparser(input));
  for (const a of out) if (!/^[^\s@]+@[^\s@]+$/.test(a.address)) throw badRequest(`Invalid email address: ${a.address || a.name}`);
  return out;
}

export interface ComposeInput {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  html?: string;
  priority?: 'high' | 'normal' | 'low';
  /** Ask the recipient's program to confirm reading (Disposition-Notification-To). */
  readReceipt?: boolean;
  inReplyTo?: string;
  references?: string[];
  /** Message whose attachments (by index) are carried over: forwarding or re-saving a draft. */
  forwardOf?: { folder: string; id: number; attachments?: number[] };
  /** Draft to delete after successful send/save. */
  draftOf?: { folder: string; id: number };
  /** Original message to mark answered. */
  replyOf?: { folder: string; id: number };
  attachments: { filename: string; contentType: string; content: Buffer }[];
}

/** Importance as Outlook, Thunderbird and Gmail understand it. MailComposer doesn't set these itself. */
const PRIORITY_HEADERS = {
  high: { 'X-Priority': '1 (Highest)', 'X-MSMail-Priority': 'High', Importance: 'High' },
  low: { 'X-Priority': '5 (Lowest)', 'X-MSMail-Priority': 'Low', Importance: 'Low' },
};

/**
 * Pictures pasted into the editor arrive as data: URLs, which many mail programs
 * (Gmail, Outlook) refuse to show. Send them as related attachments referenced by cid: instead.
 */
function inlineImagesAsAttachments(html: string, attachments: { filename: string; contentType: string; content: Buffer; cid?: string }[]): string {
  let n = 0;
  return html.replace(/(<img\b[^>]*?\bsrc=")data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)"/gi, (_m, pre: string, type: string, b64: string) => {
    const cid = `img${++n}.${crypto.randomBytes(8).toString('hex')}@homemail`;
    const ext = type.split('/')[1].replace('jpeg', 'jpg').replace(/\+.*$/, '');
    attachments.push({ filename: `image${n}.${ext}`, contentType: type, content: Buffer.from(b64, 'base64'), cid });
    return `${pre}cid:${cid}"`;
  });
}

async function buildRaw(account: AccountRow, input: ComposeInput, forDraft: boolean) {
  const to = parseAddresses(input.to);
  const cc = parseAddresses(input.cc);
  const bcc = parseAddresses(input.bcc);
  if (!forDraft && !to.length && !cc.length && !bcc.length) throw badRequest('Add at least one recipient');

  const attachments: { filename: string; contentType: string; content: Buffer; cid?: string }[] = [...input.attachments];
  if (input.forwardOf) {
    const src = await backendFor(account).getSource(input.forwardOf.folder, input.forwardOf.id);
    const orig = await parseRaw(src);
    const wanted = input.forwardOf.attachments;
    orig.attachments.forEach((a, i) => {
      if (wanted ? !wanted.includes(i) : a.related) return;
      attachments.push({ filename: attachmentName(a, i), contentType: a.contentType, content: a.content });
    });
  }

  const html = input.html ? inlineImagesAsAttachments(sanitizeEmailHtml(input.html), attachments) : undefined;
  const composer = new MailComposer({
    from: { name: account.display_name || '', address: account.email },
    to,
    cc,
    bcc,
    subject: input.subject,
    text: input.text,
    html,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments,
    headers: {
      'User-Agent': 'HomeMail',
      ...(input.readReceipt ? { 'Disposition-Notification-To': account.email } : {}),
      ...(input.priority && input.priority !== 'normal' ? PRIORITY_HEADERS[input.priority] : {}),
    },
  });
  const node = composer.compile();
  // Keep Bcc in drafts so it survives re-opening; the sent copy omits it.
  node.keepBcc = forDraft;
  const raw = await node.build();
  return { raw, recipients: [...to, ...cc, ...bcc].map((a) => a.address) };
}

export async function sendMessage(account: AccountRow, input: ComposeInput): Promise<void> {
  const { raw, recipients } = await buildRaw(account, input, false);
  if (account.protocol === 'local') {
    await submitFromBuiltin(account, raw, recipients);
  } else {
    const transport = await createTransport(account);
    try {
      await withTimeout(transport.sendMail({ envelope: { from: account.email, to: recipients }, raw }), 180_000, 'Sending');
    } finally {
      transport.close();
    }
  }

  // Sending succeeded; the follow-up steps below are best effort.
  const backend = backendFor(account);
  const providerSaves = presetById(account.provider)?.smtpSavesSent && account.protocol === 'imap';
  const tasks: Promise<unknown>[] = [];
  if (account.save_sent && !providerSaves) tasks.push(backend.storeSent(raw));
  if (input.replyOf) tasks.push(backend.setFlags(input.replyOf.folder, [input.replyOf.id], { answered: true }));
  if (input.draftOf) tasks.push(backend.remove(input.draftOf.folder, [input.draftOf.id], true));
  const results = await Promise.allSettled(tasks);
  for (const r of results) if (r.status === 'rejected') console.warn(`[send ${account.id}] post-send step failed:`, r.reason?.message);
}

export async function saveDraft(account: AccountRow, input: ComposeInput): Promise<{ folder: string; id: number | null }> {
  const { raw } = await buildRaw(account, input, true);
  const backend = backendFor(account);
  const saved = await backend.saveDraft(raw);
  if (input.draftOf) await backend.remove(input.draftOf.folder, [input.draftOf.id], true).catch(() => {});
  return saved;
}
