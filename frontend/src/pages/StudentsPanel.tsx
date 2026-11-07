import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiClientError } from '../lib/api';
import type { ClassItem, Student } from '../lib/types';
import { displayClass, normalizePkPhone } from '../lib/utils';
import { Badge, Button, EmptyState, Field, inputCls, Modal, Pager, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';
import LiveSearchInput, { HighlightedText } from '../components/LiveSearchInput';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

/** The API masks phone numbers (+92 3XX XXXX123). A masked value is not a
 * real number — never send it back as an edit; treat it as "unchanged". */
function isMaskedPhone(v: string): boolean {
  return v.includes('X');
}

interface ImportPreviewItem {
  row: number;
  status: 'ok' | 'duplicate' | 'invalid';
  reason: string | null;
  data: { name: string; roll_no?: number | null; parent_phone?: string | null; admission_no?: string | null };
}

interface ImportPreview {
  total: number;
  valid: number;
  duplicates_flagged: number;
  invalid_rows: Array<{ row: number; reason: string }>;
  preview: ImportPreviewItem[];
}

/** D2: the list endpoint used to return neither `parent_phone` nor
 * `phone_flag`, so the table read `parent_phone` (always undefined → "—")
 * and the badge fell through to green OK. The backend now sends the
 * masked `parent_phone` + `phone_flag`; derive the flag from
 * `parent_has_phone` / the masked value as a fallback for stale payloads
 * (e.g. mock data or a cached response without the new fields). */
function phoneFlagOf(s: Student): 'missing' | 'invalid' | 'duplicate' | null {
  if (s.phone_flag) return s.phone_flag;
  if (s.parent_has_phone === false) return 'missing';
  if (s.parent_has_phone === true && !(s.parent_phone_masked ?? s.parent_phone)) return 'invalid';
  return null;
}

function phoneBadge(s: Student) {
  const flag = phoneFlagOf(s);
  if (flag === 'missing') return <Badge tone="red">No number</Badge>;
  if (flag === 'invalid') return <Badge tone="amber">Invalid number</Badge>;
  if (flag === 'duplicate') return <Badge tone="amber">Duplicate number</Badge>;
  return <Badge tone="green">OK</Badge>;
}

/** Phase 9 fix: a student marked Left (or Struck off / Graduated) showed
 * nothing in the list — the status was only visible inside the edit form. */
function statusBadge(s: Student) {
  if (!s.status || s.status === 'active') return null;
  if (s.status === 'left') return <Badge tone="amber">Left</Badge>;
  if (s.status === 'struck_off') return <Badge tone="red">Struck off</Badge>;
  return <Badge tone="blue">Graduated</Badge>;
}

export default function StudentsPanel({
  classId,
  students,
  setStudents,
  showOcr,
  classNameLabel,
  // Round 5 (F1): server-side paging. When the parent passes these, the
  // search box + phone filter + pager all run against the API (page,
  // search, flag) and the panel refreshes through onRefresh instead of
  // mutating the local page after add/edit/remove/move/import. Without
  // them the panel keeps its old client-side behaviour.
  page,
  pages,
  total,
  search: serverSearch,
  onSearchChange,
  flagFilter: serverFlagFilter,
  onFlagFilterChange,
  onPageChange,
  onRefresh,
  searching,
}: {
  classId: string;
  students: Student[];
  setStudents: (s: Student[]) => void;
  showOcr?: boolean;
  classNameLabel?: string;
  page?: number;
  pages?: number;
  total?: number;
  search?: string;
  onSearchChange?: (q: string) => void;
  flagFilter?: 'all' | 'missing' | 'invalid' | 'duplicate';
  onFlagFilterChange?: (f: 'all' | 'missing' | 'invalid' | 'duplicate') => void;
  onPageChange?: (page: number) => void;
  onRefresh?: () => void;
  /** True while a debounced live-search query is in flight — the search
   * input shows a spinner instead of the clear button. */
  searching?: boolean;
}) {
  const serverPaged = onPageChange !== undefined;
  const [localSearch, setLocalSearch] = useState('');
  const [localFlagFilter, setLocalFlagFilter] = useState<'all' | 'missing' | 'invalid' | 'duplicate'>('all');
  const search = serverPaged ? (serverSearch ?? '') : localSearch;
  const flagFilter = serverPaged ? (serverFlagFilter ?? 'all') : localFlagFilter;
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Student | null>(null);
  const [importing, setImporting] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<Student | null>(null);
  const [pendingImport, setPendingImport] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ file: File; data: ImportPreview } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // 6B: move-student UI — target class list + pending move.
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [moving, setMoving] = useState<Student | null>(null);
  const [moveTarget, setMoveTarget] = useState('');
  const [pendingMove, setPendingMove] = useState<{ student: Student; classId: string } | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { push, view } = useToast();

  useEffect(() => {
    api<{ items: ClassItem[] }>('/classes')
      .then((d) => setClasses(d.items))
      .catch(() => undefined);
  }, []);

  // Round 5 (F1): server-paged mode skips the client filter entirely —
  // the API already searched/filtered this page. Client mode (no paging
  // props) keeps the old in-memory filter.
  const filtered = useMemo(() => {
    if (serverPaged) return students;
    const q = search.trim().toLowerCase();
    return students.filter((s) => {
      if (flagFilter !== 'all' && phoneFlagOf(s) !== flagFilter) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        (s.name_ur ?? '').toLowerCase().includes(q) ||
        (s.father_name ?? '').toLowerCase().includes(q) ||
        (s.admission_no ?? '').toLowerCase().includes(q) ||
        String(s.roll_no ?? '').includes(q) ||
        (s.parent_name ?? '').toLowerCase().includes(q)
      );
    });
  }, [students, search, flagFilter, serverPaged]);

  const remove = async (s: Student) => {
    try {
      await api(`/students/${s.id}`, { method: 'DELETE' });
      if (serverPaged && onRefresh) onRefresh();
      else setStudents(students.filter((x) => x.id !== s.id));
      push('success', 'Student moved to the Recycle Bin.');
    } catch (e) {
      push('error', errText(e));
    }
  };

  // 6B: preview-before-import — validate the file first, show the table,
  // and only import after the admin confirms the preview.
  const previewImport = async (file: File) => {
    setPreviewLoading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const data = await api<ImportPreview>(`/classes/${classId}/students/import-preview`, { method: 'POST', body: form });
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
      const res = await api<{ imported: number; duplicates_flagged: number; invalid_rows: Array<{ row: number; reason: string }> | number }>(
        `/classes/${classId}/students/import-csv`,
        { method: 'POST', body: form },
      );
      // R2-D (a): the API returns invalid_rows as an ARRAY of {row, reason}
      // (same shape as the preview and Parents.tsx); interpolating it
      // directly rendered "[object Object]". Count it, tolerating the
      // legacy number shape the mock API returns.
      const invalidCount = Array.isArray(res.invalid_rows) ? res.invalid_rows.length : res.invalid_rows;
      // Round 5 (F7): "Imported 1 students (… 1 invalid rows)" — pluralise.
      const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
      push(
        'success',
        `Imported ${plural(res.imported, 'student', 'students')} (${plural(res.duplicates_flagged, 'duplicate', 'duplicates')} flagged, ${plural(invalidCount, 'invalid row', 'invalid rows')}).`,
      );
      // Refresh list
      if (serverPaged && onRefresh) onRefresh();
      else {
        const fresh = await api<{ items: Student[] }>(`/classes/${classId}/students?limit=200`);
        setStudents(fresh.items);
      }
    } catch (e) {
      push('error', errText(e));
    } finally {
      setImporting(false);
    }
  };

  // 6B: move a student to another section/class (ConfirmDialog below).
  const moveStudent = async (student: Student, toClassId: string) => {
    setMoveBusy(true);
    try {
      const saved = await api<Student>(`/students/${student.id}/move`, { method: 'POST', body: { class_id: toClassId } });
      if (serverPaged && onRefresh) onRefresh();
      else setStudents(students.filter((x) => x.id !== student.id));
      const target = classes.find((c) => c.id === toClassId);
      push('success', `${student.name} moved to Class ${target ? displayClass(target) : 'the selected class'}.`);
      return saved;
    } catch (e) {
      push('error', errText(e));
      return null;
    } finally {
      setMoveBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {/* FINAL REBUILD Point 3: live search — no button, no reload.
            Typing updates instantly; the parent debounces (~200 ms) and
            queries the server with `q`, cancelling the previous request. */}
        <LiveSearchInput
          value={search}
          onChange={(q) => (serverPaged ? onSearchChange?.(q) : setLocalSearch(q))}
          placeholder="Search name, father's name, roll no., admission no.…"
          searching={searching}
          ariaLabel="Search students"
        />
        <select className={inputCls + ' w-auto'} value={flagFilter} onChange={(e) => (serverPaged ? onFlagFilterChange?.(e.target.value as typeof flagFilter) : setLocalFlagFilter(e.target.value as typeof flagFilter))}>
          <option value="all">All phone statuses</option>
          <option value="missing">Missing number</option>
          <option value="invalid">Invalid number</option>
          <option value="duplicate">Duplicate number</option>
        </select>
        <div className="ml-auto flex flex-wrap gap-2">
          {showOcr && (
            <Link to={`/classes/${classId}/ocr`} className="rounded-lg bg-brand-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-900">
              📷 Upload list photo (OCR)
            </Link>
          )}
          <Button
            variant="secondary"
            disabled={importing || previewLoading}
            onClick={() => fileRef.current?.click()}
          >
            {previewLoading ? 'Checking file…' : importing ? 'Importing…' : 'Import CSV / Excel'}
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
          <Button
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            + Add student
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={
            search.trim()
              ? 'No student found'
              : 'No students found'
          }
          body={
            search.trim()
              ? `No student matches "${search.trim()}". Try a different spelling, roll number or admission number.`
              : serverPaged
                ? (total ?? 0) === 0
                  ? `No students in ${classNameLabel ?? 'this class'} yet — upload a list photo or add them manually.`
                  : 'Try a different search or filter.'
                : students.length === 0
                  ? `No students in ${classNameLabel ?? 'this class'} yet — upload a list photo or add them manually.`
                  : 'Try a different search or filter.'
          }
          actionLabel={!search.trim() && (serverPaged ? (total ?? 0) === 0 : students.length === 0) ? 'Add your first student' : undefined}
          onAction={
            !search.trim() && (serverPaged ? (total ?? 0) === 0 : students.length === 0)
              ? () => {
                  setEditing(null);
                  setShowForm(true);
                }
              : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Roll</th>
                <th className="px-4 py-3">Student</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Parent</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Phone status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-medium">{s.roll_no ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-slate-900">
                      <HighlightedText text={s.name} query={search} />
                    </span>
                    {s.name_ur ? <span className="urdu ml-2 text-slate-500">{s.name_ur}</span> : null}
                    {s.admission_no ? (
                      <span className="block text-xs text-slate-500">
                        <HighlightedText text={s.admission_no} query={search} />
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5">{statusBadge(s) ?? <span className="text-xs text-slate-400">Active</span>}</td>
                  <td className="px-4 py-2.5">
                    {s.parent_name ? <HighlightedText text={s.parent_name} query={search} /> : '—'}
                    {s.father_name && s.father_name !== s.parent_name ? (
                      <span className="block text-xs text-slate-500">
                        Father: <HighlightedText text={s.father_name} query={search} />
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">{s.parent_phone_masked ?? s.parent_phone ?? '—'}</td>
                  <td className="px-4 py-2.5">{phoneBadge(s)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      className="mr-3 font-medium text-brand-700 hover:underline"
                      onClick={() => {
                        setEditing(s);
                        setShowForm(true);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="mr-3 font-medium text-brand-700 hover:underline"
                      onClick={() => {
                        setMoving(s);
                        setMoveTarget('');
                      }}
                    >
                      Move
                    </button>
                    <button className="font-medium text-red-600 hover:underline" onClick={() => setPendingRemove(s)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {serverPaged && filtered.length > 0 && (
        <Pager page={page ?? 1} pages={pages ?? 1} total={total ?? 0} itemLabel="students" itemLabelSingular="student" onPage={(p) => onPageChange?.(p)} />
      )}

      {showForm && (
        <StudentForm
          classId={classId}
          initial={editing}
          onClose={() => setShowForm(false)}
          onSaved={(saved) => {
            setShowForm(false);
            // Round 5 (F1): server-paged mode refreshes from the API (the
            // saved row may belong on another page); client mode keeps the
            // local list update.
            if (serverPaged && onRefresh) onRefresh();
            else if (editing) setStudents(students.map((x) => (x.id === saved.id ? saved : x)));
            else setStudents([...students, saved]);
            push('success', editing ? 'Student updated.' : 'Student added.');
          }}
        />
      )}
      <ConfirmDialog
        open={pendingRemove !== null}
        title="Remove this student?"
        message={pendingRemove ? `Are you sure? This will move ${pendingRemove.name} to the Recycle Bin. You can restore them within 30 days.` : ''}
        confirmLabel="Remove student"
        tone="danger"
        onConfirm={() => {
          const s = pendingRemove;
          setPendingRemove(null);
          if (s) remove(s);
        }}
        onCancel={() => setPendingRemove(null)}
      />
      <ConfirmDialog
        open={pendingImport !== null}
        title="Check this file first?"
        message={
          pendingImport
            ? `This will validate "${pendingImport.name}" and show a preview — nothing is imported yet. Only rows marked valid will be imported when you confirm the preview.`
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
            {preview.data.invalid_rows.length} invalid. Only valid rows will be imported.
          </p>
          <div className="max-h-80 overflow-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2">Row</th>
                  <th className="px-3 py-2">Student</th>
                  <th className="px-3 py-2">Roll</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {preview.data.preview.map((r) => (
                  <tr key={r.row} className={r.status === 'ok' ? '' : r.status === 'duplicate' ? 'bg-amber-50' : 'bg-red-50'}>
                    <td className="px-3 py-2">{r.row}</td>
                    <td className="px-3 py-2 font-medium">{r.data.name}</td>
                    <td className="px-3 py-2">{r.data.roll_no ?? '—'}</td>
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
              {importing ? 'Importing…' : `Import ${preview.data.valid} valid ${preview.data.valid === 1 ? 'student' : 'students'}`}
            </Button>
          </div>
        </Modal>
      )}
      {moving && (
        <Modal title={`Move ${moving.name}`} onClose={() => setMoving(null)}>
          <form
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              if (!moveTarget) return;
              const s = moving;
              setMoving(null);
              setPendingMove({ student: s, classId: moveTarget });
            }}
            className="space-y-4"
          >
            <Field label="Move to class/section">
              <select className={inputCls} value={moveTarget} onChange={(e) => setMoveTarget(e.target.value)} required>
                <option value="">Select a class…</option>
                {classes
                  .filter((c) => c.id !== classId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      Class {displayClass(c)} — {c.teacher_name}
                    </option>
                  ))}
              </select>
            </Field>
            <p className="text-sm text-slate-500">
              The student keeps their roll number if it is free in the new class, otherwise the move is blocked and you will see the reason.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setMoving(null)}>Cancel</Button>
              <Button type="submit" disabled={!moveTarget}>Continue</Button>
            </div>
          </form>
        </Modal>
      )}
      <ConfirmDialog
        open={pendingMove !== null}
        title="Move this student?"
        message={
          pendingMove
            ? `Are you sure? This will move ${pendingMove.student.name} to Class ${(() => {
                const t = classes.find((c) => c.id === pendingMove.classId);
                return t ? displayClass(t) : 'the selected class';
              })()}. Attendance and fee history move with them.`
            : ''
        }
        confirmLabel="Move student"
        tone="primary"
        busy={moveBusy}
        onConfirm={() => {
          const m = pendingMove;
          setPendingMove(null);
          if (m) void moveStudent(m.student, m.classId);
        }}
        onCancel={() => setPendingMove(null)}
      />
      {view}
    </div>
  );
}

function StudentForm({
  classId,
  initial,
  onClose,
  onSaved,
}: {
  classId: string;
  initial: Student | null;
  onClose: () => void;
  onSaved: (s: Student) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [nameUr, setNameUr] = useState(initial?.name_ur ?? '');
  const [rollNo, setRollNo] = useState(initial?.roll_no ? String(initial.roll_no) : '');
  const [parentName, setParentName] = useState(initial?.parent_name ?? '');
  const [parentPhone, setParentPhone] = useState(initial?.parent_phone_masked ?? initial?.parent_phone ?? '');
  const [optOut, setOptOut] = useState(initial?.parent_opt_out ?? false);
  // 6B extended profile fields.
  const [fatherName, setFatherName] = useState(initial?.father_name ?? '');
  const [admissionNo, setAdmissionNo] = useState(initial?.admission_no ?? '');
  const [dateOfBirth, setDateOfBirth] = useState(initial?.date_of_birth ?? '');
  const [gender, setGender] = useState(initial?.gender ?? '');
  const [address, setAddress] = useState(initial?.address ?? '');
  const [admissionDate, setAdmissionDate] = useState(initial?.admission_date ?? '');
  const [parent2Name, setParent2Name] = useState(initial?.parent2_name ?? '');
  const [parent2Phone, setParent2Phone] = useState(initial?.parent2_phone_masked ?? '');
  const [parent2OptOut, setParent2OptOut] = useState(initial?.parent2_opt_out ?? false);
  const [status, setStatus] = useState(initial?.status ?? 'active');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const phone = parentPhone.trim();
    if (phone && !isMaskedPhone(phone) && !normalizePkPhone(phone)) {
      setError('Parent phone looks invalid — use a Pakistani mobile like 03001234567.');
      return;
    }
    const phone2 = parent2Phone.trim();
    if (phone2 && !isMaskedPhone(phone2) && !normalizePkPhone(phone2)) {
      setError('Second parent phone looks invalid — use a Pakistani mobile like 03001234567.');
      return;
    }
    if (gender && !['male', 'female', 'other'].includes(gender)) {
      setError("Gender must be male, female or other.");
      return;
    }
    setConfirming(true);
  };

  const doSave = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        name_ur: nameUr.trim() || undefined,
        roll_no: rollNo ? Number(rollNo) : undefined,
        parent_name: parentName.trim() || undefined,
        // Masked numbers are "unchanged" — never send them back.
        parent_phone: parentPhone.trim() && !isMaskedPhone(parentPhone.trim()) ? parentPhone.trim() : undefined,
        parent_opt_out: optOut,
        father_name: fatherName.trim() || undefined,
        admission_no: admissionNo.trim() || undefined,
        date_of_birth: dateOfBirth || undefined,
        gender: gender || undefined,
        address: address.trim() || undefined,
        admission_date: admissionDate || undefined,
        parent2_name: parent2Name.trim() || undefined,
        parent2_phone: parent2Phone.trim() && !isMaskedPhone(parent2Phone.trim()) ? parent2Phone.trim() : undefined,
        parent2_opt_out: parent2OptOut,
      };
      if (initial) body.status = status;
      let saved: Student;
      if (initial) {
        saved = await api<Student>(`/students/${initial.id}`, { method: 'PATCH', body });
      } else {
        saved = await api<Student>(`/classes/${classId}/students`, { method: 'POST', body });
      }
      onSaved(saved);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={initial ? `Edit ${initial.name}` : 'Add student'} onClose={onClose}>
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <form onSubmit={submit} className="space-y-4" autoComplete="off">
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <Field label="Student name (English)">
              <input className={inputCls} required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ahmed Raza" autoComplete="off" />
            </Field>
          </div>
          <Field label="Roll no.">
            <input className={inputCls} type="number" min={1} value={rollNo} onChange={(e) => setRollNo(e.target.value)} placeholder="1" autoComplete="off" />
          </Field>
        </div>
        <Field label="Name in Urdu (optional)">
          <input className={`${inputCls} urdu`} dir="rtl" value={nameUr} onChange={(e) => setNameUr(e.target.value)} placeholder="احمد رضا" autoComplete="off" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Father's name">
            <input className={inputCls} value={fatherName} onChange={(e) => setFatherName(e.target.value)} placeholder="e.g. Muhammad Raza" autoComplete="off" />
          </Field>
          <Field label="Admission no. (unique per school)" hint="Leave blank if none">
            <input className={inputCls} value={admissionNo} onChange={(e) => setAdmissionNo(e.target.value)} placeholder="e.g. ADM-001" autoComplete="off" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date of birth">
            <input className={inputCls} type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Gender">
            <select className={inputCls} value={gender} onChange={(e) => setGender(e.target.value)}>
              <option value="">—</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="other">Other</option>
            </select>
          </Field>
        </div>
        <Field label="Home address (optional)">
          <input className={inputCls} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, town" autoComplete="off" />
        </Field>
        <Field label="Admission date">
          <input className={inputCls} type="date" value={admissionDate} onChange={(e) => setAdmissionDate(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Parent / guardian name">
          <input className={inputCls} value={parentName} onChange={(e) => setParentName(e.target.value)} placeholder="e.g. Muhammad Raza" autoComplete="off" />
        </Field>
        <Field label="Parent phone" hint="Pakistan mobile — 0300…, +92…, or 92…. Masked numbers are left unchanged.">
          <input className={inputCls} type="tel" value={parentPhone} onChange={(e) => setParentPhone(e.target.value)} placeholder="03001234567" autoComplete="off" />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={optOut} onChange={(e) => setOptOut(e.target.checked)} />
          Parent opted out of SMS (never message this number)
        </label>
        <Field label="Second parent / guardian name (optional)">
          <input className={inputCls} value={parent2Name} onChange={(e) => setParent2Name(e.target.value)} placeholder="e.g. Fatima Raza" autoComplete="off" />
        </Field>
        <Field label="Second parent phone (optional)">
          <input className={inputCls} type="tel" value={parent2Phone} onChange={(e) => setParent2Phone(e.target.value)} placeholder="03001234567" autoComplete="off" />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={parent2OptOut} onChange={(e) => setParent2OptOut(e.target.checked)} />
          Second parent opted out of SMS
        </label>
        {initial && (
          <Field label="Status">
            <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'left' | 'struck_off' | 'graduated')}>
              <option value="active">Active</option>
              <option value="left">Left</option>
              <option value="struck_off">Struck off</option>
              <option value="graduated">Graduated</option>
            </select>
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save student'}</Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirming}
        title={initial ? `Update ${initial.name}?` : 'Add this student?'}
        message={
          initial
            ? `Are you sure? This will update ${initial.name}'s record (name: ${name.trim() || '—'}${rollNo ? `, roll no. ${rollNo}` : ''}${status !== initial.status ? `, status: ${status}` : ''}).`
            : `Are you sure? This will add a new student: ${name.trim() || '—'}${rollNo ? ` (roll no. ${rollNo})` : ''}${parentName.trim() ? `, parent ${parentName.trim()}` : ''}.`
        }
        confirmLabel={initial ? 'Update student' : 'Add student'}
        tone="primary"
        busy={busy}
        onConfirm={doSave}
        onCancel={() => setConfirming(false)}
      />
    </Modal>
  );
}
