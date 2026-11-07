import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiClientError } from '../lib/api';
import type { ClassItem, PageResult, Student } from '../lib/types';
import { displayClass } from '../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Modal, Spinner, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';
import StudentsPanel from './StudentsPanel';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

export default function ClassesPage() {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ClassItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ClassItem | null>(null);
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    api<PageResult<ClassItem>>('/classes')
      .then((d) => {
        setClasses(d.items);
        setError('');
      })
      .catch(() => setError('Could not load classes.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, []);

  const remove = async (c: ClassItem) => {
    try {
      await api(`/classes/${c.id}`, { method: 'DELETE' });
      push('success', 'Class moved to the Recycle Bin.');
      load();
    } catch (e) {
      push('error', errText(e));
    }
  };

  if (loading) return <Spinner label="Loading classes…" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Classes</h1>
          <p className="text-sm text-slate-500">Each class has a teacher and a secure attendance link.</p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/recycle-bin"
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            ♻ Recycle Bin
          </Link>
          <Button
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            + Add class
          </Button>
        </div>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}
      {classes.length === 0 && !error && (
        <EmptyState
          title="No classes yet"
          body="Add your first class, then upload its student list."
          actionLabel="Add your first class"
          onAction={() => {
            setEditing(null);
            setShowForm(true);
          }}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {classes.map((c) => (
          <ClassCard key={c.id} c={c} onEdit={() => { setEditing(c); setShowForm(true); }} onDelete={() => setPendingDelete(c)} onChanged={load} push={push} />
        ))}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this class?"
        message={
          pendingDelete
            ? `Are you sure? This will move Class ${displayClass(pendingDelete)} to the Recycle Bin. You can restore it within 30 days. Deleting is blocked while the class still has students.`
            : ''
        }
        confirmLabel="Delete class"
        tone="danger"
        onConfirm={() => {
          const c = pendingDelete;
          setPendingDelete(null);
          if (c) remove(c);
        }}
        onCancel={() => setPendingDelete(null)}
      />

      {showForm && (
        <ClassForm
          initial={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            push('success', editing ? 'Class updated.' : 'Class created.');
            load();
          }}
        />
      )}
      {view}
    </div>
  );
}

function ClassCard({
  c,
  onEdit,
  onDelete,
  onChanged,
  push,
}: {
  c: ClassItem;
  onEdit: () => void;
  onDelete: () => void;
  onChanged: () => void;
  push: (kind: 'success' | 'error', text: string) => void;
}) {
  const [link, setLink] = useState<string | null>(c.attendance_link ?? null);
  const [busy, setBusy] = useState(false);
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [confirmKind, setConfirmKind] = useState<'regen' | 'revoke' | 'unlock' | null>(null);

  // Fix C (Phase 9): the card used to keep the link only in local state,
  // initialised once from props — after a reload the API never sent the
  // link back, so the card forgot it. The API now returns attendance_link,
  // so sync local state whenever the server value changes.
  useEffect(() => {
    setLink(c.attendance_link ?? null);
  }, [c.attendance_link]);

  const regen = async () => {
    setBusy(true);
    try {
      const d = await api<{ link: string }>(`/classes/${c.id}/attendance-link/regenerate`, { method: 'POST' });
      setLink(d.link);
      push('success', 'New attendance link generated.');
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      await api(`/classes/${c.id}/attendance-link/revoke`, { method: 'POST' });
      setLink(null);
      push('success', 'Link revoked.');
      onChanged();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  // Fix C (Phase 9): admin unlock was unreachable — the card forgot the
  // submitted state, and no unlock button existed. Unlocks today's
  // submission (attendance_date comes from the server, school-local) so
  // the teacher link can submit again.
  const unlock = async () => {
    if (!c.attendance_date) return;
    setUnlockBusy(true);
    try {
      await api(`/classes/${c.id}/attendance/unlock`, { method: 'PATCH', body: { date: c.attendance_date } });
      push('success', 'Attendance unlocked — the teacher can submit again.');
      onChanged();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setUnlockBusy(false);
    }
  };

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      push('success', 'Link copied.');
    } catch {
      push('error', 'Copy failed — long-press the link to copy it.');
    }
  };

  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Class {displayClass(c)}</h2>
          <p className="text-sm text-slate-500">
            {c.teacher_name} · {c.student_count ?? 0} students
          </p>
        </div>
        {c.submitted_today ? <Badge tone="green">Submitted ✓</Badge> : <Badge tone="amber">Pending today</Badge>}
      </div>

      {c.submitted_today && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          Absent today: {c.absent_today ?? 0} student{(c.absent_today ?? 0) === 1 ? '' : 's'}
        </p>
      )}

      {c.submitted_today && !c.attendance_unlocked && (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
          <p className="text-sm text-slate-600">Locked — only the admin can reopen it.</p>
          <Button variant="secondary" disabled={unlockBusy} onClick={() => setConfirmKind('unlock')}>
            Unlock
          </Button>
        </div>
      )}

      {c.submitted_today && c.attendance_unlocked && (
        <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700">
          Unlocked — the teacher can submit attendance again today.
        </p>
      )}

      <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Teacher attendance link</p>
        {link ? (
          <>
            <p className="break-all rounded-lg bg-slate-50 px-2 py-1 font-mono text-xs text-slate-700">{link}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={copyLink}>Copy</Button>
              <a
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#25d366] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
                href={`https://wa.me/?text=${encodeURIComponent(`Attendance link for Class ${displayClass(c)}: ${link}`)}`}
                target="_blank"
                rel="noreferrer"
              >
                Share on WhatsApp
              </a>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmKind('regen')}>Regenerate</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmKind('revoke')}>Revoke</Button>
            </div>
          </>
        ) : c.attendance_link_active ? (
          <>
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              An active link exists for this class, but it was created before this update so the link itself can&apos;t be shown. Regenerate to get a link you can copy and share.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => setConfirmKind('regen')}>Regenerate link</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmKind('revoke')}>Revoke</Button>
            </div>
          </>
        ) : (
          <Button variant="secondary" disabled={busy} onClick={() => setConfirmKind('regen')}>
            Generate attendance link
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirmKind !== null}
        title={
          confirmKind === 'revoke'
            ? 'Revoke this attendance link?'
            : confirmKind === 'unlock'
              ? `Unlock today's attendance?`
              : 'Generate a new attendance link?'
        }
        message={
          confirmKind === 'revoke'
            ? `Are you sure? This will revoke the attendance link for Class ${displayClass(c)} — teachers will no longer be able to open it.`
            : confirmKind === 'unlock'
              ? `Are you sure? This will unlock today's attendance for Class ${displayClass(c)} — the teacher will be able to submit it again, replacing today's submission.`
              : `Are you sure? This will generate a new attendance link for Class ${displayClass(c)} — the old link will stop working.`
        }
        confirmLabel={
          confirmKind === 'revoke' ? 'Revoke link' : confirmKind === 'unlock' ? 'Unlock attendance' : 'Generate new link'
        }
        tone={confirmKind === 'unlock' ? 'primary' : 'danger'}
        busy={busy || unlockBusy}
        onConfirm={() => {
          const kind = confirmKind;
          setConfirmKind(null);
          if (kind === 'revoke') revoke();
          else if (kind === 'regen') regen();
          else if (kind === 'unlock') unlock();
        }}
        onCancel={() => setConfirmKind(null)}
      />

      <div className="mt-4 flex gap-2 border-t border-slate-100 pt-3">
        <Link to={`/classes/${c.id}`} className="flex-1 rounded-lg bg-brand-700 px-3 py-2 text-center text-sm font-medium text-white hover:bg-brand-900">
          Students & OCR
        </Link>
        <Button variant="secondary" onClick={onEdit}>Edit</Button>
        <Button variant="danger" onClick={onDelete}>Delete</Button>
      </div>
    </Card>
  );
}

