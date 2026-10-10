import type { Account, AttachmentInfo, FullMessage } from '../../types';
import { addrText, escapeHtml, formatDate, linkify } from '../ui';

/*
 * Building replies, forwards and reopened drafts. Kept apart from the compose
 * component so the mail view doesn't load the rich text editor until it's needed.
 */

export interface Ref {
  folder: string;
  id: number;
}

/** The message being replied to or forwarded, kept as-is below what you write. */
export interface Quote {
  kind: 'reply' | 'forward';
  headerHtml: string;
  headerText: string;
  html: string;
  text: string;
}

export interface ComposeOptions {
  accountId?: number;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  /** Starting content of the editor (e.g. a reopened draft). Signature is added unless fromDraft. */
  body?: string;
  quote?: Quote;
  inReplyTo?: string;
  references?: string[];
  replyOf?: Ref;
  forwardOf?: Ref & { attachments: AttachmentInfo[] };
  draftOf?: Ref;
  fromDraft?: boolean;
}

/* ---------- building replies, forwards and drafts ---------- */

/** Makes received HTML safe to embed in a new message: no page-wide styles, no remote loads. */
export function cleanForQuote(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('style, link, meta, title, script, base').forEach((el) => el.remove());
  doc.querySelectorAll('img').forEach((img) => {
    if (!/^data:/i.test(img.getAttribute('src') || '')) img.remove();
  });
  doc.querySelectorAll('*').forEach((el) => {
    el.removeAttribute('background');
    el.removeAttribute('id');
    if (/url\(/i.test(el.getAttribute('style') || '')) el.removeAttribute('style');
  });
  return doc.body.innerHTML;
}

const quoteHtml = (m: FullMessage) => (m.html ? cleanForQuote(m.html) : `<div style="white-space:pre-wrap">${linkify(m.text)}</div>`);
const addrs = (list: { name: string; address: string }[]) => list.map(addrText).join(', ');
const withPrefix = (prefix: string, subject: string) => (new RegExp(`^${prefix}:`, 'i').test(subject.trim()) ? subject : `${prefix}: ${subject}`);

export function replyOptions(account: Account, folder: string, m: FullMessage, all: boolean): ComposeOptions {
  const me = account.email.toLowerCase();
  const primary = m.replyTo.length ? m.replyTo : m.from;
  let to = primary;
  let cc: typeof to = [];
  if (all) {
    const seen = new Set(primary.map((a) => a.address.toLowerCase()));
    seen.add(me);
    const rest = [...m.to, ...m.cc].filter((a) => {
      const k = a.address.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // Replying to your own sent message: reply to its recipients instead.
    if (primary.every((a) => a.address.toLowerCase() === me)) to = m.to;
    else cc = rest;
  }
  const who = m.from[0] ? addrText(m.from[0]) : 'someone';
  const header = `On ${formatDate(m.date, true)}, ${who} wrote:`;
  return {
    accountId: account.id,
    to: addrs(to),
    cc: addrs(cc),
    subject: withPrefix('Re', m.subject),
    quote: { kind: 'reply', headerHtml: escapeHtml(header), headerText: header, html: quoteHtml(m), text: m.text },
    inReplyTo: m.messageId ?? undefined,
    references: [...m.references, ...(m.messageId ? [m.messageId] : [])],
    replyOf: { folder, id: m.id },
  };
}

export function forwardOptions(account: Account, folder: string, m: FullMessage): ComposeOptions {
  const fields = [
    ['Subject', m.subject],
    ['Date', formatDate(m.date, true)],
    ['From', addrs(m.from)],
    ['To', addrs(m.to)],
    ...(m.cc.length ? [['CC', addrs(m.cc)]] : []),
  ];
  return {
    accountId: account.id,
    subject: withPrefix('Fwd', m.subject),
    quote: {
      kind: 'forward',
      headerHtml: `-------- Forwarded Message --------<br>${fields.map(([k, v]) => `<b>${k}:</b> ${escapeHtml(v)}`).join('<br>')}`,
      headerText: `-------- Forwarded Message --------\n${fields.map(([k, v]) => `${k}: ${v}`).join('\n')}`,
      html: quoteHtml(m),
      text: m.text,
    },
    forwardOf: { folder, id: m.id, attachments: m.attachments.filter((a) => !a.inline) },
  };
}

/** Reopens a saved draft; a quote saved by HomeMail is split off again so it stays intact. */
export function draftOptions(account: Account, folder: string, m: FullMessage): ComposeOptions {
  const atts = m.attachments.filter((a) => !a.inline);
  let body = m.html ? m.html : `<p>${escapeHtml(m.text).replace(/\n/g, '<br>')}</p>`;
  let quote: Quote | undefined;
  if (m.html) {
    const doc = new DOMParser().parseFromString(m.html, 'text/html');
    const q = doc.querySelector('.hm-quote');
    if (q) {
      const head = q.querySelector('.hm-quote-header');
      const content = q.querySelector('.hm-quote-body');
      quote = {
        kind: q.getAttribute('data-kind') === 'forward' || q.classList.contains('hm-forward') ? 'forward' : 'reply',
        headerHtml: head?.innerHTML ?? '',
        headerText: (head as HTMLElement | null)?.innerText ?? head?.textContent ?? '',
        html: cleanForQuote(content?.innerHTML ?? ''),
        text: content?.textContent ?? '',
      };
      q.remove();
    }
    body = doc.querySelector('.hm-body')?.innerHTML ?? cleanForQuote(doc.body.innerHTML);
  }
  return {
    accountId: account.id,
    to: addrs(m.to),
    cc: addrs(m.cc),
    bcc: addrs(m.bcc),
    subject: m.subject,
    body,
    quote,
    inReplyTo: m.inReplyTo ?? undefined,
    references: m.references,
    draftOf: { folder, id: m.id },
    forwardOf: atts.length ? { folder, id: m.id, attachments: atts } : undefined,
    fromDraft: true,
  };
}
