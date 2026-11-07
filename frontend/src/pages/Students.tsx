import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, isAbortError } from '../lib/api';
import { LIVE_SEARCH_DEBOUNCE_MS } from '../lib/search';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import type { ClassItem, PageResult, Student } from '../lib/types';
import { displayClass } from '../lib/utils';
import { ErrorBanner, EmptyState, Spinner } from '../components/ui';
import StudentsPanel from './StudentsPanel';

export type StudentFlagFilter = 'all' | 'missing' | 'invalid' | 'duplicate';

export default function StudentsPage() {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [classId, setClassId] = useState<string>('');
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [error, setError] = useState('');
  // Round 5 (F1): server-side pagination + search + phone-flag filter.
  // The list used to fetch ?limit=200 (API clamps to 100) with no pager
  // and filter the loaded rows in the browser — students 101-1100 of a
  // class were unreachable and unsearchable. The backend already
  // paginates and searches (listStudents: page/limit/search/flag, with
  // total/pages); this page now drives it and resets to page 1 whenever
  // the class, search or flag changes.
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState('');
  // FINAL REBUILD Point 3: live search — the input updates on every
  // keystroke; the query only fires ~200 ms after typing stops, and the
  // previous request is aborted so a slow reply can never overwrite
  // fresher results (no flicker, no stale rows).
  const debouncedSearch = useDebouncedValue(search, LIVE_SEARCH_DEBOUNCE_MS);
  const searchAbort = useRef<AbortController | null>(null);
  const [flagFilter, setFlagFilter] = useState<StudentFlagFilter>('all');

  // Abort any in-flight search when this page unmounts.
  useEffect(() => () => searchAbort.current?.abort(), []);

  const loadClasses = useCallback(() => {
    setLoading(true);
    api<PageResult<ClassItem>>('/classes')
      .then((d) => {
        setClasses(d.items);
        setError('');
        if (d.items.length > 0) setClassId((prev) => prev || d.items[0].id);
      })
      .catch(() => setError('Could not load classes.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(loadClasses, [loadClasses]);

  const loadStudents = useCallback(() => {
    if (!classId) return;
    // Cancel the previous (now outdated) search request before firing
    // the new one — its late reply must never reach setStudents.
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    setListLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: '50' });
    if (debouncedSearch.trim()) params.set('q', debouncedSearch.trim());
    if (flagFilter !== 'all') params.set('flag', flagFilter);
    api<PageResult<Student>>(`/classes/${classId}/students?${params.toString()}`, { signal: controller.signal })
      .then((d) => {
        setStudents(d.items);
        setTotal(d.total);
        setPages(d.pages);
        setError('');
      })
      .catch((e) => {
        if (isAbortError(e)) return; // superseded by a newer keystroke
        setError('Could not load students.');
      })
      .finally(() => {
        if (searchAbort.current === controller) setListLoading(false);
      });
  }, [classId, page, debouncedSearch, flagFilter]);

  useEffect(() => {
    void loadStudents();
  }, [loadStudents]);

  if (loading) return <Spinner label="Loading students…" />;

  const cls = classes.find((c) => c.id === classId);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Students</h1>
        <p className="text-sm text-slate-500">Search, add, edit, or import students — and fix parent phone problems.</p>
      </div>
      {error && <ErrorBanner message={error} onRetry={() => { loadClasses(); loadStudents(); }} />}
      {/* Round 5 (F6): error and empty states are mutually exclusive — a
          failed load used to show "Could not load classes." AND "No
          classes yet — Add a class first", which read as if every class
          had been deleted. The empty state only renders when the load
          succeeded and there really are no classes. */}
      {!error && classes.length === 0 ? (
        <EmptyState
          title="No classes yet"
          body="Add a class first, then add its students."
          actionLabel="Add your first class"
          actionHref="/classes"
        />
      ) : classes.length === 0 ? null : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm font-medium text-slate-700" htmlFor="class-select">Class:</label>
            <select
              id="class-select"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              value={classId}
              onChange={(e) => { setClassId(e.target.value); setPage(1); }}
            >
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  Class {displayClass(c)} — {c.teacher_name}
                </option>
              ))}
            </select>
            <Link to="/recycle-bin" className="ml-auto text-sm font-medium text-brand-700 hover:underline">
              ♻ Recycle Bin — restore deleted students
            </Link>
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
              page={page}
              pages={pages}
              total={total}
              search={search}
              onSearchChange={(q) => { setSearch(q); setPage(1); }}
              searching={listLoading && debouncedSearch.trim() !== ''}
              flagFilter={flagFilter}
              onFlagFilterChange={(f) => { setFlagFilter(f); setPage(1); }}
              onPageChange={setPage}
              onRefresh={loadStudents}
            />
          )}
        </>
      )}
    </div>
  );
}
