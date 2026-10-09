import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { api, mailPath, qs } from '../api';
import { useApp } from '../context';
import type { Account, Folder, FullMessage, ListResult, MailRef, MessageSummary } from '../types';
import { FolderPane, type FolderActions, type FolderState } from './FolderPane';
import { MessageList } from './MessageList';
import { MessageView } from './MessageView';
import { TopBar } from './TopBar';
import { Icon } from './Icon';
import { Menu, useAction, useLocalStorage, useToast } from './ui';
import { replyOptions, forwardOptions, draftOptions } from './Compose';

const PAGE = 50;
type Filter = 'all' | 'unread' | 'flagged';

export function MailView() {
  const { accounts, compose, mailVersion, navigate } = useApp();
  const toast = useToast();
  const run = useAction();
  const [sel, setSel] = useLocalStorage<MailRef | null>('homemail.folder', null);
  const [folderState, setFolderState] = useState<Record<number, FolderState>>({});
  const [list, setList] = useState<ListResult | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // The open message is tied to its folder, so a stale id never renders against another folder.
  const [openState, setOpenState] = useState<{ key: string; id: number } | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [mobilePane, setMobilePane] = useState<'folders' | 'list' | 'reader'>('list');
  const [syncing, setSyncing] = useState(false);
  const draggedIds = useRef<number[]>([]);
  const listReq = useRef(0);

  const folderKey = sel ? `${sel.accountId}:${sel.folder}` : '';
  const openId = openState?.key === folderKey ? openState.id : null;
  const setOpenId = (id: number | null) => setOpenState(id == null ? null : { key: folderKey, id });
  const account = accounts.find((a) => a.id === sel?.accountId) ?? null;
  const folders = (account && folderState[account.id] && 'folders' in folderState[account.id]! ? (folderState[account.id] as { folders: Folder[] }).folders : []) as Folder[];
  const currentFolder = folders.find((f) => f.path === sel?.folder) ?? null;
  const messages = list?.messages ?? [];

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

  const loadList = useCallback(
    async (opts: { append?: boolean; keep?: boolean } = {}) => {
      if (!sel) return;
      const req = ++listReq.current;
      const page = opts.append && list ? Math.ceil(list.messages.length / PAGE) : 0;
      // A background refresh reloads as many messages as are currently shown.
      const pageSize = opts.keep && list ? Math.min(200, Math.max(PAGE, list.messages.length)) : PAGE;
      setListLoading(true);
      if (!opts.append && !opts.keep) setListError(null);
      try {
        const r = await api<ListResult>(
          'GET',
          mailPath(sel.accountId, `/messages?${qs({ folder: sel.folder, page, pageSize, q: query, unread: filter === 'unread' ? 1 : undefined, flagged: filter === 'flagged' ? 1 : undefined })}`),
        );
        if (req !== listReq.current) return;
        setList((prev) => (opts.append && prev ? { ...r, messages: [...prev.messages, ...r.messages.filter((m) => !prev.messages.some((p) => p.id === m.id))] } : r));
        setListError(null);
      } catch (e) {
        if (req === listReq.current && !opts.keep) setListError((e as Error).message);
      } finally {
        if (req === listReq.current) setListLoading(false);
      }
    },
    [sel, query, filter, list],
  );

  // Pick a sensible default folder once accounts are known.
  useEffect(() => {
    if (!accounts.length) return;
    if (!sel || !accounts.some((a) => a.id === sel.accountId)) setSel({ accountId: accounts[0].id, folder: 'INBOX' });
  }, [accounts, sel, setSel]);

  useEffect(() => {
    loadAllFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.map((a) => a.id).join(','), mailVersion]);

  useEffect(() => {
    setList(null);
    setSelected(new Set());
    setOpenId(null);
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.accountId, sel?.folder, query, filter]);

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

  // Unread count in the tab title.
  useEffect(() => {
    let unread = 0;
    for (const st of Object.values(folderState)) if (st && 'folders' in st) unread += st.folders.find((f) => f.specialUse === '\\Inbox')?.unseen ?? 0;
    document.title = unread ? `(${unread}) HomeMail` : 'HomeMail';
  }, [folderState]);

  /* ---------- message actions ---------- */

  const patchMessages = (ids: number[], patch: Partial<MessageSummary>) =>
    setList((l) => (l ? { ...l, messages: l.messages.map((m) => (ids.includes(m.id) ? { ...m, ...patch } : m)) } : l));
  const dropMessages = (ids: number[]) =>
    setList((l) => (l ? { ...l, total: l.total - ids.length, messages: l.messages.filter((m) => !ids.includes(m.id)) } : l));

  const adjustUnread = (delta: number) => {
    if (!sel || !delta) return;
    setFolderState((s) => {
      const st = s[sel.accountId];
      if (!st || !('folders' in st)) return s;
      return { ...s, [sel.accountId]: { folders: st.folders.map((f) => (f.path === sel.folder ? { ...f, unseen: Math.max(0, f.unseen + delta) } : f)) } };
    });
  };

  const targetIds = (): number[] => (selected.size ? [...selected] : openId != null ? [openId] : []);

  const setFlags = async (ids: number[], change: { seen?: boolean; flagged?: boolean }) => {
    if (!sel || !ids.length) return;
    if (change.seen !== undefined) {
      const affected = messages.filter((m) => ids.includes(m.id) && m.seen !== change.seen).length;
      adjustUnread(change.seen ? -affected : affected);
    }
    patchMessages(ids, change);
    const ok = await run(() => api('POST', mailPath(sel.accountId, '/messages/flags'), { folder: sel.folder, ids, ...change }));
    if (ok === undefined) loadList({ keep: true });
  };

  /** Opens the next message after removing some, like Thunderbird. */
  const advanceAfter = (ids: number[]) => {
    if (openId == null || !ids.includes(openId)) {
      setSelected(new Set());
      return;
    }
    const idx = messages.findIndex((m) => m.id === openId);
    const keep = (m: MessageSummary) => !ids.includes(m.id);
    const next = messages.slice(idx + 1).find(keep) ?? messages.slice(0, idx).reverse().find(keep) ?? null;
    setOpenId(next?.id ?? null);
    setSelected(new Set(next ? [next.id] : []));
    if (!next) setMobilePane('list');
  };

  const removeMessages = async (ids: number[]) => {
    if (!sel || !ids.length) return;
    const isTrash = currentFolder?.specialUse === '\\Trash';
    if (isTrash && !confirm(`Permanently delete ${ids.length} message${ids.length > 1 ? 's' : ''}?`)) return;
    advanceAfter(ids);
    dropMessages(ids);
    const ok = await run(() => api('POST', mailPath(sel.accountId, '/messages/delete'), { folder: sel.folder, ids }));
    if (ok === undefined) loadList();
    if (account) loadFolders(account);
  };

  const moveMessages = async (ids: number[], dest: string, accountId = sel?.accountId) => {
    if (!sel || !ids.length || dest === sel.folder) return;
    if (accountId !== sel.accountId) {
      toast('Moving messages between accounts is not supported yet', 'error');
      return;
    }
    advanceAfter(ids);
    dropMessages(ids);
    const ok = await run(() => api('POST', mailPath(sel.accountId, '/messages/move'), { folder: sel.folder, ids, dest }));
    if (ok === undefined) loadList();
    if (account) loadFolders(account);
  };

  const onRowClick = (m: MessageSummary, e: MouseEvent) => {
    if (e.shiftKey && anchor != null) {
      const a = messages.findIndex((x) => x.id === anchor);
      const b = messages.findIndex((x) => x.id === m.id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelected(new Set(messages.slice(lo, hi + 1).map((x) => x.id)));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (openId != null && next.size === 0) next.add(openId);
      next.has(m.id) ? next.delete(m.id) : next.add(m.id);
      setSelected(next);
      setAnchor(m.id);
      return;
    }
    setSelected(new Set([m.id]));
    setAnchor(m.id);
    setOpenId(m.id);
    setMobilePane('reader');
  };

  const onLoaded = (full: FullMessage) => {
    const row = messages.find((m) => m.id === full.id);
    if (row && !row.seen) {
      patchMessages([full.id], { seen: true });
      adjustUnread(-1);
    }
  };

  /* ---------- folder actions ---------- */

  const folderActions: FolderActions = {
    create: async (accountId, parent, delimiter) => {
      const name = prompt(parent ? `New subfolder in "${parent}":` : 'New folder name:');
      if (!name?.trim()) return;
      const path = parent ? `${parent}${delimiter}${name.trim()}` : name.trim();
      await run(() => api('POST', mailPath(accountId, '/folders'), { path }), `Created "${name.trim()}"`);
      const acc = accounts.find((a) => a.id === accountId);
      if (acc) loadFolders(acc);
    },
    rename: async (accountId, f) => {
      const name = prompt('Rename folder to:', f.name);
      if (!name?.trim() || name === f.name) return;
      const i = f.path.lastIndexOf(f.delimiter);
      const newPath = i > 0 ? f.path.slice(0, i + 1) + name.trim() : name.trim();
      const ok = await run(() => api('PATCH', mailPath(accountId, '/folders'), { path: f.path, newPath }), 'Folder renamed');
      if (ok !== undefined && sel?.accountId === accountId && sel.folder === f.path) setSel({ accountId, folder: newPath });
      const acc = accounts.find((a) => a.id === accountId);
      if (acc) loadFolders(acc);
    },
    remove: async (accountId, f) => {
      if (!confirm(`Delete folder "${f.name}" and all messages in it? This cannot be undone.`)) return;
      const ok = await run(() => api('DELETE', mailPath(accountId, `/folders?${qs({ path: f.path })}`)), 'Folder deleted');
      if (ok !== undefined && sel?.accountId === accountId && sel.folder === f.path) setSel({ accountId, folder: 'INBOX' });
      const acc = accounts.find((a) => a.id === accountId);
      if (acc) loadFolders(acc);
    },
    empty: async (accountId, f) => {
      if (!confirm(`Permanently delete all ${f.total} messages in "${f.name}"?`)) return;
      await run(() => api('POST', mailPath(accountId, '/folders/empty'), { path: f.path }), `${f.name} emptied`);
      const acc = accounts.find((a) => a.id === accountId);
      if (acc) loadFolders(acc);
      if (sel?.accountId === accountId && sel.folder === f.path) loadList();
    },
    dropMessages: (accountId, dest) => moveMessages(draggedIds.current, dest, accountId),
  };

  const getMessages = async () => {
    setSyncing(true);
    await Promise.all(accounts.filter((a) => a.protocol === 'pop3').map((a) => api('POST', mailPath(a.id, '/sync')).catch(() => {})));
    await Promise.all([loadAllFolders(), loadList({ keep: true })]);
    setSyncing(false);
  };

  /* ---------- keyboard shortcuts ---------- */

  const keyState = useRef({ messages, openId, targetIds, removeMessages, setFlags, compose, account });
  keyState.current = { messages, openId, targetIds, removeMessages, setFlags, compose, account };
  const openFull = useRef<FullMessage | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || t.closest('input, textarea, select, [contenteditable="true"], .modal, .compose')) return;
      const s = keyState.current;
      const idx = s.messages.findIndex((m) => m.id === s.openId);
      const open = (m?: MessageSummary) => {
        if (!m) return;
        setOpenId(m.id);
        setSelected(new Set([m.id]));
        setAnchor(m.id);
      };
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          open(s.messages[idx + 1] ?? (idx < 0 ? s.messages[0] : undefined));
          break;
        case 'k':
        case 'ArrowUp':
          open(s.messages[idx - 1]);
          break;
        case 'Delete':
        case '#':
          s.removeMessages(s.targetIds());
          break;
        case 's':
          s.setFlags(s.targetIds(), { flagged: !s.messages.find((m) => m.id === s.targetIds()[0])?.flagged });
          break;
        case 'u':
          s.setFlags(s.targetIds(), { seen: !s.messages.find((m) => m.id === s.targetIds()[0])?.seen });
          break;
        case 'c':
          s.compose({ accountId: s.account?.id });
          break;
        case 'r':
        case 'a':
          if (openFull.current && s.account) s.compose(replyOptions(s.account, sel!.folder, openFull.current, e.key === 'a'));
          break;
        case 'f':
          if (openFull.current && s.account) s.compose(forwardOptions(s.account, sel!.folder, openFull.current));
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel]);

  /* ---------- render ---------- */

  const moveTargets = useMemo(
    () => folders.filter((f) => f.selectable && f.path !== sel?.folder).map((f) => ({ path: f.path, name: f.specialUse === '\\Inbox' ? 'Inbox' : f.path })),
    [folders, sel?.folder],
  );
  const showRecipient = currentFolder?.specialUse === '\\Sent' || currentFolder?.specialUse === '\\Drafts';
  const isDrafts = currentFolder?.specialUse === '\\Drafts';
  const bulk = selected.size > 1 ? [...selected] : [];

  if (!accounts.length) {
    return (
      <div className="app">
        <TopBar />
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
      </div>
    );
  }

  return (
    <div className={`app mail-app pane-${mobilePane}`}>
      <TopBar onMenu={() => setMobilePane(mobilePane === 'folders' ? 'list' : 'folders')}>
        <button className="btn btn-ghost" onClick={getMessages} disabled={syncing} title="Get new messages">
          <Icon name="refresh" className={syncing ? 'spin' : ''} /> <span className="hide-mobile">Get messages</span>
        </button>
        <button className="btn btn-primary" onClick={() => compose({ accountId: account?.id })} title="Write a message (c)">
          <Icon name="pencil" /> <span className="hide-mobile">Write</span>
        </button>
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
            placeholder={`Search ${currentFolder?.specialUse === '\\Inbox' ? 'Inbox' : (currentFolder?.name ?? 'folder')}…`}
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              if (!e.target.value) setQuery('');
            }}
            aria-label="Search messages"
          />
        </form>
      </TopBar>

      <div className="panes">
        <FolderPane
          accounts={accounts}
          state={folderState}
          selected={sel}
          onSelect={(r) => {
            setSel(r);
            setSearchInput('');
            setQuery('');
            setMobilePane('list');
          }}
          actions={folderActions}
          onRetry={(id) => {
            const acc = accounts.find((a) => a.id === id);
            if (acc) {
              setFolderState((s) => ({ ...s, [id]: undefined }));
              loadFolders(acc);
            }
          }}
        />

        <section className="list-pane" aria-label="Message list">
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
                <Menu
                  trigger={(open) => (
                    <button className="icon-btn" title="Move to…" onClick={open}>
                      <Icon name="folder" />
                    </button>
                  )}
                >
                  {(close) =>
                    moveTargets.map((t) => (
                      <button key={t.path} onClick={() => (close(), moveMessages(bulk, t.path))}>
                        {t.name}
                      </button>
                    ))
                  }
                </Menu>
                <button className="icon-btn" title="Delete" onClick={() => removeMessages(bulk)}>
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
                <span className="muted small">{list ? `${list.total} message${list.total === 1 ? '' : 's'}` : ''}</span>
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
          <MessageList
            messages={messages}
            total={list?.total ?? 0}
            loading={listLoading}
            error={listError}
            selected={selected}
            openId={openId}
            showRecipient={showRecipient}
            onRowClick={onRowClick}
            onToggleFlag={(m) => setFlags([m.id], { flagged: !m.flagged })}
            onLoadMore={() => loadList({ append: true })}
            onDragStart={(m) => (draggedIds.current = selected.has(m.id) ? [...selected] : [m.id])}
            emptyText={query ? 'No messages match your search.' : filter !== 'all' ? 'Nothing here.' : 'This folder is empty.'}
          />
        </section>

        <section className="reader-pane" aria-label="Message">
          {account && sel && openId != null ? (
            <MessageView
              account={account}
              folder={sel.folder}
              id={openId}
              isDrafts={isDrafts}
              moveTargets={moveTargets}
              onLoaded={(m) => {
                openFull.current = m;
                onLoaded(m);
              }}
              actions={{
                reply: (m, all) => compose(replyOptions(account, sel.folder, m, all)),
                forward: (m) => compose(forwardOptions(account, sel.folder, m)),
                editDraft: (m) => compose(draftOptions(account, sel.folder, m)),
                remove: () => removeMessages([openId]),
                markUnread: () => setFlags([openId], { seen: false }),
                moveTo: (dest) => moveMessages([openId], dest),
                back: () => setMobilePane('list'),
              }}
            />
          ) : (
            <div className="reader-empty muted">
              <Icon name="mail" size={40} />
              <p>{selected.size > 1 ? `${selected.size} messages selected` : 'Select a message to read it'}</p>
              <p className="small">Shortcuts: j/k next/previous · r reply · a reply all · f forward · c write · s star · u unread · Del delete</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
