// College Mode — Semester detail: courses + marks entry + marks table.
// NOTE (contract gap): there is no GET /college/semesters/:id, so the
// header takes the program/semester names from the link that brought the
// user here (location state) and falls back to plain labels. Marks entry
// also has no semester-roster endpoint in the contract, so students are
// picked from their class roster and each mark is saved via the upsert.
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, collegeApi, ApiClientError } from '../lib/api';
import type { ClassItem, CollegeCourse, CollegeMark, ExamItem, PageResult, StaffItem, Student } from '../lib/types';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Modal, Spinner, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

interface SemesterLocationState {
  programName?: string;
  programId?: string;
  semesterName?: string;
  semesterNumber?: number;
}

export default function CollegeSemesterDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as SemesterLocationState;
  const [courses, setCourses] = useState<CollegeCourse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<CollegeCourse | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CollegeCourse | null>(null);
  const { push, view } = useToast();

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    collegeApi
      .listCourses(id)
      .then((d) => {
        setCourses(d.courses);
        setError('');
      })
      .catch((e) => setError(errText(e)))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(load, [load]);

  const remove = async (c: CollegeCourse) => {
    try {
      await collegeApi.deleteCourse(c.id);
      push('success', 'Course deleted.');
      load();
    } catch (e) {
      push('error', errText(e));
    }
  };

  if (loading) return <Spinner label="Loading semester…" />;
  if (!id) return <ErrorBanner message="Semester not found." onRetry={() => navigate('/college/programs')} />;

  return (
    <div className="space-y-5">
      <div>
        <button onClick={() => navigate(state.programId ? `/college/programs/${state.programId}` : '/college/programs')} className="text-sm font-medium text-brand-700 hover:underline">
          ← {state.programName ? state.programName : 'All programs'}
        </button>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">
          {state.semesterName || (state.semesterNumber ? `Semester ${state.semesterNumber}` : 'Semester')}
        </h1>
        {state.programName && <p className="text-sm text-slate-500">{state.programName}</p>}
      </div>
      {error && <ErrorBanner message={error} onRetry={load} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900">Courses</h2>
        <Button
          onClick={() => {
            setEditing(null);
            setShowForm(true);
          }}
        >
          + Add course
        </Button>
      </div>

      {courses.length === 0 && !error ? (
        <EmptyState
          title="No courses yet"
          body="Add the first course for this semester, then enter marks for it."
          actionLabel="Add your first course"
          onAction={() => {
            setEditing(null);
            setShowForm(true);
          }}
        />
      ) : (
        <Card className="divide-y divide-slate-100">
          {courses.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
              <span>
                <span className="font-medium text-slate-900">{c.code}</span> — {c.title}{' '}
                <span className="text-slate-500">· {c.credit_hours} credit hour{c.credit_hours === 1 ? '' : 's'}</span>
                {c.teacher_name ? <span className="text-slate-500"> · {c.teacher_name}</span> : null}
              </span>
              <span className="flex gap-3">
                <button
                  className="font-medium text-brand-700 hover:underline"
                  onClick={() => {
                    setEditing(c);
                    setShowForm(true);
                  }}
                >
                  Edit
                </button>
                <button className="font-medium text-red-600 hover:underline" onClick={() => setPendingDelete(c)}>
                  Delete
                </button>
              </span>
            </div>
          ))}
        </Card>
      )}

      <MarksSection semesterId={id} courses={courses} />
      {courses.length > 0 && <Badge tone="slate">Marks are saved per course — pick an exam and a course below.</Badge>}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this course?"
        message={
          pendingDelete
            ? `Are you sure? This will delete ${pendingDelete.code} — ${pendingDelete.title}. Deleting is blocked while the course still has marks.`
            : ''
        }
        confirmLabel="Delete course"
        tone="danger"
        onConfirm={() => {
          const c = pendingDelete;
          setPendingDelete(null);
          if (c) remove(c);
        }}
        onCancel={() => setPendingDelete(null)}
      />

      {showForm && (
        <CourseForm
          semesterId={id}
          initial={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            push('success', editing ? 'Course updated.' : 'Course created.');
            load();
          }}
        />
      )}
      {view}
    </div>
  );
}

