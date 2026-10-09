import { useEffect, useRef, useState, type DragEvent } from 'react';
import { api, apiForm, mailPath, qs } from '../api';
import { useApp } from '../context';
import type { Account, AttachmentInfo, FullMessage } from '../types';
import { Icon } from './Icon';
import { addrText, escapeHtml, formatDate, formatSize, linkify, useToast } from './ui';

interface Ref {
  folder: string;
  id: number;
}

export interface ComposeOptions {
  accountId?: number;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  /** Initial body (quote etc.), without signature. */
  html?: string;
  inReplyTo?: string;
  references?: string[];
  replyOf?: Ref;
  forwardOf?: Ref & { attachments: AttachmentInfo[] };
  draftOf?: Ref;
  /** Editing an existing draft: its body already contains any signature. */
  fromDraft?: boolean;
}

/* ---------- building replies / forwards ---------- */

/** Makes received HTML safe to place in the editor: no styles that leak into the app, no remote loads. */
function cleanForQuote(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('style, link, meta, title, script, base').forEach((el) => el.remove());
  doc.querySelectorAll('img').forEach((img) => {
    if (!/^data:/i.test(img.getAttribute('src') || '')) img.remove();
  });
  doc.querySelectorAll('*').forEach((el) => {
    el.removeAttribute('background');
    el.removeAttribute('class');
    el.removeAttribute('id');
    if (/url\(/i.test(el.getAttribute('style') || '')) el.removeAttribute('style');
  });
  return doc.body.innerHTML;
}

const quoteBody = (m: FullMessage) => (m.html ? cleanForQuote(m.html) : `<div style="white-space:pre-wrap">${linkify(m.text)}</div>`);
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
  return {
    accountId: account.id,
    to: addrs(to),
    cc: addrs(cc),
    subject: withPrefix('Re', m.subject),
    html: `<div>On ${escapeHtml(formatDate(m.date, true))}, ${escapeHtml(who)} wrote:</div><blockquote type="cite">${quoteBody(m)}</blockquote>`,
    inReplyTo: m.messageId ?? undefined,
    references: [...m.references, ...(m.messageId ? [m.messageId] : [])],
    replyOf: { folder, id: m.id },
  };
}

export function forwardOptions(account: Account, folder: string, m: FullMessage): ComposeOptions {
  const header = [
    ['Subject', m.subject],
    ['Date', formatDate(m.date, true)],
    ['From', addrs(m.from)],
    ['To', addrs(m.to)],
    ...(m.cc.length ? [['CC', addrs(m.cc)]] : []),
  ]
    .map(([k, v]) => `<b>${k}:</b> ${escapeHtml(v)}`)
    .join('<br>');
  return {
    accountId: account.id,
    subject: withPrefix('Fwd', m.subject),
    html: `<div>-------- Forwarded Message --------</div><div>${header}</div><br>${quoteBody(m)}`,
    forwardOf: { folder, id: m.id, attachments: m.attachments.filter((a) => !a.inline) },
  };
}

export function draftOptions(account: Account, folder: string, m: FullMessage): ComposeOptions {
  const atts = m.attachments.filter((a) => !a.inline);
  return {
    accountId: account.id,
    to: addrs(m.to),
    cc: addrs(m.cc),
    bcc: addrs(m.bcc),
    subject: m.subject,
    html: m.html ? cleanForQuote(m.html) : `<div style="white-space:pre-wrap">${escapeHtml(m.text)}</div>`,
    inReplyTo: m.inReplyTo ?? undefined,
    references: m.references,
    draftOf: { folder, id: m.id },
    forwardOf: atts.length ? { folder, id: m.id, attachments: atts } : undefined,
    fromDraft: true,
  };
}

const signatureHtml = (sig: string) => (sig.trim() ? `<div class="hm-signature">-- <br>${escapeHtml(sig.replace(/^--\s*\n/, '')).replace(/\n/g, '<br>')}</div>` : '');

/**
 * Plain-text alternative of the editor content, with "> " before quoted lines.
 * innerText only lays out line breaks for rendered nodes, so work on an offscreen copy.
 */
function htmlToText(source: HTMLElement): string {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:700px;white-space:normal';
  const clone = source.cloneNode(true) as HTMLElement;
  holder.appendChild(clone);
  document.body.appendChild(holder);
  try {
    let bqs = [...clone.querySelectorAll('blockquote')];
    // Innermost first so nested quotes get stacked prefixes.
    while (bqs.length) {
      const inner = bqs.filter((b) => !b.querySelector('blockquote'));
      for (const bq of inner) {
        const div = document.createElement('div');
        div.style.whiteSpace = 'pre-wrap';
        div.textContent = bq.innerText.replace(/\n+$/, '').split('\n').map((l) => (l.startsWith('>') ? `>${l}` : `> ${l}`)).join('\n');
        bq.replaceWith(div);
      }
      bqs = [...clone.querySelectorAll('blockquote')];
    }
    return clone.innerText.replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  } finally {
    holder.remove();
  }
}

