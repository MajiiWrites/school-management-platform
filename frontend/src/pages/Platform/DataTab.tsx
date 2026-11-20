// Data tab — read-only cross-school data browser (school picker →
// entity picker → table + CSV / full-JSON export), the cross-school
// Recycle Bin, and the audit log viewer. No editors here: the links
// out go to the existing school flows.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PLATFORM_DATA_ENTITIES, platformApi, type PlatformAuditRow, type PlatformDataEntity, type PlatformRecycleRow, type PlatformSchool } from '../../lib/platform';
import { fmtDateTime } from '../../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Pager, Spinner, inputCls, useToast } from '../../components/ui';
import ConfirmDialog from '../../components/ConfirmDialog';
import { TypedConfirmDialog, cellValue, columnsFor, errText } from './shared';

const ENTITY_LABELS: Record<PlatformDataEntity, string> = {
  students: 'Students',
  classes: 'Classes',
  fees: 'Fees',
  messages: 'Messages',
  admissions: 'Admissions',
  homework: 'Homework',
  programs: 'Programs',
};

export default function DataTab() {
  const { push, view } = useToast();
  // --- data browser ---
  const [schools, setSchools] = useState<PlatformSchool[]>([]);
  const [schoolId, setSchoolId] = useState('');
  const [entity, setEntity] = useState<PlatformDataEntity>('students');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exportBusy, setExportBusy] = useState(false);

  // --- recycle bin ---
  const [binSchool, setBinSchool] = useState('');
  const [binEntity, setBinEntity] = useState('');
  const [binPage, setBinPage] = useState(1);
  const [binRows, setBinRows] = useState<PlatformRecycleRow[]>([]);
  const [binTotal, setBinTotal] = useState(0);
  const [binPages, setBinPages] = useState(1);
  const [binLoading, setBinLoading] = useState(true);
  const [binError, setBinError] = useState('');
  const [binBusyId, setBinBusyId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<PlatformRecycleRow | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<PlatformRecycleRow | null>(null);

  // --- audit log ---
  const [auditSchool, setAuditSchool] = useState('');
  const [auditUser, setAuditUser] = useState('');
  const [auditAction, setAuditAction] = useState('');
  const [auditFrom, setAuditFrom] = useState('');
  const [auditTo, setAuditTo] = useState('');
  const [auditPage, setAuditPage] = useState(1);
  const [auditRows, setAuditRows] = useState<PlatformAuditRow[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPages, setAuditPages] = useState(1);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditError, setAuditError] = useState('');

  const loadSchools = useCallback(async () => {
    try {
      const d = await platformApi.listSchools({ limit: 100 });
      setSchools(d.items);
    } catch (e) {
      push('error', errText(e));
    }
  }, [push]);

  const loadData = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    try {
      const d = await platformApi.listSchoolData(schoolId, entity, { search: search || undefined, page, limit: 20 });
      setRows(d.items);
      setTotal(d.total);
      setPages(d.pages);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [schoolId, entity, search, page]);

  const loadBin = useCallback(async () => {
    setBinLoading(true);
    setBinError('');
    try {
      const d = await platformApi.listRecycleBin({
        school_id: binSchool || undefined,
        entity: binEntity || undefined,
        page: binPage,
        limit: 20,
      });
      setBinRows(d.items);
      setBinTotal(d.total);
      setBinPages(d.pages);
    } catch (e) {
      setBinError(errText(e));
    } finally {
      setBinLoading(false);
    }
  }, [binSchool, binEntity, binPage]);

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    setAuditError('');
    try {
      const d = await platformApi.listAuditLogs({
        school_id: auditSchool || undefined,
        user_id: auditUser || undefined,
        action: auditAction || undefined,
        from: auditFrom || undefined,
        to: auditTo || undefined,
        page: auditPage,
        limit: 20,
      });
      setAuditRows(d.items);
      setAuditTotal(d.total);
      setAuditPages(d.pages);
    } catch (e) {
      setAuditError(errText(e));
    } finally {
      setAuditLoading(false);
    }
  }, [auditSchool, auditUser, auditAction, auditFrom, auditTo, auditPage]);

  useEffect(() => {
    void loadSchools();
  }, [loadSchools]);
  useEffect(() => {
    void loadData();
  }, [loadData]);
  useEffect(() => {
    void loadBin();
  }, [loadBin]);
  useEffect(() => {
    void loadAudit();
  }, [loadAudit]);

  const schoolName = schools.find((s) => s.id === schoolId)?.name ?? schoolId;

  const exportCsv = async () => {
    if (!schoolId) return;
    setExportBusy(true);
    try {
      await platformApi.exportSchoolDataCsv(schoolId, entity, `${schoolName}-${entity}.csv`);
      push('success', 'CSV export started.');
    } catch (e) {
      push('error', errText(e));
    } finally {
      setExportBusy(false);
    }
  };

  const exportJson = async () => {
    if (!schoolId) return;
    setExportBusy(true);
    try {
      await platformApi.exportSchoolJson(schoolId, `${schoolName}-full-export.json`);
      push('success', 'Full JSON export started.');
    } catch (e) {
      push('error', errText(e));
    } finally {
      setExportBusy(false);
    }
  };

  const doRestore = async () => {
    if (!restoreTarget) return;
    setBinBusyId(restoreTarget.id);
    try {
      await platformApi.restoreRecycle(restoreTarget.id);
      push('success', `Restored ${restoreTarget.entity} ${restoreTarget.entity_id.slice(0, 8)}.`);
      setRestoreTarget(null);
      await loadBin();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBinBusyId(null);
    }
  };

  const doPurge = async (typed: string) => {
    if (!purgeTarget) return;
    setBinBusyId(purgeTarget.id);
    try {
      await platformApi.permanentDeleteRecycle(purgeTarget.id, typed);
      push('success', `Permanently deleted ${purgeTarget.entity} ${purgeTarget.entity_id.slice(0, 8)}.`);
      setPurgeTarget(null);
      await loadBin();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBinBusyId(null);
    }
  };

  const cols = columnsFor(rows);
  const schoolOptions = schools;

  return (
    <div className="space-y-8">
      {/* ---- read-only data browser ---- */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold text-slate-900">School data (read-only)</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="School">
            <select
              className={inputCls}
              value={schoolId}
              onChange={(e) => { setSchoolId(e.target.value); setPage(1); }}
              aria-label="Pick a school"
            >
              <option value="">Pick a school…</option>
              {schoolOptions.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Data">
            <select
              className={inputCls}
              value={entity}
              onChange={(e) => { setEntity(e.target.value as PlatformDataEntity); setPage(1); }}
              aria-label="Pick a data type"
            >
              {PLATFORM_DATA_ENTITIES.map((en) => (
                <option key={en} value={en}>{ENTITY_LABELS[en]}</option>
              ))}
            </select>
          </Field>
          <Field label="Search">
            <input className={inputCls} value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search this data" aria-label="Search school data" />
          </Field>
          <div className="flex items-end gap-2">
            <Button variant="secondary" disabled={!schoolId || exportBusy} onClick={() => void exportCsv()}>Export CSV</Button>
            <Button variant="secondary" disabled={!schoolId || exportBusy} onClick={() => void exportJson()}>Full JSON export</Button>
          </div>
        </div>
        {!schoolId ? (
          <EmptyState title="Pick a school to browse its data" body="Data is read-only here. To edit, open the school's own pages from its dashboard." />
        ) : (
          <>
            {error && <ErrorBanner message={error} onRetry={loadData} />}
            {loading ? (
              <Spinner label="Loading school data…" />
            ) : rows.length === 0 ? (
              <EmptyState title={`No ${ENTITY_LABELS[entity].toLowerCase()} found`} body="This school has no rows of this type yet, or nothing matches the search." />
            ) : (
              <>
                <Pager page={page} pages={pages} total={total} itemLabel={ENTITY_LABELS[entity].toLowerCase()} onPage={setPage} />
                <Card>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] text-left text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                          {cols.map((c) => (
                            <th key={c} className="px-4 py-3">{c.replace(/_/g, ' ')}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={String(r.id ?? i)} className="border-b border-slate-100">
                            {cols.map((c) => (
                              <td key={c} className="max-w-[220px] truncate px-4 py-3 text-slate-700" title={cellValue(r[c])}>
                                {cellValue(r[c])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
                <p className="text-xs text-slate-500">
                  Read-only view. To edit, use the school&apos;s own pages: <Link to="/students" className="font-medium text-brand-700 hover:underline">Students</Link>, <Link to="/classes" className="font-medium text-brand-700 hover:underline">Classes</Link>, <Link to="/fees" className="font-medium text-brand-700 hover:underline">Fees</Link>, <Link to="/messages" className="font-medium text-brand-700 hover:underline">Messages</Link>.
                </p>
              </>
            )}
          </>
        )}
      </section>

      {/* ---- cross-school recycle bin ---- */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold text-slate-900">Recycle Bin (all schools)</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="School">
            <select className={inputCls} value={binSchool} onChange={(e) => { setBinSchool(e.target.value); setBinPage(1); }} aria-label="Recycle Bin school filter">
              <option value="">All schools</option>
              {schoolOptions.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Entity">
            <select className={inputCls} value={binEntity} onChange={(e) => { setBinEntity(e.target.value); setBinPage(1); }} aria-label="Recycle Bin entity filter">
              <option value="">All types</option>
              {['class', 'student', 'fee_record', 'exam', 'result', 'result_sheet', 'message_template', 'message_draft'].map((en) => (
                <option key={en} value={en}>{en.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </Field>
        </div>
        {binError && <ErrorBanner message={binError} onRetry={loadBin} />}
        {binLoading ? (
          <Spinner label="Loading the Recycle Bin…" />
        ) : binRows.length === 0 ? (
          <EmptyState title="Recycle Bin is empty" body="Nothing deleted across schools — or everything deleted more than 30 days ago is already gone." />
        ) : (
          <>
            <Pager page={binPage} pages={binPages} total={binTotal} itemLabel="deleted items" itemLabelSingular="deleted item" onPage={setBinPage} />
            <div className="space-y-3">
              {binRows.map((r) => (
                <Card key={r.id} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="slate">{r.entity.replace(/_/g, ' ')}</Badge>
                        {r.school_name && <Badge tone="blue">{r.school_name}</Badge>}
                        {r.restore_by && <span className="text-xs text-slate-500">Restore by {fmtDateTime(r.restore_by)}</span>}
                      </div>
                      <p className="mt-2 text-sm font-medium text-slate-900">{r.entity} · {r.entity_id}</p>
                      <p className="mt-0.5 text-xs text-slate-500">Deleted {fmtDateTime(r.deleted_at)}</p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button variant="secondary" disabled={binBusyId === r.id} onClick={() => setRestoreTarget(r)}>Restore</Button>
                      <Button variant="danger" disabled={binBusyId === r.id} onClick={() => setPurgeTarget(r)}>Delete permanently</Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </>
        )}
      </section>

      {/* ---- audit log ---- */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold text-slate-900">Audit log</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="School">
            <select className={inputCls} value={auditSchool} onChange={(e) => { setAuditSchool(e.target.value); setAuditPage(1); }} aria-label="Audit log school filter">
              <option value="">All schools</option>
              {schoolOptions.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="User ID">
            <input className={inputCls} value={auditUser} onChange={(e) => { setAuditUser(e.target.value); setAuditPage(1); }} placeholder="User ID" aria-label="Audit log user filter" />
          </Field>
          <Field label="Action">
            <input className={inputCls} value={auditAction} onChange={(e) => { setAuditAction(e.target.value); setAuditPage(1); }} placeholder="e.g. school.delete" aria-label="Audit log action filter" />
          </Field>
          <Field label="From">
            <input type="date" className={inputCls} value={auditFrom} onChange={(e) => { setAuditFrom(e.target.value); setAuditPage(1); }} aria-label="Audit log from date" />
          </Field>
          <Field label="To">
            <input type="date" className={inputCls} value={auditTo} onChange={(e) => { setAuditTo(e.target.value); setAuditPage(1); }} aria-label="Audit log to date" />
          </Field>
        </div>
        {auditError && <ErrorBanner message={auditError} onRetry={loadAudit} />}
        {auditLoading ? (
          <Spinner label="Loading audit log…" />
        ) : auditRows.length === 0 ? (
          <EmptyState title="No audit entries found" body="Nothing matches these filters yet." />
        ) : (
          <>
            <Pager page={auditPage} pages={auditPages} total={auditTotal} itemLabel="audit entries" itemLabelSingular="audit entry" onPage={setAuditPage} />
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-4 py-3">When</th>
                      <th className="px-4 py-3">Action</th>
                      <th className="px-4 py-3">Source</th>
                      <th className="px-4 py-3">School / User</th>
                      <th className="px-4 py-3">Entity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditRows.map((a) => (
                      <tr key={a.id} className="border-b border-slate-100">
                        <td className="px-4 py-3 text-slate-600">{fmtDateTime(a.created_at)}</td>
                        <td className="px-4 py-3 font-medium text-slate-900">{a.action}</td>
                        <td className="px-4 py-3">
                          <Badge tone={a.source === 'platform' ? 'blue' : 'slate'}>{a.source ?? '—'}</Badge>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{a.school_name ?? a.school_id ?? '—'} · {a.actor_email ?? a.user_id ?? '—'}</td>
                        <td className="px-4 py-3 text-slate-600">{a.entity ?? '—'} {a.entity_id ? `· ${String(a.entity_id).slice(0, 8)}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </section>

      <ConfirmDialog
        open={restoreTarget !== null}
        title="Restore this item?"
        message={restoreTarget ? `Restore ${restoreTarget.entity} ${restoreTarget.entity_id} to ${restoreTarget.school_name ?? 'its school'}?` : ''}
        confirmLabel="Restore"
        tone="primary"
        busy={binBusyId !== null}
        onConfirm={() => void doRestore()}
        onCancel={() => setRestoreTarget(null)}
      />
      <TypedConfirmDialog
        open={purgeTarget !== null}
        title="Permanently delete this item?"
        message={purgeTarget ? `This permanently deletes ${purgeTarget.entity} ${purgeTarget.entity_id}. It can never be restored.` : ''}
        expected={purgeTarget ? `${purgeTarget.entity}:${purgeTarget.entity_id}` : ''}
        inputLabel="Type entity:entityId to confirm"
        confirmLabel="Delete permanently"
        busy={binBusyId !== null}
        onConfirm={(typed) => void doPurge(typed)}
        onCancel={() => setPurgeTarget(null)}
      />
      {view}
    </div>
  );
}
