// Messaging tab — cross-school message queue (held / approved /
// queued / sent / failed) with Retry on failed rows, the failed list,
// and the mail health panel with the backend's honest note.
import { useCallback, useEffect, useState } from 'react';
import { platformApi, type PlatformMailHealth, type PlatformQueueRow } from '../../lib/platform';
import { fmtDateTime } from '../../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Pager, Spinner, inputCls, useToast } from '../../components/ui';
import { errText } from './shared';

const STATUS_TONES: Record<string, 'green' | 'amber' | 'red' | 'slate' | 'blue'> = {
  sent: 'green',
  approved: 'blue',
  queued: 'slate',
  held: 'amber',
  failed: 'red',
};

function asItems(v: { items: PlatformQueueRow[] } | PlatformQueueRow[]): PlatformQueueRow[] {
  return Array.isArray(v) ? v : (v.items ?? []);
}

export default function MessagingTab() {
  const { push, view } = useToast();
  const [status, setStatus] = useState('');
  const [schoolId, setSchoolId] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<PlatformQueueRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryBusyId, setRetryBusyId] = useState<string | null>(null);

  const [failed, setFailed] = useState<PlatformQueueRow[]>([]);
  const [failedError, setFailedError] = useState('');

  const [mail, setMail] = useState<PlatformMailHealth | null>(null);
  const [mailError, setMailError] = useState('');
  const [mailLoading, setMailLoading] = useState(true);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await platformApi.listMessageQueue({
        status: status || undefined,
        school_id: schoolId || undefined,
        page,
        limit: 20,
      });
      setRows(d.items);
      setTotal(d.total);
      setPages(d.pages);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [status, schoolId, page]);

  const loadFailed = useCallback(async () => {
    try {
      const d = await platformApi.listFailedMessages();
      setFailed(asItems(d));
      setFailedError('');
    } catch (e) {
      setFailedError(errText(e));
    }
  }, []);

  const loadMail = useCallback(async () => {
    setMailLoading(true);
    setMailError('');
    try {
      const d = await platformApi.getMailHealth();
      setMail(d);
    } catch (e) {
      setMailError(errText(e));
    } finally {
      setMailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);
  useEffect(() => {
    void loadFailed();
  }, [loadFailed]);
  useEffect(() => {
    void loadMail();
  }, [loadMail]);

  const retry = async (id: string) => {
    setRetryBusyId(id);
    try {
      await platformApi.retryQueuedMessage(id);
      push('success', 'Message queued for retry.');
      await loadQueue();
      await loadFailed();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setRetryBusyId(null);
    }
  };

  const queueRow = (r: PlatformQueueRow, showRetry: boolean) => (
    <tr key={r.id} className="border-b border-slate-100">
      <td className="px-4 py-3 text-slate-600">{fmtDateTime(r.created_at)}</td>
      <td className="px-4 py-3 text-slate-600">{r.school_name ?? r.school_id ?? '—'}</td>
      <td className="px-4 py-3 text-slate-600">{r.student_name ?? '—'} · {r.parent_phone_masked ?? '—'}</td>
      <td className="max-w-[280px] truncate px-4 py-3 text-slate-700" title={r.body ?? ''}>{r.body ?? '—'}</td>
      <td className="px-4 py-3">
        <Badge tone={STATUS_TONES[r.status] ?? 'slate'}>{r.status}</Badge>
        {r.error && <p className="mt-1 text-xs text-red-600">{r.error}</p>}
      </td>
      <td className="px-4 py-3">
        {showRetry && r.status === 'failed' && (
          <Button variant="secondary" disabled={retryBusyId === r.id} onClick={() => void retry(r.id)}>
            {retryBusyId === r.id ? 'Retrying…' : 'Retry'}
          </Button>
        )}
      </td>
    </tr>
  );

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-base font-semibold text-slate-900">Message queue</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Status">
            <select className={inputCls} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Filter queue by status">
              <option value="">All statuses</option>
              <option value="held">Held</option>
              <option value="approved">Approved</option>
              <option value="queued">Queued</option>
              <option value="sent">Sent</option>
              <option value="failed">Failed</option>
            </select>
          </Field>
          <Field label="School ID">
            <input className={inputCls} value={schoolId} onChange={(e) => { setSchoolId(e.target.value); setPage(1); }} placeholder="School ID" aria-label="Filter queue by school" />
          </Field>
        </div>
        {error && <ErrorBanner message={error} onRetry={loadQueue} />}
        {loading ? (
          <Spinner label="Loading message queue…" />
        ) : rows.length === 0 ? (
          <EmptyState title="Message queue is empty" body="Nothing matches these filters." />
        ) : (
          <>
            <Pager page={page} pages={pages} total={total} itemLabel="queued messages" itemLabelSingular="queued message" onPage={setPage} />
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-4 py-3">Queued</th>
                      <th className="px-4 py-3">School</th>
                      <th className="px-4 py-3">Recipient</th>
                      <th className="px-4 py-3">Message</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>{rows.map((r) => queueRow(r, true))}</tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-base font-semibold text-slate-900">Failed messages</h2>
        {failedError && <ErrorBanner message={failedError} onRetry={loadFailed} />}
        {failed.length === 0 ? (
          <EmptyState title="No failed messages" body="Nothing has failed recently." />
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">Queued</th>
                    <th className="px-4 py-3">School</th>
                    <th className="px-4 py-3">Recipient</th>
                    <th className="px-4 py-3">Message</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>{failed.map((r) => queueRow(r, true))}</tbody>
              </table>
            </div>
          </Card>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-base font-semibold text-slate-900">Mail health</h2>
        {mailLoading ? (
          <Spinner label="Loading mail health…" />
        ) : mailError ? (
          <ErrorBanner message={mailError} onRetry={loadMail} />
        ) : mail ? (
          <>
            <Card className="p-4">
              <p className="text-sm text-slate-700">
                Transport: <strong>{mail.transport}</strong> · Recent verification mail — Sent {mail.recent_verification_mail.sent} · Failed {mail.recent_verification_mail.failed} · Pending {mail.recent_verification_mail.pending}
              </p>
              {mail.recent_verification_mail.failed > 0 && (
                <p className="mt-1 text-sm font-medium text-red-600">
                  Mail is failing — {mail.recent_verification_mail.failed} recent verification email{mail.recent_verification_mail.failed === 1 ? '' : 's'} failed to send.
                </p>
              )}
              {mail.note && <p className="mt-2 text-sm text-slate-600">{mail.note}</p>}
            </Card>
            {mail.recent_failures.length > 0 && (
              <Card>
                <div className="border-b border-slate-200 px-5 py-3">
                  <h3 className="text-sm font-semibold">Recent failures</h3>
                </div>
                <ul className="divide-y divide-slate-100">
                  {mail.recent_failures.map((f, i) => (
                    <li key={`${f.email}-${i}`} className="px-5 py-3 text-sm">
                      <p className="font-medium text-slate-800">{f.email}</p>
                      <p className="text-xs text-red-600">{f.error}</p>
                      <p className="text-xs text-slate-400">{fmtDateTime(f.at)}</p>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        ) : (
          <EmptyState title="No mail health data" body="The mail health endpoint returned nothing." />
        )}
      </section>
      {view}
    </div>
  );
}
