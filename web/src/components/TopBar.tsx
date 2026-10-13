import { useEffect, useRef } from 'react';
import { api } from '../api';
import { useApp, type TopTab } from '../context';
import { Icon } from './Icon';
import { Menu } from './ui';

const LABELS: Record<TopTab['kind'], { icon: string; text: string }> = {
  mail: { icon: 'inbox', text: 'Mail' },
  calendar: { icon: 'calendar', text: 'Calendar' },
  chat: { icon: 'chat', text: 'Chat' },
  settings: { icon: 'settings', text: 'Settings' },
};

export function TopBar({
  tabs,
  active,
  onActivate,
  onClose,
  badges,
}: {
  tabs: TopTab[];
  active: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  badges: { mail: number; chat: number };
}) {
  const { auth, refreshAuth, navigate } = useApp();
  const strip = useRef<HTMLDivElement>(null);

  // Keep the active tab visible when the strip scrolls.
  useEffect(() => {
    strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const logout = async () => {
    await api('POST', '/auth/logout').catch(() => {});
    await refreshAuth();
  };

  return (
    <header className="topbar">
      <a className="brand" href="#/" aria-label="HomeMail">
        <img src="/favicon.svg" alt="" width={24} height={24} />
        <span className="hide-mobile">HomeMail</span>
      </a>
      <div className="tab-strip" role="tablist" ref={strip}>
        {tabs.map((t) => {
          const { icon, text } = LABELS[t.kind];
          const closable = t.kind === 'settings';
          const badge = t.kind === 'mail' ? badges.mail : t.kind === 'chat' ? badges.chat : 0;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === active}
              tabIndex={0}
              className={`tab ${t.id === active ? 'active' : ''} ${closable ? 'closable' : 'fixed'}`}
              title={text}
              onClick={() => onActivate(t.id)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onActivate(t.id))}
              onAuxClick={(e) => e.button === 1 && closable && onClose(t.id)}
            >
              <Icon name={icon} size={15} />
              <span className="tab-text hide-mobile">{text}</span>
              {badge > 0 && <span className="badge">{badge > 99 ? '99+' : badge}</span>}
              {closable && (
                <button
                  className="tab-close"
                  aria-label={`Close ${text}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(t.id);
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
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
            <button role="menuitem" onClick={() => (close(), navigate('/settings/calendars'))}>
              <Icon name="calendar" /> Calendars
            </button>
            <button role="menuitem" onClick={() => (close(), navigate('/settings/profile'))}>
              <Icon name="user" /> My addresses & password
            </button>
            <button role="menuitem" onClick={() => (close(), navigate('/settings/transfer'))}>
              <Icon name="download" /> Export / import
            </button>
            {auth.user!.isAdmin && (
              <>
                <button role="menuitem" onClick={() => (close(), navigate('/settings/server'))}>
                  <Icon name="server" /> Server (admin)
                </button>
                <button role="menuitem" onClick={() => (close(), navigate('/settings/admin'))}>
                  <Icon name="users" /> Users (admin)
                </button>
              </>
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
