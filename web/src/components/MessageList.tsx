import { useEffect, useRef, type MouseEvent } from 'react';
import type { MailItem } from '../types';
import { Icon } from './Icon';
import { addrShort, formatDate } from './ui';

export function MessageList({
  items,
  hasMore,
  loading,
  error,
  selected,
  openKey,
  showRecipient,
  accountLabel,
  onRowClick,
  onRowOpen,
  onRowMenu,
  onToggleFlag,
  onLoadMore,
  onDragStart,
  emptyText,
}: {
  items: MailItem[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  selected: Set<string>;
  openKey: string | null;
  showRecipient: boolean;
  /** Set in mixed-account views to label each row with its account. */
  accountLabel?: (accountId: number) => string;
  onRowClick: (m: MailItem, e: MouseEvent) => void;
  onRowOpen: (m: MailItem) => void;
  onRowMenu: (m: MailItem, e: MouseEvent) => void;
  onToggleFlag: (m: MailItem) => void;
  onLoadMore: () => void;
  onDragStart: (m: MailItem) => void;
  emptyText: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the keyboard-selected message in view.
  useEffect(() => {
    if (!openKey) return;
    const el = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-key]') ?? [])].find((n) => n.dataset.key === openKey);
    el?.scrollIntoView({ block: 'nearest' });
  }, [openKey]);

  return (
    <div className="message-list" ref={listRef} role="listbox" aria-multiselectable="true" aria-label="Messages">
      {error && <div className="list-empty error-text">{error}</div>}
      {!error && !loading && items.length === 0 && <div className="list-empty muted">{emptyText}</div>}
      {items.map((m) => {
        const who = showRecipient ? m.to.map((a) => addrShort(a)).join(', ') || '(no recipient)' : addrShort(m.from) || '(unknown sender)';
        const isSel = selected.has(m.key);
        return (
          <div
            key={m.key}
            data-key={m.key}
            role="option"
            aria-selected={isSel}
            className={`msg-row ${m.seen ? '' : 'unread'} ${isSel ? 'selected' : ''} ${openKey === m.key ? 'open' : ''}`}
            onClick={(e) => onRowClick(m, e)}
            onDoubleClick={() => onRowOpen(m)}
            onContextMenu={(e) => onRowMenu(m, e)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-homemail', m.key);
              e.dataTransfer.effectAllowed = 'move';
              onDragStart(m);
            }}
          >
            <button
              className={`flag-btn ${m.flagged ? 'on' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFlag(m);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              aria-label={m.flagged ? 'Unstar' : 'Star'}
              title={m.flagged ? 'Unstar' : 'Star'}
            >
              <Icon name="star" size={15} filled={m.flagged} />
            </button>
            <div className="msg-main">
              <div className="msg-line1">
                {!m.seen && <span className="unread-dot" aria-label="unread" />}
                <span className="msg-from ellipsis">{showRecipient ? `To: ${who}` : who}</span>
                {m.answered && <Icon name="reply" size={12} className="muted" />}
                {m.hasAttachments && <Icon name="paperclip" size={13} className="muted" />}
                <span className="msg-date">{formatDate(m.date)}</span>
              </div>
              <div className="msg-subject ellipsis">
                {accountLabel && <span className="tag account-tag">{accountLabel(m.accountId)}</span>}
                {m.draft && <span className="tag">Draft</span>}
                {m.subject || <span className="muted">(no subject)</span>}
              </div>
            </div>
          </div>
        );
      })}
      {loading && <div className="list-empty muted">Loading…</div>}
      {!loading && items.length > 0 && hasMore && (
        <button className="btn btn-ghost load-more" onClick={onLoadMore}>
          Load older messages
        </button>
      )}
    </div>
  );
}
