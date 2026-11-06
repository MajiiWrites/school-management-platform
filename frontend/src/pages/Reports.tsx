import { useCallback, useEffect, useState } from 'react';
import { api, apiDownload, ApiClientError } from '../lib/api';
import type { ClassItem, PageResult } from '../lib/types';
import { fmtPKR, todayISO } from '../lib/utils';
import { Button, Card, EmptyState, ErrorBanner, Spinner, Tabs, inputCls, useToast } from '../components/ui';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

interface AttendanceRow {
  class?: string;
  student?: string;
  present: number;
  absent: number;
  total: number;
  /** Attendance % from the API when present (present / (present + absent)). */
  rate?: number | null;
}

/** Finite number or 0 — the API must never crash the page with a NaN/undefined amount. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** One backend attendance row (by_class / by_student) -> a table row. */
function toAttendanceRow(r: Record<string, unknown>, studentName?: string): AttendanceRow {
  const present = num(r.present);
  const absent = num(r.absent);
  const late = num(r.late);
  const leave = num(r.leave);
  return {
    class: typeof r.display_name === 'string' ? r.display_name : undefined,
    student: studentName,
    present,
    absent,
    total: present + absent + late + leave,
    rate: typeof r.attendance_rate === 'number' ? r.attendance_rate : null,
  };
}

function asRows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

