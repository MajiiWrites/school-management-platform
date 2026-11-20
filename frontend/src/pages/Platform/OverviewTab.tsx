// Overview tab — totals, signup growth, health cards. Honest states
// only: if the backend says mail is failing or no backup exists, the
// panel says exactly that.
import { useCallback, useEffect, useState } from 'react';
import { isTwoFactorRequiredError, platformApi, type PlatformOverview } from '../../lib/platform';
import { fmtDateTime } from '../../lib/utils';
import { Badge, Card, EmptyState, ErrorBanner, Spinner, StatCard, useToast } from '../../components/ui';
import { errText } from './shared';

export default function OverviewTab({ onTwoFactorError }: { onTwoFactorError: (msg: string) => void }) {
  const { view } = useToast();
  const [data, setData] = useState<PlatformOverview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await platformApi.getOverview();
      setData(d);
    } catch (e) {
      if (isTwoFactorRequiredError(e)) {
        onTwoFactorError(errText(e));
      } else {
        setError(errText(e));
      }
    } finally {
      setLoading(false);
    }
  }, [onTwoFactorError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner label="Loading platform overview…" />;
  if (error) return <ErrorBanner message={error} onRetry={load} />;
  if (!data) return <EmptyState title="No overview data" body="The platform overview returned nothing." />;

  const mail = data.health.mail;
  const queue = data.health.queue;
  const queueTotal = queue.held + queue.approved + queue.queued + queue.failed;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Schools" value={data.totals.schools} tone="green" />
        <StatCard label="Students" value={data.totals.students} tone="green" />
        <StatCard label="Users" value={data.totals.users} tone="slate" />
        <StatCard label="Verified users" value={`${data.totals.verified_users} / ${data.totals.users}`} sub={`${data.totals.unverified_users} unverified`} tone={data.totals.unverified_users > 0 ? 'amber' : 'green'} />
        <StatCard label="Signups this week" value={data.signups.this_week} tone="slate" />
        <StatCard label="Signups this month" value={data.signups.this_month} tone="slate" />
      </div>

      <h2 className="text-base font-semibold text-slate-900">Platform health</h2>
      <div className="grid gap-3 md:grid-cols-2">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">API</p>
          <p className="mt-2 flex items-center gap-2">
            <Badge tone={data.health.api === 'up' ? 'green' : 'red'}>
              {data.health.api === 'up' ? 'API up' : `API: ${data.health.api}`}
            </Badge>
          </p>
          <p className="mt-2 text-sm text-slate-600">
            Last backup:{' '}
            {data.health.last_backup_at ? fmtDateTime(data.health.last_backup_at) : 'No backups recorded yet'}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Mail (verification)</p>
          <p className="mt-2 text-sm text-slate-700">
            Sent {mail.sent} · Failed {mail.failed} · Pending {mail.pending}
          </p>
          {mail.failed > 0 && (
            <p className="mt-1 text-sm font-medium text-red-600">
              Mail is failing — {mail.failed} recent verification email{mail.failed === 1 ? '' : 's'} failed to send. See the Messaging tab for the backend&apos;s note.
            </p>
          )}
          {mail.failed === 0 && <p className="mt-1 text-sm text-slate-500">No recent verification mail failures.</p>}
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Message queue</p>
          <p className="mt-2 text-sm text-slate-700">
            {queueTotal} in queue — {queue.held} held · {queue.approved} approved · {queue.queued} queued · {queue.failed} failed
          </p>
          {queue.failed > 0 && (
            <p className="mt-1 text-sm font-medium text-red-600">{queue.failed} failed message{queue.failed === 1 ? '' : 's'} need attention in the Messaging tab.</p>
          )}
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Backups</p>
          <p className="mt-2 text-sm text-slate-700">
            {data.health.last_backup_at
              ? `Latest backup ${fmtDateTime(data.health.last_backup_at)}`
              : 'No backups recorded yet'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Render&apos;s local disk is ephemeral — the durable copy is the manual export (Backups tab).
          </p>
        </Card>
      </div>
      {view}
    </div>
  );
}
