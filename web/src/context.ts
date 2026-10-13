import { createContext, useContext } from 'react';
import type { Account, AuthState, MessageRef } from './types';
import type { ComposeOptions } from './components/compose/options';

/** Tabs in the top bar. */
export type TopTab =
  | { id: 'mail'; kind: 'mail' }
  | { id: 'calendar'; kind: 'calendar' }
  | { id: 'chat'; kind: 'chat' }
  | { id: 'settings'; kind: 'settings'; route: string };

/** Tabs above the reading pane: the preview of the selected message, opened messages and compose windows. */
export type ReaderTab =
  | { id: 'preview'; kind: 'preview' }
  | { id: string; kind: 'message'; ref: MessageRef; title: string }
  | { id: string; kind: 'compose'; options: ComposeOptions; title: string };

export interface AppContextValue {
  auth: AuthState;
  refreshAuth: () => Promise<void>;
  accounts: Account[];
  reloadAccounts: () => Promise<void>;
  /** Opens a new compose tab in the reading pane. */
  compose: (opts?: ComposeOptions) => void;
  /** Opens a message in its own reading-pane tab. */
  openMessage: (ref: MessageRef, title: string) => void;
  /** Goes to a hash route: "/", "/calendar", "/chat" or "/settings/...". */
  navigate: (hash: string) => void;
  activeTab: TopTab['id'];
  readerTabs: ReaderTab[];
  readerActive: string;
  activateReader: (id: string) => void;
  setTabTitle: (id: string, title: string) => void;
  /** Compose tabs report unsaved changes so closing them asks first. */
  setTabDirty: (id: string, dirty: boolean) => void;
  /** Closes a reading-pane tab or the Settings tab. */
  closeTab: (id: string, force?: boolean) => void;
  /** Bumped when mail changed elsewhere (e.g. after sending) so views refetch. */
  mailVersion: number;
  bumpMail: () => void;
}

export const AppContext = createContext<AppContextValue>(null as unknown as AppContextValue);
export const useApp = () => useContext(AppContext);