/** The API masks phone numbers (+92 3XX XXXX123). A masked value is not a
 * real number — never send it back as an edit; treat it as "unchanged".
 * (Same rule as StudentsPanel.) */
function isMaskedPhone(v: string): boolean {
  return v.includes('X');
}

function ClassForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: ClassItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [section, setSection] = useState(initial?.section ?? '');
  const [teacherName, setTeacherName] = useState(initial?.teacher_name ?? '');
  // Fix C (Phase 9): the edit form read initial.teacher_phone, which the API
  // never returns (it returns teacher_phone_masked) — the field always came
  // up empty. Pre-fill from the masked value; it is sent back only if the
  // admin actually changes it to a real number.
  const [teacherPhone, setTeacherPhone] = useState(initial?.teacher_phone_masked ?? initial?.teacher_phone ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setConfirming(true);
  };

  const doSave = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      const body = { name: name.trim(), section: section.trim(), teacher_name: teacherName.trim(), teacher_phone: teacherPhone.trim() && !isMaskedPhone(teacherPhone.trim()) ? teacherPhone.trim() : undefined };
      if (initial) await api(`/classes/${initial.id}`, { method: 'PATCH', body });
      else await api('/classes', { method: 'POST', body });
      onSaved();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={initial ? `Edit Class ${displayClass(initial)}` : 'Add class'} onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <form onSubmit={submit} className="space-y-4" autoComplete="off">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Class name">
            <input className={inputCls} required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 5" autoComplete="off" />
          </Field>
          <Field label="Section">
            <input className={inputCls} required value={section} onChange={(e) => setSection(e.target.value)} placeholder="e.g. A" autoComplete="off" />
          </Field>
        </div>
        <Field label="Teacher name">
          <input className={inputCls} required value={teacherName} onChange={(e) => setTeacherName(e.target.value)} placeholder="e.g. Ms. Shazia Parveen" autoComplete="off" />
        </Field>
        <Field label="Teacher phone" hint="Pakistan format, e.g. 03001234567">
          <input className={inputCls} type="tel" value={teacherPhone} onChange={(e) => setTeacherPhone(e.target.value)} placeholder="03XX XXXXXXX" autoComplete="off" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save class'}</Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirming}
        title={initial ? `Update Class ${displayClass(initial)}?` : 'Add this class?'}
        message={
          initial
            ? `Are you sure? This will update Class ${displayClass(initial)} to Class ${name.trim() || '?'}-${section.trim() || '?'} (teacher: ${teacherName.trim() || '—'}).`
            : `Are you sure? This will add a new class: Class ${name.trim() || '?'}-${section.trim() || '?'} (teacher: ${teacherName.trim() || '—'}).`
        }
        confirmLabel={initial ? 'Update class' : 'Add class'}
        tone="primary"
        busy={busy}
        onConfirm={doSave}
        onCancel={() => setConfirming(false)}
      />
    </Modal>
  );
}

