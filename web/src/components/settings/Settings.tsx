import { useApp } from '../../context';
import { Icon } from '../Icon';
import { TopBar } from '../TopBar';
import { AccountsSettings } from './AccountsSettings';
import { Transfer } from './Transfer';
import { Profile } from './Profile';
import { Admin } from './Admin';

const TABS = [
  { id: 'accounts', label: 'Mail accounts', icon: 'mail' },
  { id: 'transfer', label: 'Export / import', icon: 'download' },
  { id: 'profile', label: 'Profile & password', icon: 'user' },
  { id: 'admin', label: 'Users (admin)', icon: 'users', admin: true },
];

export function Settings({ route }: { route: string }) {
  const { auth } = useApp();
  const [path, query = ''] = route.split('?');
  const tab = path.split('/')[2] || 'accounts';
  const params = new URLSearchParams(query);
  return (
    <div className="app settings-app">
      <TopBar>
        <a className="btn btn-ghost" href="#/">
          <Icon name="chevronLeft" /> Back to mail
        </a>
      </TopBar>
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
          {tab === 'admin' && auth.user?.isAdmin && <Admin />}
        </main>
      </div>
    </div>
  );
}
