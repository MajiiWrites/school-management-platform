// College Mode shared bits: the "not available" guard state and the
// report-card college block. The block is pure (props only) so it can be
// unit-tested without the API, and it renders ONLY when a `college`
// object is passed — School report cards never carry one, so they are
// byte-identical to before.
import { Link } from 'react-router-dom';
import type { ReportCardCollege } from '../lib/types';
import { formatGpa, formatPct } from '../lib/college';

export function CollegeNotAvailable() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">College</h1>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center">
        <p className="text-lg font-semibold text-slate-800">Not available for your organization type</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
          College Mode is only for colleges. Your organization is registered as a school, so programs, semesters,
          courses and CGPA are not available here.
        </p>
        <Link to="/dashboard" className="mt-4 inline-block font-medium text-brand-700 hover:underline">
          Go to the dashboard
        </Link>
      </div>
    </div>
  );
}

/** CGPA block for a report card. `college` is the report-card payload's
 * `college` object ({ program, semester, courses, semester_gpa, cgpa }).
 * A null semester GPA / CGPA means no marks yet — shown as '—', never 0. */
export function CollegeReportCardBlock({ college }: { college: ReportCardCollege }) {
  return (
    <div data-testid="college-report-card-block" className="mt-4 rounded-xl border border-slate-200 bg-white px-4 py-4">
      <h2 className="text-base font-semibold text-slate-900">College result</h2>
      <dl className="mt-2 space-y-1 text-sm">
        {college.program ? (
          <div className="flex flex-wrap justify-between gap-x-4">
            <dt className="text-slate-500">Program</dt>
            <dd className="font-medium text-slate-800">{college.program}</dd>
          </div>
        ) : null}
        {college.semester ? (
          <div className="flex flex-wrap justify-between gap-x-4">
            <dt className="text-slate-500">Semester</dt>
            <dd className="font-medium text-slate-800">{college.semester}</dd>
          </div>
        ) : null}
        <div className="flex flex-wrap justify-between gap-x-4">
          <dt className="text-slate-500">Semester GPA</dt>
          <dd className="font-medium text-slate-800" data-testid="college-semester-gpa">
            {formatGpa(college.semester_gpa)}
          </dd>
        </div>
        <div className="flex flex-wrap justify-between gap-x-4">
          <dt className="text-slate-500">CGPA</dt>
          <dd className="font-medium text-slate-800" data-testid="college-cgpa">
            {formatGpa(college.cgpa)}
          </dd>
        </div>
      </dl>
      {college.courses.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
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
              {college.courses.map((c) => (
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
      )}
    </div>
  );
}
