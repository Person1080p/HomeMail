import type { ReactNode } from 'react';
import { api } from '../api';
import { useApp } from '../context';
import { Icon } from './Icon';
import { Menu } from './ui';

export function TopBar({ children, onMenu }: { children?: ReactNode; onMenu?: () => void }) {
  const { auth, refreshAuth, navigate } = useApp();
  const logout = async () => {
    await api('POST', '/auth/logout').catch(() => {});
    await refreshAuth();
  };
  return (
    <header className="topbar">
      {onMenu && (
        <button className="icon-btn only-mobile" onClick={onMenu} aria-label="Folders">
          <Icon name="menu" size={18} />
        </button>
      )}
      <a className="brand" href="#/" aria-label="HomeMail home">
        <img src="/favicon.svg" alt="" width={24} height={24} />
        <span className="hide-mobile">HomeMail</span>
      </a>
      <div className="topbar-main">{children}</div>
      <Menu
        align="right"
        trigger={(toggle) => (
          <button className="btn btn-ghost user-btn" onClick={toggle} aria-haspopup="menu">
            <Icon name="user" />
            <span className="hide-mobile">{auth.user!.displayName || auth.user!.username}</span>
            <Icon name="chevronDown" size={14} />
          </button>
        )}
      >
        {(close) => (
          <>
            <button role="menuitem" onClick={() => (close(), navigate('/settings/accounts'))}>
              <Icon name="mail" /> Mail accounts
            </button>
            <button role="menuitem" onClick={() => (close(), navigate('/settings/transfer'))}>
              <Icon name="download" /> Export / import
            </button>
            <button role="menuitem" onClick={() => (close(), navigate('/settings/profile'))}>
              <Icon name="user" /> Profile & password
            </button>
            {auth.user!.isAdmin && (
              <button role="menuitem" onClick={() => (close(), navigate('/settings/admin'))}>
                <Icon name="users" /> Users (admin)
              </button>
            )}
            <hr />
            <button role="menuitem" onClick={logout}>
              <Icon name="logout" /> Sign out
            </button>
          </>
        )}
      </Menu>
    </header>
  );
}
