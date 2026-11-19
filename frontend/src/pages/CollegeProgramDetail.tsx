// College Mode — Program detail: semesters, enroll a student, toppers.
// Enroll picks an existing student (via their class roster) into this
// program + semester. Toppers need a semester and an exam.
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, collegeApi, ApiClientError } from '../lib/api';
import type { ClassItem, CollegeProgram, CollegeSemester, CollegeTopper, ExamItem, PageResult, Student } from '../lib/types';
import { formatGpa } from '../lib/college';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Spinner, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

export default function CollegeProgramDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [program, setProgram] = useState<CollegeProgram | null>(null);
  const [semesters, setSemesters] = useState<CollegeSemester[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [semNumber, setSemNumber] = useState('');
  const [semName, setSemName] = useState('');
  const [addingSem, setAddingSem] = useState(false);
  const [pendingDeleteSem, setPendingDeleteSem] = useState<CollegeSemester | null>(null);
  const { push, view } = useToast();

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    collegeApi
      .getProgram(id)
      .then((d) => {
        setProgram(d.program);
        setSemesters(d.semesters);
        setError('');
      })
      .catch((e) => setError(errText(e)))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(load, [load]);

  const addSemester = async (e: FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setAddingSem(true);
    try {
      await collegeApi.createSemester(id, { number: Number(semNumber), name: semName.trim() || undefined });
      setSemNumber('');
      setSemName('');
      push('success', 'Semester added.');
      load();
    } catch (err) {
      push('error', errText(err));
    } finally {
      setAddingSem(false);
    }
  };

  const removeSemester = async (s: CollegeSemester) => {
    try {
      await collegeApi.deleteSemester(s.id);
      push('success', 'Semester deleted.');
      load();
    } catch (e) {
      push('error', errText(e));
    }
  };

  if (loading) return <Spinner label="Loading program…" />;
  if (!program) return <ErrorBanner message={error || 'Program not found.'} onRetry={() => navigate('/college/programs')} />;

  return (
    <div className="space-y-5">
      <div>
        <button onClick={() => navigate('/college/programs')} className="text-sm font-medium text-brand-700 hover:underline">
          ← All programs
        </button>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">{program.name}</h1>
        <p className="text-sm text-slate-500">
          {program.code} · {program.department} · {program.duration_years} years · {program.student_count} student
          {program.student_count === 1 ? '' : 's'}
        </p>
      </div>
      {error && <ErrorBanner message={error} onRetry={load} />}

      <Card className="p-5">
        <h2 className="text-base font-semibold">Add a semester</h2>
        <form onSubmit={addSemester} className="mt-3 flex flex-wrap items-end gap-3" autoComplete="off">
          <Field label="Semester number">
            <input className={inputCls} required type="number" min={1} max={12} value={semNumber} onChange={(e) => setSemNumber(e.target.value)} placeholder="e.g. 1" autoComplete="off" />
          </Field>
          <Field label="Name (optional)">
            <input className={inputCls} value={semName} onChange={(e) => setSemName(e.target.value)} placeholder="e.g. Semester 1" autoComplete="off" />
          </Field>
          <Button type="submit" disabled={addingSem}>
            {addingSem ? 'Adding…' : 'Add semester'}
          </Button>
        </form>
      </Card>

      {semesters.length === 0 ? (
        <EmptyState title="No semesters yet" body="Add the first semester above, then add its courses." />
      ) : (
        <Card className="divide-y divide-slate-100">
          {semesters.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
              <span>
                <Link
                  to={`/college/semesters/${s.id}`}
                  state={{ programName: program.name, programId: program.id, semesterName: s.name, semesterNumber: s.number }}
                  className="font-medium text-brand-700 hover:underline"
                >
                  {s.name || `Semester ${s.number}`}
                </Link>{' '}
                <span className="text-slate-500">
                  · {s.course_count} course{s.course_count === 1 ? '' : 's'} · {s.student_count} student
                  {s.student_count === 1 ? '' : 's'}
                </span>
              </span>
              <span className="flex gap-3">
                <Link
                  to={`/college/semesters/${s.id}`}
                  state={{ programName: program.name, programId: program.id, semesterName: s.name, semesterNumber: s.number }}
                  className="font-medium text-brand-700 hover:underline"
                >
                  Courses & marks
                </Link>
                <button className="font-medium text-red-600 hover:underline" onClick={() => setPendingDeleteSem(s)}>
                  Delete
                </button>
              </span>
            </div>
          ))}
        </Card>
      )}

      <EnrollStudentForm programId={program.id} semesters={semesters} />
      <ToppersSection programId={program.id} semesters={semesters} />

      <ConfirmDialog
        open={pendingDeleteSem !== null}
        title="Delete this semester?"
        message={
          pendingDeleteSem
            ? `Are you sure? This will delete ${pendingDeleteSem.name || `Semester ${pendingDeleteSem.number}`}. Deleting is blocked while the semester still has courses or enrollments.`
            : ''
        }
        confirmLabel="Delete semester"
        tone="danger"
        onConfirm={() => {
          const s = pendingDeleteSem;
          setPendingDeleteSem(null);
          if (s) removeSemester(s);
        }}
        onCancel={() => setPendingDeleteSem(null)}
      />
      {view}
    </div>
  );
}

