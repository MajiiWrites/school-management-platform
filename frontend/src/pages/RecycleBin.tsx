/**
 * Recycle Bin page (D1, admin only).
 *
 * The backend soft-deletes classes, students, fee records, exams, results
 * and result sheets (GET /recycle-bin, admin only): a deleted row stays
 * restorable for 30 days, then it is gone. This page is the UI the Phase 9
 * inspection found missing — it lists everything in the bin with its
 * restore deadline, restores in one click, and permanently deletes only
 * after a SECOND confirmation (the API also requires {confirm: true}).
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { DeletedRecord, PageResult } from '../lib/types';
import { fmtDate, fmtDateTime } from '../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Spinner, Tabs, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

/** Soft-deletable entity types the backend supports (hardening/helpers.ts). */
const ENTITY_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'class', label: 'Classes' },
  { key: 'student', label: 'Students' },
  { key: 'fee_record', label: 'Fee records' },
  { key: 'exam', label: 'Exams' },
  { key: 'result', label: 'Results' },
  { key: 'result_sheet', label: 'Result sheets' },
] as const;

const ENTITY_LABELS: Record<string, string> = {
  class: 'Class',
  student: 'Student',
  fee_record: 'Fee record',
  exam: 'Exam',
  result: 'Result',
  result_sheet: 'Result sheet',
  message_template: 'Message template',
  message_draft: 'Message draft',
  academic_session: 'School year',
  exam_datesheet: 'Exam datesheet',
  timetable_entry: 'Timetable entry',
  staff: 'Staff member',
};

/** Entities the backend can actually restore (hardening/recycleBin.ts).
 * Everything else lands in the bin when it is deleted, but the backend
 * has no way to rebuild it — Round 5 (F4): instead of a Restore button
 * that always fails ("Entity cannot be restored: message_template"),
 * those rows show plain words explaining that they can't be restored.
 * The raw entity key (message_template) must never reach the user. */
const RESTORABLE = new Set([
  'class',
  'student',
  'fee_record',
  'exam',
  'result',
  'result_sheet',
  'message_template',
]);

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

/** Human summary of a deleted row, read from its snapshot. */
function describe(r: DeletedRecord): string {
  const s = r.snapshot ?? {};
  switch (r.entity) {
    case 'class':
      return `Class ${str(s.name)}-${str(s.section)}${str(s.teacherName) ? ` · ${str(s.teacherName)}` : ''}`;
    case 'student':
      return `${str(s.name) || 'Student'}${s.rollNo !== null && s.rollNo !== undefined ? ` · Roll ${String(s.rollNo)}` : ''}${str(s.admissionNo) ? ` · Adm ${str(s.admissionNo)}` : ''}`;
    case 'fee_record':
      return `Fee record · ${str(s.month) || 'unknown month'}`;
    case 'exam':
      return str(s.title) || str(s.name) || 'Exam';
    case 'result':
      return `${str(s.studentName) || 'Result'}${s.rollNo !== null && s.rollNo !== undefined ? ` · Roll ${String(s.rollNo)}` : ''}`;
    case 'result_sheet':
      return str(s.title) || 'Result sheet';
    case 'message_template':
      // Snapshot shape is the camelCase mapTemplateRow row (name, type,
      // language, body) — see hardening/recycleBin.ts.
      return `Message template “${str(s.name) || str(s.type) || 'template'}”${str(s.type) ? ` · ${str(s.type)}` : ''}${str(s.language) ? ` · ${str(s.language)}` : ''}`;
    case 'message_draft':
      return `Message draft${str(s.title) ? ` — ${str(s.title)}` : ''}`;
    case 'academic_session':
      return `School year ${str(s.name) || str(s.title) || ''}`.trim();
    case 'exam_datesheet':
      return `Exam datesheet${str(s.title) ? ` — ${str(s.title)}` : ''}`;
    case 'timetable_entry':
      return `Timetable entry${str(s.title) ? ` — ${str(s.title)}` : ''}`;
    case 'staff':
      return `Staff member ${str(s.name) || ''}`.trim();
    default:
      return `${ENTITY_LABELS[r.entity] ?? 'Deleted item'} ${r.entity_id.slice(0, 8)}`;
  }
}

