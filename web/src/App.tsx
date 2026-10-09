import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { AppContext } from './context';
import type { Account, AuthState } from './types';
import { Login } from './components/Login';
import { MailView } from './components/MailView';
import { Settings } from './components/settings/Settings';
import { Compose, type ComposeOptions } from './components/Compose';
import { Spinner } from './components/ui';

function useHashRoute(): [string, (h: string) => void] {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setHash(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const navigate = useCallback((h: string) => {
    window.location.hash = h;
  }, []);
  return [hash, navigate];
}

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [composeOpts, setComposeOpts] = useState<ComposeOptions | null>(null);
  const [composeKey, setComposeKey] = useState(0);
  const [mailVersion, setMailVersion] = useState(0);
  const [route, navigate] = useHashRoute();

  const refreshAuth = useCallback(async () => {
    setAuth(await api<AuthState>('GET', '/auth/state'));
  }, []);

  const reloadAccounts = useCallback(async () => {
    setAccounts(await api<Account[]>('GET', '/accounts'));
  }, []);

  useEffect(() => {
    refreshAuth().catch(() => setAuth({ user: null, needsSetup: false, registrationOpen: false, oauth: { google: false, microsoft: false } }));
    const onUnauthorized = () => refreshAuth().catch(() => {});
    window.addEventListener('homemail:unauthorized', onUnauthorized);
    return () => window.removeEventListener('homemail:unauthorized', onUnauthorized);
  }, [refreshAuth]);

  useEffect(() => {
    if (auth?.user) reloadAccounts().catch(() => {});
    else setAccounts([]);
  }, [auth?.user, reloadAccounts]);

  const compose = useCallback((opts: ComposeOptions = {}) => {
    setComposeOpts(opts);
    setComposeKey((k) => k + 1);
  }, []);

  const ctx = useMemo(
    () => ({
      auth: auth!,
      refreshAuth,
      accounts,
      reloadAccounts,
      compose,
      navigate,
      mailVersion,
      bumpMail: () => setMailVersion((v) => v + 1),
    }),
    [auth, refreshAuth, accounts, reloadAccounts, compose, navigate, mailVersion],
  );

  if (!auth) return <Spinner label="Loading…" />;
  if (!auth.user) return <Login auth={auth} onDone={refreshAuth} />;

  const page = route.startsWith('/settings') ? (
    <Settings route={route} />
  ) : (
    <MailView />
  );

  return (
    <AppContext.Provider value={ctx}>
      {page}
      {composeOpts && <Compose key={composeKey} options={composeOpts} onClose={() => setComposeOpts(null)} />}
    </AppContext.Provider>
  );
}
