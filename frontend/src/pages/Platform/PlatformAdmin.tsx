// Platform Admin panel shell — tabs: Overview, Schools, Users, Data,
// Messaging, Settings, Security, Backups. Route: /platform/* behind
// RequirePlatformAdmin (see App.tsx). If the overview call fails with
// the backend's "enable 2FA first" message, that message is shown here
// with a link to /security instead of the panel content.
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Tabs } from '../../components/ui';
import OverviewTab from './OverviewTab';
import SchoolsTab from './SchoolsTab';
import UsersTab from './UsersTab';
import DataTab from './DataTab';
import MessagingTab from './MessagingTab';
import SettingsTab from './SettingsTab';
import SecurityTab from './SecurityTab';
import BackupsTab from './BackupsTab';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'schools', label: 'Schools' },
  { key: 'users', label: 'Users' },
  { key: 'data', label: 'Data' },
  { key: 'messaging', label: 'Messaging' },
  { key: 'settings', label: 'Settings' },
  { key: 'security', label: 'Security' },
  { key: 'backups', label: 'Backups' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export default function PlatformAdminPage() {
  const [tab, setTab] = useState<TabKey>('overview');
  const [twoFactorError, setTwoFactorError] = useState('');
  const onTwoFactorError = useCallback((msg: string) => setTwoFactorError(msg), []);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Platform Admin</h1>
        <p className="text-sm text-slate-500">
          All schools, users, data, messaging and platform settings — for platform admins only.
        </p>
      </div>

      {twoFactorError && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-medium">Platform Admin needs 2FA enabled on your account.</p>
          <p className="mt-1">{twoFactorError}</p>
          <Link to="/security" className="mt-2 inline-block font-medium text-brand-700 hover:underline">
            Open Security to enable 2FA →
          </Link>
        </div>
      )}

      <Tabs tabs={[...TABS]} active={tab} onChange={(k) => setTab(k as TabKey)} />

      {tab === 'overview' && <OverviewTab onTwoFactorError={onTwoFactorError} />}
      {tab === 'schools' && <SchoolsTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'data' && <DataTab />}
      {tab === 'messaging' && <MessagingTab />}
      {tab === 'settings' && <SettingsTab />}
      {tab === 'security' && <SecurityTab />}
      {tab === 'backups' && <BackupsTab />}
    </div>
  );
}
