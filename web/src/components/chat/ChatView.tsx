import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api } from '../../api';
import { useApp } from '../../context';
import type { ChatMessage, Conversation, DirectoryUser } from '../../types';
import { Icon } from '../Icon';
import { Menu, Modal, linkify, useAction, useLocalStorage } from '../ui';
import { useChat } from './ChatStore';

const initials = (name: string) =>
  name
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';

function hue(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function Avatar({ name, online, group }: { name: string; online?: boolean; group?: boolean }) {
  return (
    <span className="avatar" style={{ background: `hsl(${hue(name)} 55% 45%)` }} aria-hidden="true">
      {group ? <Icon name="users" size={15} /> : initials(name)}
      {online !== undefined && <span className={`presence ${online ? 'on' : ''}`} />}
    </span>
  );
}

const dayLabel = (ts: number) => {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
};
const timeLabel = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

const shortTime = (ts: number) => {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? timeLabel(ts) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export function ChatView({ active }: { active: boolean }) {
  const { auth } = useApp();
  const chat = useChat();
  const run = useAction();
  const [selectedId, setSelectedId] = useLocalStorage<number | null>('homemail.chat', null);
  const [filter, setFilter] = useState('');
  const [dialog, setDialog] = useState<'dm' | 'group' | 'members' | null>(null);
  const [info, setInfo] = useState<{ address: string; federation: boolean } | null>(null);
  const [mobileThread, setMobileThread] = useState(false);
  const [notifyPerm, setNotifyPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

  useEffect(() => {
    api<{ address: string; federation: boolean }>('GET', '/chat/info').then(setInfo).catch(() => {});
  }, []);

  const conv = chat.conversations.find((c) => c.id === selectedId) ?? null;
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? chat.conversations.filter((c) => c.title.toLowerCase().includes(f) || c.members.some((m) => m.address.includes(f))) : chat.conversations;
  }, [chat.conversations, filter]);

  const select = (id: number) => {
    setSelectedId(id);
    setMobileThread(true);
  };

  const peer = (c: Conversation) => (c.kind === 'dm' ? c.members.find((m) => m.userId !== auth.user!.id) : undefined);

  return (
    <div className={`chat-app ${mobileThread && conv ? 'show-thread' : ''}`}>
      <aside className="chat-sidebar">
        <div className="chat-sidebar-head">
          <div className="chat-me">
            <strong>Chat</strong>
            {info && (
              <span className="muted small" title={info.federation ? 'People on other XMPP servers can reach you here' : 'Only people on this server can reach you'}>
                {info.address}
                {info.federation && <Icon name="globe" size={12} className="federated-icon" />}
              </span>
            )}
          </div>
          <Menu
            align="right"
            trigger={(open) => (
              <button className="btn btn-primary btn-sm" onClick={open}>
                <Icon name="plus" /> New
              </button>
            )}
          >
            {(close) => (
              <>
                <button onClick={() => (close(), setDialog('dm'))}>
                  <Icon name="chat" /> New chat
                </button>
                <button onClick={() => (close(), setDialog('group'))}>
                  <Icon name="users" /> New group
                </button>
              </>
            )}
          </Menu>
        </div>
        <div className="chat-search">
          <Icon name="search" size={14} />
          <input type="search" placeholder="Search chats" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search chats" />
        </div>
        {notifyPerm === 'default' && (
          <button
            className="notify-hint"
            onClick={async () => setNotifyPerm(await Notification.requestPermission())}
          >
            <Icon name="bell" size={14} /> Turn on desktop notifications
          </button>
        )}
        <ul className="conv-list" role="listbox" aria-label="Conversations">
          {chat.loaded && shown.length === 0 && <li className="list-empty muted">{filter ? 'No matches.' : 'No conversations yet. Start one with "New".'}</li>}
          {shown.map((c) => {
            const p = peer(c);
            const last = c.lastMessage;
            const lastText = !last ? '' : last.deleted ? 'Message deleted' : last.kind === 'system' ? last.body : `${last.senderUserId === auth.user!.id ? 'You: ' : ''}${last.body}`;
            return (
              <li
                key={c.id}
                role="option"
                aria-selected={c.id === selectedId}
                tabIndex={0}
                className={`conv-row ${c.id === selectedId ? 'selected' : ''} ${c.unread ? 'unread' : ''}`}
                onClick={() => select(c.id)}
                onKeyDown={(e) => e.key === 'Enter' && select(c.id)}
              >
                <Avatar name={c.title} group={c.kind === 'group'} online={p?.userId ? (chat.online[p.userId] ?? p.online) : undefined} />
                <div className="conv-main">
                  <div className="conv-line1">
                    <span className="ellipsis conv-title">{c.title}</span>
                    {c.remote && <Icon name="globe" size={12} className="muted" />}
                    {last && <span className="msg-date">{shortTime(last.createdAt)}</span>}
                  </div>
                  <div className="conv-line2">
                    <span className="ellipsis muted small">{(chat.typing[c.id] ?? []).length ? 'typing…' : lastText}</span>
                    {c.unread > 0 && <span className="badge">{c.unread}</span>}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </aside>

      <section className="chat-thread-pane">
        {conv ? (
          <Thread key={conv.id} conv={conv} active={active} onBack={() => setMobileThread(false)} onMembers={() => setDialog('members')} onClosed={() => setSelectedId(null)} />
        ) : (
          <div className="reader-empty muted">
            <Icon name="chat" size={40} />
            <p>Pick a conversation, or start a new one.</p>
            {info && (
              <p className="small">
                Your chat address is <strong>{info.address}</strong>
                {info.federation ? '. People on other XMPP servers can message you there too.' : '.'}
              </p>
            )}
          </div>
        )}
      </section>

      {dialog === 'dm' && (
        <NewChatDialog
          federation={!!info?.federation}
          onClose={() => setDialog(null)}
          onOpen={async (address) => {
            const c = await run(() => api<Conversation>('POST', '/chat/dm', { address }));
            if (c) {
              chat.upsert(c);
              select(c.id);
              setDialog(null);
            }
          }}
        />
      )}
      {dialog === 'group' && (
        <GroupDialog
          title="New group"
          onClose={() => setDialog(null)}
          onDone={async (name, members) => {
            const c = await run(() => api<Conversation>('POST', '/chat/groups', { name, members }));
            if (c) {
              chat.upsert(c);
              select(c.id);
              setDialog(null);
            }
          }}
        />
      )}
      {dialog === 'members' && conv?.kind === 'group' && <MembersDialog conv={conv} onClose={() => setDialog(null)} />}
    </div>
  );
}

/* ---------- conversation thread ---------- */

function Thread({ conv, active, onBack, onMembers, onClosed }: { conv: Conversation; active: boolean; onBack: () => void; onMembers: () => void; onClosed: () => void }) {
  const { auth } = useApp();
  const chat = useChat();
  const run = useAction();
  const me = auth.user!.id;
  const messages = chat.messages[conv.id];
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevHeight = useRef(0);
  const loadingOlder = useRef(false);
  const typingSent = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    chat.loadMessages(conv.id).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.id]);

  // Stay pinned to the newest message unless the user scrolled up; keep position when older ones load.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (loadingOlder.current) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      loadingOlder.current = false;
    } else if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Mark as read while the conversation is actually visible.
  useEffect(() => {
    if (!active || !messages?.length || conv.unread === 0) return;
    const markIfVisible = () => !document.hidden && chat.markRead(conv.id);
    markIfVisible();
    document.addEventListener('visibilitychange', markIfVisible);
    return () => document.removeEventListener('visibilitychange', markIfVisible);
  }, [active, messages, conv.unread, conv.id, chat]);

  useEffect(() => {
    if (active) input.current?.focus();
  }, [active, conv.id]);

  const onScroll = () => {
    const el = scroller.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (el.scrollTop < 80 && chat.hasMore[conv.id] && !loadingOlder.current) {
      loadingOlder.current = true;
      prevHeight.current = el.scrollHeight;
      chat.loadMessages(conv.id, true).catch(() => (loadingOlder.current = false));
    }
  };

  const signalTyping = (activeNow: boolean) => {
    const now = Date.now();
    if (activeNow && now - typingSent.current < 3000) return;
    typingSent.current = activeNow ? now : 0;
    api('POST', `/chat/conversations/${conv.id}/typing`, { active: activeNow }).catch(() => {});
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    atBottom.current = true;
    const ok = await run(() => chat.send(conv.id, body));
    setSending(false);
    if (ok !== undefined) {
      setText('');
      signalTyping(false);
    } else chat.loadMessages(conv.id).catch(() => {});
    input.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const others = conv.members.filter((m) => m.userId !== me);
  const peer = conv.kind === 'dm' ? others[0] : undefined;
  const peerOnline = peer?.userId ? (chat.online[peer.userId] ?? peer.online) : undefined;
  const isOwner = conv.members.find((m) => m.userId === me)?.role === 'owner';
  const typing = chat.typing[conv.id] ?? [];
  const sender = (m: ChatMessage) => conv.members.find((x) => (m.senderUserId ? x.userId === m.senderUserId : x.jid === m.senderJid));
  // Latest of my messages that everyone else has read, for a "Seen" marker in DMs.
  const seenId = peer ? Math.min(...others.map((o) => o.lastReadId)) : 0;
  const lastMine = messages ? [...messages].reverse().find((m) => m.senderUserId === me && !m.deleted) : undefined;

  const subtitle =
    conv.kind === 'group'
      ? `${conv.members.length} members`
      : peer?.jid
        ? `${peer.address} · on another server`
        : `${peer?.address ?? ''}${peerOnline ? ' · online' : ''}`;

  return (
    <div className="thread">
      <header className="thread-head">
        <button className="icon-btn only-mobile" onClick={onBack} aria-label="Back to conversations">
          <Icon name="chevronLeft" size={18} />
        </button>
        <Avatar name={conv.title} group={conv.kind === 'group'} online={peerOnline} />
        <div className="thread-title">
          <strong className="ellipsis">{conv.title}</strong>
          <span className="muted small ellipsis">{subtitle}</span>
        </div>
        <span className="spacer" />
        <Menu
          align="right"
          trigger={(open) => (
            <button className="icon-btn" onClick={open} aria-label="Conversation options">
              <Icon name="more" />
            </button>
          )}
        >
          {(close) =>
            conv.kind === 'group' ? (
              <>
                <button onClick={() => (close(), onMembers())}>
                  <Icon name="users" /> Members{isOwner ? ' & name' : ''}
                </button>
                <button
                  className="danger"
                  onClick={async () => {
                    close();
                    if (!confirm(`Leave "${conv.title}"?`)) return;
                    const ok = await run(() => api('DELETE', `/chat/conversations/${conv.id}/members/${me}`));
                    if (ok !== undefined) {
                      chat.remove(conv.id);
                      onClosed();
                    }
                  }}
                >
                  <Icon name="logout" /> Leave group
                </button>
              </>
            ) : (
              <button
                className="danger"
                onClick={async () => {
                  close();
                  if (!confirm('Delete this conversation for both of you? This cannot be undone.')) return;
                  const ok = await run(() => api('DELETE', `/chat/conversations/${conv.id}`));
                  if (ok !== undefined) {
                    chat.remove(conv.id);
                    onClosed();
                  }
                }}
              >
                <Icon name="trash" /> Delete conversation
              </button>
            )
          }
        </Menu>
      </header>

      <div className="thread-messages" ref={scroller} onScroll={onScroll} aria-live="polite">
        {!messages && <div className="list-empty muted">Loading…</div>}
        {messages && chat.hasMore[conv.id] && <div className="list-empty muted small">Scroll up for older messages</div>}
        {messages?.length === 0 && <div className="list-empty muted">No messages yet. Say hello!</div>}
        {messages?.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
          const mine = m.senderUserId === me;
          const grouped = prev && !newDay && prev.kind === 'text' && m.kind === 'text' && prev.senderUserId === m.senderUserId && prev.senderJid === m.senderJid && m.createdAt - prev.createdAt < 5 * 60_000;
          const s = sender(m);
          return (
            <div key={m.id}>
              {newDay && <div className="day-sep">{dayLabel(m.createdAt)}</div>}
              {m.kind === 'system' ? (
                <div className="system-msg">{m.body}</div>
              ) : (
                <div className={`bubble-row ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''}`}>
                  {!mine && conv.kind === 'group' && !grouped && <div className="bubble-sender">{s?.displayName ?? m.senderJid ?? 'Former member'}</div>}
                  <div className={`bubble ${m.deleted ? 'deleted' : ''}`} title={new Date(m.createdAt).toLocaleString()}>
                    {m.deleted ? <em>Message deleted</em> : <span dangerouslySetInnerHTML={{ __html: linkify(m.body) }} />}
                    <span className="bubble-time">{timeLabel(m.createdAt)}</span>
                    {mine && !m.deleted && (
                      <button
                        className="bubble-delete"
                        title="Delete message"
                        aria-label="Delete message"
                        onClick={() => confirm('Delete this message?') && run(() => api('DELETE', `/chat/messages/${m.id}`))}
                      >
                        <Icon name="trash" size={12} />
                      </button>
                    )}
                  </div>
                  {peer?.userId && lastMine?.id === m.id && seenId >= m.id && <div className="seen">Seen</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="typing-line muted small" aria-live="polite">
        {typing.length > 0 && `${typing.map((t) => t.name).join(', ')} ${typing.length > 1 ? 'are' : 'is'} typing…`}
      </div>
      <form className="chat-composer" onSubmit={submit}>
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={`Message ${conv.title}`}
          onChange={(e) => {
            setText(e.target.value);
            signalTyping(e.target.value.length > 0);
          }}
          onBlur={() => text && signalTyping(false)}
          onKeyDown={onKeyDown}
          aria-label="Message"
        />
        <button className="btn btn-primary" disabled={!text.trim() || sending} aria-label="Send">
          <Icon name="send" />
        </button>
      </form>
    </div>
  );
}

/* ---------- dialogs ---------- */

function useDirectory() {
  const [dir, setDir] = useState<DirectoryUser[]>([]);
  useEffect(() => {
    api<DirectoryUser[]>('GET', '/chat/directory').then(setDir).catch(() => {});
  }, []);
  return dir;
}

function NewChatDialog({ federation, onClose, onOpen }: { federation: boolean; onClose: () => void; onOpen: (address: string) => void }) {
  const dir = useDirectory();
  const [address, setAddress] = useState('');
  const f = address.trim().toLowerCase();
  const matches = dir.filter((u) => !f || u.username.includes(f) || u.displayName.toLowerCase().includes(f) || u.address.includes(f));
  return (
    <Modal title="New chat" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (f) onOpen(f);
        }}
      >
        <label>
          Address or name
          <input autoFocus value={address} onChange={(e) => setAddress(e.target.value)} placeholder={federation ? 'bob, or someone@other-server.org' : 'bob'} />
        </label>
        {federation && <p className="muted small">You can also chat with anyone on another XMPP server (e.g. Conversations or Gajim users) by their full address.</p>}
        <ul className="pick-list">
          {matches.map((u) => (
            <li key={u.userId}>
              <button type="button" onClick={() => onOpen(u.address)}>
                <Avatar name={u.displayName} online={u.online} />
                <span className="ellipsis">{u.displayName}</span>
                <span className="muted small ellipsis">{u.address}</span>
              </button>
            </li>
          ))}
          {!matches.length && f && <li className="muted small">No one here matches. Press Enter to start a chat with “{f}”.</li>}
        </ul>
      </form>
    </Modal>
  );
}

function GroupDialog({ title, initialName = '', exclude = [], onClose, onDone }: { title: string; initialName?: string; exclude?: number[]; onClose: () => void; onDone: (name: string, members: number[]) => void }) {
  const dir = useDirectory().filter((u) => !exclude.includes(u.userId));
  const [name, setName] = useState(initialName);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!name.trim()} onClick={() => onDone(name.trim(), [...picked])}>
            {initialName ? 'Save' : 'Create group'}
          </button>
        </>
      }
    >
      <label>
        Group name
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
      </label>
      <fieldset className="checklist">
        <legend>{initialName ? 'Add people' : 'Members'}</legend>
        {dir.length === 0 && <span className="muted small">No other users to add.</span>}
        {dir.map((u) => (
          <label key={u.userId} className="inline">
            <input
              type="checkbox"
              checked={picked.has(u.userId)}
              onChange={(e) => {
                const next = new Set(picked);
                if (e.target.checked) next.add(u.userId);
                else next.delete(u.userId);
                setPicked(next);
              }}
            />
            {u.displayName} <span className="muted small">{u.address}</span>
          </label>
        ))}
      </fieldset>
    </Modal>
  );
}

function MembersDialog({ conv, onClose }: { conv: Conversation; onClose: () => void }) {
  const { auth } = useApp();
  const run = useAction();
  const [adding, setAdding] = useState(false);
  const isOwner = conv.members.find((m) => m.userId === auth.user!.id)?.role === 'owner';
  const chat = useChat();
  if (adding) {
    return (
      <GroupDialog
        title={`Edit "${conv.title}"`}
        initialName={conv.name}
        exclude={conv.members.map((m) => m.userId!).filter(Boolean)}
        onClose={() => setAdding(false)}
        onDone={async (name, members) => {
          if (name !== conv.name) await run(() => api('PATCH', `/chat/conversations/${conv.id}`, { name }));
          if (members.length) await run(() => api('POST', `/chat/conversations/${conv.id}/members`, { members }));
          setAdding(false);
        }}
      />
    );
  }
  return (
    <Modal title={conv.title} onClose={onClose}>
      <ul className="pick-list">
        {conv.members.map((m) => (
          <li key={m.userId ?? m.jid}>
            <div className="member-row">
              <Avatar name={m.displayName} online={m.userId ? (chat.online[m.userId] ?? m.online) : undefined} />
              <span className="ellipsis">
                {m.displayName}
                {m.userId === auth.user!.id && ' (you)'}
              </span>
              <span className="muted small ellipsis">{m.role === 'owner' ? 'Owner' : m.address}</span>
              {isOwner && m.userId !== auth.user!.id && m.userId && (
                <button className="btn btn-sm btn-danger" onClick={() => run(() => api('DELETE', `/chat/conversations/${conv.id}/members/${m.userId}`))}>
                  Remove
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {isOwner && (
        <button className="btn" onClick={() => setAdding(true)}>
          <Icon name="pencil" /> Rename or add people
        </button>
      )}
    </Modal>
  );
}