function CourseForm({ semesterId, initial, onClose, onSaved }: { semesterId: string; initial: CollegeCourse | null; onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState(initial?.code ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [creditHours, setCreditHours] = useState(initial?.credit_hours ?? 3);
  const [teacherId, setTeacherId] = useState(initial?.teacher_id ?? '');
  const [staff, setStaff] = useState<StaffItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    api<PageResult<StaffItem>>('/staff?limit=200')
      .then((d) => setStaff(d.items))
      .catch(() => undefined);
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setConfirming(true);
  };

  const doSave = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      const body = { code: code.trim(), title: title.trim(), credit_hours: creditHours, teacher_id: teacherId || undefined };
      if (initial) await collegeApi.updateCourse(initial.id, body);
      else await collegeApi.createCourse(semesterId, body);
      onSaved();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={initial ? `Edit ${initial.code}` : 'Add course'} onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <form onSubmit={submit} className="space-y-4" autoComplete="off">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Course code">
            <input className={inputCls} required value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. CS101" autoComplete="off" />
          </Field>
          <Field label="Credit hours">
            <input className={inputCls} required type="number" min={1} max={6} value={creditHours} onChange={(e) => setCreditHours(Number(e.target.value))} autoComplete="off" />
          </Field>
        </div>
        <Field label="Course title">
          <input className={inputCls} required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Intro to Computing" autoComplete="off" />
        </Field>
        <Field label="Teacher (optional)">
          <select className={inputCls} value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
            <option value="">No teacher assigned</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save course'}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirming}
        title={initial ? `Update ${initial.code}?` : 'Add this course?'}
        message={initial ? `Are you sure? This will update ${initial.code} — ${initial.title}.` : `Are you sure? This will add ${code.trim() || '—'} — ${title.trim() || '—'} (${creditHours} credit hours).`}
        confirmLabel={initial ? 'Update course' : 'Add course'}
        tone="primary"
        busy={busy}
        onConfirm={doSave}
        onCancel={() => setConfirming(false)}
      />
    </Modal>
  );
}

