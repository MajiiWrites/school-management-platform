import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { DashboardData, SmsStatus } from '../lib/types';
import { fmtDateTime, fmtPKR } from '../lib/utils';
import { Badge, Card, EmptyState, ErrorBanner, Spinner, StatCard } from '../components/ui';

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [sms, setSms] = useState<SmsStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    Promise.all([api<DashboardData>('/dashboard'), api<SmsStatus>('/sms/status')])
      .then(([d, s]) => {
        setData(d);
        setSms(s);
        setError('');
      })
      .catch(() => setError('Could not load the dashboard.'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  if (loading) return <Spinner label="Loading dashboard…" />;
  if (!data) return <ErrorBanner message={error || 'Dashboard unavailable.'} onRetry={load} />;

  const totalClasses = data.classes_submitted + data.classes_pending;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Today&apos;s overview</h1>
          <p className="text-sm text-slate-500">Attendance, teachers and fees — at a glance.</p>
        </div>
        <Link to="/classes" className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-900">
          View classes
        </Link>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {totalClasses === 0 && (
        <EmptyState
          title="No classes yet"
          body="Your school is empty — add your first class, then its students, and attendance, fees and messages will show up here."
          actionLabel="Add your first class"
          actionHref="/classes"
        />
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Classes submitted" value={`${data.classes_submitted} / ${totalClasses}`} sub={`${data.classes_pending} still pending`} tone={data.classes_pending > 0 ? 'amber' : 'green'} />
        <StatCard label="Present today" value={data.present} sub={`${data.absent} absent`} tone="green" />
        <StatCard label="Absent today" value={data.absent} sub="Parents notified after approval" tone={data.absent > 0 ? 'red' : 'green'} />
        <StatCard label="Teachers" value={`${data.teachers_present} present`} sub={`${data.teachers_absent} absent`} tone={data.teachers_absent > 0 ? 'amber' : 'green'} />
        <StatCard label="Fee collected (this month)" value={fmtPKR(data.fee_collected_this_month)} sub="Paid + partial" tone="green" />
        <StatCard label="Fee pending (this month)" value={fmtPKR(data.fee_pending_this_month)} sub="Unpaid students" tone={data.fee_pending_this_month > 0 ? 'amber' : 'green'} />
        <Card className="col-span-2 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">SMS / SIM status</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone={sms?.sim_connected ? 'green' : 'red'}>
              {sms?.sim_connected ? 'SIM connected' : 'SIM offline'}
            </Badge>
            <span className="text-sm text-slate-600">
              Provider: {sms?.provider === 'gateway' ? 'SMS gateway' : 'Admin SIM'} · {sms?.queued_count ?? 0} queued
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Last seen: {fmtDateTime(sms?.last_seen_at)}
          </p>
          <Link to="/messages" className="mt-2 inline-block text-sm font-medium text-brand-700 hover:underline">
            Open message queue →
          </Link>
        </Card>
      </div>

      <Card>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-base font-semibold">Notifications</h2>
          <Link to="/messages" className="text-sm font-medium text-brand-700 hover:underline">
            Review pending approvals
          </Link>
        </div>
        {data.recent_notifications.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">Nothing needs your attention right now.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.recent_notifications.map((n) => (
              <li key={n.id} className="flex items-start gap-3 px-5 py-3">
                <span className="mt-0.5">{n.is_read ? '○' : '●'}</span>
                <div>
                  <p className="text-sm font-medium text-slate-800">{n.title}</p>
                  <p className="text-xs text-slate-500">{n.body}</p>
                  <p className="text-xs text-slate-400">{fmtDateTime(n.created_at)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
