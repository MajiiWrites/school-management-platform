// Timetable page (6C-1): class-wise and teacher-wise weekly views,
// add/edit/delete entries. Conflicts are rejected by the server with a
// friendly message and shown inline.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { ClassItem, PageResult, StaffItem, TimetableEntryItem } from '../lib/types';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Spinner, Tabs, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function TimetablePage() {
  const [view, setView] = useState<'class' | 'teacher'>('class');
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [teachers, setTeachers] = useState<StaffItem[]>([]);
  const [selectedClass, setSelectedClass] = useState('');
  const [selectedTeacher, setSelectedTeacher] = useState('');
  const [entries, setEntries] = useState<TimetableEntryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ class_id: '', teacher_id: '', day_of_week: '1', period_no: '1', subject: '', start_time: '08:00', end_time: '08:45', room: '' });
  const [pendingDelete, setPendingDelete] = useState<TimetableEntryItem | null>(null);
  const { push, view: toastView } = useToast();

  // Phase 9 fix: the teacher dropdown only listed staff rows with
  // role=teacher, but class teachers live as plain `teacher_name` strings
  // on classes — schools that never added staff rows saw only
  // "No teacher", so teacher-wise timetables were unusable. Offer the
  // class teachers too: picking one creates the staff row on first use
  // (value `name:<teacher name>`), after which it behaves like any
  // staff teacher.
  const teacherOptions = useMemo(() => {
    const staffNames = new Set(teachers.map((t) => t.name.trim().toLowerCase()));
    const opts: { value: string; label: string }[] = teachers.map((t) => ({ value: t.id, label: t.name }));
    for (const c of classes) {
      const name = (c.teacher_name ?? '').trim();
      if (!name || staffNames.has(name.toLowerCase())) continue;
      staffNames.add(name.toLowerCase());
      opts.push({ value: `name:${name}`, label: `${name} — Class ${c.name}-${c.section} teacher` });
    }
    return opts;
  }, [teachers, classes]);

  const selectedTeacherIsNameOnly = selectedTeacher.startsWith('name:');

  const resolveTeacherId = async (value: string): Promise<string | null> => {
    if (!value) return null;
    if (!value.startsWith('name:')) return value;
    const name = value.slice('name:'.length);
    const created = await api<{ id?: string; status?: string }>('/staff', {
      method: 'POST',
      body: { name, role: 'teacher' },
    });
    if (!created.id) {
      // Clerk create went to the approval queue (202) — no staff row yet.
      throw new Error('That teacher was submitted for admin approval — add the lesson once they approve it.');
    }
    // Refresh the staff list so the new teacher stays selectable.
    api<PageResult<StaffItem>>('/staff?role=teacher&limit=200')
      .then((d) => setTeachers(d.items))
      .catch(() => undefined);
    return created.id;
  };

  const loadMeta = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<PageResult<ClassItem>>('/classes?limit=200'),
      api<PageResult<StaffItem>>('/staff?role=teacher&limit=200'),
    ])
      .then(([cc, tt]) => {
        setClasses(cc.items);
        setTeachers(tt.items);
        setError('');
      })
      .catch(() => setError('Could not load timetable.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(loadMeta, [loadMeta]);

  useEffect(() => {
    if (view === 'class' && !selectedClass) {
      setEntries([]);
      return;
    }
    if (view === 'teacher' && !selectedTeacher) {
      setEntries([]);
      return;
    }
    // A class teacher with no staff row yet has no lessons to show.
    if (view === 'teacher' && selectedTeacherIsNameOnly) {
      setEntries([]);
      return;
    }
    const q = view === 'class' ? `class_id=${selectedClass}` : `teacher_id=${selectedTeacher}`;
    api<PageResult<TimetableEntryItem>>(`/timetable?${q}&limit=200`)
      .then((d) => setEntries(d.items))
      .catch(() => undefined);
  }, [view, selectedClass, selectedTeacher, selectedTeacherIsNameOnly]);

  const reloadEntries = () => {
    const q = view === 'class' ? `class_id=${selectedClass}` : `teacher_id=${selectedTeacher}`;
    if (!selectedClass && view === 'class') return;
    if (!selectedTeacher && view === 'teacher') return;
    api<PageResult<TimetableEntryItem>>(`/timetable?${q}&limit=200`)
      .then((d) => setEntries(d.items))
      .catch(() => undefined);
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const teacherId = await resolveTeacherId(form.teacher_id);
      const r = await api('/timetable', {
        method: 'POST',
        body: {
          class_id: form.class_id,
          teacher_id: teacherId,
          day_of_week: Number(form.day_of_week),
          period_no: Number(form.period_no),
          subject: form.subject.trim(),
          start_time: form.start_time,
          end_time: form.end_time,
          room: form.room.trim() || null,
        },
      });
      if ((r as { status?: string })?.status === 'pending') push('success', 'Submitted for admin approval — nothing was applied yet.');
      else push('success', 'Timetable entry added.');
      // If a class teacher was just turned into a staff row, switch the
      // teacher-wise view to them so the new lesson shows up.
      if (view === 'teacher' && selectedTeacherIsNameOnly && teacherId) setSelectedTeacher(teacherId);
      setForm({ ...form, subject: '', room: '' });
      reloadEntries();
    } catch (err) {
      push('error', errText(err));
    }
  };

  const doDelete = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    try {
      await api(`/timetable/${id}`, { method: 'DELETE' });
      push('success', 'Timetable entry deleted.');
      reloadEntries();
    } catch (err) {
      push('error', errText(err));
    }
  };

  if (loading) return <Spinner label="Loading timetable…" />;

  const byDay: Record<number, TimetableEntryItem[]> = {};
  for (let d = 0; d <= 6; d += 1) byDay[d] = [];
  for (const e of entries) byDay[e.day_of_week].push(e);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Timetable</h1>
        <p className="text-sm text-slate-500">Weekly lessons by class or by teacher. A class and a teacher can never be double-booked.</p>
      </div>
      {error && <ErrorBanner message={error} onRetry={loadMeta} />}
      <Tabs
        tabs={[
          { key: 'class', label: 'Class-wise' },
          { key: 'teacher', label: 'Teacher-wise' },
        ]}
        active={view}
        onChange={(k) => setView(k as 'class' | 'teacher')}
      />

      <div className="flex gap-2">
        {view === 'class' ? (
          <select className={inputCls + ' w-auto'} value={selectedClass} onChange={(e) => setSelectedClass(e.target.value)}>
            <option value="">Select a class…</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>Class {c.name}-{c.section}</option>
            ))}
          </select>
        ) : (
          <select className={inputCls + ' w-auto'} value={selectedTeacher} onChange={(e) => setSelectedTeacher(e.target.value)}>
            <option value="">Select a teacher…</option>
            {teacherOptions.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        )}
      </div>

      {view === 'teacher' && selectedTeacherIsNameOnly && (
        <p className="text-sm text-slate-500">
          {selectedTeacher.slice('name:'.length)} is a class teacher with no staff record yet — no lessons are
          scheduled for them. Add a lesson below with this teacher and they will be added to staff automatically.
        </p>
      )}

      {(view === 'class' ? !selectedClass : !selectedTeacher) ? (
        <EmptyState title={view === 'class' ? 'Pick a class' : 'Pick a teacher'} body="Choose one above to see the weekly timetable." />
      ) : entries.length === 0 ? (
        <EmptyState title="No lessons scheduled" body="Add the first lesson with the form below." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {DAYS.map((day, d) => (
            <Card key={day} className="p-4">
              <h3 className="text-sm font-semibold">{day}</h3>
              {byDay[d].length === 0 ? (
                <p className="mt-2 text-sm text-slate-400">No lessons</p>
              ) : (
                <ul className="mt-2 divide-y divide-slate-100 text-sm">
                  {byDay[d].map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center gap-2 py-2">
                      <Badge tone="blue">P{e.period_no}</Badge>
                      <span className="font-medium">{e.subject}</span>
                      <span className="text-slate-500">
                        {e.start_time}–{e.end_time}
                        {e.room ? ` · Room ${e.room}` : ''}
                        {view === 'class' ? (e.teacher_name ? ` · ${e.teacher_name}` : '') : ` · ${e.class_name ?? ''}`}
                      </span>
                      <Button variant="ghost" onClick={() => setPendingDelete(e)}>Remove</Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}

      <Card className="p-5">
        <h2 className="text-base font-semibold">Add a lesson</h2>
        <form onSubmit={create} autoComplete="off" className="mt-3 grid gap-3 sm:grid-cols-4">
          <Field label="Class">
            <select
              className={inputCls}
              value={form.class_id}
              onChange={(e) => {
                const classId = e.target.value;
                const next = { ...form, class_id: classId };
                // Default the teacher to this class's teacher when none is picked.
                if (!form.teacher_id && classId) {
                  const klass = classes.find((c) => c.id === classId);
                  const name = (klass?.teacher_name ?? '').trim();
                  if (name) {
                    const staff = teachers.find((t) => t.name.trim().toLowerCase() === name.toLowerCase());
                    next.teacher_id = staff ? staff.id : `name:${name}`;
                  }
                }
                setForm(next);
              }}
              required
            >
              <option value="">Select…</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>Class {c.name}-{c.section}</option>
              ))}
            </select>
          </Field>
          <Field label="Teacher (optional)">
            <select className={inputCls} value={form.teacher_id} onChange={(e) => setForm({ ...form, teacher_id: e.target.value })}>
              <option value="">No teacher</option>
              {teacherOptions.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Day">
            <select className={inputCls} value={form.day_of_week} onChange={(e) => setForm({ ...form, day_of_week: e.target.value })}>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>{d}</option>
              ))}
            </select>
          </Field>
          <Field label="Period">
            <input type="number" min={1} className={inputCls} value={form.period_no} onChange={(e) => setForm({ ...form, period_no: e.target.value })} autoComplete="off" required />
          </Field>
          <Field label="Subject">
            <input className={inputCls} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="Math" autoComplete="off" required />
          </Field>
          <Field label="Start time">
            <input type="time" className={inputCls} value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} autoComplete="off" required />
          </Field>
          <Field label="End time">
            <input type="time" className={inputCls} value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} autoComplete="off" required />
          </Field>
          <Field label="Room (optional)">
            <input className={inputCls} value={form.room} onChange={(e) => setForm({ ...form, room: e.target.value })} placeholder="Room 4" autoComplete="off" />
          </Field>
          <div className="flex items-end">
            <Button type="submit">Add lesson</Button>
          </div>
        </form>
      </Card>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Remove this lesson?"
        message={pendingDelete ? `Are you sure? This will remove "${pendingDelete.subject}" (period ${pendingDelete.period_no}, ${pendingDelete.day_name}) from the timetable.` : ''}
        confirmLabel="Remove lesson"
        tone="danger"
        onConfirm={doDelete}
        onCancel={() => setPendingDelete(null)}
      />
      {toastView}
    </div>
  );
}
