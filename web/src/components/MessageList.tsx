import { useEffect, useRef, type MouseEvent } from 'react';
import type { MessageSummary } from '../types';
import { Icon } from './Icon';
import { addrShort, formatDate } from './ui';

export function MessageList({
  messages,
  total,
  loading,
  error,
  selected,
  openId,
  showRecipient,
  onRowClick,
  onToggleFlag,
  onLoadMore,
  onDragStart,
  emptyText,
}: {
  messages: MessageSummary[];
  total: number;
  loading: boolean;
  error: string | null;
  selected: Set<number>;
  openId: number | null;
  showRecipient: boolean;
  onRowClick: (m: MessageSummary, e: MouseEvent) => void;
  onToggleFlag: (m: MessageSummary) => void;
  onLoadMore: () => void;
  onDragStart: (m: MessageSummary) => void;
  emptyText: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the keyboard-selected message in view.
  useEffect(() => {
    if (openId == null) return;
    listRef.current?.querySelector(`[data-id="${openId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [openId]);

  return (
    <div className="message-list" ref={listRef} role="listbox" aria-multiselectable="true" aria-label="Messages">
      {error && <div className="list-empty error-text">{error}</div>}
      {!error && !loading && messages.length === 0 && <div className="list-empty muted">{emptyText}</div>}
      {messages.map((m) => {
        const who = showRecipient ? m.to.map((a) => addrShort(a)).join(', ') || '(no recipient)' : addrShort(m.from) || '(unknown sender)';
        const isSel = selected.has(m.id);
        return (
          <div
            key={m.id}
            data-id={m.id}
            role="option"
            aria-selected={isSel}
            className={`msg-row ${m.seen ? '' : 'unread'} ${isSel ? 'selected' : ''} ${openId === m.id ? 'open' : ''}`}
            onClick={(e) => onRowClick(m, e)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-homemail', String(m.id));
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
                {m.draft && <span className="tag">Draft</span>}
                {m.subject || <span className="muted">(no subject)</span>}
              </div>
            </div>
          </div>
        );
      })}
      {loading && <div className="list-empty muted">Loading…</div>}
      {!loading && messages.length > 0 && messages.length < total && (
        <button className="btn btn-ghost load-more" onClick={onLoadMore}>
          Load more ({total - messages.length} older)
        </button>
      )}
    </div>
  );
}
