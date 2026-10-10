import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { api, apiForm, mailPath, qs } from '../../api';
import { useApp } from '../../context';
import type { FullMessage } from '../../types';
import { Icon } from '../Icon';
import { escapeHtml, formatSize, useToast } from '../ui';
import type { ComposeOptions, Quote, Ref } from './options';
import { DEFAULT_FONT, DEFAULT_SIZE, RichEditor, type RichEditorHandle } from './RichEditor';

const signatureHtml = (sig: string) =>
  sig.trim()
    ? `<p>-- </p>${escapeHtml(sig.replace(/^--\s*\n/, ''))
        .split('\n')
        .map((l) => `<p>${l || '<br>'}</p>`)
        .join('')}`
    : '';

const initialBody = (sig: string) => `<p></p>${sig ? `<p></p>${signatureHtml(sig)}` : ''}`;

/** Adds the inline styles mail programs need, since they ignore our stylesheet. */
function emailSafeHtml(editorHtml: string): string {
  const doc = new DOMParser().parseFromString(`<div>${editorHtml}</div>`, 'text/html');
  const style = (sel: string, css: string) => doc.querySelectorAll<HTMLElement>(sel).forEach((el) => el.setAttribute('style', `${css};${el.getAttribute('style') ?? ''}`));
  style('p', 'margin:0');
  style('table', 'border-collapse:collapse');
  style('td, th', 'border:1px solid #bbb;padding:4px 8px;vertical-align:top');
  style('blockquote', 'margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex');
  style('img', 'max-width:100%');
  style('pre', 'background:#f4f4f4;padding:8px;border-radius:4px');
  return doc.body.firstElementChild!.innerHTML;
}

function buildBody(editor: RichEditorHandle, quote: Quote | null): { html: string; text: string } {
  const body = `<div class="hm-body" style="font-family:${DEFAULT_FONT};font-size:${DEFAULT_SIZE}">${emailSafeHtml(editor.getHTML())}</div>`;
  let text = editor.getText().replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  if (!quote) return { html: body, text };
  const quoted =
    quote.kind === 'reply'
      ? `<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${quote.html}</blockquote>`
      : quote.html;
  const html = `${body}<br><div class="hm-quote${quote.kind === 'forward' ? ' hm-forward' : ''}"><div class="hm-quote-header">${quote.headerHtml}</div>${quote.kind === 'forward' ? '<br>' : ''}<div class="hm-quote-body">${quoted}</div></div>`;
  text +=
    quote.kind === 'reply'
      ? `\n${quote.headerText}\n${quote.text
          .replace(/\n+$/, '')
          .split('\n')
          .map((l) => (l.startsWith('>') ? `>${l}` : `> ${l}`))
          .join('\n')}\n`
      : `\n${quote.headerText}\n\n${quote.text}`;
  return { html, text };
}

/* ---------- component ---------- */

