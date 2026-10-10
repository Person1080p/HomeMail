import { useApp } from '../../context';
import { Icon } from '../Icon';
import { AccountsSettings } from './AccountsSettings';
import { Transfer } from './Transfer';
import { Profile } from './Profile';
import { Admin } from './Admin';
import { ServerSettings } from './ServerSettings';

const TABS = [
  { id: 'accounts', label: 'Mail accounts', icon: 'mail' },
  { id: 'profile', label: 'My addresses & password', icon: 'user' },
  { id: 'transfer', label: 'Export / import', icon: 'download' },
  { id: 'server', label: 'Server (admin)', icon: 'server', admin: true },
  { id: 'admin', label: 'Users (admin)', icon: 'users', admin: true },
];

export function Settings({ route }: { route: string }) {
  const { auth } = useApp();
  const [path, query = ''] = route.split('?');
  const tab = path.split('/')[2] || 'accounts';
  const params = new URLSearchParams(query);
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings">
        {TABS.filter((t) => !t.admin || auth.user?.isAdmin).map((t) => (
          <a key={t.id} href={`#/settings/${t.id}`} className={tab === t.id ? 'active' : ''} aria-current={tab === t.id ? 'page' : undefined}>
            <Icon name={t.icon} /> {t.label}
          </a>
        ))}
      </nav>
      <main className="settings-main">
        {tab === 'accounts' && <AccountsSettings params={params} />}
        {tab === 'transfer' && <Transfer />}
        {tab === 'profile' && <Profile />}
        {tab === 'server' && auth.user?.isAdmin && <ServerSettings />}
        {tab === 'admin' && auth.user?.isAdmin && <Admin />}
      </main>
    </div>
  );
}
