/**
 * Approval Queue page (D2, admin only).
 *
 * Clerk creates/updates/deletes never apply directly — they land here as
 * approval_requests (GET /approvals, admin sees all). An admin approves
 * (POST /approvals/:id/approve — the payload is applied, e.g. the student
 * appears) or rejects (POST /approvals/:id/reject, optional reason).
 * Nothing is applied until an admin decides.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { PageResult } from '../lib/types';
import { fmtDateTime } from '../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Modal, Pager, Spinner, Tabs, useToast } from '../components/ui';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

export interface ApprovalRow {
  id: string;
  school_id: string;
  requested_by: string;
  action_type: string;
  entity: string;
  entity_id?: string | null;
  payload: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected';
  decided_by?: string | null;
  decided_at?: string | null;
  created_at: string;
  /** Returned by approve: what the applied payload produced (e.g. student_id). */
  applied?: Record<string, unknown>;
}

const FILTERS = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: '', label: 'All' },
] as const;

type FilterKey = (typeof FILTERS)[number]['key'];

/** Short human summary of a request: who, what action, which record. */
function describe(r: ApprovalRow): string {
  const p = r.payload ?? {};
  const name =
    (typeof p.name === 'string' && p.name) ||
    (typeof p.email === 'string' && p.email) ||
    (typeof p.student_name === 'string' && p.student_name) ||
    (typeof p.title === 'string' && p.title) ||
    '';
  const id = (typeof p.id === 'string' && p.id) || r.entity_id || '';
  return `${r.action_type} ${r.entity}${name ? ` — ${name}` : ''}${id ? ` (${id.slice(0, 8)})` : ''}`;
}

function statusTone(s: string): 'amber' | 'green' | 'red' | 'slate' {
  return s === 'pending' ? 'amber' : s === 'approved' ? 'green' : s === 'rejected' ? 'red' : 'slate';
}

export default function ApprovalsPage() {
  const { push, view } = useToast();
  const [filter, setFilter] = useState<FilterKey>('pending');
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [total, setTotal] = useState(0);
  // Round 5 (F1): server-side pagination — the queue fetched ?limit=50
  // with no pager, so requests past the first 50 were unreachable. The
  // backend already paginates (total/pages).
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [users, setUsers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<ApprovalRow | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [appliedNote, setAppliedNote] = useState<{ id: string; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = filter ? `?status=${filter}&page=${page}&limit=50` : `?page=${page}&limit=50`;
      const [data, u] = await Promise.all([
        api<PageResult<ApprovalRow>>(`/approvals${qs}`),
        api<PageResult<{ id: string; email: string }>>('/users').catch(() => ({ items: [] as { id: string; email: string }[], total: 0, page: 1, pages: 1 })),
      ]);
      setRows(data.items);
      setTotal(data.total);
      setPages(data.pages);
      setUsers(Object.fromEntries(u.items.map((x) => [x.id, x.email])));
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }, [filter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const approve = async (r: ApprovalRow) => {
    setBusyId(r.id);
    try {
      const res = await api<ApprovalRow>(`/approvals/${r.id}/approve`, { method: 'POST' });
      const applied = res.applied ? Object.entries(res.applied).map(([k, v]) => `${k}: ${String(v)}`).join(', ') : '';
      setAppliedNote({ id: r.id, text: applied ? `Approved and applied — ${applied}.` : 'Approved and applied.' });
      push('success', `Approved: ${describe(r)} — the change is now live.`);
      await load();
    } catch (err) {
      push('error', errText(err));
    } finally {
      setBusyId(null);
    }
  };

  const reject = async () => {
    if (!rejectTarget) return;
    const target = rejectTarget;
    setBusyId(target.id);
    try {
      await api(`/approvals/${target.id}/reject`, {
        method: 'POST',
        body: rejectReason.trim() ? { reason: rejectReason.trim() } : {},
      });
      push('success', `Rejected: ${describe(target)} — nothing was applied.`);
      setRejectTarget(null);
      setRejectReason('');
      await load();
    } catch (err) {
      push('error', errText(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Approval Queue</h1>
        <p className="text-sm text-slate-500">
          Clerk creates, updates and deletes wait here until an admin approves or rejects them. Approving applies the
          change (e.g. the student appears); rejecting applies nothing.
        </p>
      </div>

      <Tabs tabs={FILTERS.map((f) => ({ key: f.key, label: `${f.label}${f.key === filter ? ` (${total})` : ''}` }))} active={filter} onChange={(k) => { setFilter(k as FilterKey); setPage(1); }} />

      {error && <ErrorBanner message={error} onRetry={() => void load()} />}
      {loading ? (
        <Spinner label="Loading approval requests…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title={filter === 'pending' ? 'Nothing waiting for approval' : `No ${filter || 'all'} requests`}
          body={filter === 'pending' ? 'When a clerk submits a change, it appears here for you to approve or reject.' : 'No requests match this filter yet.'}
        />
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <Card key={r.id} className="p-5">
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-900">{describe(r)}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Requested by {users[r.requested_by] ?? r.requested_by} · {fmtDateTime(r.created_at)}
                    {r.decided_by ? ` · decided by ${users[r.decided_by] ?? r.decided_by}${r.decided_at ? ` ${fmtDateTime(r.decided_at)}` : ''}` : ''}
                  </p>
                </div>
                <Badge tone={statusTone(r.status)}>{r.status}</Badge>
              </div>

              <details className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                <summary className="cursor-pointer font-medium text-slate-700">Request details (payload)</summary>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(r.payload, null, 2)}</pre>
              </details>

              {appliedNote?.id === r.id && (
                <p className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm font-medium text-green-800">{appliedNote.text}</p>
              )}

              {r.status === 'pending' && (
                <div className="mt-4 flex gap-3">
                  <Button onClick={() => void approve(r)} disabled={busyId === r.id}>
                    {busyId === r.id ? 'Working…' : 'Approve'}
                  </Button>
                  <Button variant="danger" onClick={() => setRejectTarget(r)} disabled={busyId === r.id}>
                    Reject
                  </Button>
                </div>
              )}
              {r.status === 'approved' && (
                <p className="mt-3 text-sm text-green-700">Approved — the change was applied.</p>
              )}
              {r.status === 'rejected' && (
                <p className="mt-3 text-sm text-red-700">Rejected — nothing was applied; the record was not created, changed or deleted.</p>
              )}
            </Card>
          ))}
        </div>
      )}
      {rows.length > 0 && (
        <Pager page={page} pages={pages} total={total} itemLabel="requests" itemLabelSingular="request" onPage={setPage} />
      )}

      {rejectTarget && (
        <Modal title="Reject this request?" onClose={() => setRejectTarget(null)}>
          <p className="text-sm text-slate-600">
            {describe(rejectTarget)} — nothing will be applied. The clerk keeps their existing data; only this request
            is dropped.
          </p>
          <div className="mt-4">
            <Field label="Reason (optional — shown in the audit log)">
              <textarea className={inputCls} rows={3} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="e.g. Wrong class — resubmit for Class 5-B" />
            </Field>
          </div>
          <div className="mt-4 flex gap-3">
            <Button variant="danger" onClick={() => void reject()} disabled={busyId === rejectTarget.id}>
              {busyId === rejectTarget.id ? 'Rejecting…' : 'Reject request'}
            </Button>
            <Button variant="secondary" onClick={() => setRejectTarget(null)}>
              Cancel
            </Button>
          </div>
        </Modal>
      )}
      {view}
    </div>
  );
}
