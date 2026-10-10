import { useEffect, useState } from 'react';
import { api, mailPath } from '../api';
import { useApp } from '../context';
import type { Folder, FullMessage, MessageRef } from '../types';
import { MessageView } from './MessageView';
import { draftOptions, forwardOptions, replyOptions } from './compose/options';
import { useAction } from './ui';

/** A message opened in its own tab. */
export function MessageTab({ tabId, messageRef, active }: { tabId: string; messageRef: MessageRef; active: boolean }) {
  const { accounts, compose, closeTab, setTabTitle, bumpMail } = useApp();
  const run = useAction();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [full, setFull] = useState<FullMessage | null>(null);
  const account = accounts.find((a) => a.id === messageRef.accountId);
  const { folder, id } = messageRef;

  useEffect(() => {
    if (account) api<Folder[]>('GET', mailPath(account.id, '/folders')).then(setFolders).catch(() => {});
  }, [account]);

  // Same single-key shortcuts as the mail view, while this tab is showing.
  useEffect(() => {
    if (!active || !full || !account) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"], .modal')) return;
      if (e.key === 'r' || e.key === 'a') compose(replyOptions(account, folder, full, e.key === 'a'));
      else if (e.key === 'f') compose(forwardOptions(account, folder, full));
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, full, account, folder, compose]);

  if (!account) return <div className="reader-empty muted">This account no longer exists.</div>;

  const specialUse = folders.find((f) => f.path === folder)?.specialUse;
  const afterRemoval = () => {
    bumpMail();
    closeTab(tabId, true);
  };

  return (
    <div className="message-tab">
      <MessageView
        account={account}
        folder={folder}
        id={id}
        isDrafts={specialUse === '\\Drafts'}
        moveTargets={folders.filter((f) => f.selectable && f.path !== folder).map((f) => ({ path: f.path, name: f.specialUse === '\\Inbox' ? 'Inbox' : f.path }))}
        onLoaded={(m) => {
          setFull(m);
          setTabTitle(tabId, m.subject || '(no subject)');
          bumpMail();
        }}
        actions={{
          reply: (m, all) => compose(replyOptions(account, folder, m, all)),
          forward: (m) => compose(forwardOptions(account, folder, m)),
          editDraft: (m) => {
            compose(draftOptions(account, folder, m));
            closeTab(tabId, true);
          },
          remove: async () => {
            if (specialUse === '\\Trash' && !confirm('Permanently delete this message?')) return;
            const ok = await run(() => api('POST', mailPath(account.id, '/messages/delete'), { folder, ids: [id] }));
            if (ok !== undefined) afterRemoval();
          },
          markUnread: async () => {
            await run(() => api('POST', mailPath(account.id, '/messages/flags'), { folder, ids: [id], seen: false }), 'Marked as unread');
            bumpMail();
          },
          moveTo: async (dest) => {
            const ok = await run(() => api('POST', mailPath(account.id, '/messages/move'), { folder, ids: [id], dest }));
            if (ok !== undefined) afterRemoval();
          },
        }}
      />
    </div>
  );
}