/** Whole days left until the restore deadline (negative = expired). */
function daysLeft(r: DeletedRecord): number | null {
  if (!r.restore_by) return null;
  return Math.floor((new Date(r.restore_by).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

export default function RecycleBinPage() {
  const { push, view } = useToast();
  const [entity, setEntity] = useState<string>('all');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<DeletedRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  // Permanent delete is a TWO-step confirmation: the first dialog warns,
  // the second is the explicit "this cannot be undone" step.
  const [purgeStep1, setPurgeStep1] = useState<DeletedRecord | null>(null);
  const [purgeStep2, setPurgeStep2] = useState<DeletedRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = `?page=${page}&limit=20${entity !== 'all' ? `&entity=${entity}` : ''}`;
      const data = await api<PageResult<DeletedRecord>>(`/recycle-bin${qs}`);
      setRows(data.items);
      setTotal(data.total);
      setPages(data.pages);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }, [entity, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (r: DeletedRecord) => {
    setBusyId(r.id);
    try {
      await api(`/recycle-bin/${r.id}/restore`, { method: 'POST' });
      push('success', `Restored: ${describe(r)}.`);
      await load();
    } catch (err) {
      push('error', errText(err));
    } finally {
      setBusyId(null);
    }
  };

  const purge = async (r: DeletedRecord) => {
    setBusyId(r.id);
    try {
      await api(`/recycle-bin/${r.id}/permanent-delete`, { method: 'POST', body: { confirm: true } });
      push('success', `Permanently deleted: ${describe(r)}.`);
      await load();
    } catch (err) {
      push('error', errText(err));
    } finally {
      setBusyId(null);
      setPurgeStep2(null);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Recycle Bin</h1>
        <p className="text-sm text-slate-500">
          Deleted classes, students, fee records, exams and results stay here for 30 days. Restore them any time
          before the deadline — after that they are gone for good.
        </p>
      </div>

      <Tabs
        tabs={ENTITY_FILTERS.map((f) => ({ key: f.key, label: f.label }))}
        active={entity}
        onChange={(k) => {
          setEntity(k);
          setPage(1);
        }}
      />

      {error && <ErrorBanner message={error} onRetry={load} />}
      {loading ? (
        <Spinner label="Loading the Recycle Bin…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Recycle Bin is empty"
          body="Nothing has been deleted — or everything deleted more than 30 days ago is already gone."
        />
      ) : (
        <>
          <p className="text-sm text-slate-500">
            {total} deleted item{total === 1 ? '' : 's'} · Page {page} of {pages}
          </p>
          <div className="space-y-3">
            {rows.map((r) => {
              const left = daysLeft(r);
              return (
                <Card key={r.id} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="slate">{ENTITY_LABELS[r.entity] ?? 'Deleted item'}</Badge>
                        {left === null ? null : left < 0 ? (
                          <Badge tone="red">Restore window expired</Badge>
                        ) : left <= 7 ? (
                          <Badge tone="amber">{left === 0 ? 'Last day to restore' : `${left} day${left === 1 ? '' : 's'} left to restore`}</Badge>
                        ) : (
                          <Badge tone="green">{left} days left to restore</Badge>
                        )}
                      </div>
                      <p className="mt-2 font-medium text-slate-900">{describe(r)}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        Deleted {fmtDateTime(r.deleted_at)}
                        {r.restore_by ? ` · Restore by ${fmtDate(r.restore_by)}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {RESTORABLE.has(r.entity) ? (
                        <Button
                          variant="secondary"
                          disabled={busyId === r.id || (left !== null && left < 0)}
                          onClick={() => restore(r)}
                        >
                          {busyId === r.id ? 'Working…' : 'Restore'}
                        </Button>
                      ) : (
                        <span className="inline-flex min-h-11 items-center px-3 py-2 text-sm text-slate-500">
                          Can’t be restored — only kept here for the record
                        </span>
                      )}
                      <Button variant="danger" disabled={busyId === r.id} onClick={() => setPurgeStep1(r)}>
                        Delete permanently
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>

          <div className="flex items-center justify-between">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              ← Previous
            </Button>
            <span className="text-sm text-slate-500">
              Page {page} of {pages}
            </span>
            <Button variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>
              Next →
            </Button>
          </div>
        </>
      )}

      {/* Permanent delete, step 1: warn + offer restore instead. */}
      <ConfirmDialog
        open={purgeStep1 !== null}
        title="Permanently delete this item?"
        message={
          purgeStep1
            ? `This will permanently delete ${describe(purgeStep1)} from the Recycle Bin. It can never be restored after this. If you might need it, Restore it instead.`
            : ''
        }
        confirmLabel="Continue to permanent delete"
        tone="danger"
        onConfirm={() => {
          setPurgeStep2(purgeStep1);
          setPurgeStep1(null);
        }}
        onCancel={() => setPurgeStep1(null)}
      />
      {/* Permanent delete, step 2: the second confirmation the API requires. */}
      <ConfirmDialog
        open={purgeStep2 !== null}
        title="Are you absolutely sure?"
        message={
          purgeStep2
            ? `Final confirmation: permanently delete ${describe(purgeStep2)}? This cannot be undone — the record and its backup snapshot are deleted immediately.`
            : ''
        }
        confirmLabel="Yes, permanently delete"
        tone="danger"
        busy={busyId !== null}
        onConfirm={() => {
          const r = purgeStep2;
          if (r) void purge(r);
        }}
        onCancel={() => setPurgeStep2(null)}
      />
      {view}
    </div>
  );
}