/* ---------- Class detail: students + OCR entry ---------- */

export function ClassDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [cls, setCls] = useState<ClassItem | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [error, setError] = useState('');
  // Round 5 (F1): same server-side pagination + search + flag filter as
  // the Students page — this detail view used to cap at 200 rows (API
  // clamps to 100) with no pager, so most of a big class was unreachable
  // here too.
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [flagFilter, setFlagFilter] = useState<'all' | 'missing' | 'invalid' | 'duplicate'>('all');

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api<ClassItem>(`/classes/${id}`)
      .then((c) => setCls(c))
      .catch(() => setError('Could not load this class.'))
      .finally(() => setLoading(false));
  }, [id]);

  const loadStudents = useCallback(() => {
    if (!id) return;
    setListLoading(true);
    const q = new URLSearchParams({ page: String(page), limit: '50' });
    if (debouncedSearch.trim()) q.set('search', debouncedSearch.trim());
    if (flagFilter !== 'all') q.set('flag', flagFilter);
    api<PageResult<Student>>(`/classes/${id}/students?${q.toString()}`)
      .then((d) => {
        setStudents(d.items);
        setTotal(d.total);
        setPages(d.pages);
      })
      .catch(() => setError('Could not load students.'))
      .finally(() => setListLoading(false));
  }, [id, page, debouncedSearch, flagFilter]);

  useEffect(() => {
    void loadStudents();
  }, [loadStudents]);

  if (loading) return <Spinner label="Loading class…" />;
  if (!cls) return <ErrorBanner message={error || 'Class not found.'} onRetry={() => navigate('/classes')} />;

  return (
    <div className="space-y-5">
      <div>
        <button onClick={() => navigate('/classes')} className="text-sm font-medium text-brand-700 hover:underline">
          ← All classes
        </button>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Class {displayClass(cls)}</h1>
        <p className="text-sm text-slate-500">
          Teacher: {cls.teacher_name} · {total} student{total === 1 ? '' : 's'}
        </p>
      </div>
      {error && <ErrorBanner message={error} onRetry={loadStudents} />}
      {listLoading ? (
        <Spinner label="Loading students…" />
      ) : (
        <StudentsPanel
          classId={cls.id}
          students={students}
          setStudents={setStudents}
          showOcr
          page={page}
          pages={pages}
          total={total}
          search={search}
          onSearchChange={(q) => { setSearch(q); setPage(1); }}
          flagFilter={flagFilter}
          onFlagFilterChange={(f) => { setFlagFilter(f); setPage(1); }}
          onPageChange={setPage}
          onRefresh={loadStudents}
        />
      )}
    </div>
  );
}