/* ---------- component ---------- */

export function Compose({ options, onClose }: { options: ComposeOptions; onClose: () => void }) {
  const { accounts, bumpMail } = useApp();
  const toast = useToast();
  const [accountId, setAccountId] = useState(options.accountId && accounts.some((a) => a.id === options.accountId) ? options.accountId : accounts[0]?.id);
  const [to, setTo] = useState(options.to ?? '');
  const [cc, setCc] = useState(options.cc ?? '');
  const [bcc, setBcc] = useState(options.bcc ?? '');
  const [showCc, setShowCc] = useState(!!(options.cc || options.bcc));
  const [subject, setSubject] = useState(options.subject ?? '');
  const [files, setFiles] = useState<File[]>([]);
  // Attachments carried over from another message (forwarded mail or a saved draft).
  const [carry, setCarry] = useState<Ref | undefined>(options.forwardOf && { folder: options.forwardOf.folder, id: options.forwardOf.id });
  const [carried, setCarried] = useState(options.forwardOf?.attachments ?? []);
  const [draftOf, setDraftOf] = useState(options.draftOf);
  const [busy, setBusy] = useState<'send' | 'draft' | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editor = useRef<HTMLDivElement>(null);
  const caretPlaced = useRef(!!options.fromDraft);
  const fileInput = useRef<HTMLInputElement>(null);
  const account = accounts.find((a) => a.id === accountId);

  // Initial body: blank line, signature, then any quote.
  useEffect(() => {
    if (!editor.current) return;
    const sig = options.fromDraft ? '' : signatureHtml(account?.signature ?? '');
    editor.current.innerHTML = options.fromDraft ? options.html || '<div><br></div>' : `<div><br></div>${sig ? `<div><br></div>${sig}` : ''}${options.html ? `<div><br></div>${options.html}` : ''}`;
    // Replies start in the body; new messages and forwards start in the To field.
    if (options.to && !options.fromDraft) editor.current.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switching the From account swaps the signature.
  const changeAccount = (id: number) => {
    setAccountId(id);
    const next = accounts.find((a) => a.id === id);
    const old = editor.current?.querySelector('.hm-signature');
    const html = signatureHtml(next?.signature ?? '');
    if (old) {
      if (html) old.outerHTML = html;
      else old.remove();
    } else if (html && editor.current) {
      editor.current.querySelector(':scope > div')?.insertAdjacentHTML('afterend', `<div><br></div>${html}`);
    }
  };

  const exec = (cmd: string, value?: string) => {
    editor.current?.focus();
    document.execCommand(cmd, false, value);
    setDirty(true);
  };

  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    setFiles((f) => [...f, ...Array.from(list)]);
    setDirty(true);
  };

  const buildForm = () => {
    const html = editor.current!.innerHTML;
    const payload = {
      to,
      cc: showCc ? cc : '',
      bcc: showCc ? bcc : '',
      subject,
      html,
      text: htmlToText(editor.current!),
      inReplyTo: options.inReplyTo,
      references: options.references,
      replyOf: options.replyOf,
      draftOf,
      forwardOf: carry && carried.length ? { ...carry, attachments: carried.map((a) => a.index) } : undefined,
    };
    const form = new FormData();
    form.append('payload', JSON.stringify(payload));
    for (const f of files) form.append('files', f, f.name);
    return form;
  };

  const send = async () => {
    if (!account || busy) return;
    if (!to.trim() && !cc.trim() && !bcc.trim()) return toast('Add at least one recipient', 'error');
    if (!subject.trim() && !confirm('Send this message without a subject?')) return;
    setBusy('send');
    try {
      await apiForm(mailPath(account.id, '/send'), buildForm());
      toast('Message sent', 'success');
      bumpMail();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(null);
    }
  };

  const saveDraft = async () => {
    if (!account || busy) return;
    setBusy('draft');
    try {
      const saved = await apiForm<{ folder: string; id: number | null }>(mailPath(account.id, '/drafts'), buildForm());
      if (saved.id) {
        // The saved draft now holds every attachment; carry them from there from now on.
        const ref = { folder: saved.folder, id: saved.id };
        const draft = await api<FullMessage>('GET', mailPath(account.id, `/messages/${saved.id}?${qs({ folder: saved.folder, peek: 1 })}`));
        setDraftOf(ref);
        setCarry(ref);
        setCarried(draft.attachments.filter((a) => !a.inline));
        setFiles([]);
      } else {
        // Server didn't report the new draft's id, so the next save can't replace it.
        setDraftOf(undefined);
      }
      setDirty(false);
      toast('Draft saved', 'success');
      bumpMail();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const close = () => {
    if (dirty && !confirm('Discard this message? Unsaved changes will be lost.')) return;
    onClose();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const totalSize = files.reduce((n, f) => n + f.size, 0) + carried.reduce((n, a) => n + a.size, 0);

  return (
    <div className={`compose ${minimized ? 'minimized' : ''}`} role="dialog" aria-label="Write message">
      <header className="compose-head" onDoubleClick={() => setMinimized(!minimized)}>
        <span className="ellipsis">{subject || 'New message'}</span>
        <span className="spacer" />
        <button className="icon-btn icon-btn-sm" onClick={() => setMinimized(!minimized)} aria-label={minimized ? 'Restore' : 'Minimize'}>
          <Icon name={minimized ? 'arrowUp' : 'arrowDown'} size={14} />
        </button>
        <button className="icon-btn icon-btn-sm" onClick={close} aria-label="Close">
          <Icon name="x" size={14} />
        </button>
      </header>
      {!minimized && (
        <div
          className={`compose-body ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
          onDrop={onDrop}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
          onInput={() => setDirty(true)}
        >
          <div className="compose-fields">
            <label>
              <span>From</span>
              <select value={accountId} onChange={(e) => changeAccount(Number(e.target.value))}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName ? `${a.displayName} <${a.email}>` : a.email}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>To</span>
              <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com, …" autoFocus={!options.to} />
              {!showCc && (
                <button type="button" className="link-btn small" onClick={() => setShowCc(true)}>
                  Cc/Bcc
                </button>
              )}
            </label>
            {showCc && (
              <>
                <label>
                  <span>Cc</span>
                  <input value={cc} onChange={(e) => setCc(e.target.value)} />
                </label>
                <label>
                  <span>Bcc</span>
                  <input value={bcc} onChange={(e) => setBcc(e.target.value)} />
                </label>
              </>
            )}
            <label>
              <span>Subject</span>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} />
            </label>
          </div>

          <div className="editor-toolbar" role="toolbar" aria-label="Formatting">
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('bold')} title="Bold">
              <b>B</b>
            </button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('italic')} title="Italic">
              <i>I</i>
            </button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('underline')} title="Underline">
              <u>U</u>
            </button>
            <span className="sep" />
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('insertUnorderedList')} title="Bulleted list">
              <Icon name="list" size={15} />
            </button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('insertOrderedList')} title="Numbered list">
              <Icon name="listOrdered" size={15} />
            </button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('formatBlock', 'blockquote')} title="Quote">
              <Icon name="quote" size={15} />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const url = prompt('Link address:', 'https://');
                if (url && /^(https?:|mailto:)/i.test(url)) exec('createLink', url);
              }}
              title="Insert link"
            >
              <Icon name="link" size={15} />
            </button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('removeFormat')} title="Clear formatting">
              <Icon name="eraser" size={15} />
            </button>
            <span className="sep" />
            <button type="button" onClick={() => fileInput.current?.click()} title="Attach files">
              <Icon name="paperclip" size={15} />
            </button>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
          </div>

          <div
            ref={editor}
            className="editor"
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label="Message body"
            onFocus={() => {
              // The first time, start typing above the signature and quote (after the click has placed its caret).
              if (caretPlaced.current) return;
              caretPlaced.current = true;
              setTimeout(() => {
                const first = editor.current?.firstChild;
                if (!first) return;
                const range = document.createRange();
                range.setStart(first, 0);
                range.collapse(true);
                window.getSelection()?.removeAllRanges();
                window.getSelection()?.addRange(range);
              });
            }}
          />

          {(files.length > 0 || carried.length > 0) && (
            <div className="compose-attachments">
              {carried.map((a) => (
                <span key={`f${a.index}`} className="attachment">
                  <Icon name="paperclip" size={13} />
                  <span className="ellipsis">{a.filename}</span>
                  <span className="muted small">{formatSize(a.size)}</span>
                  <button className="icon-btn icon-btn-sm" onClick={() => (setCarried(carried.filter((x) => x !== a)), setDirty(true))} aria-label={`Remove ${a.filename}`}>
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
              {files.map((f, i) => (
                <span key={`u${i}`} className="attachment">
                  <Icon name="paperclip" size={13} />
                  <span className="ellipsis">{f.name}</span>
                  <span className="muted small">{formatSize(f.size)}</span>
                  <button className="icon-btn icon-btn-sm" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
              <span className="muted small">Total {formatSize(totalSize)}</span>
            </div>
          )}

          <footer className="compose-foot">
            <button className="btn btn-primary" onClick={send} disabled={!!busy} title="Send (Ctrl+Enter)">
              <Icon name="send" /> {busy === 'send' ? 'Sending…' : 'Send'}
            </button>
            <button className="btn" onClick={saveDraft} disabled={!!busy}>
              {busy === 'draft' ? 'Saving…' : 'Save draft'}
            </button>
            <span className="spacer" />
            <span className="muted small hide-mobile">Drop files here to attach</span>
            <button className="icon-btn" onClick={close} title="Discard" aria-label="Discard">
              <Icon name="trash" />
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