export default function ReportsPage() {
  type ReportTab = 'daily' | 'weekly' | 'monthly' | 'fees' | 'defaulters' | 'strength' | 'income-expense' | 'messages';
  const [tab, setTab] = useState<ReportTab>('daily');
  // 6C-2: generic JSON for the new report tabs (rendered as a simple table).
  const [generic, setGeneric] = useState<{ title: string; columns: { key: string; label: string }[]; rows: Record<string, unknown>[] } | null>(null);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [classId, setClassId] = useState('');
  const [date, setDate] = useState(todayISO());
  const [month, setMonth] = useState(() => todayISO().slice(0, 7));
  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [feeReport, setFeeReport] = useState<{ collected: number; pending: number; by_class: { class: string; collected: number; pending: number }[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { push, view } = useToast();

  useEffect(() => {
    api<PageResult<ClassItem>>('/classes')
      .then((d) => setClasses(Array.isArray(d?.items) ? d.items : []))
      .catch(() => undefined);
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    setGeneric(null);
    // 6C-2 tabs: defaulters, class strength, income-vs-expense, message history.
    if (tab === 'defaulters' || tab === 'strength' || tab === 'income-expense' || tab === 'messages') {
      const paths: Record<string, string> = {
        defaulters: `/reports/fees/defaulters?month=${month}`,
        strength: '/reports/classes/strength',
        'income-expense': `/reports/income-expense?month=${month}`,
        messages: '/reports/messages/history?limit=200',
      };
      api<Record<string, unknown>>(paths[tab])
        .then((d) => {
          const data = (d ?? {}) as Record<string, unknown>;
          if (tab === 'defaulters') {
            setGeneric({
              title: `Fee defaulters — ${month}`,
              columns: [
                { key: 'student_name', label: 'Student' },
                { key: 'display_name', label: 'Class' },
                { key: 'amount_due', label: 'Due' },
                { key: 'amount_paid', label: 'Paid' },
                { key: 'balance', label: 'Balance' },
                { key: 'status', label: 'Status' },
              ],
              rows: asRows(data.by_student),
            });
          } else if (tab === 'strength') {
            setGeneric({
              title: 'Class strength',
              columns: [
                { key: 'display_name', label: 'Class' },
                { key: 'active', label: 'Active' },
                { key: 'left', label: 'Left' },
                { key: 'struck_off', label: 'Struck off' },
                { key: 'graduated', label: 'Graduated' },
                { key: 'total', label: 'Total' },
              ],
              rows: asRows(data.by_class),
            });
          } else if (tab === 'income-expense') {
            setGeneric({
              title: `Income vs expense — ${month}`,
              columns: [
                { key: 'category', label: 'Category' },
                { key: 'total', label: 'Total (PKR)' },
                { key: 'count', label: 'Entries' },
              ],
              rows: [
                { category: 'Fees collected (income)', total: num(data.income), count: '' },
                { category: 'Expenses', total: num(data.expense), count: '' },
                { category: 'Balance', total: num(data.balance), count: '' },
                ...asRows(data.by_category),
              ],
            });
          } else {
            setGeneric({
              title: 'Message history',
              columns: [
                { key: 'type', label: 'Type' },
                { key: 'student_name', label: 'Student' },
                { key: 'status', label: 'Status' },
                { key: 'created_at', label: 'Created' },
                { key: 'body', label: 'Message' },
              ],
              rows: asRows(data.items),
            });
          }
          setRows([]);
          setFeeReport(null);
        })
        .catch(() => {
          setGeneric(null);
          setRows([]);
          setFeeReport(null);
          setError('Could not load the report.');
        })
        .finally(() => setLoading(false));
      return;
    }
    if (tab === 'fees') {
      // Backend shape: { collected, pending, by_class: [{ class_id,
      // display_name, collected, pending, students }] } — there is no
      // `class` field on the rows, and by_class may be absent/empty.
      api<Record<string, unknown>>(`/reports/fees/monthly?month=${month}`)
        .then((d) => {
          const data = (d ?? {}) as Record<string, unknown>;
          setFeeReport({
            collected: num(data.collected),
            pending: num(data.pending),
            by_class: asRows(data.by_class).map((b) => ({
              class: typeof b.display_name === 'string' ? b.display_name : typeof b.class_id === 'string' ? b.class_id : '—',
              collected: num(b.collected),
              pending: num(b.pending),
            })),
          });
          setRows([]);
        })
        .catch(() => {
          setFeeReport(null);
          setRows([]);
          setError('Could not load the fee report.');
        })
        .finally(() => setLoading(false));
      return;
    }
    const qs = new URLSearchParams();
    if (classId) qs.set('class_id', classId);
    let path = '';
    if (tab === 'daily') {
      qs.set('date', date);
      path = `/reports/attendance/daily?${qs}`;
    } else if (tab === 'weekly') {
      qs.set('week_start', date);
      path = `/reports/attendance/weekly?${qs}`;
    } else {
      qs.set('month', month);
      path = `/reports/attendance/monthly?${qs}`;
    }
    // Backend shape: { date|week_start|month, present, absent, ...,
    // by_class: [{ class_id, display_name, present, absent, late, leave,
    // attendance_rate }], by_student: [{ student_id, name, display_name,
    // ... }] } — there is NO `items` array. Daily shows one row per class
    // (by_class); weekly/monthly show one row per student (by_student).
    api<Record<string, unknown>>(path)
      .then((d) => {
        const data = (d ?? {}) as Record<string, unknown>;
        if (tab === 'daily') {
          setRows(asRows(data.by_class).map((r) => toAttendanceRow(r)));
        } else {
          setRows(
            asRows(data.by_student).map((r) =>
              toAttendanceRow(r, typeof r.name === 'string' ? r.name : undefined),
            ),
          );
        }
        setFeeReport(null);
      })
      .catch(() => {
        setRows([]);
        setFeeReport(null);
        setError('Could not load the report.');
      })
      .finally(() => setLoading(false));
  }, [tab, classId, date, month]);

  useEffect(load, [load]);

  const exportReport = async (format: 'pdf' | 'xlsx' | 'csv') => {
    try {
      const qs = new URLSearchParams({ format });
      if (classId) qs.set('class_id', classId);
      let path = '';
      if (tab === 'daily') path = `/reports/attendance/daily?date=${date}&${qs}`;
      else if (tab === 'weekly') path = `/reports/attendance/weekly?week_start=${date}&${qs}`;
      else if (tab === 'monthly') path = `/reports/attendance/monthly?month=${month}&${qs}`;
      else if (tab === 'fees') path = `/reports/fees/monthly?month=${month}&${qs}`;
      else if (tab === 'defaulters') path = `/reports/fees/defaulters?month=${month}&${qs}`;
      else if (tab === 'strength') path = `/reports/classes/strength?${qs}`;
      else if (tab === 'income-expense') path = `/reports/income-expense?month=${month}&${qs}`;
      else path = `/reports/messages/history?${qs}`;
      await apiDownload(path, `report-${tab}-${date}.${format}`);
    } catch (e) {
      push('error', errText(e));
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Reports</h1>
        <p className="text-sm text-slate-500">Daily, weekly and monthly attendance — per class and per student — plus fee summaries.</p>
      </div>
      {error && <ErrorBanner message={error} onRetry={load} />}

      <Tabs
        tabs={[
          { key: 'daily', label: 'Daily' },
          { key: 'weekly', label: 'Weekly' },
          { key: 'monthly', label: 'Monthly' },
          { key: 'fees', label: 'Fees' },
          // 6C-2 tabs
          { key: 'defaulters', label: 'Defaulters' },
          { key: 'strength', label: 'Class strength' },
          { key: 'income-expense', label: 'Income vs expense' },
          { key: 'messages', label: 'Message history' },
        ]}
        active={tab}
        onChange={(k) => setTab(k as typeof tab)}
      />

      <Card className="flex flex-wrap items-end gap-3 p-4">
        {tab !== 'fees' && tab !== 'monthly' && tab !== 'defaulters' && tab !== 'strength' && tab !== 'income-expense' && tab !== 'messages' && (
          <label className="text-sm font-medium text-slate-700">
            {tab === 'weekly' ? 'Week starting' : 'Date'}{' '}
            <input className={inputCls + ' w-auto'} type="date" value={date} onChange={(e) => setDate(e.target.value || todayISO())} autoComplete="off" />
          </label>
        )}
        {(tab === 'monthly' || tab === 'fees' || tab === 'defaulters' || tab === 'income-expense') && (
          <label className="text-sm font-medium text-slate-700">
            Month{' '}
            <input className={inputCls + ' w-auto'} type="month" value={month} onChange={(e) => setMonth(e.target.value || todayISO().slice(0, 7))} autoComplete="off" />
          </label>
        )}
        {tab !== 'fees' && tab !== 'defaulters' && tab !== 'strength' && tab !== 'income-expense' && tab !== 'messages' && (
          <label className="text-sm font-medium text-slate-700">
            Class{' '}
            <select className={inputCls + ' w-auto'} value={classId} onChange={(e) => setClassId(e.target.value)}>
              <option value="">All classes</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  Class {c.name}-{c.section}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={() => exportReport('pdf')}>Export PDF</Button>
          <Button variant="secondary" onClick={() => exportReport('xlsx')}>Export Excel</Button>
          <Button variant="secondary" onClick={() => exportReport('csv')}>Export CSV</Button>
        </div>
      </Card>

      {loading ? (
        <Spinner label="Loading report…" />
      ) : generic ? (
        generic.rows.length === 0 ? (
          <EmptyState title="No data for this report" body="There is nothing to show for the selected period yet." />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  {generic.columns.map((c) => (
                    <th key={c.key} className="px-4 py-3">{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {generic.rows.map((r, i) => (
                  <tr key={i} className="hover:bg-slate-50">
                    {generic.columns.map((c) => (
                      <td key={c.key} className="px-4 py-2.5">
                        {typeof r[c.key] === 'number' && (c.label.includes('PKR') || ['Due', 'Paid', 'Balance', 'Total'].includes(c.label))
                          ? fmtPKR(r[c.key] as number)
                          : String(r[c.key] ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : tab === 'fees' ? (
        feeReport ? (
          <Card className="p-5">
            <p className="text-sm text-slate-700">Collected: <strong>{fmtPKR(feeReport.collected)}</strong></p>
            <p className="text-sm text-slate-700">Pending: <strong>{fmtPKR(feeReport.pending)}</strong></p>
            <table className="mt-4 w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2">Class</th>
                  <th className="py-2">Collected</th>
                  <th className="py-2">Pending</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {feeReport.by_class.map((b) => (
                  <tr key={b.class}>
                    <td className="py-2 font-medium">{b.class}</td>
                    <td className="py-2">{fmtPKR(b.collected)}</td>
                    <td className="py-2">{fmtPKR(b.pending)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ) : (
          <EmptyState
            title="No fee data for this month"
            body="Fee records are created from fee structures at the start of each month."
            actionLabel="Set up fees"
            actionHref="/fees"
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          title="No attendance data"
          body={classes.length === 0 ? 'No classes exist yet — add your first class to start recording attendance.' : 'Pick a different date, class, or period.'}
          actionLabel={classes.length === 0 ? 'Add your first class' : undefined}
          actionHref={classes.length === 0 ? '/classes' : undefined}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">{tab === 'daily' ? 'Class' : 'Student'}</th>
                {tab !== 'daily' && <th className="px-4 py-3">Class</th>}
                <th className="px-4 py-3">Present</th>
                <th className="px-4 py-3">Absent</th>
                <th className="px-4 py-3">Total</th>
                <th className="px-4 py-3">Attendance %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r, i) => (
                <tr key={i} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-medium">{r.class ?? r.student ?? '—'}</td>
                  {tab !== 'daily' && <td className="px-4 py-2.5">{r.class ?? '—'}</td>}
                  <td className="px-4 py-2.5">{r.present}</td>
                  <td className="px-4 py-2.5">{r.absent}</td>
                  <td className="px-4 py-2.5">{r.total}</td>
                  <td className="px-4 py-2.5">{r.rate != null ? `${r.rate}%` : r.total > 0 ? `${Math.round((r.present / r.total) * 100)}%` : '—'}</td>                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view}
    </div>
  );
}
