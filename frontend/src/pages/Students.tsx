import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { ClassItem, PageResult, Student } from '../lib/types';
import { displayClass } from '../lib/utils';
import { ErrorBanner, Spinner } from '../components/ui';
import StudentsPanel from './StudentsPanel';

export default function StudentsPage() {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [classId, setClassId] = useState<string>('');
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<PageResult<ClassItem>>('/classes')
      .then((d) => {
        setClasses(d.items);
        if (d.items.length > 0) setClassId(d.items[0].id);
      })
      .catch(() => setError('Could not load classes.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!classId) return;
    setListLoading(true);
    api<PageResult<Student>>(`/classes/${classId}/students?limit=200`)
      .then((d) => setStudents(d.items))
      .catch(() => setError('Could not load students.'))
      .finally(() => setListLoading(false));
  }, [classId]);

  if (loading) return <Spinner label="Loading students…" />;

  const cls = classes.find((c) => c.id === classId);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Students</h1>
        <p className="text-sm text-slate-500">Search, add, edit, or import students — and fix parent phone problems.</p>
      </div>
      {error && <ErrorBanner message={error} />}
      {classes.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
          Add a class first, then add its students.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm font-medium text-slate-700" htmlFor="class-select">Class:</label>
            <select
              id="class-select"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
            >
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  Class {displayClass(c)} — {c.teacher_name}
                </option>
              ))}
            </select>
          </div>
          {listLoading ? (
            <Spinner label="Loading students…" />
          ) : (
            <StudentsPanel
              classId={classId}
              students={students}
              setStudents={setStudents}
              showOcr
              classNameLabel={cls ? `Class ${displayClass(cls)}` : undefined}
            />
          )}
        </>
      )}
    </div>
  );
}