function EnrollStudentForm({ programId, semesters }: { programId: string; semesters: CollegeSemester[] }) {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [classId, setClassId] = useState('');
  const [students, setStudents] = useState<Student[]>([]);
  const [studentId, setStudentId] = useState('');
  const [semesterId, setSemesterId] = useState('');
  const [busy, setBusy] = useState(false);
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

  const enroll = async () => {
    if (!studentId || !semesterId) {
      push('error', 'Pick a student and a semester first.');
      return;
    }
    setBusy(true);
    try {
      await collegeApi.createEnrollment({ student_id: studentId, program_id: programId, semester_id: semesterId });
      push('success', 'Student enrolled.');
      setStudentId('');
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (semesters.length === 0) return null;
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold">Enroll a student</h2>
      <p className="mt-1 text-sm text-slate-500">Pick an existing student from the school and enroll them in this program.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label="Semester">
          <select className={inputCls} value={semesterId} onChange={(e) => setSemesterId(e.target.value)}>
            <option value="">Select…</option>
            {semesters.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || `Semester ${s.number}`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Class (to find the student)">
          <select
            className={inputCls}
            value={classId}
            onChange={(e) => {
              setClassId(e.target.value);
              setStudentId('');
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
        <Field label="Student">
          <select className={inputCls} value={studentId} onChange={(e) => setStudentId(e.target.value)}>
            <option value="">Select…</option>
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.roll_no ? `#${s.roll_no} ` : ''}
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Button className="mt-3" disabled={busy || !studentId || !semesterId} onClick={() => void enroll()}>
        {busy ? 'Enrolling…' : 'Enroll student'}
      </Button>
      {view}
    </Card>
  );
}

function ToppersSection({ programId, semesters }: { programId: string; semesters: CollegeSemester[] }) {
  const [exams, setExams] = useState<ExamItem[]>([]);
  const [semesterId, setSemesterId] = useState('');
  const [examId, setExamId] = useState('');
  const [toppers, setToppers] = useState<CollegeTopper[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { push } = useToast();

  useEffect(() => {
    api<PageResult<ExamItem>>('/exams?limit=100')
      .then((d) => setExams(d.items))
      .catch(() => undefined);
  }, []);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const d = await collegeApi.listToppers(programId, semesterId || undefined, examId || undefined);
      setToppers(d.toppers);
      setLoaded(true);
    } catch (e) {
      setError(errText(e));
      push('error', errText(e));
    } finally {
      setLoading(false);
    }
  };

  if (semesters.length === 0) return null;
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold">🏆 Toppers</h2>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Field label="Semester">
          <select className={inputCls} value={semesterId} onChange={(e) => setSemesterId(e.target.value)}>
            <option value="">All semesters</option>
            {semesters.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || `Semester ${s.number}`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Exam (optional)">
          <select className={inputCls} value={examId} onChange={(e) => setExamId(e.target.value)}>
            <option value="">All exams</option>
            {exams.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </Field>
        <Button disabled={loading} onClick={() => void load()}>
          {loading ? 'Loading…' : 'Show toppers'}
        </Button>
      </div>
      {error && <div className="mt-3"><ErrorBanner message={error} /></div>}
      {loaded &&
        (toppers.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No toppers yet for this selection.</p>
        ) : (
          <ol className="mt-3 space-y-1 text-sm">
            {toppers.map((t, i) => (
              <li key={t.student_id}>
                #{i + 1} —{' '}
                <Link to={`/college/students/${t.student_id}`} className="font-medium text-brand-700 hover:underline">
                  {t.student_name}
                </Link>{' '}
                {t.roll_no ? `(Roll ${t.roll_no})` : ''} · Semester GPA {formatGpa(t.semester_gpa)} · CGPA{' '}
                {formatGpa(t.cgpa)} <Badge tone="green">Topper</Badge>
              </li>
            ))}
          </ol>
        ))}
    </Card>
  );
}
