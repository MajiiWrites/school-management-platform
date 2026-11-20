// Backups tab — latest backup, per-school table, and the honest
// note that Render's local disk is ephemeral and the durable copy is
// the manual export.
import { useCallback, useEffect, useState } from 'react';
import { platformApi, type PlatformBackups } from '../../lib/platform';
import { fmtDateTime } from '../../lib/utils';
import { Card, EmptyState, ErrorBanner, Spinner } from '../../components/ui';
import { errText } from './shared';

function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function BackupsTab() {
  const [data, setData] = useState<PlatformBackups | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await platformApi.listBackups();
      setData(d);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner label="Loading backups…" />;
  if (error) return <ErrorBanner message={error} onRetry={load} />;
  if (!data) return <EmptyState title="No backup data" body="The backups endpoint returned nothing." />;

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <h2 className="text-base font-semibold text-slate-900">Latest backup</h2>
        {data.latest ? (
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-slate-500">School</dt><dd className="font-medium text-slate-900">{data.latest.school_name ?? data.latest.school_id ?? '—'}</dd></div>
            <div><dt className="text-slate-500">File</dt><dd className="font-medium text-slate-900">{data.latest.file ?? '—'}</dd></div>
            <div><dt className="text-slate-500">Size</dt><dd className="font-medium text-slate-900">{fmtBytes(data.latest.size_bytes)}</dd></div>
            <div><dt className="text-slate-500">Taken</dt><dd className="font-medium text-slate-900">{fmtDateTime(data.latest.created_at)}</dd></div>
          </dl>
        ) : (
          <p className="mt-2 text-sm text-slate-600">No backups recorded yet</p>
        )}
        <p className="mt-3 text-sm text-slate-500">
          Total backups recorded: {data.total}. Render&apos;s local disk is ephemeral — a backup stored only on
          the server can disappear on redeploy or restart. The durable copy is the manual export: open a school in
          the Data tab and use “Full JSON export”.
        </p>
      </Card>

      <h2 className="text-base font-semibold text-slate-900">Backups per school</h2>
      {data.per_school.length === 0 ? (
        <EmptyState title="No per-school backups" body="No backups recorded yet for any school." />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3">School</th>
                  <th className="px-4 py-3">Last backup</th>
                  <th className="px-4 py-3">Size</th>
                </tr>
              </thead>
              <tbody>
                {data.per_school.map((b) => (
                  <tr key={b.school_id} className="border-b border-slate-100">
                    <td className="px-4 py-3 font-medium text-slate-900">{b.school_name ?? b.school_id}</td>
                    <td className="px-4 py-3 text-slate-600">{b.last_backup_at ? fmtDateTime(b.last_backup_at) : 'No backups recorded yet'}</td>
                    <td className="px-4 py-3 text-slate-600">{fmtBytes(b.size_bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