export function Compose({ tabId, options, active }: { tabId: string; options: ComposeOptions; active: boolean }) {
  const { accounts, bumpMail, closeTab, setTabTitle, setTabDirty } = useApp();
  const toast = useToast();
  const [accountId, setAccountId] = useState(options.accountId && accounts.some((a) => a.id === options.accountId) ? options.accountId : accounts[0]?.id);
  const account = accounts.find((a) => a.id === accountId);
  const [to, setTo] = useState(options.to ?? '');
  const [cc, setCc] = useState(options.cc ?? '');
  const [bcc, setBcc] = useState(options.bcc ?? '');
  const [showCc, setShowCc] = useState(!!(options.cc || options.bcc));
  const [subject, setSubject] = useState(options.subject ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [quote, setQuote] = useState<Quote | null>(options.quote ?? null);
  const [showQuote, setShowQuote] = useState(options.quote?.kind === 'forward');
  // Attachments carried over from another message (forwarded mail or a saved draft).
  const [carry, setCarry] = useState<Ref | undefined>(options.forwardOf && { folder: options.forwardOf.folder, id: options.forwardOf.id });
  const [carried, setCarried] = useState(options.forwardOf?.attachments ?? []);
  const [draftOf, setDraftOf] = useState(options.draftOf);
  const [priority, setPriority] = useState<'normal' | 'high' | 'low'>('normal');
  const [readReceipt, setReadReceipt] = useState(false);
  const [busy, setBusy] = useState<'send' | 'draft' | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dirty, setDirtyState] = useState(false);
  const editor = useRef<RichEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const initialHtml = useMemo(
    () => (options.fromDraft ? options.body || '<p></p>' : initialBody(account?.signature ?? '')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const setDirty = (d: boolean) => {
    setDirtyState(d);
    setTabDirty(tabId, d);
  };

  useEffect(() => setTabTitle(tabId, subject.trim() || 'New message'), [subject, tabId, setTabTitle]);
  useEffect(() => () => setTabDirty(tabId, false), [tabId, setTabDirty]);

  // Untouched message: switching From swaps in that account's signature.
  const changeAccount = (id: number) => {
    setAccountId(id);
    if (!dirty && !options.fromDraft) editor.current?.setHTML(initialBody(accounts.find((a) => a.id === id)?.signature ?? ''));
  };

  const addFiles = (list: File[] | FileList | null) => {
    const arr = Array.from(list ?? []);
    if (!arr.length) return;
    setFiles((f) => [...f, ...arr]);
    setDirty(true);
  };

  const buildForm = () => {
    const { html, text } = buildBody(editor.current!, quote);
    const payload = {
      to,
      cc: showCc ? cc : '',
      bcc: showCc ? bcc : '',
      subject,
      html,
      text,
      priority,
      readReceipt,
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
      closeTab(tabId, true);
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

  // Ctrl+Enter sends, Ctrl+S saves a draft, while this tab is showing.
  const keys = useRef({ send, saveDraft });
  keys.current = { send, saveDraft };
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'Enter') keys.current.send();
      else if (e.key === 's') keys.current.saveDraft();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const totalSize = files.reduce((n, f) => n + f.size, 0) + carried.reduce((n, a) => n + a.size, 0);
  const quoteDoc = quote
    ? `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>body{margin:8px;font:13px/1.45 system-ui,sans-serif;color:#1d2125;background:#fff}img{max-width:100%}blockquote{margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex}</style></head><body>${quote.html}</body></html>`
    : '';

  return (
    <div
      className={`compose-tab ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e: DragEvent) => {
        setDragging(false);
        if (e.defaultPrevented) return;
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
    >
      <div className="compose-actions">
        <button className="btn btn-primary" onClick={send} disabled={!!busy} title="Send (Ctrl+Enter)">
          <Icon name="send" /> {busy === 'send' ? 'Sending…' : 'Send'}
        </button>
        <button className="btn" onClick={saveDraft} disabled={!!busy} title="Save draft (Ctrl+S)">
          {busy === 'draft' ? 'Saving…' : 'Save draft'}
        </button>
        <button className="btn" onClick={() => fileInput.current?.click()}>
          <Icon name="paperclip" /> <span className="hide-mobile">Attach</span>
        </button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
        <label className="inline compose-option" title="Importance">
          <Icon name="flag" size={14} />
          <select value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)} aria-label="Importance">
            <option value="normal">Normal importance</option>
            <option value="high">High importance</option>
            <option value="low">Low importance</option>
          </select>
        </label>
        <label className="inline compose-option hide-mobile">
          <input type="checkbox" checked={readReceipt} onChange={(e) => setReadReceipt(e.target.checked)} />
          Request read receipt
        </label>
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={() => closeTab(tabId)} title="Discard">
          <Icon name="trash" /> <span className="hide-mobile">Discard</span>
        </button>
      </div>

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
          <input value={to} onChange={(e) => (setTo(e.target.value), setDirty(true))} placeholder="name@example.com, …" autoFocus={!options.to} />
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
              <input value={cc} onChange={(e) => (setCc(e.target.value), setDirty(true))} />
            </label>
            <label>
              <span>Bcc</span>
              <input value={bcc} onChange={(e) => (setBcc(e.target.value), setDirty(true))} />
            </label>
          </>
        )}
        <label>
          <span>Subject</span>
          <input value={subject} onChange={(e) => (setSubject(e.target.value), setDirty(true))} />
        </label>
      </div>

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

      <div className="compose-editor">
        <RichEditor ref={editor} initialHtml={initialHtml} onChange={() => setDirty(true)} onFiles={addFiles} autoFocus={!!options.to || !!options.fromDraft} />
        {quote && (
          <div className="quote-card">
            <div className="quote-head">
              <button className="link-btn small" onClick={() => setShowQuote(!showQuote)}>
                <Icon name={showQuote ? 'chevronDown' : 'chevronRight'} size={13} />
                {quote.kind === 'reply' ? 'Quoted message' : 'Forwarded message'}
              </button>
              <span className="muted small ellipsis">{quote.headerText.split('\n')[0]}</span>
              <span className="spacer" />
              <button className="link-btn small" onClick={() => (setQuote(null), setDirty(true))}>
                Remove
              </button>
            </div>
            {showQuote && <iframe className="quote-frame" title="Quoted message" sandbox="" srcDoc={quoteDoc} />}
          </div>
        )}
      </div>
    </div>
  );
}
