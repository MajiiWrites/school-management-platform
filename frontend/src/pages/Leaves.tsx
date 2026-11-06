// Leave & late arrivals (6C-2) — leave applications (approve/reject) +
// late arrivals read from attendance (status 'late').
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { ClassItem, PageResult, Student } from '../lib/types';
import { currentMonth, fmtDate, todayISO } from '../lib/utils';
import { Button, Card, EmptyState, ErrorBanner, Field, inputCls, Spinner, Tabs, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';
import { useLanguage } from '../lib/i18n';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

interface Leave {
  id: string;
  student_id: string;
  student_name: string | null;
  from_date: string;
  to_date: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
}

interface LateRow {
  date: string;
  student_id: string;
  student_name: string;
  roll_no: number | null;
  class_id: string;
  class_name: string;
}

export default function LeavesPage() {
  const { title } = useLanguage();
  const [tab, setTab] = useState<'leaves' | 'late'>('leaves');
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [late, setLate] = useState<LateRow[]>([]);
  const [month, setMonth] = useState(currentMonth());
  const [date, setDate] = useState(todayISO());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState<{ leave: Leave; status: 'approved' | 'rejected' } | null>(null);
  const { push, view } = useToast();
  // Phase 9 fix: there was no way to create a leave at all — the page only
  // approved/rejected applications that nothing could submit. Admins record
  // a leave here (on a parent's/student's behalf — there is no parent
  // portal); it lands as a pending application for approval below.
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [leaveClass, setLeaveClass] = useState('');
  const [leaveStudents, setLeaveStudents] = useState<Student[]>([]);
  const [leaveStudent, setLeaveStudent] = useState('');
  const [fromDate, setFromDate] = useState(todayISO());
  const [toDate, setToDate] = useState(todayISO());
  const [reason, setReason] = useState('');

  useEffect(() => {
    api<PageResult<ClassItem>>('/classes?limit=200')
      .then((d) => setClasses(d.items))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!leaveClass) {
      setLeaveStudents([]);
      setLeaveStudent('');
      return;
    }
    api<PageResult<Student>>(`/classes/${leaveClass}/students?limit=200`)
      .then((d) => {
        setLeaveStudents(d.items);
        setLeaveStudent('');
      })
      .catch(() => undefined);
  }, [leaveClass]);

  const submitLeave = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!leaveStudent) {
      setError('Pick a student for the leave.');
      return;
    }
    if (fromDate > toDate) {
      setError('The "from" date must be on or before the "to" date.');
      return;
    }
    if (reason.trim().length < 2) {
      setError('Give a reason for the leave.');
      return;
    }
    setBusy(true);
    try {
      await api('/leaves', {
        method: 'POST',
        body: { student_id: leaveStudent, from_date: fromDate, to_date: toDate, reason: reason.trim() },
      });
      push('success', 'Leave recorded — it is pending approval below.');
      setReason('');
      load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<PageResult<Leave>>('/leaves?limit=200'),
      api<PageResult<LateRow>>(`/leaves/late?month=${month}`),
    ])
      .then(([l, la]) => {
        setLeaves(l.items);
        setLate(la.items);
        setError('');
      })
      .catch(() => setError('Could not load leave data.'))
      .finally(() => setLoading(false));
  }, [month]);

  useEffect(load, [load]);

  const doDecide = async () => {
    if (!deciding) return;
    setBusy(true);
    try {
      await api(`/leaves/${deciding.leave.id}`, { method: 'PATCH', body: { status: deciding.status } });
      push('success', `Leave ${deciding.status}.`);
      setDeciding(null);
      load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner label="Loading leave…" />;

  const pending = leaves.filter((l) => l.status === 'pending');

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{title('leaves')}</h1>
        <p className="text-sm text-slate-500">Approve or reject leave applications, and see who arrived late.</p>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      <Tabs
        tabs={[
          { key: 'leaves', label: `Leave applications (${pending.length} pending)` },
          { key: 'late', label: `Late arrivals (${late.length})` },
        ]}
        active={tab}
        onChange={(k) => setTab(k as typeof tab)}
      />

      {tab === 'leaves' && (
        <>
          <Card className="p-5">
            <h2 className="text-base font-semibold">Record a leave</h2>
            <p className="text-sm text-slate-500">
              For a student whose parent asked for leave (by phone, note, or in person). It is saved as a pending
              application and needs approval below before it counts.
            </p>
            <form onSubmit={submitLeave} autoComplete="off" className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Field label="Class">
                <select className={inputCls} value={leaveClass} onChange={(e) => setLeaveClass(e.target.value)} required>
                  <option value="">Select…</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>Class {c.name}-{c.section}</option>
                  ))}
                </select>
              </Field>
              <Field label="Student">
                <select className={inputCls} value={leaveStudent} onChange={(e) => setLeaveStudent(e.target.value)} required disabled={!leaveClass}>
                  <option value="">{leaveClass ? 'Select…' : 'Pick a class first'}</option>
                  {leaveStudents.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}{s.roll_no !== null ? ` (Roll ${s.roll_no})` : ''}</option>
                  ))}
                </select>
              </Field>
              <Field label="From">
                <input type="date" lang="en-GB" className={inputCls} value={fromDate} onChange={(e) => setFromDate(e.target.value || todayISO())} autoComplete="off" required />
              </Field>
              <Field label="To">
                <input type="date" lang="en-GB" className={inputCls} value={toDate} onChange={(e) => setToDate(e.target.value || todayISO())} autoComplete="off" required />
              </Field>
              <Field label="Reason">
                <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Family wedding" autoComplete="off" required />
              </Field>
              <div className="flex items-end sm:col-span-2 lg:col-span-5">
                <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Record leave'}</Button>
              </div>
            </form>
          </Card>
          {leaves.length === 0 ? (
            <EmptyState title="No leave applications" body="When a leave is recorded for a student it shows up here for approval." />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">Student</th>
                    <th className="px-4 py-3">From</th>
                    <th className="px-4 py-3">To</th>
                    <th className="px-4 py-3">Reason</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {leaves.map((l) => (
                    <tr key={l.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-medium">{l.student_name ?? '—'}</td>
                      <td className="px-4 py-2.5">{fmtDate(l.from_date)}</td>
                      <td className="px-4 py-2.5">{fmtDate(l.to_date)}</td>
                      <td className="px-4 py-2.5">{l.reason}</td>
                      <td className="px-4 py-2.5 capitalize">{l.status}</td>
                      <td className="px-4 py-2.5 text-right">
                        {l.status === 'pending' ? (
                          <span className="flex justify-end gap-2">
                            <Button variant="secondary" onClick={() => setDeciding({ leave: l, status: 'approved' })}>Approve</Button>
                            <Button variant="secondary" onClick={() => setDeciding({ leave: l, status: 'rejected' })}>Reject</Button>
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400">Decided</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'late' && (
        <>
          <Card className="flex flex-wrap items-end gap-3 p-4">
            <label className="text-sm font-medium text-slate-700">
              Month{' '}
              <input className={inputCls + ' w-auto'} type="month" value={month} onChange={(e) => setMonth(e.target.value || currentMonth())} autoComplete="off" />
            </label>
            <label className="text-sm font-medium text-slate-700">
              Or a single day{' '}
              <input
                className={inputCls + ' w-auto'}
                type="date"
                value={date}
                onChange={(e) => {
                  const d = e.target.value || todayISO();
                  setDate(d);
                  setLoading(true);
                  api<PageResult<LateRow>>(`/leaves/late?date=${d}`)
                    .then((r) => setLate(r.items))
                    .catch(() => setError('Could not load late arrivals.'))
                    .finally(() => setLoading(false));
                }}
                autoComplete="off"
              />
            </label>
          </Card>
          {late.length === 0 ? (
            <EmptyState title="No late arrivals" body="Students marked 'late' in attendance show up here." />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Student</th>
                    <th className="px-4 py-3">Roll</th>
                    <th className="px-4 py-3">Class</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {late.map((r, i) => (
                    <tr key={`${r.student_id}-${r.date}-${i}`} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5">{r.date}</td>
                      <td className="px-4 py-2.5 font-medium">{r.student_name}</td>
                      <td className="px-4 py-2.5">{r.roll_no ?? '—'}</td>
                      <td className="px-4 py-2.5">{r.class_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={deciding !== null}
        title={`${deciding?.status === 'approved' ? 'Approve' : 'Reject'} this leave?`}
        message={deciding ? `Are you sure? This will mark the leave from ${fmtDate(deciding.leave.from_date)} to ${fmtDate(deciding.leave.to_date)} (${deciding.leave.reason}) as ${deciding.status}.` : ''}
        confirmLabel={deciding?.status === 'approved' ? 'Approve leave' : 'Reject leave'}
        tone={deciding?.status === 'approved' ? 'primary' : 'danger'}
        busy={busy}
        onConfirm={doDecide}
        onCancel={() => setDeciding(null)}
      />
      {view}
    </div>
  );
}
