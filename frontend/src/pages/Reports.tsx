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
}

export default function ReportsPage() {
  const [tab, setTab] = useState<'daily' | 'weekly' | 'monthly' | 'fees'>('daily');
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
      .then((d) => setClasses(d.items))
      .catch(() => undefined);
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    if (tab === 'fees') {
      api<{ collected: number; pending: number; by_class: { class: string; collected: number; pending: number }[] }>(`/reports/fees/monthly?month=${month}`)
        .then((d) => {
          setFeeReport(d);
          setRows([]);
        })
        .catch(() => setError('Could not load the fee report.'))
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
    api<PageResult<AttendanceRow>>(path)
      .then((d) => {
        setRows(d.items);
        setFeeReport(null);
      })
      .catch(() => setError('Could not load the report.'))
      .finally(() => setLoading(false));
  }, [tab, classId, date, month]);

  useEffect(load, [load]);

  const exportReport = async (format: 'pdf' | 'xlsx') => {
    try {
      const qs = new URLSearchParams({ format });
      if (classId) qs.set('class_id', classId);
      let path = '';
      if (tab === 'daily') path = `/reports/attendance/daily?date=${date}&${qs}`;
      else if (tab === 'weekly') path = `/reports/attendance/weekly?week_start=${date}&${qs}`;
      else if (tab === 'monthly') path = `/reports/attendance/monthly?month=${month}&${qs}`;
      else path = `/reports/fees/monthly?month=${month}&${qs}`;
      await apiDownload(path, `report-${tab}-${date}.${format === 'pdf' ? 'pdf' : 'xlsx'}`);
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
        ]}
        active={tab}
        onChange={(k) => setTab(k as typeof tab)}
      />

      <Card className="flex flex-wrap items-end gap-3 p-4">
        {tab !== 'fees' && tab !== 'monthly' && (
          <label className="text-sm font-medium text-slate-700">
            {tab === 'weekly' ? 'Week starting' : 'Date'}{' '}
            <input className={inputCls + ' w-auto'} type="date" value={date} onChange={(e) => setDate(e.target.value || todayISO())} />
          </label>
        )}
        {(tab === 'monthly' || tab === 'fees') && (
          <label className="text-sm font-medium text-slate-700">
            Month{' '}
            <input className={inputCls + ' w-auto'} type="month" value={month} onChange={(e) => setMonth(e.target.value || todayISO().slice(0, 7))} />
          </label>
        )}
        {tab !== 'fees' && (
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
        </div>
      </Card>

      {loading ? (
        <Spinner label="Loading report…" />
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
          <EmptyState title="No fee data for this month" />
        )
      ) : rows.length === 0 ? (
        <EmptyState title="No attendance data" body="Pick a different date, class, or period." />
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
                  <td className="px-4 py-2.5">{r.total > 0 ? `${Math.round((r.present / r.total) * 100)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view}
    </div>
  );
}
