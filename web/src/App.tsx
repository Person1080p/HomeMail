import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { AppContext, type ReaderTab, type TopTab } from './context';
import { connectEvents, disconnectEvents, onEvent } from './events';
import type { Account, AuthState, MessageRef } from './types';
import { Login } from './components/Login';
import { MailView } from './components/MailView';
import { Settings } from './components/settings/Settings';
import type { ComposeOptions } from './components/compose/options';
import { ChatProvider, useChat } from './components/chat/ChatStore';
import { ChatView } from './components/chat/ChatView';
import { CalendarView } from './components/calendar/CalendarView';
import { TopBar } from './components/TopBar';
import { Spinner } from './components/ui';

const FIXED: TopTab[] = [
  { id: 'mail', kind: 'mail' },
  { id: 'calendar', kind: 'calendar' },
  { id: 'chat', kind: 'chat' },
];
const PREVIEW: ReaderTab = { id: 'preview', kind: 'preview' };
const STORAGE_KEY = 'homemail.tabs.v2';

interface TabState {
  top: TopTab[];
  active: TopTab['id'];
  reader: ReaderTab[];
  readerActive: string;
}

/** Restores open tabs (except unsaved compose windows) from the last visit. */
function loadTabs(): TabState {
  const fresh: TabState = { top: FIXED, active: 'mail', reader: [PREVIEW], readerActive: 'preview' };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as TabState | null;
    if (!saved?.top || !saved.reader) return fresh;
    const top = [...FIXED, ...saved.top.filter((t) => t.kind === 'settings')];
    const reader = [PREVIEW, ...saved.reader.filter((t) => t.kind === 'message')];
    return {
      top,
      active: top.some((t) => t.id === saved.active) ? saved.active : 'mail',
      reader,
      readerActive: reader.some((t) => t.id === saved.readerActive) ? saved.readerActive : 'preview',
    };
  } catch {
    return fresh;
  }
}

const hashFor = (t: TopTab) => (t.kind === 'chat' ? '/chat' : t.kind === 'calendar' ? '/calendar' : t.kind === 'settings' ? t.route : '/');

