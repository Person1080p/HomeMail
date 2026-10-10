import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { onEvent } from '../../events';
import type { ChatMessage, Conversation } from '../../types';

interface Typing {
  key: string;
  name: string;
  until: number;
}

export interface ChatStore {
  conversations: Conversation[];
  loaded: boolean;
  messages: Record<number, ChatMessage[]>;
  hasMore: Record<number, boolean>;
  typing: Record<number, Typing[]>;
  online: Record<number, boolean>;
  totalUnread: number;
  myId: number;
  reload: () => Promise<void>;
  loadMessages: (convId: number, older?: boolean) => Promise<void>;
  send: (convId: number, body: string) => Promise<void>;
  markRead: (convId: number) => void;
  upsert: (c: Conversation) => void;
  remove: (convId: number) => void;
}

const Ctx = createContext<ChatStore>(null as unknown as ChatStore);
export const useChat = () => useContext(Ctx);

const PAGE = 50;
const byRecent = (a: Conversation, b: Conversation) => b.lastMessageAt - a.lastMessageAt;

/** Shows a desktop notification for chat messages that arrive while the page isn't visible. */
function notify(title: string, body: string) {
  if (!document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body: body.slice(0, 200), tag: 'homemail-chat' });
    n.onclick = () => {
      window.focus();
      window.location.hash = '/chat';
    };
  } catch {
    /* not available in this context */
  }
}

