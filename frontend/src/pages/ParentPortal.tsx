// Parent portal (Gap #1, 2026-11-20) — public read-only page at /p/:token.
// No login, no edits: one student's attendance, results, fees, timetable,
// announcements and homework. A bad / revoked / expired token shows the
// "ask the school admin" state, never another student's data.
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { portalApi } from '../lib/api';
import { ApiClientError } from '../lib/api';
import type { ParentPortalData } from '../lib/types';
import { Badge, Card, EmptyState, Spinner, Tabs } from '../components/ui';
import DeveloperFooter from '../components/DeveloperFooter';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type TabKey = 'attendance' | 'results' | 'fees' | 'timetable' | 'announcements' | 'homework';

export default function ParentPortalPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<ParentPortalData | null>(null);
  const [tab, setTab] = useState<TabKey>('attendance');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      setData(await portalApi.getPortal(token));
    } catch (e) {
      setError(
        e instanceof ApiClientError && e.status === 404
          ? 'This parent link is invalid, revoked or expired. Please ask the school admin for a new link.'
          : 'Could not open this link. Check your connection and try again.',
      );
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Spinner label="Opening parent portal…" />;

  if (!data) {
    return (
      <div className="mx-auto min-h-screen w-full max-w-2xl bg-slate-50 px-4 py-6">
        <div className="mb-4 text-center">
          <p className="text-xl font-bold text-brand-900">🏫 Student Manager</p>
          <p className="text-sm text-slate-500">Parent portal — no login needed</p>
        </div>
        <EmptyState title="Link could not be opened" body={error || 'Ask the school admin for a fresh parent link.'} />
        <DeveloperFooter />
      </div>
    );
  }

  const feeBalance = data.fees.reduce((sum, f) => sum + Math.max(0, f.amount_due - f.amount_paid - f.discount), 0);

  return (
    <div className="mx-auto min-h-screen w-full max-w-2xl bg-slate-50 px-4 py-6">
      <div className="mb-4 text-center">
        <p className="text-xl font-bold text-brand-900">🏫 Student Manager</p>
        <p className="text-sm text-slate-500">{data.school.name} · Parent portal</p>
      </div>

      <Card className="mb-4 p-4">
        <h1 className="text-lg font-bold text-slate-900">{data.student.name}</h1>
        <p className="text-sm text-slate-500">
          Class {data.student.class_name}
          {data.student.roll_no ? ` · Roll no. ${data.student.roll_no}` : ''}
          {data.student.admission_no ? ` · Admission no. ${data.student.admission_no}` : ''}
        </p>
        {feeBalance > 0 && (
          <p className="mt-2 text-sm font-medium text-amber-700">Outstanding fee balance: Rs {feeBalance.toLocaleString()}</p>
        )}
      </Card>

      <Tabs
        tabs={[
          { key: 'attendance', label: 'Attendance' },
          { key: 'results', label: 'Results' },
          { key: 'fees', label: 'Fees' },
          { key: 'timetable', label: 'Timetable' },
          { key: 'announcements', label: 'Announcements' },
          { key: 'homework', label: 'Homework' },
        ]}
        active={tab}
        onChange={(k) => setTab(k as TabKey)}
      />

      <div className="mt-4">
        {tab === 'attendance' && <AttendanceTab data={data} />}
        {tab === 'results' && <ResultsTab data={data} />}
        {tab === 'fees' && <FeesTab data={data} />}
        {tab === 'timetable' && <TimetableTab data={data} />}
        {tab === 'announcements' && <AnnouncementsTab data={data} />}
        {tab === 'homework' && <HomeworkTab data={data} />}
      </div>

      <p className="mt-4 text-center text-xs text-slate-400">
        Read-only — if anything looks wrong, contact the school office.
      </p>
      <DeveloperFooter />
    </div>
  );
}

