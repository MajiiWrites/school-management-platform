// Schools tab — list + filters, detail view, Suspend / Activate,
// and Delete ONLY via a typed confirmation (exact school name, sent
// as the backend `confirm` field).
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { platformApi, type PlatformSchool } from '../../lib/platform';
import { fmtDateTime } from '../../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Pager, Spinner, inputCls, useToast } from '../../components/ui';
import ConfirmDialog from '../../components/ConfirmDialog';
import { TypedConfirmDialog, errText } from './shared';

export default function SchoolsTab() {
  const { push, view } = useToast();
  const [search, setSearch] = useState('');
  const [orgType, setOrgType] = useState('');
  const [province, setProvince] = useState('');
  const [category, setCategory] = useState('');
  const [verified, setVerified] = useState('');
  const [suspended, setSuspended] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<PlatformSchool[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<PlatformSchool | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [suspendTarget, setSuspendTarget] = useState<PlatformSchool | null>(null);
  const [activateTarget, setActivateTarget] = useState<PlatformSchool | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PlatformSchool | null>(null);
  const [auditNote, setAuditNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await platformApi.listSchools({
        search: search || undefined,
        org_type: orgType || undefined,
        province: province || undefined,
        category: category || undefined,
        verified: verified || undefined,
        suspended: suspended || undefined,
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
  }, [search, orgType, province, category, verified, suspended, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (s: PlatformSchool) => {
    setSelected(s);
    setAuditNote('');
    setDetailLoading(true);
    try {
      const d = await platformApi.getSchool(s.id);
      setSelected(d);
    } catch (e) {
      push('error', errText(e));
    } finally {
      setDetailLoading(false);
    }
  };

  const refreshDetail = async (id: string) => {
    try {
      const d = await platformApi.getSchool(id);
      setSelected(d);
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...d } : r)));
    } catch {
      await load();
    }
  };

  const doSuspend = async () => {
    if (!suspendTarget) return;
    setBusy(true);
    try {
      await platformApi.suspendSchool(suspendTarget.id);
      push('success', `Suspended ${suspendTarget.name}. Its logins are blocked until it is activated again.`);
      setSuspendTarget(null);
      await refreshDetail(suspendTarget.id);
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const doActivate = async () => {
    if (!activateTarget) return;
    setBusy(true);
    try {
      await platformApi.activateSchool(activateTarget.id);
      push('success', `Activated ${activateTarget.name}.`);
      setActivateTarget(null);
      await refreshDetail(activateTarget.id);
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (typed: string) => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      const res = await platformApi.deleteSchool(deleteTarget.id, typed);
      const name = deleteTarget.name;
      setDeleteTarget(null);
      setSelected(null);
      setAuditNote(
        res?.message ??
          `Deleted school “${name}”. This action was recorded in the audit log — see the Data tab → Audit log.`,
      );
      push('success', `Deleted school “${name}”.`);
      await load();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {auditNote && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{auditNote}</div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Search schools">
          <input className={inputCls} value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Name, slug or admin email" aria-label="Search schools" />
        </Field>
        <Field label="Organisation type">
          <select className={inputCls} value={orgType} onChange={(e) => { setOrgType(e.target.value); setPage(1); }} aria-label="Filter by organisation type">
            <option value="">All types</option>
            <option value="School">School</option>
            <option value="College">College</option>
          </select>
        </Field>
        <Field label="Province">
          <input className={inputCls} value={province} onChange={(e) => { setProvince(e.target.value); setPage(1); }} placeholder="e.g. Punjab" aria-label="Filter by province" />
        </Field>
        <Field label="Category">
          <input className={inputCls} value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} placeholder="e.g. Private" aria-label="Filter by category" />
        </Field>
        <Field label="Verification">
          <select className={inputCls} value={verified} onChange={(e) => { setVerified(e.target.value); setPage(1); }} aria-label="Filter by verification">
            <option value="">All</option>
            <option value="true">Verified</option>
            <option value="false">Unverified</option>
          </select>
        </Field>
        <Field label="Status">
          <select className={inputCls} value={suspended} onChange={(e) => { setSuspended(e.target.value); setPage(1); }} aria-label="Filter by suspended status">
            <option value="">All</option>
            <option value="true">Suspended</option>
            <option value="false">Active</option>
          </select>
        </Field>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}
      {loading ? (
        <Spinner label="Loading schools…" />
      ) : rows.length === 0 ? (
        <EmptyState title="No schools found" body="Try widening the search or clearing a filter." />
      ) : (
        <>
          <Pager page={page} pages={pages} total={total} itemLabel="schools" itemLabelSingular="school" onPage={setPage} />
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">School</th>
                    <th className="px-4 py-3">Type / Province</th>
                    <th className="px-4 py-3">Counts</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id} className="cursor-pointer border-b border-slate-100 hover:bg-slate-50" onClick={() => void openDetail(s)}>
                      <td className="px-4 py-3 font-medium text-slate-900">{s.name}</td>
                      <td className="px-4 py-3 text-slate-600">
                        {s.org_type ?? '—'} · {s.province ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {s.student_count ?? '—'} students · {s.user_count ?? '—'} users
                      </td>
                      <td className="px-4 py-3">
                        <span className="flex flex-wrap gap-1">
                          {s.suspended ? <Badge tone="red">Suspended</Badge> : <Badge tone="green">Active</Badge>}
                          {s.verified === true ? <Badge tone="green">Verified</Badge> : s.verified === false ? <Badge tone="amber">Unverified</Badge> : null}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{s.created_at ? fmtDateTime(s.created_at) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {selected && (
        <Card className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">{selected.name}</h2>
              <p className="text-sm text-slate-500">
                {selected.org_type ?? ''} {selected.category ? `· ${selected.category}` : ''} {selected.district ? `· ${selected.district}` : ''} {selected.tehsil ? `· ${selected.tehsil}` : ''}
              </p>
            </div>
            <Button variant="secondary" onClick={() => setSelected(null)}>Close</Button>
          </div>
          {detailLoading ? (
            <Spinner label="Loading school details…" />
          ) : (
            <>
              <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
                <div><dt className="text-slate-500">Admin</dt><dd className="font-medium text-slate-900">{selected.admin_name ?? '—'} {selected.admin_email ? `(${selected.admin_email})` : ''}</dd></div>
                <div><dt className="text-slate-500">Admin phone</dt><dd className="font-medium text-slate-900">{selected.admin_phone_masked ?? '—'}</dd></div>
                <div><dt className="text-slate-500">Address</dt><dd className="font-medium text-slate-900">{selected.address ?? '—'}</dd></div>
                <div><dt className="text-slate-500">Students / Users</dt><dd className="font-medium text-slate-900">{selected.student_count ?? '—'} / {selected.user_count ?? '—'}</dd></div>
                <div><dt className="text-slate-500">Email verified</dt><dd className="font-medium text-slate-900">{selected.verified === true ? 'Yes' : selected.verified === false ? 'No' : 'Unknown'}</dd></div>
                <div><dt className="text-slate-500">Mail status</dt><dd className="font-medium text-slate-900">{typeof selected.email_verification_status === 'string' ? String(selected.email_verification_status) : 'Unknown'}</dd></div>
              </dl>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link to="/dashboard" className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                  Open school dashboard →
                </Link>
                {selected.suspended ? (
                  <Button variant="success" disabled={busy} onClick={() => setActivateTarget(selected)}>Activate school</Button>
                ) : (
                  <Button variant="secondary" disabled={busy} onClick={() => setSuspendTarget(selected)}>Suspend school</Button>
                )}
                <Button variant="danger" disabled={busy} onClick={() => setDeleteTarget(selected)}>Delete school…</Button>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Suspending blocks the school&apos;s logins until it is activated again. Deleting is permanent and
                requires typing the exact school name.
              </p>
            </>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={suspendTarget !== null}
        title="Suspend this school?"
        message={suspendTarget ? `Suspending ${suspendTarget.name} blocks its logins until it is activated again. Students, fees and messages stay stored.` : ''}
        confirmLabel="Suspend school"
        tone="danger"
        busy={busy}
        onConfirm={() => void doSuspend()}
        onCancel={() => setSuspendTarget(null)}
      />
      <ConfirmDialog
        open={activateTarget !== null}
        title="Activate this school?"
        message={activateTarget ? `Activating ${activateTarget.name} restores its logins.` : ''}
        confirmLabel="Activate school"
        tone="primary"
        busy={busy}
        onConfirm={() => void doActivate()}
        onCancel={() => setActivateTarget(null)}
      />
      <TypedConfirmDialog
        open={deleteTarget !== null}
        title="Delete this school permanently?"
        message={deleteTarget ? `This permanently deletes ${deleteTarget.name} and all of its data. This cannot be undone.` : ''}
        expected={deleteTarget?.name ?? ''}
        inputLabel="Type the exact school name to confirm"
        confirmLabel="Delete school permanently"
        busy={busy}
        onConfirm={(typed) => void doDelete(typed)}
        onCancel={() => setDeleteTarget(null)}
      />
      {view}
    </div>
  );
}