export function ChatProvider({ myId, children }: { myId: number; children: ReactNode }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [messages, setMessages] = useState<Record<number, ChatMessage[]>>({});
  const [hasMore, setHasMore] = useState<Record<number, boolean>>({});
  const [typing, setTyping] = useState<Record<number, Typing[]>>({});
  const [online, setOnline] = useState<Record<number, boolean>>({});
  const convRef = useRef(conversations);
  convRef.current = conversations;

  const upsert = useCallback((c: Conversation) => {
    setConversations((list) => [...list.filter((x) => x.id !== c.id), c].sort(byRecent));
    setOnline((o) => {
      const next = { ...o };
      for (const m of c.members) if (m.userId) next[m.userId] = m.online;
      return next;
    });
  }, []);

  const remove = useCallback((convId: number) => {
    setConversations((list) => list.filter((c) => c.id !== convId));
  }, []);

  const reload = useCallback(async () => {
    const list = await api<Conversation[]>('GET', '/chat/conversations');
    setConversations(list.sort(byRecent));
    const o: Record<number, boolean> = {};
    for (const c of list) for (const m of c.members) if (m.userId) o[m.userId] = m.online;
    setOnline((prev) => ({ ...prev, ...o }));
    setLoaded(true);
  }, []);

  const loadMessages = useCallback(async (convId: number, older = false) => {
    const current = older ? messagesRef.current[convId] : undefined;
    const before = older && current?.length ? current[0].id : undefined;
    const page = await api<ChatMessage[]>('GET', `/chat/conversations/${convId}/messages?limit=${PAGE}${before ? `&before=${before}` : ''}`);
    setMessages((all) => {
      const existing = all[convId] ?? [];
      const merged = older ? [...page, ...existing] : [...existing.filter((m) => !page.some((p) => p.id === m.id)), ...page];
      const unique = [...new Map(merged.map((m) => [m.id, m])).values()].sort((a, b) => a.id - b.id);
      return { ...all, [convId]: unique };
    });
    setHasMore((h) => ({ ...h, [convId]: page.length === PAGE ? true : older ? false : (h[convId] ?? false) }));
  }, []);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const send = useCallback(async (convId: number, body: string) => {
    const msg = await api<ChatMessage>('POST', `/chat/conversations/${convId}/messages`, { body });
    addMessage(msg);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addMessage = (msg: ChatMessage) => {
    setMessages((all) => {
      const list = all[msg.conversationId];
      if (!list) return all; // not open yet; loaded on demand
      const idx = list.findIndex((m) => m.id === msg.id);
      const next = idx >= 0 ? list.map((m) => (m.id === msg.id ? msg : m)) : [...list, msg];
      return { ...all, [msg.conversationId]: next };
    });
    setConversations((list) =>
      list
        .map((c) =>
          c.id !== msg.conversationId
            ? c
            : {
                ...c,
                lastMessage: !c.lastMessage || msg.id >= c.lastMessage.id ? msg : c.lastMessage,
                lastMessageAt: Math.max(c.lastMessageAt, msg.createdAt),
                unread: msg.senderUserId === myId || msg.kind === 'system' || msg.deleted || (c.lastMessage && msg.id <= c.lastMessage.id) ? c.unread : c.unread + 1,
              },
        )
        .sort(byRecent),
    );
  };

  const markRead = useCallback(
    (convId: number) => {
      const list = messagesRef.current[convId];
      const conv = convRef.current.find((c) => c.id === convId);
      const last = list?.[list.length - 1];
      if (!last || !conv || conv.unread === 0) return;
      setConversations((cs) => cs.map((c) => (c.id === convId ? { ...c, unread: 0 } : c)));
      api('POST', `/chat/conversations/${convId}/read`, { messageId: last.id }).catch(() => {});
    },
    [],
  );

  useEffect(() => {
    reload().catch(() => {});
    const offs = [
      onEvent('connected', () => reload().catch(() => {})),
      onEvent('chat.message', (m: ChatMessage) => {
        const known = convRef.current.some((c) => c.id === m.conversationId);
        if (!known) {
          api<Conversation>('GET', `/chat/conversations/${m.conversationId}`).then(upsert).catch(() => {});
        } else addMessage(m);
        if (m.senderUserId !== myId && m.kind === 'text' && !m.deleted) {
          const conv = convRef.current.find((c) => c.id === m.conversationId);
          const sender = conv?.members.find((x) => (m.senderUserId ? x.userId === m.senderUserId : x.jid === m.senderJid));
          notify(conv?.kind === 'group' ? `${sender?.displayName ?? 'Someone'} in ${conv.title}` : (sender?.displayName ?? 'New message'), m.body);
          setTyping((t) => ({ ...t, [m.conversationId]: (t[m.conversationId] ?? []).filter((x) => x.key !== String(m.senderUserId ?? m.senderJid)) }));
        }
      }),
      onEvent('chat.conversation', (c: Conversation) => upsert(c)),
      onEvent('chat.removed', (d: { conversationId: number }) => remove(d.conversationId)),
      onEvent('chat.read', (d: { conversationId: number; userId: number; lastReadId: number }) => {
        setConversations((cs) =>
          cs.map((c) =>
            c.id !== d.conversationId
              ? c
              : {
                  ...c,
                  unread: d.userId === myId ? 0 : c.unread,
                  members: c.members.map((m) => (m.userId === d.userId ? { ...m, lastReadId: Math.max(m.lastReadId, d.lastReadId) } : m)),
                },
          ),
        );
      }),
      onEvent('chat.typing', (d: { conversationId: number; userId?: number; jid?: string; name: string; active: boolean }) => {
        const key = String(d.userId ?? d.jid);
        setTyping((t) => {
          const rest = (t[d.conversationId] ?? []).filter((x) => x.key !== key);
          return { ...t, [d.conversationId]: d.active ? [...rest, { key, name: d.name, until: Date.now() + 6000 }] : rest };
        });
      }),
      onEvent('presence', (d: { userId: number; online: boolean }) => setOnline((o) => ({ ...o, [d.userId]: d.online }))),
    ];
    // Typing indicators expire if the "stopped typing" signal never comes.
    const timer = setInterval(() => {
      setTyping((t) => {
        const now = Date.now();
        let changed = false;
        const next: Record<number, Typing[]> = {};
        for (const [k, v] of Object.entries(t)) {
          const keep = v.filter((x) => x.until > now);
          if (keep.length !== v.length) changed = true;
          next[Number(k)] = keep;
        }
        return changed ? next : t;
      });
    }, 2000);
    return () => {
      offs.forEach((off) => off());
      clearInterval(timer);
    };
  }, [myId]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalUnread = conversations.reduce((n, c) => n + c.unread, 0);

  const value = useMemo(
    () => ({ conversations, loaded, messages, hasMore, typing, online, totalUnread, myId, reload, loadMessages, send, markRead, upsert, remove }),
    [conversations, loaded, messages, hasMore, typing, online, totalUnread, myId, reload, loadMessages, send, markRead, upsert, remove],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