function MarksSection({ semesterId, courses }: { semesterId: string; courses: CollegeCourse[] }) {
  const [exams, setExams] = useState<ExamItem[]>([]);
  const [examId, setExamId] = useState('');
  const [marks, setMarks] = useState<CollegeMark[]>([]);
  const [marksLoaded, setMarksLoaded] = useState(false);
  const [marksLoading, setMarksLoading] = useState(false);
  const [error, setError] = useState('');
  const { view } = useToast();

  useEffect(() => {
    api<PageResult<ExamItem>>('/exams?limit=100')
      .then((d) => setExams(d.items))
      .catch(() => undefined);
  }, []);

  const loadMarks = useCallback(async () => {
    if (!examId) return;
    setMarksLoading(true);
    setError('');
    try {
      const d = await collegeApi.listSemesterMarks(semesterId, examId);
      setMarks(d.marks);
      setMarksLoaded(true);
    } catch (e) {
      setError(errText(e));
    } finally {
      setMarksLoading(false);
    }
  }, [semesterId, examId]);

  useEffect(() => {
    setMarksLoaded(false);
    setMarks([]);
  }, [examId]);

  const byStudent = new Map<string, CollegeMark[]>();
  for (const m of marks) {
    const rows = byStudent.get(m.student_id) ?? [];
    rows.push(m);
    byStudent.set(m.student_id, rows);
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-base font-semibold">Marks</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="Exam">
            <select className={inputCls} value={examId} onChange={(e) => setExamId(e.target.value)}>
              <option value="">Select an exam…</option>
              {exams.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </Field>
          <Button variant="secondary" disabled={!examId || marksLoading} onClick={() => void loadMarks()}>
            {marksLoading ? 'Loading…' : 'Show marks'}
          </Button>
          {!examId && <span className="text-xs text-slate-500">Pick an exam to see saved marks or enter new ones.</span>}
        </div>
        {error && (
          <div className="mt-3">
            <ErrorBanner message={error} onRetry={loadMarks} />
          </div>
        )}
        {marksLoaded &&
          (marks.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No marks recorded for this exam yet — enter them below.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-2">Roll</th>
                    <th className="px-3 py-2">Student</th>
                    <th className="px-3 py-2">Course</th>
                    <th className="px-3 py-2">Obtained</th>
                    <th className="px-3 py-2">Total</th>
                    <th className="px-3 py-2">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {[...byStudent.values()].flatMap((rows) =>
                    rows.map((m) => (
                      <tr key={`${m.student_id}-${m.course_id}`}>
                        <td className="px-3 py-2">{m.roll_no ?? '—'}</td>
                        <td className="px-3 py-2 font-medium">
                          <Link to={`/college/students/${m.student_id}`} className="text-brand-700 hover:underline">
                            {m.student_name}
                          </Link>
                        </td>
                        <td className="px-3 py-2">{m.course_code}</td>
                        <td className="px-3 py-2">{m.obtained_marks}</td>
                        <td className="px-3 py-2">{m.total_marks}</td>
                        <td className="px-3 py-2">{m.percentage}%</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          ))}
      </Card>

      {examId && courses.length > 0 && (
        <MarksEntryForm
          semesterId={semesterId}
          examId={examId}
          courses={courses}
          onSaved={() => void loadMarks()}
        />
      )}
      {view}
    </div>
  );
}

function MarksEntryForm({ semesterId: _semesterId, examId, courses, onSaved }: { semesterId: string; examId: string; courses: CollegeCourse[]; onSaved: () => void }) {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [classId, setClassId] = useState('');
  const [students, setStudents] = useState<Student[]>([]);
  const [courseId, setCourseId] = useState(courses[0]?.id ?? '');
  const [values, setValues] = useState<Record<string, { obtained: string; total: string }>>({});
  const [saving, setSaving] = useState(false);
  const { push, view } = useToast();

  useEffect(() => {
    api<PageResult<ClassItem>>('/classes')
      .then((d) => setClasses(d.items))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!classId) {
      setStudents([]);
      return;
    }
    api<PageResult<Student>>(`/classes/${classId}/students?limit=200`)
      .then((d) => setStudents(d.items))
      .catch(() => undefined);
  }, [classId]);

  const save = async () => {
    const rows = students
      .map((s) => ({ student: s, v: values[s.id] }))
      .filter((r) => r.v && r.v.obtained !== '' && r.v.total !== '');
    if (rows.length === 0) {
      push('error', 'Enter obtained and total marks for at least one student.');
      return;
    }
    if (!courseId) {
      push('error', 'Pick a course first.');
      return;
    }
    setSaving(true);
    let saved = 0;
    let failed = 0;
    for (const r of rows) {
      try {
        await collegeApi.upsertMark({
          course_id: courseId,
          student_id: r.student.id,
          exam_id: examId,
          obtained_marks: Number(r.v!.obtained),
          total_marks: Number(r.v!.total),
        });
        saved += 1;
      } catch {
        failed += 1;
      }
    }
    setSaving(false);
    if (failed === 0) push('success', `Saved marks for ${saved} student${saved === 1 ? '' : 's'}.`);
    else push('error', `Saved ${saved}, failed ${failed} — check the failed rows and try again.`);
    setValues({});
    onSaved();
  };

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold">Enter marks</h2>
      <p className="mt-1 text-sm text-slate-500">Marks save per student per course (the API upserts — re-saving a mark updates it).</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label="Course">
          <select className={inputCls} value={courseId} onChange={(e) => setCourseId(e.target.value)}>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Class (to find the students)">
          <select
            className={inputCls}
            value={classId}
            onChange={(e) => {
              setClassId(e.target.value);
              setValues({});
            }}
          >
            <option value="">Select…</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                Class {c.name}-{c.section}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {students.length > 0 && (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2">Roll</th>
                  <th className="px-3 py-2">Student</th>
                  <th className="px-3 py-2">Obtained</th>
                  <th className="px-3 py-2">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {students.map((s) => (
                  <tr key={s.id}>
                    <td className="px-3 py-2">{s.roll_no ?? '—'}</td>
                    <td className="px-3 py-2 font-medium">{s.name}</td>
                    <td className="px-3 py-2">
                      <input
                        className={`${inputCls} w-24`}
                        type="number"
                        min={0}
                        value={values[s.id]?.obtained ?? ''}
                        onChange={(e) => setValues({ ...values, [s.id]: { obtained: e.target.value, total: values[s.id]?.total ?? '' } })}
                        placeholder="Obtained"
                        autoComplete="off"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        className={`${inputCls} w-24`}
                        type="number"
                        min={1}
                        value={values[s.id]?.total ?? ''}
                        onChange={(e) => setValues({ ...values, [s.id]: { obtained: values[s.id]?.obtained ?? '', total: e.target.value } })}
                        placeholder="Total"
                        autoComplete="off"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button className="mt-3" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save marks'}
          </Button>
        </>
      )}
      {view}
    </Card>
  );
}
