import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { api, mailPath, qs } from '../api';
import { useApp } from '../context';
import type { Account, Folder, FullMessage, ListResult, MailItem, MailSelection } from '../types';
import { FolderPane, type FolderActions, type FolderState } from './FolderPane';
import { MessageList } from './MessageList';
import { MessageView } from './MessageView';
import { Icon } from './Icon';
import { Menu, Spinner, useAction, useLocalStorage, useToast } from './ui';
import { MessageTab } from './MessageTab';
import type { ReaderTab } from '../context';
import { replyOptions, forwardOptions, draftOptions } from './compose/options';

// The rich text editor is large; load it the first time someone writes a message.
const Compose = lazy(() => import('./compose/Compose').then((m) => ({ default: m.Compose })));

const PAGE = 50;
type Filter = 'all' | 'unread' | 'flagged';
interface Source {
  accountId: number;
  folder: string;
}
interface SourceState {
  items: MailItem[];
  total: number;
  /** Pages of PAGE messages loaded so far. */
  pages: number;
  error: string | null;
}

const srcKey = (s: Source) => `${s.accountId}\u0000${s.folder}`;
export const itemKey = (accountId: number, folder: string, id: number) => `${accountId}\u0000${folder}\u0000${id}`;
const time = (m: MailItem) => new Date(m.date).getTime();

/** Earlier versions stored {accountId, folder} without a kind. */
function normalizeSelection(v: unknown): MailSelection | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.kind === 'unified') return { kind: 'unified' };
  if (typeof o.accountId === 'number' && typeof o.folder === 'string') return { kind: 'folder', accountId: o.accountId, folder: o.folder };
  return null;
}

