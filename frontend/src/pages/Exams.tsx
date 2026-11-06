// Exams page (6C-1): exam definitions, datesheets, grading scales +
// passing marks. Results are a separate module — this page never touches
// result rows.
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { AcademicSession, ClassItem, DatesheetItem, ExamItem, GradingScaleItem, PageResult } from '../lib/types';
import { fmtDate } from '../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Spinner, Tabs, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

export default function ExamsPage() {
  const [tab, setTab] = useState('exams');
  const [exams, setExams] = useState<ExamItem[]>([]);
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [scales, setScales] = useState<GradingScaleItem[]>([]);
  const [passing, setPassing] = useState<{ passing_marks: number | null; grade: string | null; source: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sessionFilter, setSessionFilter] = useState('');
  const [scaleClass, setScaleClass] = useState('');
  const [name, setName] = useState('');
  const [examSession, setExamSession] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [openExam, setOpenExam] = useState<ExamItem | null>(null);
  const [datesheet, setDatesheet] = useState<DatesheetItem[]>([]);
  const [dsClass, setDsClass] = useState('');
  const [dsSubject, setDsSubject] = useState('');
  const [dsDate, setDsDate] = useState('');
  const [dsStart, setDsStart] = useState('09:00');
  const [dsEnd, setDsEnd] = useState('10:30');
  const [band, setBand] = useState({ class_id: '', min_marks: '', max_marks: '', grade: '', gpa_points: '', is_passing: true });
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'exam' | 'scale' | 'datesheet'; id: string; label: string } | null>(null);
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<PageResult<ExamItem>>(`/exams?limit=100${sessionFilter ? `&session_id=${sessionFilter}` : ''}`),
      api<PageResult<AcademicSession>>('/sessions?limit=100'),
      api<PageResult<ClassItem>>('/classes?limit=200'),
      api<{ items: GradingScaleItem[] }>(`/grading-scales${scaleClass ? `?class_id=${scaleClass}` : ''}`),
      api<{ passing_marks: number | null; grade: string | null; source: string | null }>(`/grading-scales/passing${scaleClass ? `?class_id=${scaleClass}` : ''}`),
    ])
      .then(([ex, ss, cc, gs, ps]) => {
        setExams(ex.items);
        setSessions(ss.items);
        setClasses(cc.items);
        setScales(gs.items);
        setPassing(ps);
        setError('');
      })
      .catch(() => setError('Could not load exams.'))
      .finally(() => setLoading(false));
  }, [sessionFilter, scaleClass]);

  useEffect(load, [load]);

  useEffect(() => {
    if (!openExam) {
      setDatesheet([]);
      return;
    }
    api<PageResult<DatesheetItem>>(`/exams/${openExam.id}/datesheet?limit=200`)
      .then((d) => setDatesheet(d.items))
      .catch(() => undefined);
  }, [openExam]);

  const reloadDatesheet = () => {
    if (!openExam) return;
    api<PageResult<DatesheetItem>>(`/exams/${openExam.id}/datesheet?limit=200`)
      .then((d) => setDatesheet(d.items))
      .catch(() => undefined);
  };

  const createExam = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api('/exams', {
        method: 'POST',
        body: { name: name.trim(), session_id: examSession || null, start_date: startDate || null, end_date: endDate || null },
      });
      if ((r as { status?: string })?.status === 'pending') push('success', 'Submitted for admin approval — nothing was applied yet.');
      else push('success', 'Exam created.');
      setName('');
      setExamSession('');
      setStartDate('');
      setEndDate('');
      load();
    } catch (err) {
      push('error', errText(err));
    }
  };

  const addPaper = async (e: FormEvent) => {
    e.preventDefault();
    if (!openExam) return;
    try {
      await api(`/exams/${openExam.id}/datesheet`, {
        method: 'POST',
        body: { class_id: dsClass, subject: dsSubject.trim(), date: dsDate, start_time: dsStart, end_time: dsEnd },
      });
      push('success', 'Paper added to the datesheet.');
      setDsSubject('');
      setDsDate('');
      reloadDatesheet();
    } catch (err) {
      push('error', errText(err));
    }
  };

  const addBand = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/grading-scales', {
        method: 'POST',
        body: {
          class_id: band.class_id || null,
          min_marks: Number(band.min_marks),
          max_marks: Number(band.max_marks),
          grade: band.grade.trim(),
          gpa_points: Number(band.gpa_points),
          is_passing: band.is_passing,
        },
      });
      push('success', 'Grade band added.');
      setBand({ class_id: '', min_marks: '', max_marks: '', grade: '', gpa_points: '', is_passing: true });
      load();
    } catch (err) {
      push('error', errText(err));
    }
  };

  const seedDefaults = async () => {
    try {
      await api('/grading-scales/seed-defaults', { method: 'POST' });
      push('success', 'Default A+ to F grading scale added.');
      load();
    } catch (err) {
      push('error', errText(err));
    }
  };

  const doDelete = async () => {
    const d = pendingDelete;
    setPendingDelete(null);
    if (!d) return;
    try {
      if (d.kind === 'exam') await api(`/exams/${d.id}`, { method: 'DELETE' });
      else if (d.kind === 'scale') await api(`/grading-scales/${d.id}`, { method: 'DELETE' });
      else await api(`/exams/datesheet/${d.id}`, { method: 'DELETE' });
      push('success', 'Deleted.');
      if (d.kind === 'datesheet') reloadDatesheet();
      else load();
    } catch (err) {
      push('error', errText(err));
    }
  };

  if (loading) return <Spinner label="Loading exams…" />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Exams</h1>
        <p className="text-sm text-slate-500">Exam definitions, datesheets, and grading scales. Results live in their own module.</p>
      </div>
      {error && <ErrorBanner message={error} onRetry={load} />}
      <Tabs
        tabs={[
          { key: 'exams', label: 'Exams' },
          { key: 'grading', label: 'Grading scales' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'exams' && (
        <>
          <Card className="p-5">
            <h2 className="text-base font-semibold">New exam</h2>
            <form onSubmit={createExam} autoComplete="off" className="mt-3 grid gap-3 sm:grid-cols-5">
              <Field label="Name">
                <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Midterm" autoComplete="off" required />
              </Field>
              <Field label="Session (optional)">
                <select className={inputCls} value={examSession} onChange={(e) => setExamSession(e.target.value)}>
                  <option value="">No session (monthly test)</option>
                  {sessions.filter((s) => !s.is_archived).map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Start date">
                <input type="date" className={inputCls} value={startDate} onChange={(e) => setStartDate(e.target.value)} autoComplete="off" />
              </Field>
              <Field label="End date">
                <input type="date" className={inputCls} value={endDate} onChange={(e) => setEndDate(e.target.value)} autoComplete="off" />
              </Field>
              <div className="flex items-end">
                <Button type="submit">Add exam</Button>
              </div>
            </form>
          </Card>

          <div className="flex gap-2">
            <select className={inputCls + ' w-auto'} value={sessionFilter} onChange={(e) => setSessionFilter(e.target.value)}>
              <option value="">All sessions</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>{s.name}{s.is_archived ? ' (archived)' : ''}</option>
              ))}
            </select>
          </div>

          {exams.length === 0 ? (
            <EmptyState title="No exams yet" body="Add your first exam above — Midterm, Final, or a monthly test." />
          ) : (
            <div className="space-y-3">
              {exams.map((ex) => (
                <Card key={ex.id} className="p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{ex.name}</span>
                    <span className="text-sm text-slate-500">
                      {sessions.find((s) => s.id === ex.session_id)?.name ?? 'No session'}
                      {ex.start_date ? ` · ${fmtDate(ex.start_date)} → ${ex.end_date ? fmtDate(ex.end_date) : '…'}` : ''}
                    </span>
                    <span className="ml-auto flex gap-1">
                      <Button variant="ghost" onClick={() => setOpenExam(openExam?.id === ex.id ? null : ex)}>
                        {openExam?.id === ex.id ? 'Hide datesheet' : 'Datesheet'}
                      </Button>
                      <Button variant="ghost" onClick={() => setPendingDelete({ kind: 'exam', id: ex.id, label: ex.name })}>Delete</Button>
                    </span>
                  </div>
                  {openExam?.id === ex.id && (
                    <div className="mt-4 border-t border-slate-100 pt-4">
                      {datesheet.length === 0 ? (
                        <p className="text-sm text-slate-500">No papers scheduled yet.</p>
                      ) : (
                        <ul className="divide-y divide-slate-100 text-sm">
                          {datesheet.map((d) => (
                            <li key={d.id} className="flex flex-wrap items-center gap-2 py-2">
                              <span className="font-medium">{d.subject}</span>
                              <span className="text-slate-500">
                                {classes.find((c) => c.id === d.class_id) ? `Class ${classes.find((c) => c.id === d.class_id)?.name}-${classes.find((c) => c.id === d.class_id)?.section}` : ''} · {fmtDate(d.date)} · {d.start_time}–{d.end_time}
                              </span>
                              <Button variant="ghost" onClick={() => setPendingDelete({ kind: 'datesheet', id: d.id, label: d.subject })}>Remove</Button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <form onSubmit={addPaper} autoComplete="off" className="mt-3 grid gap-3 sm:grid-cols-6">
                        <Field label="Class">
                          <select className={inputCls} value={dsClass} onChange={(e) => setDsClass(e.target.value)} required>
                            <option value="">Select…</option>
                            {classes.map((c) => (
                              <option key={c.id} value={c.id}>Class {c.name}-{c.section}</option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Subject">
                          <input className={inputCls} value={dsSubject} onChange={(e) => setDsSubject(e.target.value)} placeholder="Math" autoComplete="off" required />
                        </Field>
                        <Field label="Date">
                          <input type="date" className={inputCls} value={dsDate} onChange={(e) => setDsDate(e.target.value)} autoComplete="off" required />
                        </Field>
                        <Field label="Start">
                          <input type="time" className={inputCls} value={dsStart} onChange={(e) => setDsStart(e.target.value)} autoComplete="off" required />
                        </Field>
                        <Field label="End">
                          <input type="time" className={inputCls} value={dsEnd} onChange={(e) => setDsEnd(e.target.value)} autoComplete="off" required />
                        </Field>
                        <div className="flex items-end">
                          <Button type="submit">Add paper</Button>
                        </div>
                      </form>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'grading' && (
        <>
          <Card className="p-5">
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <h2 className="text-base font-semibold">Grading scales</h2>
                <p className="text-sm text-slate-500">
                  Passing marks:{' '}
                  {passing?.passing_marks !== null && passing?.passing_marks !== undefined ? (
                    <strong>{passing.passing_marks} ({passing.grade})</strong>
                  ) : (
                    'not set yet'
                  )}
                  {passing?.source ? ` — from the ${passing.source === 'class' ? 'class override' : 'school default'}` : ''}
                </p>
              </div>
              <span className="ml-auto flex gap-2">
                <select className={inputCls + ' w-auto'} value={scaleClass} onChange={(e) => setScaleClass(e.target.value)}>
                  <option value="">School default (all classes)</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>Class {c.name}-{c.section}</option>
                  ))}
                </select>
                <Button variant="secondary" onClick={seedDefaults}>Seed default A+–F</Button>
              </span>
            </div>
            {scales.length === 0 ? (
              <div className="mt-4">
                <EmptyState title="No grade bands yet" body="Seed the standard A+ to F scale, or add bands one by one below." actionLabel="Seed default A+–F" onAction={seedDefaults} />
              </div>
            ) : (
              <ul className="mt-4 divide-y divide-slate-100 text-sm">
                {scales.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center gap-2 py-2">
                    <Badge tone={g.is_passing ? 'green' : 'red'}>{g.grade}</Badge>
                    <span>{g.min_marks}–{g.max_marks} marks</span>
                    <span className="text-slate-500">GPA {g.gpa_points} · {g.is_passing ? 'Passing' : 'Failing'}</span>
                    <span className="text-slate-400">{g.class_id ? `Class ${classes.find((c) => c.id === g.class_id)?.name}-${classes.find((c) => c.id === g.class_id)?.section}` : 'School default'}</span>
                    <Button variant="ghost" onClick={() => setPendingDelete({ kind: 'scale', id: g.id, label: g.grade })}>Delete</Button>
                  </li>
                ))}
              </ul>
            )}
            <form onSubmit={addBand} autoComplete="off" className="mt-4 grid gap-3 sm:grid-cols-7">
              <Field label="Class (blank = default)">
                <select className={inputCls} value={band.class_id} onChange={(e) => setBand({ ...band, class_id: e.target.value })}>
                  <option value="">Default</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>Class {c.name}-{c.section}</option>
                  ))}
                </select>
              </Field>
              <Field label="Min marks">
                <input type="number" min={0} className={inputCls} value={band.min_marks} onChange={(e) => setBand({ ...band, min_marks: e.target.value })} autoComplete="off" required />
              </Field>
              <Field label="Max marks">
                <input type="number" min={0} className={inputCls} value={band.max_marks} onChange={(e) => setBand({ ...band, max_marks: e.target.value })} autoComplete="off" required />
              </Field>
              <Field label="Grade">
                <input className={inputCls} value={band.grade} onChange={(e) => setBand({ ...band, grade: e.target.value })} placeholder="A+" autoComplete="off" required />
              </Field>
              <Field label="GPA points">
                <input type="number" step="0.1" min={0} className={inputCls} value={band.gpa_points} onChange={(e) => setBand({ ...band, gpa_points: e.target.value })} autoComplete="off" required />
              </Field>
              <Field label="Passing band?">
                <select className={inputCls} value={band.is_passing ? 'yes' : 'no'} onChange={(e) => setBand({ ...band, is_passing: e.target.value === 'yes' })}>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </Field>
              <div className="flex items-end">
                <Button type="submit">Add band</Button>
              </div>
            </form>
          </Card>
        </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete ? `Delete ${pendingDelete.kind === 'exam' ? 'exam' : pendingDelete.kind === 'scale' ? 'grade band' : 'datesheet entry'}?` : ''}
        message={pendingDelete ? `Are you sure? This will delete "${pendingDelete.label}".${pendingDelete.kind === 'exam' ? ' The exam moves to the recycle bin (30-day restore).' : ''}` : ''}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={doDelete}
        onCancel={() => setPendingDelete(null)}
      />
      {view}
    </div>
  );
}
