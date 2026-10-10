import { useState } from 'react';
import type { Account, Folder, MailSelection } from '../types';
import { Icon } from './Icon';
import { Menu, useLocalStorage } from './ui';

export type FolderState = { folders: Folder[] } | { error: string } | undefined;

const ICON_FOR: Record<string, string> = {
  '\\Inbox': 'inbox',
  '\\Drafts': 'file',
  '\\Sent': 'send',
  '\\Trash': 'trash',
  '\\Junk': 'alert',
  '\\Archive': 'archive',
  '\\Flagged': 'star',
};

interface Node {
  folder: Folder | null;
  name: string;
  path: string;
  children: Node[];
}

/** Builds a tree from IMAP's flat folder list using each folder's delimiter. */
function buildTree(folders: Folder[]): Node[] {
  const roots: Node[] = [];
  const byPath = new Map<string, Node>();
  const ensure = (path: string, name: string, delimiter: string): Node => {
    let node = byPath.get(path);
    if (node) return node;
    node = { folder: null, name, path, children: [] };
    byPath.set(path, node);
    const i = delimiter ? path.lastIndexOf(delimiter) : -1;
    if (i > 0) {
      const parentPath = path.slice(0, i);
      ensure(parentPath, parentPath.slice(parentPath.lastIndexOf(delimiter) + 1), delimiter).children.push(node);
    } else roots.push(node);
    return node;
  };
  for (const f of folders) {
    const node = ensure(f.path, f.name, f.delimiter);
    node.folder = f;
    node.name = f.specialUse === '\\Inbox' ? 'Inbox' : f.name;
  }
  return roots;
}

export interface FolderActions {
  create: (accountId: number, parent: string | null, delimiter: string) => void;
  rename: (accountId: number, folder: Folder) => void;
  remove: (accountId: number, folder: Folder) => void;
  empty: (accountId: number, folder: Folder) => void;
  dropMessages: (accountId: number, folder: string) => void;
}

export function FolderPane({
  accounts,
  state,
  selected,
  unifiedUnread,
  onSelect,
  actions,
  onRetry,
}: {
  accounts: Account[];
  state: Record<number, FolderState>;
  selected: MailSelection | null;
  unifiedUnread: number;
  onSelect: (sel: MailSelection) => void;
  actions: FolderActions;
  onRetry: (accountId: number) => void;
}) {
  const [collapsed, setCollapsed] = useLocalStorage<Record<string, boolean>>('homemail.collapsed', {});
  const toggle = (key: string) => setCollapsed({ ...collapsed, [key]: !collapsed[key] });
  const unifiedSelected = selected?.kind === 'unified';

  return (
    <nav className="folder-pane" aria-label="Folders">
      {accounts.length > 1 && (
        <div
          className={`folder-row unified-row ${unifiedSelected ? 'selected' : ''}`}
          role="treeitem"
          aria-selected={unifiedSelected}
          tabIndex={0}
          onClick={() => onSelect({ kind: 'unified' })}
          onKeyDown={(e) => e.key === 'Enter' && onSelect({ kind: 'unified' })}
        >
          <span className="folder-twisty" />
          <Icon name="inbox" size={15} />
          <span className={`ellipsis ${unifiedUnread > 0 ? 'bold' : ''}`}>All Inboxes</span>
          {unifiedUnread > 0 && <span className="badge">{unifiedUnread}</span>}
        </div>
      )}
      {accounts.map((acc) => {
        const st = state[acc.id];
        const key = `a${acc.id}`;
        const folders = st && 'folders' in st ? st.folders : [];
        const inboxUnread = folders.find((f) => f.specialUse === '\\Inbox')?.unseen ?? 0;
        return (
          <section key={acc.id} className="folder-account">
            <div className="folder-account-head">
              <button className="folder-account-toggle" onClick={() => toggle(key)} title={acc.email}>
                <Icon name={collapsed[key] ? 'chevronRight' : 'chevronDown'} size={14} />
                <span className="ellipsis">{acc.label}</span>
                {collapsed[key] && inboxUnread > 0 && <span className="badge">{inboxUnread}</span>}
              </button>
              {acc.protocol === 'imap' && (
                <button className="icon-btn icon-btn-sm hover-only" title="New folder" onClick={() => actions.create(acc.id, null, folders[0]?.delimiter || '/')}>
                  <Icon name="plus" size={14} />
                </button>
              )}
            </div>
            {!collapsed[key] && (
              <>
                {!st && <div className="folder-msg muted">Loading…</div>}
                {st && 'error' in st && (
                  <div className="folder-msg error-text">
                    {st.error}{' '}
                    <button className="link-btn" onClick={() => onRetry(acc.id)}>
                      Retry
                    </button>{' '}
                    <a href="#/settings/accounts">Settings</a>
                  </div>
                )}
                {st && 'folders' in st && (
                  <FolderTree nodes={buildTree(st.folders)} account={acc} selected={selected} onSelect={onSelect} actions={actions} collapsed={collapsed} toggle={toggle} depth={0} />
                )}
              </>
            )}
          </section>
        );
      })}
    </nav>
  );
}

