import { createContext, useContext } from 'react';
import type { Account, AuthState } from './types';
import type { ComposeOptions } from './components/Compose';

export interface AppContextValue {
  auth: AuthState;
  refreshAuth: () => Promise<void>;
  accounts: Account[];
  reloadAccounts: () => Promise<void>;
  compose: (opts?: ComposeOptions) => void;
  navigate: (hash: string) => void;
  /** Bumped when mail changed elsewhere (e.g. after sending) so views refetch. */
  mailVersion: number;
  bumpMail: () => void;
}

export const AppContext = createContext<AppContextValue>(null as unknown as AppContextValue);
export const useApp = () => useContext(AppContext);
