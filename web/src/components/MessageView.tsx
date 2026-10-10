import { useEffect, useMemo, useState } from 'react';
import { api, mailPath, qs } from '../api';
import type { Account, Addr, FullMessage } from '../types';
import { Icon } from './Icon';
import { Menu, Spinner, addrText, formatDate, formatSize, linkify, useLocalStorage } from './ui';

export interface MessageViewActions {
  reply: (m: FullMessage, all: boolean) => void;
  forward: (m: FullMessage) => void;
  editDraft: (m: FullMessage) => void;
  remove: () => void;
  markUnread: () => void;
  moveTo: (dest: string) => void;
  /** Present in the reading pane; absent when already shown in its own tab. */
  openInTab?: () => void;
  back?: () => void;
}

/**
 * Builds the iframe document. The CSP blocks every remote load (tracking pixels,
 * fonts, CSS) until the user allows remote content; the sandbox blocks scripts.
 */
function buildDoc(msg: FullMessage, allowRemote: boolean, dark: boolean): string {
  const remote = allowRemote ? ' https: http:' : '';
  const csp = `default-src 'none'; img-src data:${remote}; style-src 'unsafe-inline'${remote}; font-src data:${remote}; media-src data:${remote}`;
  const isHtml = !!msg.html;
  // HTML mail is designed for white backgrounds; plain text follows the app theme.
  const fg = !isHtml && dark ? '#e6e8eb' : '#1d2125';
  const bg = !isHtml && dark ? '#1b1f24' : '#ffffff';
  const link = !isHtml && dark ? '#8ab4ff' : '#1a5fd0';
  const body = isHtml ? msg.html! : `<pre class="hm-plain">${linkify(msg.text)}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
html{color-scheme:${!isHtml && dark ? 'dark' : 'light'}}
body{margin:0;padding:16px 20px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:${fg};background:${bg};overflow-wrap:anywhere}
img{max-width:100%;height:auto}
a{color:${link}}
.hm-plain{white-space:pre-wrap;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin:0}
blockquote{margin:0 0 0 4px;padding-left:12px;border-left:3px solid #c6ccd4;color:inherit}
</style></head><body>${body}</body></html>`;
}

function AddrLine({ label, list }: { label: string; list: Addr[] }) {
  if (!list.length) return null;
  return (
    <div className="hdr-line">
      <span className="hdr-label">{label}</span>
      <span className="hdr-value">{list.map(addrText).join(', ')}</span>
    </div>
  );
}