function AttendanceTab({ data }: { data: ParentPortalData }) {
  if (data.attendance.length === 0) return <EmptyState title="No attendance yet" body="Attendance will show here once the teacher marks it." />;
  return (
    <ul className="space-y-2">
      {data.attendance.map((a) => (
        <li key={a.date} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3">
          <span className="text-sm font-medium text-slate-900">{a.date}</span>
          {a.status === 'present' ? (
            <Badge tone="green">Present</Badge>
          ) : a.status === 'absent' ? (
            <Badge tone="red">Absent</Badge>
          ) : (
            <Badge tone="slate">Not marked</Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

function ResultsTab({ data }: { data: ParentPortalData }) {
  if (data.results.length === 0) return <EmptyState title="No results yet" body="Exam results will show here once published." />;
  return (
    <ul className="space-y-2">
      {data.results.map((r) => (
        <li key={r.id} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-slate-900">{r.exam_name}</span>
            {r.grade && <Badge tone={r.grade === 'F' ? 'red' : 'green'}>{r.grade}</Badge>}
          </div>
          <p className="mt-1 text-sm text-slate-600">
            {r.obtained_marks ?? '—'} / {r.total_marks ?? '—'}
            {r.percentage !== null && r.percentage !== undefined ? ` · ${r.percentage}%` : ''}
            {r.position ? ` · Position ${r.position}` : ''}
          </p>
        </li>
      ))}
    </ul>
  );
}

function FeesTab({ data }: { data: ParentPortalData }) {
  if (data.fees.length === 0) return <EmptyState title="No fee records yet" body="Monthly fee bills will show here." />;
  return (
    <ul className="space-y-2">
      {data.fees.map((f) => {
        const balance = Math.max(0, f.amount_due - f.amount_paid - f.discount);
        return (
          <li key={f.month} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-slate-900">{f.month}</span>
              <Badge tone={f.status === 'paid' ? 'green' : f.status === 'partial' ? 'amber' : 'red'}>{f.status}</Badge>
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Due Rs {f.amount_due.toLocaleString()} · Paid Rs {f.amount_paid.toLocaleString()}
              {balance > 0 ? ` · Balance Rs ${balance.toLocaleString()}` : ' · Fully paid'}
            </p>
            {f.receipt_no && <p className="text-xs text-slate-400">Receipt {f.receipt_no}</p>}
          </li>
        );
      })}
    </ul>
  );
}

function TimetableTab({ data }: { data: ParentPortalData }) {
  if (data.timetable.length === 0) return <EmptyState title="No timetable yet" body="The class timetable will show here once the school sets it." />;
  return (
    <div className="space-y-3">
      {data.timetable.map((d) => (
        <Card key={d.day_of_week} className="p-4">
          <h2 className="text-sm font-bold text-slate-900">{DAY_NAMES[d.day_of_week] ?? `Day ${d.day_of_week}`}</h2>
          <ul className="mt-2 space-y-1.5">
            {d.periods.map((p) => (
              <li key={p.period_no} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-slate-900">
                  {p.period_no}. {p.subject}
                  {p.teacher_name ? ` — ${p.teacher_name}` : ''}
                </span>
                <span className="text-slate-500">
                  {p.start_time}–{p.end_time}
                  {p.room ? ` · ${p.room}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function AnnouncementsTab({ data }: { data: ParentPortalData }) {
  if (data.announcements.length === 0) return <EmptyState title="No announcements" body="School announcements will show here." />;
  return (
    <ul className="space-y-2">
      {data.announcements.map((a) => (
        <li key={a.id} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-sm font-medium text-slate-900">{a.title}</p>
          <p className="mt-1 text-sm text-slate-600">{a.body}</p>
        </li>
      ))}
    </ul>
  );
}

function HomeworkTab({ data }: { data: ParentPortalData }) {
  if (data.homework.length === 0) return <EmptyState title="No homework" body="Homework for this class will show here." />;
  return (
    <ul className="space-y-2">
      {data.homework.map((h) => (
        <li key={h.id} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-slate-900">{h.title}</span>
            <Badge tone="blue">{h.subject}</Badge>
          </div>
          {h.description && <p className="mt-1 text-sm text-slate-600">{h.description}</p>}
          <p className="mt-1 text-xs text-slate-500">
            Due {h.due_date} · {h.teacher}
          </p>
        </li>
      ))}
    </ul>
  );
}

export { AttendanceTab, ResultsTab, FeesTab, TimetableTab, AnnouncementsTab, HomeworkTab };
