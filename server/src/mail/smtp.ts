import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import addressparser from 'nodemailer/lib/addressparser';
import type { AccountRow } from '../accounts.js';
import { resolveAuth } from '../oauth.js';
import { presetById } from '../providers.js';
import { badRequest } from '../http.js';
import { attachmentName, sanitizeEmailHtml, parseRaw } from './parse.js';
import { backendFor } from './service.js';
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
  const t = await createTransport(account);
  try {
    await t.verify();
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

async function buildRaw(account: AccountRow, input: ComposeInput, forDraft: boolean) {
  const to = parseAddresses(input.to);
  const cc = parseAddresses(input.cc);
  const bcc = parseAddresses(input.bcc);
  if (!forDraft && !to.length && !cc.length && !bcc.length) throw badRequest('Add at least one recipient');

  const attachments: { filename: string; contentType: string; content: Buffer }[] = [...input.attachments];
  if (input.forwardOf) {
    const src = await backendFor(account).getSource(input.forwardOf.folder, input.forwardOf.id);
    const orig = await parseRaw(src);
    const wanted = input.forwardOf.attachments;
    orig.attachments.forEach((a, i) => {
      if (wanted ? !wanted.includes(i) : a.related) return;
      attachments.push({ filename: attachmentName(a, i), contentType: a.contentType, content: a.content });
    });
  }

  const composer = new MailComposer({
    from: { name: account.display_name || '', address: account.email },
    to,
    cc,
    bcc,
    subject: input.subject,
    text: input.text,
    html: input.html ? sanitizeEmailHtml(input.html) : undefined,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments,
    headers: { 'User-Agent': 'HomeMail' },
  });
  const node = composer.compile();
  // Keep Bcc in drafts so it survives re-opening; the sent copy omits it.
  node.keepBcc = forDraft;
  const raw = await node.build();
  return { raw, recipients: [...to, ...cc, ...bcc].map((a) => a.address) };
}

export async function sendMessage(account: AccountRow, input: ComposeInput): Promise<void> {
  const { raw, recipients } = await buildRaw(account, input, false);
  const transport = await createTransport(account);
  try {
    await transport.sendMail({ envelope: { from: account.email, to: recipients }, raw });
  } finally {
    transport.close();
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