export function MessageView({
  account,
  folder,
  id,
  isDrafts,
  moveTargets,
  actions,
  onLoaded,
}: {
  account: Account;
  folder: string;
  id: number;
  isDrafts: boolean;
  moveTargets: { path: string; name: string }[];
  actions: MessageViewActions;
  onLoaded: (m: FullMessage) => void;
}) {
  const [msg, setMsg] = useState<FullMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allowRemote, setAllowRemote] = useState(false);
  const [trusted, setTrusted] = useLocalStorage<string[]>('homemail.trustedSenders', []);
  const [showDetails, setShowDetails] = useState(false);
  const dark = useMemo(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false, []);

  useEffect(() => {
    let cancelled = false;
    setMsg(null);
    setError(null);
    setAllowRemote(false);
    api<FullMessage>('GET', mailPath(account.id, `/messages/${id}?${qs({ folder })}`))
      .then((m) => {
        if (cancelled) return;
        setMsg(m);
        onLoaded(m);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, folder, id]);

  const sender = msg?.from[0]?.address?.toLowerCase() ?? '';
  const remoteOn = allowRemote || (!!sender && trusted.includes(sender));
  const srcDoc = useMemo(() => (msg ? buildDoc(msg, remoteOn, dark) : ''), [msg, remoteOn, dark]);

  if (error)
    return (
      <div className="reader-empty">
        <p className="error-text">{error}</p>
        {actions.back && (
          <button className="btn" onClick={actions.back}>
            Back
          </button>
        )}
      </div>
    );
  if (!msg) return <Spinner label="Loading message…" />;

  const attUrl = (index: number, inline = false) =>
    `/api${mailPath(account.id, `/messages/${id}/attachments/${index}?${qs({ folder, inline: inline ? 1 : undefined })}`)}`;
  const visibleAttachments = msg.attachments.filter((a) => !a.inline);
  const ccOrMore = msg.cc.length > 0 || msg.bcc.length > 0 || msg.replyTo.length > 0;

  return (
    <article className="reader">
      <div className="reader-toolbar">
        {actions.back && (
          <button className="icon-btn only-mobile" onClick={actions.back} aria-label="Back to list">
            <Icon name="chevronLeft" size={18} />
          </button>
        )}
        {isDrafts ? (
          <button className="btn btn-primary" onClick={() => actions.editDraft(msg)}>
            <Icon name="pencil" /> Edit draft
          </button>
        ) : (
          <>
            <button className="btn" onClick={() => actions.reply(msg, false)} title="Reply (r)">
              <Icon name="reply" /> <span className="hide-narrow">Reply</span>
            </button>
            <button className="btn" onClick={() => actions.reply(msg, true)} title="Reply all (a)">
              <Icon name="replyAll" /> <span className="hide-narrow">Reply all</span>
            </button>
            <button className="btn" onClick={() => actions.forward(msg)} title="Forward (f)">
              <Icon name="forward" /> <span className="hide-narrow">Forward</span>
            </button>
          </>
        )}
        <span className="spacer" />
        {actions.openInTab && (
          <button className="icon-btn hide-mobile" onClick={actions.openInTab} title="Open in a new tab (Enter)" aria-label="Open in a new tab">
            <Icon name="external" />
          </button>
        )}
        {moveTargets.length > 0 && (
          <Menu
            align="right"
            trigger={(open) => (
              <button className="icon-btn" onClick={open} title="Move to…" aria-label="Move to folder">
                <Icon name="folder" />
              </button>
            )}
          >
            {(close) =>
              moveTargets.map((t) => (
                <button key={t.path} onClick={() => (close(), actions.moveTo(t.path))}>
                  {t.name}
                </button>
              ))
            }
          </Menu>
        )}
        <button className="icon-btn" onClick={actions.remove} title="Delete (Del)" aria-label="Delete">
          <Icon name="trash" />
        </button>
        <Menu
          align="right"
          trigger={(open) => (
            <button className="icon-btn" onClick={open} aria-label="More actions">
              <Icon name="more" />
            </button>
          )}
        >
          {(close) => (
            <>
              <button onClick={() => (close(), actions.markUnread())}>
                <Icon name="mail" /> Mark as unread
              </button>
              <a href={`/api${mailPath(account.id, `/messages/${id}/raw?${qs({ folder })}`)}`} onClick={close}>
                <Icon name="download" /> Download .eml
              </a>
            </>
          )}
        </Menu>
      </div>

      <header className="reader-head">
        <h1 className="reader-subject">{msg.subject || '(no subject)'}</h1>
        <div className="hdr-line">
          <span className="hdr-label">From</span>
          <span className="hdr-value strong">{msg.from.map(addrText).join(', ') || '(unknown)'}</span>
          <span className="hdr-date" title={formatDate(msg.date, true)}>
            {formatDate(msg.date, true)}
          </span>
        </div>
        <AddrLine label="To" list={msg.to} />
        {ccOrMore && !showDetails && (
          <button className="link-btn small" onClick={() => setShowDetails(true)}>
            Show Cc / Reply-To
          </button>
        )}
        {showDetails && (
          <>
            <AddrLine label="Cc" list={msg.cc} />
            <AddrLine label="Bcc" list={msg.bcc} />
            <AddrLine label="Reply-To" list={msg.replyTo} />
          </>
        )}
      </header>

      {msg.hasRemoteContent && !remoteOn && (
        <div className="remote-bar">
          <Icon name="image" />
          <span>Remote content was blocked to protect your privacy.</span>
          <button className="btn btn-sm" onClick={() => setAllowRemote(true)}>
            Show
          </button>
          {sender && (
            <button className="btn btn-sm btn-ghost" onClick={() => setTrusted([...trusted, sender])}>
              Always for {sender}
            </button>
          )}
        </div>
      )}

      {visibleAttachments.length > 0 && (
        <div className="attachments">
          {visibleAttachments.map((a) => (
            <a key={a.index} className="attachment" href={attUrl(a.index)} title={`${a.filename} (${a.contentType})`}>
              <Icon name="paperclip" size={14} />
              <span className="ellipsis">{a.filename}</span>
              <span className="muted small">{formatSize(a.size)}</span>
            </a>
          ))}
        </div>
      )}

      <iframe
        className="reader-body"
        title="Message content"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
      />
    </article>
  );
}
