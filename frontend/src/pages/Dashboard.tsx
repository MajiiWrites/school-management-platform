import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/api';
import type { DashboardData, SmsStatus } from '../lib/types';
import { fmtDateTime, fmtPKR } from '../lib/utils';
import { Badge, Card, EmptyState, ErrorBanner, Spinner, StatCard } from '../components/ui';

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [sms, setSms] = useState<SmsStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  // Phase 1: honest verification banner, driven by
  // user.email_verification_status and shown only while the email is
  // unverified. It never claims a send that did not happen: 'sent'
  // means the mail went out, 'failed' means it did not, and
  // 'pending'/unknown means the send is still in progress. Dismissing
  // records it per user for this tab session, so it does not nag again
  // until the next session — but it returns after a refresh until the
  // email is actually verified, unless dismissed. "Unknown"
  // (email_verified undefined, e.g. mock payloads) never triggers it.
  const { user } = useAuth();
  const [verifyDismissed, setVerifyDismissed] = useState<boolean>(() => {
    try {
      return !!user && sessionStorage.getItem(`smp_verify_dismissed_${user.id}`) === '1';
    } catch {
      return false;
    }
  });
  const showVerifyReminder = !verifyDismissed && user?.email_verified === false;
  const [verifyResendResult, setVerifyResendResult] = useState('');
  const [verifyResendBusy, setVerifyResendBusy] = useState(false);
  const resendVerification = async () => {
    if (!user?.email) return;
    setVerifyResendResult('');
    setVerifyResendBusy(true);
    try {
      const data = await api<{ sent: boolean; message: string }>('/auth/resend-verification', {
        method: 'POST',
        body: { email: user.email },
      });
      setVerifyResendResult(data.message);
    } catch {
      setVerifyResendResult('Could not resend the verification email. Please try again.');
    } finally {
      setVerifyResendBusy(false);
    }
  };
  const dismissVerifyReminder = () => {
    try {
      if (user) sessionStorage.setItem(`smp_verify_dismissed_${user.id}`, '1');
    } catch {
      /* Private mode / storage blocked: banner may show again. Harmless. */
    }
    setVerifyDismissed(true);
  };

  // Phase 9 fix: /sms/status used to block the whole dashboard (Promise.all
  // with /dashboard) — a slow SIM-status call held the first paint for
  // 10–25s. The dashboard renders as soon as its own data arrives; the
  // SMS card fills in (or stays blank) independently.
  const load = () => {
    setLoading(true);
    api<DashboardData>('/dashboard')
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch(() => setError('Could not load the dashboard.'))
      .finally(() => setLoading(false));
    api<SmsStatus>('/sms/status')
      .then((s) => setSms(s))
      .catch(() => undefined);
  };

  useEffect(load, []);

  if (loading) return <Spinner label="Loading dashboard…" />;
  if (!data) return <ErrorBanner message={error || 'Dashboard unavailable.'} onRetry={load} />;

  const totalClasses = data.classes_submitted + data.classes_pending;

  return (
    <div className="space-y-5">
      {showVerifyReminder && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span>
            <strong>Verify your email.</strong>{' '}
            {user?.email_verification_status === 'sent' ? (
              <>We sent a verification link to {user?.email ?? 'your inbox'} — please check your inbox (and spam folder).</>
            ) : user?.email_verification_status === 'failed' ? (
              <>We could not send the verification email to {user?.email ?? 'your inbox'}. Please resend it.</>
            ) : (
              <>We&apos;re sending a verification link to {user?.email ?? 'your inbox'}… If it doesn&apos;t arrive in a few minutes, resend it.</>
            )}
            {verifyResendResult && <span className="mt-1 block">{verifyResendResult}</span>}
          </span>
          <span className="flex shrink-0 gap-3">
            <button onClick={resendVerification} disabled={verifyResendBusy} className="font-medium underline disabled:opacity-50" aria-label="Resend verification email">
              {verifyResendBusy ? 'Sending…' : 'Resend'}
            </button>
            <button onClick={dismissVerifyReminder} className="font-medium underline" aria-label="Dismiss verification reminder">
              Dismiss
            </button>
          </span>
        </div>
      )}
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
