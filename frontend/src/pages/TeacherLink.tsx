import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiClientError } from '../lib/api';
import type { AttendanceStatus, TeacherLinkData } from '../lib/types';
import { Badge, Button, Card, EmptyState, Spinner } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';
import DeveloperFooter from '../components/DeveloperFooter';
import { cx } from '../lib/utils';

type StatusMap = Record<string, AttendanceStatus>;

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: 'Present',
  absent: 'Absent',
  late: 'Late',
  leave: 'Leave',
};

function pendingKey(token: string): string {
  return `smp_pending_attendance_${token}`;
}
function cacheKey(token: string): string {
  return `smp_teacher_link_${token}`;
}

export default function TeacherLinkPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<TeacherLinkData | null>(null);
  const [statuses, setStatuses] = useState<StatusMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pendingOffline, setPendingOffline] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [confirmingSubmit, setConfirmingSubmit] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const d = await api<TeacherLinkData>(`/t/${token}`, { public: true });
      setData(d);
      localStorage.setItem(cacheKey(token), JSON.stringify(d));
      const initial: StatusMap = {};
      d.students.forEach((s) => {
        initial[s.id] = s.status ?? 'present';
      });
      setStatuses(initial);
      if (d.already_submitted) setSaved(true);
    } catch (e) {
      // Offline? Fall back to the cached class list so the teacher can still mark.
      const cached = localStorage.getItem(cacheKey(token));
      if (cached) {
        const d = JSON.parse(cached) as TeacherLinkData;
        setData(d);
        const initial: StatusMap = {};
        d.students.forEach((s) => {
          initial[s.id] = s.status ?? 'present';
        });
        setStatuses(initial);
        setError('You are offline — showing the last loaded class list. Your attendance will be sent when you are back online.');
      } else if (e instanceof ApiClientError) {
        setError(
          e.status === 404
            ? 'This attendance link is invalid or has been revoked. Please ask the school admin for a new link.'
            : e.message,
        );
      } else {
        setError('Could not open this link. Check your connection and try again.');
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Track connectivity + auto-retry any pending offline submission.
  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!token) return;
    const raw = localStorage.getItem(pendingKey(token));
    setPendingOffline(Boolean(raw));
  }, [token, saved]);

  const submit = useCallback(async () => {
    if (!token || !data) return;
    const records = data.students.map((s) => ({ student_id: s.id, status: statuses[s.id] ?? 'present' }));
    const payload = { records };
    setSaving(true);
    try {
      await api(`/t/${token}/submit`, { method: 'POST', body: payload, public: true });
      localStorage.removeItem(pendingKey(token));
      setPendingOffline(false);
      setSaved(true);
    } catch (e) {
      // Network failure → store locally, retry when online.
      const isNetwork =
        !navigator.onLine || !(e instanceof ApiClientError) || e.status === 0;
      if (isNetwork) {
        localStorage.setItem(pendingKey(token), JSON.stringify(payload));
        setPendingOffline(true);
      } else if (e instanceof ApiClientError && e.status === 409) {
        setSaved(true);
      } else {
        setError(e instanceof ApiClientError ? e.message : 'Could not save attendance.');
      }
    } finally {
      setSaving(false);
    }
  }, [token, data, statuses]);

  // Auto-retry pending payload when connectivity returns.
  useEffect(() => {
    if (!online || !pendingOffline || saved) return;
    submit();
  }, [online, pendingOffline, saved, submit]);

  const setAll = (status: AttendanceStatus) => {
    if (!data) return;
    const next: StatusMap = {};
    data.students.forEach((s) => {
      next[s.id] = status;
    });
    setStatuses(next);
  };

  const counts = data
    ? data.students.reduce(
        (acc, s) => {
          acc[statuses[s.id] ?? 'present'] += 1;
          return acc;
        },
        { present: 0, absent: 0, late: 0, leave: 0 } as Record<AttendanceStatus, number>,
      )
    : null;

  // Fix C (Phase 9): the API used to return only display_name, so
  // data.class.name/section were undefined ("Class -" / "undefined-
  // undefined"). The API now returns name + section; fall back to
  // display_name for copies cached on the device before the fix.
  const classLabel = data
    ? data.class.name && data.class.section
      ? `${data.class.name}-${data.class.section}`
      : (data.class.display_name ?? '—')
    : '—';

  if (loading) return <Spinner label="Opening attendance…" />;

  return (
    <div className="mx-auto min-h-screen w-full max-w-2xl bg-slate-50 px-4 py-6">
      <div className="mb-4 text-center">
        <p className="text-xl font-bold text-brand-900">🏫 School Manager</p>
        <p className="text-sm text-slate-500">Teacher attendance — no login needed</p>
      </div>

      {!online && (
        <p className="mb-4 rounded-lg bg-amber-100 px-4 py-2 text-center text-sm font-medium text-amber-800">
          You are offline. You can still mark attendance — it will be sent automatically when you are back online.
        </p>
      )}

      {error && (
        <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}

      {saved && data ? (
        <Card className="p-6 text-center">
          <p className="text-4xl">✅</p>
          <h1 className="mt-2 text-xl font-bold text-slate-900">Attendance saved</h1>
          <p className="mt-1 text-sm text-slate-500">
            Class {classLabel} · {data.date}
          </p>
          <p className="mt-3 text-sm text-slate-700">
            {counts?.present ?? 0} present · {counts?.absent ?? 0} absent · {counts?.late ?? 0} late · {counts?.leave ?? 0} on leave
          </p>
          {pendingOffline && (
            <p className="mt-3 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-800">
              Saved on this device — will be sent to the school when you are back online.
            </p>
          )}
          <p className="mt-4 text-xs text-slate-400">
            Attendance for this class today is locked. If something is wrong, ask the school admin to unlock it.
          </p>
        </Card>
      ) : data ? (
        <>
          <Card className="mb-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h1 className="text-lg font-bold text-slate-900">
                  Class {classLabel}
                </h1>
                <p className="text-sm text-slate-500">Date: {data.date}</p>
              </div>
              <Badge tone="blue">{data.students.length} students</Badge>
            </div>
            {counts && (
              <p className="mt-2 text-sm text-slate-600">
                {counts.present} present · {counts.absent} absent · {counts.late} late · {counts.leave} leave
              </p>
            )}
            <div className="mt-3 flex gap-2">
              <Button variant="secondary" onClick={() => setAll('present')}>
                Mark all present
              </Button>
              <Button variant="secondary" onClick={() => setAll('absent')}>
                Mark all absent
              </Button>
            </div>
          </Card>

          {data.students.length === 0 ? (
            <EmptyState title="No students in this class yet" body="Ask the school admin to add students first." />
          ) : (
            <ul className="space-y-2">
              {data.students.map((s, i) => {
                const st = statuses[s.id] ?? 'present';
                return (
                  <li key={s.id} className="rounded-xl border border-slate-200 bg-white p-3">
                    <div className="flex items-center gap-3">
                      <span className="w-6 text-sm font-medium text-slate-400">{s.roll_no ?? i + 1}</span>
                      <span className="flex-1 text-sm font-medium text-slate-900">{s.name}</span>
                    </div>
                    <div className="mt-2 grid grid-cols-4 gap-1.5">
                      {(Object.keys(STATUS_LABEL) as AttendanceStatus[]).map((opt) => (
                        <button
                          key={opt}
                          onClick={() => setStatuses((m) => ({ ...m, [s.id]: opt }))}
                          className={cx(
                            'rounded-lg border px-2 py-2 text-xs font-semibold',
                            st === opt
                              ? opt === 'present'
                                ? 'border-brand-700 bg-brand-700 text-white'
                                : opt === 'absent'
                                  ? 'border-red-600 bg-red-600 text-white'
                                  : opt === 'late'
                                    ? 'border-amber-500 bg-amber-500 text-white'
                                    : 'border-blue-600 bg-blue-600 text-white'
                              : 'border-slate-300 bg-white text-slate-600',
                          )}
                        >
                          {STATUS_LABEL[opt]}
                        </button>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <Button
            disabled={saving || data.students.length === 0}
            onClick={() => setConfirmingSubmit(true)}
            className="mt-5 w-full py-3 text-base"
          >
            {saving ? 'Saving…' : 'Save attendance'}
          </Button>
          <ConfirmDialog
            open={confirmingSubmit}
            title="Submit attendance?"
            message={
              counts
                ? `Are you sure? This will submit attendance for Class ${classLabel} (${data.date}): ${counts.present} present, ${counts.absent} absent, ${counts.late} late, ${counts.leave} on leave. One submission per class per day — it locks afterwards and only the admin can unlock it.`
                : ''
            }
            confirmLabel="Submit attendance"
            tone="primary"
            busy={saving}
            onConfirm={() => {
              setConfirmingSubmit(false);
              submit();
            }}
            onCancel={() => setConfirmingSubmit(false)}
          />
          {pendingOffline && (
            <p className="mt-3 rounded-lg bg-amber-100 px-3 py-2 text-center text-sm text-amber-800">
              Saved on this device — will be sent when you are back online.
            </p>
          )}
          <p className="mt-3 text-center text-xs text-slate-400">
            One submission per class per day. Only the admin can unlock it afterwards.
          </p>
        </>
      ) : (
        <EmptyState title="Link could not be opened" body="Ask the school admin for a fresh attendance link." />
      )}
      <DeveloperFooter />
    </div>
  );
}