export function MailView({ active, onUnreadChange }: { active: boolean; onUnreadChange: (n: number) => void }) {
  const { accounts, compose, openMessage, mailVersion, navigate, readerTabs, readerActive, activateReader, closeTab } = useApp();
  const [expanded, setExpanded] = useLocalStorage('homemail.readerExpanded', false);
  const previewShown = readerActive === 'preview';
  const toast = useToast();
  const run = useAction();
  const [storedSel, setSel] = useLocalStorage<MailSelection | null>('homemail.folder', null);
  const sel = normalizeSelection(storedSel);
  const [folderState, setFolderState] = useState<Record<number, FolderState>>({});
  const [lists, setLists] = useState<Record<string, SourceState>>({});
  const [listLoading, setListLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selKey = sel ? (sel.kind === 'unified' ? 'unified' : srcKey(sel)) : '';
  // The open message is tied to the current view so a stale key never renders against another folder.
  const [openState, setOpenState] = useState<{ view: string; key: string } | null>(null);
  const openKey = openState?.view === selKey ? openState.key : null;
  const setOpenKey = (key: string | null) => setOpenState(key == null ? null : { view: selKey, key });
  const [anchor, setAnchor] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<'folders' | 'list' | 'reader'>('list');
  const [syncing, setSyncing] = useState(false);
  const dragged = useRef<MailItem[]>([]);
  const listReq = useRef(0);
  const openFull = useRef<FullMessage | null>(null);

  const accountIds = accounts.map((a) => a.id).join(',');
  const sources: Source[] = useMemo(
    () => (!sel ? [] : sel.kind === 'unified' ? accounts.map((a) => ({ accountId: a.id, folder: 'INBOX' })) : [{ accountId: sel.accountId, folder: sel.folder }]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selKey, accountIds],
  );
  const foldersOf = (accountId: number): Folder[] => {
    const st = folderState[accountId];
    return st && 'folders' in st ? st.folders : [];
  };
  const singleAccount = sel?.kind === 'folder' ? (accounts.find((a) => a.id === sel.accountId) ?? null) : null;
  const currentFolder = sel?.kind === 'folder' ? (foldersOf(sel.accountId).find((f) => f.path === sel.folder) ?? null) : null;

  /* ---------- merged list ---------- */

  const { items, total, hasMore, errors } = useMemo(() => {
    const states = sources.map((s) => lists[srcKey(s)]).filter((s): s is SourceState => !!s);
    const errors = sources
      .map((s) => ({ s, st: lists[srcKey(s)] }))
      .filter((x) => x.st?.error)
      .map((x) => ({ accountId: x.s.accountId, error: x.st!.error! }));
    const total = states.reduce((n, s) => n + s.total, 0);
    const hasMore = states.some((s) => s.items.length < s.total);
    if (states.length <= 1) return { items: states[0]?.items ?? [], total, hasMore, errors };
    // Merge newest-first, only down to the point every account has loaded up to.
    const all = states.flatMap((s) => s.items).sort((a, b) => time(b) - time(a));
    const limits = states.filter((s) => s.items.length && s.items.length < s.total).map((s) => time(s.items[s.items.length - 1]));
    const cutoff = limits.length ? Math.max(...limits) : -Infinity;
    return { items: all.filter((m) => time(m) >= cutoff), total, hasMore, errors };
  }, [sources, lists]);

  /* ---------- loading ---------- */

  const loadFolders = useCallback(async (acc: Account) => {
    try {
      const f = await api<Folder[]>('GET', mailPath(acc.id, '/folders'));
      setFolderState((s) => ({ ...s, [acc.id]: { folders: f } }));
    } catch (e) {
      setFolderState((s) => ({ ...s, [acc.id]: { error: (e as Error).message } }));
    }
  }, []);

  const loadAllFolders = useCallback(() => Promise.all(accounts.map(loadFolders)), [accounts, loadFolders]);

  const fetchSource = useCallback(
    async (s: Source, page: number, pageSize: number): Promise<ListResult> =>
      api<ListResult>(
        'GET',
        mailPath(
          s.accountId,
          `/messages?${qs({ folder: s.folder, page, pageSize, q: query, unread: filter === 'unread' ? 1 : undefined, flagged: filter === 'flagged' ? 1 : undefined })}`,
        ),
      ),
    [query, filter],
  );

  const toItems = (s: Source, r: ListResult): MailItem[] => r.messages.map((m) => ({ ...m, accountId: s.accountId, folder: s.folder, key: itemKey(s.accountId, s.folder, m.id) }));

  /**
   * Loads the current view. `keep` refreshes what's already shown (for polling);
   * `append` loads the next page from whichever accounts are holding the merged list back.
   */
  const loadList = useCallback(
    async (opts: { append?: boolean; keep?: boolean } = {}) => {
      if (!sources.length) return;
      const req = ++listReq.current;
      setListLoading(true);
      const current = listsRef.current;
      let targets = sources;
      if (opts.append) {
        const withMore = sources.filter((s) => {
          const st = current[srcKey(s)];
          return st && st.items.length < st.total;
        });
        // Only the accounts whose oldest loaded message is the newest such cut-off need more.
        const oldest = (s: Source) => {
          const st = current[srcKey(s)]!;
          return st.items.length ? time(st.items[st.items.length - 1]) : Infinity;
        };
        const cutoff = Math.max(...withMore.map(oldest));
        targets = withMore.filter((s) => oldest(s) >= cutoff);
      }
      const results = await Promise.all(
        targets.map(async (s) => {
          const st = current[srcKey(s)];
          try {
            if (opts.append && st) {
              const r = await fetchSource(s, st.pages, PAGE);
              const seen = new Set(st.items.map((m) => m.key));
              return [srcKey(s), { items: [...st.items, ...toItems(s, r).filter((m) => !seen.has(m.key))], total: r.total, pages: st.pages + 1, error: null }] as const;
            }
            const pages = opts.keep && st ? Math.min(4, Math.max(1, st.pages)) : 1;
            const r = await fetchSource(s, 0, pages * PAGE);
            return [srcKey(s), { items: toItems(s, r), total: r.total, pages, error: null }] as const;
          } catch (e) {
            if (opts.keep && st) return [srcKey(s), st] as const;
            return [srcKey(s), { items: [], total: 0, pages: 0, error: (e as Error).message }] as const;
          }
        }),
      );
      if (req !== listReq.current) return;
      setLists((prev) => ({ ...(opts.append || opts.keep ? prev : {}), ...Object.fromEntries(results) }));
      setListLoading(false);
    },
    [sources, fetchSource],
  );
  const listsRef = useRef(lists);
  listsRef.current = lists;

  // Pick a sensible default view once accounts are known.
  useEffect(() => {
    if (!accounts.length) return;
    if (!sel || (sel.kind === 'folder' && !accounts.some((a) => a.id === sel.accountId))) {
      setSel(accounts.length > 1 ? { kind: 'unified' } : { kind: 'folder', accountId: accounts[0].id, folder: 'INBOX' });
    }
  }, [accounts, sel, setSel]);

  useEffect(() => {
    loadAllFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountIds, mailVersion]);

  useEffect(() => {
    setLists({});
    setSelected(new Set());
    setOpenKey(null);
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, accountIds, query, filter]);

  useEffect(() => {
    if (mailVersion > 0) loadList({ keep: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mailVersion]);

  // Poll for new mail, like Thunderbird's periodic check.
  const latest = useRef({ loadAllFolders, loadList });
  latest.current = { loadAllFolders, loadList };
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return;
      latest.current.loadAllFolders();
      latest.current.loadList({ keep: true });
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  const inboxUnread = useMemo(() => {
    let n = 0;
    for (const st of Object.values(folderState)) if (st && 'folders' in st) n += st.folders.find((f) => f.specialUse === '\\Inbox')?.unseen ?? 0;
    return n;
  }, [folderState]);
  useEffect(() => onUnreadChange(inboxUnread), [inboxUnread, onUnreadChange]);

  // On phones, opening a message or compose tab switches to the reading pane.
  useEffect(() => {
    if (readerActive !== 'preview') setMobilePane('reader');
  }, [readerActive]);

  /* ---------- message actions ---------- */

  const patchItems = (keys: string[], patch: Partial<MailItem>) =>
    setLists((ls) => Object.fromEntries(Object.entries(ls).map(([k, st]) => [k, { ...st, items: st.items.map((m) => (keys.includes(m.key) ? { ...m, ...patch } : m)) }])));
  const dropItems = (keys: string[]) =>
    setLists((ls) =>
      Object.fromEntries(
        Object.entries(ls).map(([k, st]) => {
          const items = st.items.filter((m) => !keys.includes(m.key));
          return [k, { ...st, items, total: st.total - (st.items.length - items.length) }];
        }),
      ),
    );

  const adjustUnread = (accountId: number, folder: string, delta: number) => {
    if (!delta) return;
    setFolderState((s) => {
      const st = s[accountId];
      if (!st || !('folders' in st)) return s;
      return { ...s, [accountId]: { folders: st.folders.map((f) => (f.path === folder ? { ...f, unseen: Math.max(0, f.unseen + delta) } : f)) } };
    });
  };

  /** Groups messages by account and folder, since each API call works on one folder. */
  const grouped = (list: MailItem[]) => {
    const m = new Map<string, { accountId: number; folder: string; ids: number[] }>();
    for (const it of list) {
      const k = srcKey(it);
      if (!m.has(k)) m.set(k, { accountId: it.accountId, folder: it.folder, ids: [] });
      m.get(k)!.ids.push(it.id);
    }
    return [...m.values()];
  };

  const byKeys = (keys: string[]) => items.filter((m) => keys.includes(m.key));
  const targets = (): MailItem[] => byKeys(selected.size ? [...selected] : openKey ? [openKey] : []);

  const setFlags = async (list: MailItem[], change: { seen?: boolean; flagged?: boolean }) => {
    if (!list.length) return;
    if (change.seen !== undefined) for (const m of list) if (m.seen !== change.seen) adjustUnread(m.accountId, m.folder, change.seen ? -1 : 1);
    patchItems(
      list.map((m) => m.key),
      change,
    );
    for (const g of grouped(list)) {
      const ok = await run(() => api('POST', mailPath(g.accountId, '/messages/flags'), { folder: g.folder, ids: g.ids, ...change }));
      if (ok === undefined) loadList({ keep: true });
    }
  };

  /** Opens the next message after removing some, like Thunderbird. */
  const advanceAfter = (keys: string[]) => {
    if (!openKey || !keys.includes(openKey)) {
      setSelected(new Set());
      return;
    }
    const idx = items.findIndex((m) => m.key === openKey);
    const keep = (m: MailItem) => !keys.includes(m.key);
    const next = items.slice(idx + 1).find(keep) ?? items.slice(0, idx).reverse().find(keep) ?? null;
    setOpenKey(next?.key ?? null);
    setSelected(new Set(next ? [next.key] : []));
    if (!next) setMobilePane('list');
  };

  const removeItems = async (list: MailItem[]) => {
    if (!list.length) return;
    if (currentFolder?.specialUse === '\\Trash' && !confirm(`Permanently delete ${list.length} message${list.length > 1 ? 's' : ''}?`)) return;
    const keys = list.map((m) => m.key);
    advanceAfter(keys);
    dropItems(keys);
    for (const g of grouped(list)) {
      const ok = await run(() => api('POST', mailPath(g.accountId, '/messages/delete'), { folder: g.folder, ids: g.ids }));
      if (ok === undefined) loadList();
      const acc = accounts.find((a) => a.id === g.accountId);
      if (acc) loadFolders(acc);
    }
  };

  const moveItems = async (list: MailItem[], dest: string, destAccountId: number) => {
    const movable = list.filter((m) => m.folder !== dest || m.accountId !== destAccountId);
    if (!movable.length) return;
    if (movable.some((m) => m.accountId !== destAccountId)) {
      toast('Messages can only be moved to folders of the same account', 'error');
      return;
    }
    const keys = movable.map((m) => m.key);
    advanceAfter(keys);
    dropItems(keys);
    for (const g of grouped(movable)) {
      const ok = await run(() => api('POST', mailPath(g.accountId, '/messages/move'), { folder: g.folder, ids: g.ids, dest }));
      if (ok === undefined) loadList();
    }
    const acc = accounts.find((a) => a.id === destAccountId);
    if (acc) loadFolders(acc);
  };

  const onRowClick = (m: MailItem, e: MouseEvent) => {
    if (e.shiftKey && anchor) {
      const a = items.findIndex((x) => x.key === anchor);
      const b = items.findIndex((x) => x.key === m.key);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelected(new Set(items.slice(lo, hi + 1).map((x) => x.key)));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (openKey && next.size === 0) next.add(openKey);
      if (next.has(m.key)) next.delete(m.key);
      else next.add(m.key);
      setSelected(next);
      setAnchor(m.key);
      return;
    }
    setSelected(new Set([m.key]));
    setAnchor(m.key);
    setOpenKey(m.key);
    activateReader('preview');
    setMobilePane('reader');
  };

  const openInTab = (m: MailItem) => openMessage({ accountId: m.accountId, folder: m.folder, id: m.id }, m.subject);

  const onLoaded = (full: FullMessage, item: MailItem) => {
    openFull.current = full;
    if (!item.seen) {
      patchItems([item.key], { seen: true });
      adjustUnread(item.accountId, item.folder, -1);
    }
  };

  /* ---------- folder actions ---------- */

  const reloadAccountFolders = (accountId: number) => {
    const acc = accounts.find((a) => a.id === accountId);
    if (acc) loadFolders(acc);
  };

  const folderActions: FolderActions = {
    create: async (accountId, parent, delimiter) => {
      const name = prompt(parent ? `New subfolder in "${parent}":` : 'New folder name:');
      if (!name?.trim()) return;
      const path = parent ? `${parent}${delimiter}${name.trim()}` : name.trim();
      await run(() => api('POST', mailPath(accountId, '/folders'), { path }), `Created "${name.trim()}"`);
      reloadAccountFolders(accountId);
    },
    rename: async (accountId, f) => {
      const name = prompt('Rename folder to:', f.name);
      if (!name?.trim() || name === f.name) return;
      const i = f.path.lastIndexOf(f.delimiter);
      const newPath = i > 0 ? f.path.slice(0, i + 1) + name.trim() : name.trim();
      const ok = await run(() => api('PATCH', mailPath(accountId, '/folders'), { path: f.path, newPath }), 'Folder renamed');
      if (ok !== undefined && sel?.kind === 'folder' && sel.accountId === accountId && sel.folder === f.path) setSel({ kind: 'folder', accountId, folder: newPath });
      reloadAccountFolders(accountId);
    },
    remove: async (accountId, f) => {
      if (!confirm(`Delete folder "${f.name}" and all messages in it? This cannot be undone.`)) return;
      const ok = await run(() => api('DELETE', mailPath(accountId, `/folders?${qs({ path: f.path })}`)), 'Folder deleted');
      if (ok !== undefined && sel?.kind === 'folder' && sel.accountId === accountId && sel.folder === f.path) setSel({ kind: 'folder', accountId, folder: 'INBOX' });
      reloadAccountFolders(accountId);
    },
    empty: async (accountId, f) => {
      if (!confirm(`Permanently delete all ${f.total} messages in "${f.name}"?`)) return;
      await run(() => api('POST', mailPath(accountId, '/folders/empty'), { path: f.path }), `${f.name} emptied`);
      reloadAccountFolders(accountId);
      if (sel?.kind === 'folder' && sel.accountId === accountId && sel.folder === f.path) loadList();
    },
    dropMessages: (accountId, dest) => moveItems(dragged.current, dest, accountId),
  };

  const getMessages = async () => {
    setSyncing(true);
    await Promise.all(accounts.filter((a) => a.protocol === 'pop3').map((a) => api('POST', mailPath(a.id, '/sync')).catch(() => {})));
    await Promise.all([loadAllFolders(), loadList({ keep: true })]);
    setSyncing(false);
  };

  /* ---------- keyboard shortcuts ---------- */

  const openItem = items.find((m) => m.key === openKey) ?? null;
  const openAccount = openItem ? (accounts.find((a) => a.id === openItem.accountId) ?? null) : null;
  const shortcutsOn = active && previewShown;
  const keyState = useRef({ items, openKey, openItem, openAccount, targets, removeItems, setFlags, compose, active: shortcutsOn });
  keyState.current = { items, openKey, openItem, openAccount, targets, removeItems, setFlags, compose, active: shortcutsOn };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = keyState.current;
      const t = e.target as HTMLElement;
      if (!s.active || e.ctrlKey || e.metaKey || e.altKey || t.closest('input, textarea, select, [contenteditable="true"], .modal')) return;
      // Enter on a focused button or link belongs to that control.
      if (e.key === 'Enter' && t.closest('button, a, [role="tab"], [role="treeitem"]')) return;
      const idx = s.items.findIndex((m) => m.key === s.openKey);
      const open = (m?: MailItem) => {
        if (!m) return;
        setOpenKey(m.key);
        setSelected(new Set([m.key]));
        setAnchor(m.key);
      };
      const full = openFull.current;
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          open(s.items[idx + 1] ?? (idx < 0 ? s.items[0] : undefined));
          break;
        case 'k':
        case 'ArrowUp':
          open(s.items[idx - 1]);
          break;
        case 'Enter':
          if (s.openItem) openInTab(s.openItem);
          break;
        case 'Delete':
        case '#':
          s.removeItems(s.targets());
          break;
        case 's':
          s.setFlags(s.targets(), { flagged: !s.targets()[0]?.flagged });
          break;
        case 'u':
          s.setFlags(s.targets(), { seen: !s.targets()[0]?.seen });
          break;
        case 'c':
          s.compose({ accountId: s.openAccount?.id ?? singleAccount?.id });
          break;
        case 'r':
        case 'a':
          if (full && s.openAccount && s.openItem) s.compose(replyOptions(s.openAccount, s.openItem.folder, full, e.key === 'a'));
          break;
        case 'f':
          if (full && s.openAccount && s.openItem) s.compose(forwardOptions(s.openAccount, s.openItem.folder, full));
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);

  /* ---------- render ---------- */

  const moveTargetsFor = (accountId: number | undefined, exclude?: string) =>
    accountId === undefined
      ? []
      : foldersOf(accountId)
          .filter((f) => f.selectable && f.path !== exclude)
          .map((f) => ({ path: f.path, name: f.specialUse === '\\Inbox' ? 'Inbox' : f.path }));
  const bulk = selected.size > 1 ? byKeys([...selected]) : [];
  const bulkAccount = bulk.length && bulk.every((m) => m.accountId === bulk[0].accountId) ? bulk[0].accountId : undefined;
  const showRecipient = currentFolder?.specialUse === '\\Sent' || currentFolder?.specialUse === '\\Drafts';
  const accountLabel = (id: number) => accounts.find((a) => a.id === id)?.label ?? '';
  const viewName = sel?.kind === 'unified' ? 'All Inboxes' : currentFolder?.specialUse === '\\Inbox' ? 'Inbox' : (currentFolder?.name ?? 'folder');

  if (!accounts.length) {
    return (
      <div className="welcome">
        <Icon name="mail" size={48} />
        <h1>Add your first mail account</h1>
        <p className="muted">HomeMail works with Gmail, Outlook.com, Yahoo, iCloud, Proton Mail (via Bridge) and any IMAP or POP3 provider.</p>
        <button className="btn btn-primary" onClick={() => navigate('/settings/accounts?add=1')}>
          <Icon name="plus" /> Add account
        </button>
        <p className="muted small">
          Already use Thunderbird? You can <a href="#/settings/transfer">import your accounts</a>.
        </p>
      </div>
    );
  }

  const searchForm = (
    <form
      className="search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        setQuery(searchInput.trim());
      }}
    >
      <Icon name="search" size={15} />
      <input
        type="search"
        placeholder={`Search ${viewName}…`}
        value={searchInput}
        onChange={(e) => {
          setSearchInput(e.target.value);
          if (!e.target.value) setQuery('');
        }}
        aria-label="Search messages"
      />
    </form>
  );

  const preview =
    openItem && openAccount ? (
      <MessageView
        key={openItem.key}
        account={openAccount}
        folder={openItem.folder}
        id={openItem.id}
        isDrafts={openItem.draft || foldersOf(openItem.accountId).find((f) => f.path === openItem.folder)?.specialUse === '\\Drafts'}
        moveTargets={moveTargetsFor(openItem.accountId, openItem.folder)}
        onLoaded={(m) => onLoaded(m, openItem)}
        actions={{
          reply: (m, all) => compose(replyOptions(openAccount, openItem.folder, m, all)),
          forward: (m) => compose(forwardOptions(openAccount, openItem.folder, m)),
          editDraft: (m) => compose(draftOptions(openAccount, openItem.folder, m)),
          remove: () => removeItems([openItem]),
          markUnread: () => setFlags([openItem], { seen: false }),
          moveTo: (dest) => moveItems([openItem], dest, openItem.accountId),
          openInTab: () => openInTab(openItem),
        }}
      />
    ) : (
      <div className="reader-empty muted">
        <Icon name="mail" size={40} />
        <p>{selected.size > 1 ? `${selected.size} messages selected` : 'Select a message to read it'}</p>
        <p className="small">Double-click or press Enter to open a message in its own tab.</p>
        <p className="small">j/k next/previous · r reply · a reply all · f forward · c write · s star · u unread · Del delete</p>
      </div>
    );

  const tabTitle = (t: ReaderTab) => (t.kind === 'preview' ? (openItem?.subject || 'Preview') : t.title);
  const tabIcon = (t: ReaderTab) => (t.kind === 'compose' ? 'pencil' : t.kind === 'message' ? 'mail' : 'mailOpen');

  return (
    <div className={`mail-app pane-${mobilePane}`}>
      <div className={`panes ${expanded ? 'reader-expanded' : ''}`}>
        <div className="folder-col">
          <div className="pane-head">
            <button className="btn btn-primary write-btn" onClick={() => compose({ accountId: openAccount?.id ?? singleAccount?.id })} title="Write a message (c)">
              <Icon name="pencil" /> Write
            </button>
            <button className="icon-btn" onClick={getMessages} disabled={syncing} title="Get new messages" aria-label="Get new messages">
              <Icon name="refresh" className={syncing ? 'spin' : ''} />
            </button>
            <button className="icon-btn only-mobile" onClick={() => setMobilePane('list')} aria-label="Close folders">
              <Icon name="x" />
            </button>
          </div>
          <FolderPane
            accounts={accounts}
            state={folderState}
            selected={sel}
            unifiedUnread={inboxUnread}
            onSelect={(r) => {
              setSel(r);
              setSearchInput('');
              setQuery('');
              setMobilePane('list');
            }}
            actions={folderActions}
            onRetry={(id) => {
              setFolderState((s) => ({ ...s, [id]: undefined }));
              reloadAccountFolders(id);
            }}
          />
        </div>

        <section className="list-pane" aria-label="Message list">
          <div className="pane-head">
            <button className="icon-btn only-mobile" onClick={() => setMobilePane('folders')} aria-label="Folders">
              <Icon name="menu" size={18} />
            </button>
            {searchForm}
            <button className="icon-btn only-mobile" onClick={() => compose({ accountId: singleAccount?.id })} aria-label="Write a message">
              <Icon name="pencil" />
            </button>
          </div>
          <div className="list-toolbar">
            {bulk.length > 0 ? (
              <>
                <span className="muted small">{bulk.length} selected</span>
                <button className="icon-btn" title="Mark read" onClick={() => setFlags(bulk, { seen: true })}>
                  <Icon name="mailOpen" />
                </button>
                <button className="icon-btn" title="Mark unread" onClick={() => setFlags(bulk, { seen: false })}>
                  <Icon name="mail" />
                </button>
                <button className="icon-btn" title="Star" onClick={() => setFlags(bulk, { flagged: true })}>
                  <Icon name="star" />
                </button>
                {bulkAccount !== undefined && (
                  <Menu
                    trigger={(open) => (
                      <button className="icon-btn" title="Move to…" onClick={open}>
                        <Icon name="folder" />
                      </button>
                    )}
                  >
                    {(close) =>
                      moveTargetsFor(bulkAccount, sel?.kind === 'folder' ? sel.folder : undefined).map((t) => (
                        <button key={t.path} onClick={() => (close(), moveItems(bulk, t.path, bulkAccount))}>
                          {t.name}
                        </button>
                      ))
                    }
                  </Menu>
                )}
                <button className="icon-btn" title="Delete" onClick={() => removeItems(bulk)}>
                  <Icon name="trash" />
                </button>
                <button className="link-btn small" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
              </>
            ) : (
              <>
                <div className="segmented" role="tablist">
                  {(['all', 'unread', 'flagged'] as Filter[]).map((f) => (
                    <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                      {f === 'all' ? 'All' : f === 'unread' ? 'Unread' : 'Starred'}
                    </button>
                  ))}
                </div>
                <span className="spacer" />
                <span className="muted small">{Object.keys(lists).length ? `${total} message${total === 1 ? '' : 's'}` : ''}</span>
              </>
            )}
          </div>
          {query && (
            <div className="search-banner">
              Results for “{query}”
              <button className="link-btn" onClick={() => (setQuery(''), setSearchInput(''))}>
                Clear
              </button>
            </div>
          )}
          {sel?.kind === 'unified' && errors.length > 0 && (
            <div className="search-banner warn-banner">
              Couldn't load {errors.map((e) => accountLabel(e.accountId)).join(', ')}: {errors[0].error}
            </div>
          )}
          <MessageList
            items={items}
            hasMore={hasMore}
            loading={listLoading}
            error={sel?.kind === 'folder' ? (errors[0]?.error ?? null) : null}
            selected={selected}
            openKey={openKey}
            showRecipient={showRecipient}
            accountLabel={sel?.kind === 'unified' ? accountLabel : undefined}
            onRowClick={onRowClick}
            onRowOpen={openInTab}
            onToggleFlag={(m) => setFlags([m], { flagged: !m.flagged })}
            onLoadMore={() => loadList({ append: true })}
            onDragStart={(m) => (dragged.current = selected.has(m.key) ? byKeys([...selected]) : [m])}
            emptyText={query ? 'No messages match your search.' : filter !== 'all' ? 'Nothing here.' : sel?.kind === 'unified' ? 'All inboxes are empty.' : 'This folder is empty.'}
          />
        </section>

        <section className="reader-pane" aria-label="Messages and drafts">
          <div className="pane-head reader-tabs">
            <button className="icon-btn only-mobile" onClick={() => setMobilePane('list')} aria-label="Back to list">
              <Icon name="chevronLeft" size={18} />
            </button>
            <div className="reader-tab-strip" role="tablist" aria-label="Open messages">
              {readerTabs.map((t) => {
                const closable = t.kind !== 'preview';
                const title = tabTitle(t);
                return (
                  <div
                    key={t.id}
                    role="tab"
                    tabIndex={0}
                    aria-selected={t.id === readerActive}
                    className={`rtab ${t.id === readerActive ? 'active' : ''} ${t.kind}`}
                    title={t.kind === 'preview' ? 'Preview of the selected message' : title}
                    onClick={() => activateReader(t.id)}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), activateReader(t.id))}
                    onAuxClick={(e) => e.button === 1 && closable && closeTab(t.id)}
                  >
                    <Icon name={tabIcon(t)} size={14} />
                    <span className="rtab-text">{title}</span>
                    {closable && (
                      <button
                        className="tab-close"
                        aria-label={`Close ${title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(t.id);
                        }}
                      >
                        <Icon name="x" size={12} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <button
              className="icon-btn hide-mobile"
              onClick={() => setExpanded(!expanded)}
              title={expanded ? 'Show folders and message list' : 'Use the full width'}
              aria-label={expanded ? 'Show folders and message list' : 'Use the full width'}
              aria-pressed={expanded}
            >
              <Icon name={expanded ? 'collapse' : 'expand'} />
            </button>
          </div>
          <div className="reader-panels">
            {readerTabs.map((t) => (
              <div key={t.id} className="reader-panel" hidden={t.id !== readerActive} role="tabpanel">
                {t.kind === 'preview' && preview}
                {t.kind === 'message' && <MessageTab tabId={t.id} messageRef={t.ref} active={active && readerActive === t.id} />}
                {t.kind === 'compose' && (
                  <Suspense fallback={<Spinner label="Loading editor…" />}>
                    <Compose tabId={t.id} options={t.options} active={active && readerActive === t.id} />
                  </Suspense>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
