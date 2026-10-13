import { simpleParser, type AddressObject, type Attachment, type ParsedMail } from 'mailparser';
import sanitizeHtml from 'sanitize-html';
import type { Addr } from './types.js';
import { type UnsubscribeInfo, unsubscribeInfo } from './unsubscribe.js';

export function addrList(a: AddressObject | AddressObject[] | undefined): Addr[] {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  return list.flatMap((o) =>
    o.value.flatMap((v) => (v.group ? v.group.map((g) => ({ name: g.name || '', address: g.address || '' })) : [{ name: v.name || '', address: v.address || '' }])),
  );
}

const ALLOWED_TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  'img', 'style', 'center', 'font', 'span', 'div', 'u', 's', 'strike', 'big', 'small', 'sub', 'sup',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'col', 'colgroup', 'caption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'br', 'pre', 'blockquote', 'figure', 'figcaption',
  'picture', 'map', 'area', 'del', 'ins', 'mark', 'abbr', 'address',
];

const COMMON_ATTRS = [
  'style', 'class', 'id', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'border', 'cellpadding', 'cellspacing',
  'dir', 'lang', 'title', 'colspan', 'rowspan', 'face', 'size', 'background', 'nowrap', 'role', 'span', 'start', 'type',
];

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      '*': COMMON_ATTRS,
      a: [...COMMON_ATTRS, 'href', 'name', 'target', 'rel'],
      img: [...COMMON_ATTRS, 'src', 'alt'],
      area: ['href', 'alt', 'shape', 'coords'],
      map: ['name'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
    allowVulnerableTags: true, // <style> is needed for most newsletters; rendering is sandboxed and script-free.
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }),
    },
  });
}

const REMOTE_RE = /(?:src|background)\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//i;

export interface AttachmentInfo {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
}

export interface ParsedMessage {
  subject: string;
  from: Addr[];
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  replyTo: Addr[];
  date: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  html: string | null;
  text: string;
  hasRemoteContent: boolean;
  attachments: AttachmentInfo[];
  unsubscribe: UnsubscribeInfo | null;
}

export const attachmentName = (a: Attachment, i: number) => a.filename || `attachment-${i + 1}${a.contentType === 'message/rfc822' ? '.eml' : ''}`;

export async function parseRaw(raw: Buffer): Promise<ParsedMail> {
  return simpleParser(raw, { skipImageLinks: true });
}

export async function renderMessage(raw: Buffer): Promise<ParsedMessage> {
  const m = await parseRaw(raw);
  let html: string | null = null;
  const usedCids = new Set<string>();
  if (m.html) {
    const byCid = new Map<string, Attachment>();
    for (const a of m.attachments) if (a.cid) byCid.set(a.cid.toLowerCase(), a);
    html = sanitizeEmailHtml(m.html).replace(/cid:([^"'\s)>]+)/gi, (match, cid: string) => {
      const a = byCid.get(decodeURIComponent(cid).toLowerCase());
      if (!a || a.size > 5 * 1024 * 1024) return match;
      usedCids.add(a.cid!.toLowerCase());
      return `data:${a.contentType};base64,${a.content.toString('base64')}`;
    });
  }
  return {
    subject: m.subject || '',
    from: addrList(m.from),
    to: addrList(m.to),
    cc: addrList(m.cc),
    bcc: addrList(m.bcc),
    replyTo: addrList(m.replyTo),
    date: m.date ? m.date.toISOString() : null,
    messageId: m.messageId || null,
    inReplyTo: m.inReplyTo || null,
    references: Array.isArray(m.references) ? m.references : m.references ? [m.references] : [],
    html,
    text: m.text || '',
    hasRemoteContent: html ? REMOTE_RE.test(html) : false,
    unsubscribe: unsubscribeInfo(m, html),
    attachments: m.attachments.map((a, index) => ({
      index,
      filename: attachmentName(a, index),
      contentType: a.contentType,
      size: a.size,
      inline: !!a.cid && usedCids.has(a.cid.toLowerCase()),
    })),
  };
}