let tabCounter = 0;
const newTabId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${tabCounter++}`;

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);

  const refreshAuth = useCallback(async () => {
    setAuth(await api<AuthState>('GET', '/auth/state'));
  }, []);

  useEffect(() => {
    refreshAuth().catch(() => setAuth({ user: null, needsSetup: false, registrationOpen: false, oauth: { google: false, microsoft: false } }));
    const onUnauthorized = () => refreshAuth().catch(() => {});
    window.addEventListener('homemail:unauthorized', onUnauthorized);
    return () => window.removeEventListener('homemail:unauthorized', onUnauthorized);
  }, [refreshAuth]);

  useEffect(() => {
    if (!auth?.user) return;
    connectEvents();
    return () => disconnectEvents();
  }, [auth?.user]);

  if (!auth) return <Spinner label="Loading…" />;
  if (!auth.user) return <Login auth={auth} onDone={refreshAuth} />;
  return (
    <ChatProvider myId={auth.user.id} key={auth.user.id}>
      <Workspace auth={auth} refreshAuth={refreshAuth} />
    </ChatProvider>
  );
}

function Workspace({ auth, refreshAuth }: { auth: AuthState; refreshAuth: () => Promise<void> }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [mailVersion, setMailVersion] = useState(0);
  const [tabs, setTabs] = useState(loadTabs);
  const [mailUnread, setMailUnread] = useState(0);
  const dirty = useRef(new Set<string>());
  /** Reading-pane tabs in the order they were last shown, for returning to the previous one on close. */
  const visited = useRef<string[]>([]);
  const chat = useChat();
  const { top, active, reader, readerActive } = tabs;

  const reloadAccounts = useCallback(async () => {
    setAccounts(await api<Account[]>('GET', '/accounts'));
  }, []);

  useEffect(() => {
    reloadAccounts().catch(() => {});
  }, [reloadAccounts]);

  // New mail delivered by the built-in server arrives as an event.
  useEffect(() => onEvent('mail.new', () => setMailVersion((v) => v + 1)), []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...tabs, reader: tabs.reader.filter((t) => t.kind !== 'compose') }));
    } catch {
      /* storage unavailable */
    }
  }, [tabs]);

  const activate = useCallback((id: string) => setTabs((s) => (s.top.some((t) => t.id === id) ? { ...s, active: id as TopTab['id'] } : s)), []);
  const activateReader = useCallback((id: string) => setTabs((s) => (s.reader.some((t) => t.id === id) ? { ...s, readerActive: id } : s)), []);

  /** Applies a hash route: opens Settings, or switches to Mail / Calendar / Chat. */
  const applyRoute = useCallback((route: string) => {
    setTabs((s) => {
      if (route.startsWith('/settings')) {
        const tab: TopTab = { id: 'settings', kind: 'settings', route };
        const exists = s.top.some((t) => t.kind === 'settings');
        return { ...s, top: exists ? s.top.map((t) => (t.kind === 'settings' ? tab : t)) : [...s.top, tab], active: 'settings' };
      }
      if (route === '/chat') return { ...s, active: 'chat' };
      if (route === '/calendar') return { ...s, active: 'calendar' };
      if (route === '/' || route === '') return { ...s, active: 'mail' };
      return s;
    });
  }, []);

  useEffect(() => {
    const current = () => window.location.hash.slice(1) || '/';
    applyRoute(current());
    const on = () => applyRoute(current());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [applyRoute]);

  useEffect(() => {
    visited.current = [...visited.current.filter((v) => v !== readerActive), readerActive].slice(-50);
  }, [readerActive]);

  // Keep the address bar in step with the active tab, without adding history entries.
  useEffect(() => {
    const tab = top.find((t) => t.id === active);
    if (!tab) return;
    const hash = '#' + hashFor(tab);
    if (window.location.hash !== hash) history.replaceState(null, '', hash);
  }, [top, active]);

  const navigate = useCallback(
    (hash: string) => {
      if (window.location.hash === '#' + hash) applyRoute(hash);
      else window.location.hash = hash;
    },
    [applyRoute],
  );

  const closeTab = useCallback((id: string, force = false) => {
    if (id === 'mail' || id === 'calendar' || id === 'chat' || id === 'preview') return;
    if (id === 'settings') {
      setTabs((s) => ({ ...s, top: s.top.filter((t) => t.id !== 'settings'), active: s.active === 'settings' ? 'mail' : s.active }));
      return;
    }
    if (!force && dirty.current.has(id) && !confirm('Discard this message? Unsaved changes will be lost.')) return;
    dirty.current.delete(id);
    setTabs((s) => {
      const idx = s.reader.findIndex((t) => t.id === id);
      const reader = s.reader.filter((t) => t.id !== id);
      if (s.readerActive !== id) return { ...s, reader };
      // Like a browser: go back to the tab you came from, else the one to the left.
      const previous = [...visited.current].reverse().find((v) => v !== id && reader.some((t) => t.id === v));
      return { ...s, reader, readerActive: previous ?? reader[Math.max(0, idx - 1)]?.id ?? 'preview' };
    });
  }, []);

  const compose = useCallback((options: ComposeOptions = {}) => {
    const id = newTabId('compose');
    setTabs((s) => ({ ...s, active: 'mail', reader: [...s.reader, { id, kind: 'compose', options, title: options.subject || 'New message' }], readerActive: id }));
  }, []);

  const openMessage = useCallback((ref: MessageRef, title: string) => {
    setTabs((s) => {
      const existing = s.reader.find((t) => t.kind === 'message' && t.ref.accountId === ref.accountId && t.ref.folder === ref.folder && t.ref.id === ref.id);
      if (existing) return { ...s, active: 'mail', readerActive: existing.id };
      const id = newTabId('msg');
      return { ...s, active: 'mail', reader: [...s.reader, { id, kind: 'message', ref, title: title || '(no subject)' }], readerActive: id };
    });
  }, []);

  const setTabTitle = useCallback((id: string, title: string) => {
    setTabs((s) => ({ ...s, reader: s.reader.map((t) => (t.id === id && 'title' in t && t.title !== title ? { ...t, title } : t)) }));
  }, []);

  const setTabDirty = useCallback((id: string, isDirty: boolean) => {
    if (isDirty) dirty.current.add(id);
    else dirty.current.delete(id);
  }, []);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current.size) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useEffect(() => {
    const n = mailUnread + chat.totalUnread;
    document.title = n ? `(${n}) HomeMail` : 'HomeMail';
  }, [mailUnread, chat.totalUnread]);

  const ctx = useMemo(
    () => ({
      auth,
      refreshAuth,
      accounts,
      reloadAccounts,
      compose,
      openMessage,
      navigate,
      activeTab: active,
      readerTabs: reader,
      readerActive,
      activateReader,
      setTabTitle,
      setTabDirty,
      closeTab,
      mailVersion,
      bumpMail: () => setMailVersion((v) => v + 1),
    }),
    [auth, refreshAuth, accounts, reloadAccounts, compose, openMessage, navigate, active, reader, readerActive, activateReader, setTabTitle, setTabDirty, closeTab, mailVersion],
  );

  return (
    <AppContext.Provider value={ctx}>
      <div className="app">
        <TopBar tabs={top} active={active} onActivate={activate} onClose={closeTab} badges={{ mail: mailUnread, chat: chat.totalUnread }} />
        <div className="tab-panels">
          {top.map((t) => (
            <div key={t.id} className="tab-panel" hidden={t.id !== active} role="tabpanel">
              {t.kind === 'mail' && <MailView active={active === 'mail'} onUnreadChange={setMailUnread} />}
              {t.kind === 'calendar' && <CalendarView active={active === 'calendar'} />}
              {t.kind === 'chat' && <ChatView active={active === 'chat'} />}
              {t.kind === 'settings' && <Settings route={t.route} />}
            </div>
          ))}
        </div>
      </div>
    </AppContext.Provider>
  );
}
