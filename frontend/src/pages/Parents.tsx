import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiClientError, portalApi } from '../lib/api';
import type { PageResult, ParentTokenInfo, Student } from '../lib/types';
import { normalizePkPhone } from '../lib/utils';
import { Badge, Button, EmptyState, ErrorBanner, Field, inputCls, Modal, Pager, Spinner, Tabs, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';
import type { FormEvent } from 'react';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

interface ParentImportPreviewItem {
  row: number;
  status: 'ok' | 'duplicate' | 'invalid';
  reason: string | null;
  data: { admission_no?: string | null; student_name: string; parent_name?: string | null; parent_phone?: string | null };
  student_id: string | null;
  student_name: string | null;
}

interface ParentImportPreview {
  total: number;
  valid: number;
  duplicates_flagged: number;
  invalid_rows: Array<{ row: number; reason: string }>;
  preview: ParentImportPreviewItem[];
}

export default function ParentsPage() {
  const [flag, setFlag] = useState<'missing' | 'invalid' | 'duplicate'>('missing');
  const [students, setStudents] = useState<Student[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Student | null>(null);
  const [linkStudent, setLinkStudent] = useState<Student | null>(null);
  const { push, view } = useToast();
  // Phase 9 fix: bulk import of parent numbers (CSV/Excel) — same
  // preview-first pattern as the student import.
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingImport, setPendingImport] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ file: File; data: ParentImportPreview } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  const previewImport = async (file: File) => {
    setPreviewLoading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const data = await api<ParentImportPreview>('/parents/import-preview', { method: 'POST', body: form });
      setPreview({ file, data });
    } catch (e) {
      push('error', errText(e));
    } finally {
      setPreviewLoading(false);
    }
  };

  const importCsv = async (file: File) => {
    setImporting(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await api<{ imported: number; duplicates_flagged: number; invalid_rows: Array<{ row: number; reason: string }> }>(
        '/parents/import-csv',
        { method: 'POST', body: form },
      );
      push('success', `Updated ${res.imported} parent number(s) (${res.duplicates_flagged} duplicates skipped, ${res.invalid_rows.length} invalid rows).`);
      load();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setImporting(false);
    }
  };

  const load = useCallback(() => {
    setLoading(true);
    // Round 5 (F1): server-side pagination — the list used to fetch
    // ?limit=200 with no pager, so flagged students past the cap were
    // unreachable. The backend already paginates (listParents returns
    // total/pages).
    api<PageResult<Student>>(`/parents?flag=${flag}&page=${page}&limit=50`)
      .then((d) => {
        setStudents(d.items);
        setTotal(d.total);
        setPages(d.pages);
        setError('');
      })
      .catch(() => setError('Could not load parent numbers.'))
      .finally(() => setLoading(false));
  }, [flag, page]);

  useEffect(load, [load]);

  const flagLabel: Record<string, string> = {
    missing: 'Missing number',
    invalid: 'Invalid number',
    duplicate: 'Duplicate number',
  };

  if (loading) return <Spinner label="Loading parent numbers…" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Parents & phone numbers</h1>
          <p className="text-sm text-slate-500">
            Absent alerts and fee reminders can only reach parents with a valid number. Fix the flagged students below —
            numbers are stored encrypted and shown masked everywhere else.
          </p>
        </div>
        <div>
          <Button variant="secondary" disabled={importing || previewLoading} onClick={() => fileRef.current?.click()}>
            {previewLoading ? 'Checking file…' : importing ? 'Importing…' : 'Import parent numbers (CSV)'}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setPendingImport(f);
              e.target.value = '';
            }}
          />
          <p className="mt-1 max-w-xs text-right text-xs text-slate-500">
            Columns: admission_no, student, parent_name, parent_phone
          </p>
        </div>
      </div>
      {error && <ErrorBanner message={error} onRetry={load} />}

      <Tabs
        tabs={[
          { key: 'missing', label: 'Missing number' },
          { key: 'invalid', label: 'Invalid number' },
          { key: 'duplicate', label: 'Duplicate number' },
        ]}
        active={flag}
        onChange={(k) => { setFlag(k as typeof flag); setPage(1); }}
      />

      {students.length === 0 ? (
        <EmptyState
          title={`No students with a ${flag} phone issue`}
          body="All parent numbers in this category look fine."
          actionLabel="Go to Students"
          actionHref="/students"
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Student</th>
                <th className="px-4 py-3">Class</th>
                <th className="px-4 py-3">Parent</th>
                <th className="px-4 py-3">Phone on file</th>
                <th className="px-4 py-3">Issue</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {students.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-medium text-slate-900">{s.name}</td>
                  <td className="px-4 py-2.5">{s.class_name ?? '—'}</td>
                  <td className="px-4 py-2.5">{s.parent_name ?? '—'}
                    {s.parent_name_ur ? <span className="urdu ml-2 text-slate-500">{s.parent_name_ur}</span> : null}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">{s.parent_phone ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={flag === 'missing' ? 'red' : 'amber'}>{flagLabel[flag]}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="secondary" onClick={() => setLinkStudent(s)}>Parent link</Button>
                      <Button variant="secondary" onClick={() => setEditing(s)}>Fix number</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {students.length > 0 && (
        <Pager page={page} pages={pages} total={total} itemLabel="students" itemLabelSingular="student" onPage={setPage} />
      )}

      {editing && (
        <ParentFixModal
          student={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            push('success', 'Parent number updated.');
            load();
          }}
        />
      )}
      {linkStudent && (
        <ParentLinkModal
          student={linkStudent}
          onClose={() => setLinkStudent(null)}
          onToast={(tone, message) => push(tone, message)}
        />
      )}
      <ConfirmDialog
        open={pendingImport !== null}
        title="Check this file first?"
        message={
          pendingImport
            ? `This will validate "${pendingImport.name}" and show a preview — nothing is updated yet. Only rows marked valid will be imported when you confirm the preview. Match students by admission number (best) or by name.`
            : ''
        }
        confirmLabel="Check file"
        tone="primary"
        busy={previewLoading}
        onConfirm={() => {
          const f = pendingImport;
          setPendingImport(null);
          if (f) void previewImport(f);
        }}
        onCancel={() => setPendingImport(null)}
      />
      {preview && (
        <Modal title={`Import preview — ${preview.file.name}`} onClose={() => setPreview(null)}>
          <p className="mb-3 text-sm text-slate-600">
            {preview.data.valid} of {preview.data.total} rows are valid · {preview.data.duplicates_flagged} duplicates ·{' '}
            {preview.data.invalid_rows.length} invalid. Only valid rows will update parent numbers.
          </p>
          <div className="max-h-80 overflow-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2">Row</th>
                  <th className="px-3 py-2">Student</th>
                  <th className="px-3 py-2">Parent phone</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {preview.data.preview.map((r) => (
                  <tr key={r.row} className={r.status === 'ok' ? '' : r.status === 'duplicate' ? 'bg-amber-50' : 'bg-red-50'}>
                    <td className="px-3 py-2">{r.row}</td>
                    <td className="px-3 py-2 font-medium">{r.student_name ?? r.data.student_name ?? '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.data.parent_phone ?? '—'}</td>
                    <td className="px-3 py-2">
                      {r.status === 'ok' ? <Badge tone="green">Valid</Badge> : r.status === 'duplicate' ? <Badge tone="amber">Duplicate</Badge> : <Badge tone="red">Invalid</Badge>}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">{r.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPreview(null)}>Cancel</Button>
            <Button
              disabled={preview.data.valid === 0 || importing}
              onClick={() => {
                const f = preview.file;
                setPreview(null);
                void importCsv(f);
              }}
            >
              {importing ? 'Importing…' : `Update ${preview.data.valid} parent number(s)`}
            </Button>
          </div>
        </Modal>
      )}
      {view}
    </div>
  );
}

function ParentFixModal({
  student,
  onClose,
  onSaved,
}: {
  student: Student;
  onClose: () => void;
  onSaved: () => void;
}) {  const [parentName, setParentName] = useState(student.parent_name ?? '');
  const [phone, setPhone] = useState(student.parent_phone ?? '');
  const [optOut, setOptOut] = useState(student.parent_opt_out ?? false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (phone.trim() && !normalizePkPhone(phone.trim())) {
      setError('That number is not a valid Pakistani mobile (e.g. 03001234567).');
      return;
    }
    setConfirming(true);
  };

  const doSave = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      await api(`/students/${student.id}/parent`, {
        method: 'PATCH',
        body: { parent_name: parentName.trim(), parent_phone: phone.trim() || undefined, opt_out: optOut },
      });
      onSaved();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Fix parent number — ${student.name}`} onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <form onSubmit={submit} className="space-y-4" autoComplete="off">
        <Field label="Parent / guardian name">
          <input className={inputCls} value={parentName} onChange={(e) => setParentName(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Parent phone" hint="Pakistan mobile — 0300…, +92…, or 92…">
          <input className={inputCls} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="03001234567" autoComplete="off" />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={optOut} onChange={(e) => setOptOut(e.target.checked)} />
          Parent opted out of SMS (never message this number)
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirming}
        title={`Update parent number for ${student.name}?`}
        message={`Are you sure? This will save the parent number ${phone.trim() || '(none)'} for ${student.name}${optOut ? ' and mark this parent as opted out of SMS (they will never be messaged)' : ''}.`}
        confirmLabel="Save number"
        tone="primary"
        busy={busy}
        onConfirm={doSave}
        onCancel={() => setConfirming(false)}
      />
    </Modal>
  );
}

/**
 * Parent portal link for one student (Gap #1): shows the existing link,
 * creates/rotates it, copies it, sends it to the parent by SMS (held draft
 * — the admin still approves it in Messages), or revokes it.
 */
function ParentLinkModal({
  student,
  onClose,
  onToast,
}: {
  student: Student;
  onClose: () => void;
  onToast: (tone: 'success' | 'error', message: string) => void;
}) {
  const [info, setInfo] = useState<ParentTokenInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    portalApi
      .getTokenInfo(student.id)
      .then((d) => {
        setInfo(d);
        setError('');
      })
      .catch((e) => setError(errText(e)))
      .finally(() => setLoading(false));
  }, [student.id]);

  useEffect(load, [load]);

  const isQueued = (res: unknown): boolean =>
    typeof res === 'object' && res !== null && 'approval_request_id' in res;

  const create = async () => {
    setBusy(true);
    try {
      const res = await portalApi.createToken(student.id);
      if (isQueued(res)) {
        onToast('success', 'Submitted for admin approval — nothing was applied yet.');
      } else {
        setInfo(res);
        onToast('success', 'Parent link created.');
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!info?.url) return;
    try {
      await navigator.clipboard.writeText(info.url);
      onToast('success', 'Parent link copied.');
    } catch {
      onToast('error', 'Could not copy — copy the link text manually.');
    }
  };

  const sendSms = async () => {
    setBusy(true);
    try {
      const res = await portalApi.sendLinkSms(student.id);
      onToast(
        'success',
        res.already_queued
          ? 'The link SMS is already queued for approval in Messages.'
          : 'Link SMS queued — approve it in Messages to send it.',
      );
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setConfirmRevoke(false);
    setBusy(true);
    try {
      const res = await portalApi.revokeToken(student.id);
      if (isQueued(res)) {
        onToast('success', 'Submitted for admin approval — nothing was applied yet.');
      } else {
        setInfo({ exists: false, url: null, expires_at: null });
        onToast('success', 'Parent link revoked.');
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const hasValidPhone = Boolean(student.parent_has_phone ?? student.parent_phone);
  const optedOut = student.parent_opt_out ?? false;

  return (
    <Modal title={`Parent link — ${student.name}`} onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      {loading ? (
        <Spinner label="Loading parent link…" />
      ) : info?.exists && info.url ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Anyone with this link can view {student.name}'s attendance, results, fees, timetable, announcements and
            homework — read-only, no login. It expires{' '}
            {info.expires_at ? new Date(info.expires_at).toLocaleDateString() : 'in one year'}.
          </p>
          <p className="break-all rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700">
            {info.url}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={copy}>Copy link</Button>
            <Button variant="secondary" disabled={busy || !hasValidPhone || optedOut} onClick={sendSms}>
              Send link via SMS
            </Button>
            <Button variant="secondary" disabled={busy} onClick={create}>Create new link</Button>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirmRevoke(true)}>Revoke link</Button>
          </div>
          {(!hasValidPhone || optedOut) && (
            <p className="text-xs text-slate-500">
              {optedOut
                ? 'This parent opted out of SMS, so the link cannot be sent by text — copy it instead.'
                : 'No valid parent number on file, so the link cannot be sent by SMS — copy it instead.'}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            No parent link exists for {student.name} yet. Creating one gives the parent a read-only link to attendance,
            results, fees, timetable, announcements and homework.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create parent link'}</Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmRevoke}
        title={`Revoke the parent link for ${student.name}?`}
        message="The old link stops working immediately. The parent will need a new link to see anything again."
        confirmLabel="Revoke link"
        tone="danger"
        busy={busy}
        onConfirm={revoke}
        onCancel={() => setConfirmRevoke(false)}
      />
    </Modal>
  );
}