function FolderTree({
  nodes,
  account,
  selected,
  onSelect,
  actions,
  collapsed,
  toggle,
  depth,
}: {
  nodes: Node[];
  account: Account;
  selected: MailSelection | null;
  onSelect: (sel: MailSelection) => void;
  actions: FolderActions;
  collapsed: Record<string, boolean>;
  toggle: (k: string) => void;
  depth: number;
}) {
  const [dragOver, setDragOver] = useState<string | null>(null);
  return (
    <ul className="folder-list" role="tree">
      {nodes.map((n) => {
        const f = n.folder;
        const key = `a${account.id}:${n.path}`;
        const isSel = selected?.kind === 'folder' && selected.accountId === account.id && selected.folder === n.path;
        const canSelect = f?.selectable ?? false;
        const icon = (f?.specialUse && ICON_FOR[f.specialUse]) || 'folder';
        const canEmpty = f?.specialUse === '\\Trash' || f?.specialUse === '\\Junk';
        const isSpecial = !!f?.specialUse;
        return (
          <li key={n.path} role="treeitem" aria-selected={isSel}>
            <div
              className={`folder-row ${isSel ? 'selected' : ''} ${dragOver === n.path ? 'drag-over' : ''} ${canSelect ? '' : 'disabled'}`}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => canSelect && onSelect({ kind: 'folder', accountId: account.id, folder: n.path })}
              onDragOver={(e) => {
                if (!canSelect || !e.dataTransfer.types.includes('application/x-homemail')) return;
                e.preventDefault();
                setDragOver(n.path);
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                actions.dropMessages(account.id, n.path);
              }}
            >
              {n.children.length > 0 ? (
                <button
                  className="folder-twisty"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(key);
                  }}
                  aria-label={collapsed[key] ? 'Expand' : 'Collapse'}
                >
                  <Icon name={collapsed[key] ? 'chevronRight' : 'chevronDown'} size={12} />
                </button>
              ) : (
                <span className="folder-twisty" />
              )}
              <Icon name={icon} size={15} />
              <span className={`ellipsis ${f && f.unseen > 0 ? 'bold' : ''}`}>{n.name}</span>
              {f && f.unseen > 0 && <span className="badge">{f.unseen}</span>}
              {account.protocol === 'imap' && f && (
                <Menu
                  align="right"
                  trigger={(open) => (
                    <button
                      className="icon-btn icon-btn-sm hover-only"
                      onClick={(e) => {
                        e.stopPropagation();
                        open();
                      }}
                      aria-label="Folder actions"
                    >
                      <Icon name="more" size={14} />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <button onClick={() => (close(), actions.create(account.id, n.path, f.delimiter))}>
                        <Icon name="plus" /> New subfolder
                      </button>
                      {!isSpecial && (
                        <button onClick={() => (close(), actions.rename(account.id, f))}>
                          <Icon name="pencil" /> Rename
                        </button>
                      )}
                      {canEmpty && (
                        <button onClick={() => (close(), actions.empty(account.id, f))}>
                          <Icon name="trash" /> Empty {n.name}
                        </button>
                      )}
                      {!isSpecial && (
                        <button className="danger" onClick={() => (close(), actions.remove(account.id, f))}>
                          <Icon name="trash" /> Delete folder
                        </button>
                      )}
                    </>
                  )}
                </Menu>
              )}
              {account.protocol === 'pop3' && canEmpty && f && f.total > 0 && (
                <button
                  className="icon-btn icon-btn-sm hover-only"
                  title={`Empty ${n.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.empty(account.id, f);
                  }}
                >
                  <Icon name="trash" size={14} />
                </button>
              )}
            </div>
            {n.children.length > 0 && !collapsed[key] && (
              <FolderTree nodes={n.children} account={account} selected={selected} onSelect={onSelect} actions={actions} collapsed={collapsed} toggle={toggle} depth={depth + 1} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
