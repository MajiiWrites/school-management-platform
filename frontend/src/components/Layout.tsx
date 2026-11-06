import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/api';
import type { NotificationItem, Role } from '../lib/types';
import { cx } from '../lib/utils';
import DeveloperFooter from './DeveloperFooter';

const NAV: { to: string; label: string; icon: string; roles: Role[] }[] = [
  { to: '/', label: 'Dashboard', icon: '▦', roles: ['admin', 'clerk'] },
  { to: '/classes', label: 'Classes', icon: '▤', roles: ['admin', 'clerk'] },
  { to: '/students', label: 'Students', icon: '👥', roles: ['admin', 'clerk'] },
  { to: '/parents', label: 'Parents', icon: '☎', roles: ['admin', 'clerk'] },
  { to: '/fees', label: 'Fees', icon: '₨', roles: ['admin', 'clerk'] },
  { to: '/messages', label: 'Messages', icon: '✉', roles: ['admin', 'clerk'] },
  { to: '/reports', label: 'Reports', icon: '▧', roles: ['admin', 'clerk'] },
  { to: '/settings', label: 'Settings', icon: '⚙', roles: ['admin'] },
];

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 px-4 py-4">
        <p className="text-lg font-bold text-brand-900">🏫 School Manager</p>
        <p className="truncate text-xs text-slate-500">{user?.school_name ?? 'Your school'}</p>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
        {NAV.filter((n) => user && n.roles.includes(user.role)).map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            onClick={onNavigate}
            className={({ isActive }) =>
              cx(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium',
                isActive ? 'bg-brand-100 text-brand-700' : 'text-slate-600 hover:bg-slate-100',
              )
            }
          >
            <span className="w-5 text-center">{n.icon}</span>
            {n.label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-slate-200 px-4 py-3 text-xs text-slate-500">
        <p className="truncate font-medium text-slate-700">{user?.email}</p>
        <p className="capitalize">{user?.role}</p>
        <button
          onClick={() => {
            logout();
            navigate('/login');
          }}
          className="mt-2 font-medium text-red-600 hover:underline"
        >
          Log out
        </button>
      </div>
    </div>
  );
}

export default function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);

  useEffect(() => {
    api<{ items: NotificationItem[] }>('/notifications?limit=10')
      .then((d) => setNotifications(d.items))
      .catch(() => undefined);
  }, []);

  const unread = notifications.filter((n) => !n.is_read).length;

  const markRead = (id: string) => {
    api(`/notifications/${id}/read`, { method: 'POST' }).catch(() => undefined);
    setNotifications((ns) => ns.map((n) => (n.id === id ? { ...n, is_read: true } : n)));
  };

  return (
    <div className="min-h-screen lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white lg:block">
        <div className="sticky top-0 h-screen">
          <SidebarContent />
        </div>
      </aside>

      {/* Mobile sidebar */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 bg-white shadow-xl">
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="min-w-0 flex-1">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
          <button
            className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            ☰
          </button>
          <p className="flex-1 text-sm font-semibold text-slate-800 lg:hidden">School Manager</p>
          <div className="relative ml-auto">
            <button
              onClick={() => setBellOpen((v) => !v)}
              className="relative rounded-lg p-2 text-slate-600 hover:bg-slate-100"
              aria-label="Notifications"
            >
              🔔
              {unread > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white">
                  {unread}
                </span>
              )}
            </button>
            {bellOpen && (
              <div className="absolute right-0 mt-2 w-80 max-w-[90vw] rounded-xl border border-slate-200 bg-white shadow-xl">
                <p className="border-b border-slate-200 px-4 py-2 text-sm font-semibold">Notifications</p>
                <div className="max-h-96 overflow-y-auto">
                  {notifications.length === 0 && (
                    <p className="px-4 py-6 text-center text-sm text-slate-500">No notifications.</p>
                  )}
                  {notifications.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => markRead(n.id)}
                      className={cx('block w-full px-4 py-3 text-left hover:bg-slate-50', !n.is_read && 'bg-brand-50')}
                    >
                      <p className="text-sm font-medium text-slate-800">{n.title}</p>
                      <p className="text-xs text-slate-500">{n.body}</p>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
          <Outlet />
        </main>
        <DeveloperFooter variant="compact" />
      </div>
    </div>
  );
}
