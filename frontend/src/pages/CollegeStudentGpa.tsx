// College Mode — Student CGPA view: enrollments, per-semester GPA,
// overall CGPA and the course table with grade + grade points.
// Opened from a student row (College orgs only) or by picking a student
// here (class roster → student). A null GPA/CGPA means no marks yet.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, collegeApi, ApiClientError } from '../lib/api';
import type { ClassItem, CollegeEnrollment, CollegeGpa, PageResult, Student } from '../lib/types';
import { formatGpa, formatPct } from '../lib/college';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Spinner, useToast } from '../components/ui';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

export function GpaSummary({ gpa }: { gpa: CollegeGpa }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {[
        ['Semester GPA', formatGpa(gpa.semester?.gpa ?? null)],
        ['Semester credits', String(gpa.semester?.total_credit_hours ?? 0)],
        ['CGPA', formatGpa(gpa.cgpa)],
        ['Total credits', String(gpa.total_credit_hours_all)],
      ].map(([label, value]) => (
        <div key={label} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
          <p className="text-xl font-bold text-slate-900" data-testid={`gpa-${label.toLowerCase().replace(/ /g, '-')}`}>
            {value}
          </p>
        </div>
      ))}
    </div>
  );
}

export function GpaCourseTable({ gpa }: { gpa: CollegeGpa }) {
  if (gpa.courses.length === 0) {
    return <p className="mt-3 text-sm text-slate-500">No courses with marks yet for this selection.</p>;
  }
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="px-3 py-2">Course</th>
            <th className="px-3 py-2">Title</th>
            <th className="px-3 py-2">Credits</th>
            <th className="px-3 py-2">Marks</th>
            <th className="px-3 py-2">%</th>
            <th className="px-3 py-2">Grade</th>
            <th className="px-3 py-2">Points</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {gpa.courses.map((c) => (
            <tr key={c.course_id}>
              <td className="px-3 py-2 font-medium">{c.course_code}</td>
              <td className="px-3 py-2">{c.course_title}</td>
              <td className="px-3 py-2">{c.credit_hours}</td>
              <td className="px-3 py-2">
                {c.obtained_marks ?? '—'} / {c.total_marks ?? '—'}
              </td>
              <td className="px-3 py-2">{formatPct(c.percentage)}</td>
              <td className="px-3 py-2">{c.grade ?? '—'}</td>
              <td className="px-3 py-2">{c.grade_points === null || c.grade_points === undefined ? '—' : c.grade_points.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CollegeStudentGpaPage() {
  const { id } = useParams<{ id: string }>();
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [classId, setClassId] = useState('');
  const [students, setStudents] = useState<Student[]>([]);
  const [studentId, setStudentId] = useState(id ?? '');
  const [enrollments, setEnrollments] = useState<CollegeEnrollment[]>([]);
  const [semesterId, setSemesterId] = useState('');
  const [gpa, setGpa] = useState<CollegeGpa | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { push, view } = useToast();

  const load = useCallback(async (sid: string, semId?: string) => {
    if (!sid) return;
    setLoading(true);
    setError('');
    try {
      const [enr, g] = await Promise.all([
        collegeApi.listStudentEnrollments(sid),
        collegeApi.getStudentGpa(sid, semId || undefined),
      ]);
      setEnrollments(enr.enrollments);
      setGpa(g);
    } catch (e) {
      setError(errText(e));
      setGpa(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (id) void load(id);
  }, [id, load]);

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

  const pickStudent = (sid: string) => {
    setStudentId(sid);
    setSemesterId('');
    if (sid) void load(sid);
  };

  const pickSemester = (semId: string) => {
    setSemesterId(semId);
    if (studentId) void load(studentId, semId || undefined);
  };

  const studentName = students.find((s) => s.id === studentId)?.name ?? (enrollments.length > 0 ? '' : '');

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Student CGPA</h1>
        <p className="text-sm text-slate-500">Per-semester GPA, overall CGPA and course grades for one student.</p>
      </div>
      {error && <ErrorBanner message={error} onRetry={() => void load(studentId, semesterId || undefined)} />}

      <Card className="p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Class (to find the student)">
            <select
              className={inputCls}
              value={classId}
              onChange={(e) => {
                setClassId(e.target.value);
                setStudentId('');
                setGpa(null);
                setEnrollments([]);
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
            <select className={inputCls} value={studentId} onChange={(e) => pickStudent(e.target.value)}>
              <option value="">Select…</option>
              {students.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.roll_no ? `#${s.roll_no} ` : ''}
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Semester">
            <select className={inputCls} value={semesterId} onChange={(e) => pickSemester(e.target.value)} disabled={enrollments.length === 0}>
              <option value="">All semesters (CGPA)</option>
              {enrollments.map((e) => (
                <option key={e.id} value={e.semester_id}>
                  {e.program_name} — {e.semester_name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {studentId && !classId && (
          <p className="mt-2 text-xs text-slate-500">
            Viewing student <span className="font-mono text-xs">{studentId}</span>
            {studentName ? ` — ${studentName}` : ''}. Pick a class above to switch students.
          </p>
        )}
      </Card>

      {loading ? (
        <Spinner label="Loading GPA…" />
      ) : !studentId ? (
        <EmptyState title="No student selected" body="Pick a class and a student above to see their GPA and CGPA." />
      ) : !gpa ? (
        <EmptyState title="No GPA yet" body="This student has no marks recorded yet, or is not enrolled in any program." />
      ) : (
        <>
          {enrollments.length > 0 && (
            <Card className="p-5">
              <h2 className="text-base font-semibold">Enrollments</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {enrollments.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{e.program_name}</span>
                    <span className="text-slate-500">— {e.semester_name}</span>
                    <Link to={`/college/programs/${e.program_id}`} className="font-medium text-brand-700 hover:underline">
                      View program
                    </Link>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        collegeApi
                          .deleteEnrollment(e.id)
                          .then(() => {
                            push('success', 'Enrollment removed.');
                            void load(studentId, semesterId || undefined);
                          })
                          .catch((err) => push('error', errText(err)));
                      }}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {gpa.semester && (
            <p className="text-sm text-slate-600">
              Semester: <strong>{gpa.semester.name}</strong> <Badge tone="blue">GPA {formatGpa(gpa.semester.gpa)}</Badge>
            </p>
          )}
          <GpaSummary gpa={gpa} />
          <Card className="p-5">
            <h2 className="text-base font-semibold">Courses</h2>
            <GpaCourseTable gpa={gpa} />
          </Card>
        </>
      )}
      {view}
    </div>
  );
}
