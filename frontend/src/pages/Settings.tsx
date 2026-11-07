import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api';
import type {
  AcademicSession,
  AuditLog,
  ClassItem,
  Holiday,
  JobStatus,
  PageResult,
  SchoolSettings,
  Student,
} from '../lib/types';
import { fmtDate, fmtDateTime } from '../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Spinner, Tabs, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

export default function SettingsPage() {
  const [tab, setTab] = useState('school');
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500">School settings, holidays, sessions, promotion and audit log. Admin only.</p>
      </div>
      <Tabs
        tabs={[
          { key: 'school', label: 'School & SMS' },
          { key: 'holidays', label: 'Holidays' },
          { key: 'sessions', label: 'Sessions & promotion' },
          { key: 'users', label: 'Clerk logins' },
          { key: 'jobs', label: 'Scheduled jobs' },
          { key: 'audit', label: 'Audit log' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'school' && <SchoolSettingsTab />}
      {tab === 'holidays' && <HolidaysTab />}
      {tab === 'sessions' && <SessionsTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'jobs' && <JobsTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}

/* ---------- School & SMS settings ---------- */

function SchoolSettingsTab() {
  const [s, setS] = useState<SchoolSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { push, view } = useToast();

  useEffect(() => {
    api<SchoolSettings>('/settings')
      .then(setS)
      .catch(() => setError('Could not load settings.'))
      .finally(() => setLoading(false));
  }, []);

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!s) return;
    setConfirming(true);
  };

  const doSave = async () => {
    if (!s) return;
    setConfirming(false);
    setBusy(true);
    try {
      await api('/settings', { method: 'PATCH', body: s });
      push('success', 'Settings saved.');
    } catch (err) {
      push('error', errText(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner label="Loading settings…" />;
  if (!s) return <ErrorBanner message={error || 'Settings unavailable.'} />;

  return (
    <Card className="max-w-2xl p-5">
      {error && <ErrorBanner message={error} />}
      <form onSubmit={save} className="space-y-4" autoComplete="off">
        <Field label="Teacher reminder time" hint="Classes with no attendance by this time get a reminder. Never on Sundays or holidays.">
          <input className={inputCls} type="time" value={s.teacher_reminder_time} onChange={(e) => setS({ ...s, teacher_reminder_time: e.target.value })} autoComplete="off" />
        </Field>
        <Field label="SMS provider">
          <select className={inputCls} value={s.sms_provider} onChange={(e) => setS({ ...s, sms_provider: e.target.value as 'sim' | 'gateway' })}>
            <option value="sim">Admin SIM (Android companion app)</option>
            <option value="gateway">SMS gateway (Twilio / local provider)</option>
          </select>
        </Field>
        <Field label="Teacher attendance mode">
          <select className={inputCls} value={s.teacher_attendance_mode} onChange={(e) => setS({ ...s, teacher_attendance_mode: e.target.value as 'admin' | 'link' })}>
            <option value="link">Teacher link (teacher marks via link)</option>
            <option value="admin">Admin marks teacher attendance</option>
          </select>
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={s.fee_auto_send} onChange={(e) => setS({ ...s, fee_auto_send: e.target.checked })} />
          Auto-send fee reminders on the 1st of the month
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={s.fee_require_approval} onChange={(e) => setS({ ...s, fee_require_approval: e.target.checked })} />
          Require admin approval before fee reminders are sent
        </label>
        <Field label="Fee follow-up day (optional)" hint="Send a second reminder on this day of the month, e.g. 10. Leave blank to disable.">
          <input
            className={inputCls}
            type="number"
            min={2}
            max={28}
            value={s.fee_followup_day ?? ''}
            onChange={(e) => setS({ ...s, fee_followup_day: e.target.value ? Number(e.target.value) : null })}
            placeholder="e.g. 10" autoComplete="off" />
        </Field>
        {/* 6C-2: school identity + display language. Logo is stored as a
            data URL in settings (max ~500 KB); it appears on certificates
            and ID cards. Language changes the navigation labels only — see
            lib/i18n.tsx for the honest coverage note. */}
        <Field label="School name">
          <input className={inputCls} value={s.school_name ?? ''} onChange={(e) => setS({ ...s, school_name: e.target.value })} placeholder="e.g. Demo Public School" autoComplete="off" />
        </Field>
        <Field label="Timezone">
          <select className={inputCls} value={s.timezone ?? 'Asia/Karachi'} onChange={(e) => setS({ ...s, timezone: e.target.value })}>
            <option value="Asia/Karachi">Asia/Karachi (Pakistan)</option>
            <option value="Asia/Dubai">Asia/Dubai (UAE)</option>
            <option value="Asia/Kolkata">Asia/Kolkata (India)</option>
            <option value="Asia/Dhaka">Asia/Dhaka (Bangladesh)</option>
            <option value="Europe/London">Europe/London (UK)</option>
            <option value="America/New_York">America/New_York (US East)</option>
            <option value="UTC">UTC</option>
          </select>
        </Field>
        <Field label="School address">
          <input className={inputCls} value={s.school_address ?? ''} onChange={(e) => setS({ ...s, school_address: e.target.value })} placeholder="Street, town/city" autoComplete="off" />
        </Field>
        <Field label="School phone">
          <input className={inputCls} value={s.school_phone ?? ''} onChange={(e) => setS({ ...s, school_phone: e.target.value })} placeholder="e.g. 03001234567" autoComplete="off" />
        </Field>
        <Field label="School logo" hint="Shown on certificates and ID cards. JPG/PNG up to ~500 KB.">
          <div className="flex items-center gap-3">
            {s.logo_url ? <img src={s.logo_url} alt="School logo" className="h-12 max-w-[120px] rounded border border-slate-200 object-contain" /> : <span className="text-sm text-slate-400">No logo uploaded</span>}
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 500_000) {
                  push('error', 'Logo is too large — pick an image under 500 KB.');
                  return;
                }
                const reader = new FileReader();
                reader.onload = () => setS((prev) => (prev ? { ...prev, logo_url: String(reader.result) } : prev));
                reader.readAsDataURL(f);
              }}
            />
            {s.logo_url ? (
              <button type="button" className="text-sm font-medium text-red-600 hover:underline" onClick={() => setS({ ...s, logo_url: '' })}>Remove</button>
            ) : null}
          </div>
        </Field>
        <Field label="Language" hint="Changes the navigation labels (English / اردو). Forms and reports stay in English for now.">
          <select className={inputCls} value={s.language ?? 'en'} onChange={(e) => setS({ ...s, language: e.target.value as 'en' | 'ur' })}>
            <option value="en">English</option>
            <option value="ur">Urdu (اردو)</option>
          </select>
        </Field>
        <p className="text-sm text-slate-500">
          Message templates (SMS wording) live under <a className="font-medium text-brand-700 hover:underline" href="/messages">Messages → Templates</a>.
        </p>
        {/* 6D: idle/session timeout — enforced on refresh-token use; the frontend warns 2 min before. */}
        <Field label="Session timeout (minutes)" hint="Sign inactive sessions out after this long. 15–1440 minutes; default 120. A warning appears 2 minutes before sign-out.">
          <input
            className={inputCls}
            type="number"
            min={15}
            max={1440}
            value={s.session_timeout_minutes ?? 120}
            onChange={(e) => setS({ ...s, session_timeout_minutes: e.target.value ? Number(e.target.value) : 120 })}
            placeholder="120" autoComplete="off" />
        </Field>
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</Button>
      </form>
      <ConfirmDialog
        open={confirming}
        title="Save these settings?"
        message="Are you sure? This will update the school settings — teacher reminder time, SMS provider, attendance mode, fee-reminder rules and the session timeout — for the whole school."
        confirmLabel="Save settings"
        tone="primary"
        busy={busy}
        onConfirm={doSave}
        onCancel={() => setConfirming(false)}
      />
      {view}
    </Card>
  );
}

/* ---------- Holidays ---------- */

function HolidaysTab() {
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmingAdd, setConfirmingAdd] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<Holiday | null>(null);
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    api<PageResult<Holiday>>('/holidays?limit=100')
      .then((d) => setHolidays(d.items))
      .catch(() => setError('Could not load holidays.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const add = (e: FormEvent) => {
    e.preventDefault();
    setConfirmingAdd(true);
  };

  const doAdd = async () => {
    setConfirmingAdd(false);
    try {
      await api('/holidays', { method: 'POST', body: { date, name: name.trim() } });
      setDate('');
      setName('');
      push('success', 'Holiday added — no attendance or messages on that day.');
      load();
    } catch (err) {
      push('error', errText(err));
    }
  };

  const remove = async (h: Holiday) => {
    try {
      await api(`/holidays/${h.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      push('error', errText(err));
    }
  };

  if (loading) return <Spinner label="Loading holidays…" />;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Sundays are always non-school days. Add other holidays here — no attendance reminders or messages are sent on these dates.
      </p>
      {error && <ErrorBanner message={error} onRetry={load} />}
      <Card className="p-5">
        <form onSubmit={add} className="flex flex-wrap items-end gap-3" autoComplete="off">
          <Field label="Date">
            <input className={inputCls} type="date" required value={date} onChange={(e) => setDate(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Holiday name">
            <input className={inputCls} required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Iqbal Day" autoComplete="off" />
          </Field>
          <Button type="submit">Add holiday</Button>
        </form>
      </Card>
      {holidays.length === 0 ? (
        <EmptyState title="No holidays added" body="Sundays are already treated as non-school days. Use the form above to add your first holiday." />
      ) : (
        <Card className="divide-y divide-slate-100">
          {holidays.map((h) => (
            <div key={h.id} className="flex items-center justify-between px-5 py-3 text-sm">
              <span>
                <strong>{fmtDate(h.date)}</strong> — {h.name}
              </span>
              <button className="font-medium text-red-600 hover:underline" onClick={() => setPendingRemove(h)}>Remove</button>
            </div>
          ))}
        </Card>
      )}
      <ConfirmDialog
        open={confirmingAdd}
        title="Add this holiday?"
        message={`Are you sure? This will add a holiday: ${name.trim() || '—'} on ${date || '—'}. No attendance reminders or messages will be sent on that day.`}
        confirmLabel="Add holiday"
        tone="primary"
        onConfirm={doAdd}
        onCancel={() => setConfirmingAdd(false)}
      />
      <ConfirmDialog
        open={pendingRemove !== null}
        title="Remove this holiday?"
        message={pendingRemove ? `Are you sure? This will remove the holiday ${pendingRemove.name} (${pendingRemove.date}) — attendance reminders and messages will run on that day again.` : ''}
        confirmLabel="Remove holiday"
        tone="danger"
        onConfirm={() => {
          const h = pendingRemove;
          setPendingRemove(null);
          if (h) remove(h);
        }}
        onCancel={() => setPendingRemove(null)}
      />
      {view}
    </div>
  );
}

/* ---------- Sessions & promotion ---------- */

function SessionsTab() {
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fromClass, setFromClass] = useState('');
  const [toClass, setToClass] = useState('');
  const [students, setStudents] = useState<Student[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingMakeCurrent, setPendingMakeCurrent] = useState<AcademicSession | null>(null);
  const [confirmingPromote, setConfirmingPromote] = useState(false);
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<PageResult<AcademicSession>>('/sessions'),
      api<PageResult<ClassItem>>('/classes'),
    ])
      .then(([ss, cc]) => {
        setSessions(ss.items);
        setClasses(cc.items);
      })
      .catch(() => setError('Could not load sessions.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    if (!fromClass) {
      setStudents([]);
      return;
    }
    api<PageResult<Student>>(`/classes/${fromClass}/students?limit=200`)
      .then((d) => setStudents(d.items))
      .catch(() => undefined);
  }, [fromClass]);

  const makeCurrent = async (id: string) => {
    try {
      await api(`/sessions/${id}/make-current`, { method: 'POST' });
      push('success', 'Session set as current.');
      load();
    } catch (e) {
      push('error', errText(e));
    }
  };

  const promote = async () => {
    // Runs ONLY from the ConfirmDialog onConfirm below.
    const current = sessions.find((s) => s.is_current);
    if (!current) {
      push('error', 'Set a current session first.');
      return;
    }
    if (selected.size === 0 || !toClass) {
      push('error', 'Pick a target class and at least one student.');
      return;
    }
    try {
      await api('/promotions', {
        method: 'POST',
        body: { session_id: current.id, mappings: [...selected].map((student_id) => ({ student_id, to_class_id: toClass })) },
      });
      push('success', `${selected.size} student(s) promoted.`);
      setSelected(new Set());
    } catch (e) {
      push('error', errText(e));
    }
  };

  if (loading) return <Spinner label="Loading sessions…" />;

  return (
    <div className="space-y-5">
      {error && <ErrorBanner message={error} onRetry={load} />}
      <Card className="p-5">
        <h2 className="text-base font-semibold">Academic sessions</h2>
        <ul className="mt-3 divide-y divide-slate-100">
          {sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="font-medium">{s.name}</span>
              <span className="text-slate-500">{fmtDate(s.start_date)} → {fmtDate(s.end_date)}</span>
              {s.is_current ? <Badge tone="green">Current</Badge> : (
                <Button variant="ghost" onClick={() => setPendingMakeCurrent(s)}>Make current</Button>
              )}
            </li>
          ))}
          {sessions.length === 0 && <li className="py-2 text-sm text-slate-500">No sessions yet.</li>}
        </ul>
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold">Promote students to the next class</h2>
        <p className="mt-1 text-sm text-slate-500">Pick a class, select students, and move them to their next class for the current session.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="From class">
            <select className={inputCls} value={fromClass} onChange={(e) => { setFromClass(e.target.value); setSelected(new Set()); }}>
              <option value="">Select…</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>Class {c.name}-{c.section}</option>
              ))}
            </select>
          </Field>
          <Field label="To class">
            <select className={inputCls} value={toClass} onChange={(e) => setToClass(e.target.value)}>
              <option value="">Select…</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>Class {c.name}-{c.section}</option>
              ))}
            </select>
          </Field>
        </div>
        {students.length > 0 && (
          <>
            <ul className="mt-4 divide-y divide-slate-100">
              {students.map((s) => (
                <li key={s.id} className="flex items-center gap-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(s.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(s.id);
                      else next.delete(s.id);
                      setSelected(next);
                    }}
                  />
                  <span className="font-medium">{s.name}</span>
                  <span className="text-slate-500">Roll {s.roll_no ?? '—'}</span>
                </li>
              ))}
            </ul>
            <Button className="mt-4" onClick={() => setConfirmingPromote(true)} disabled={selected.size === 0 || !toClass}>
              Promote {selected.size} student(s)
            </Button>
          </>
        )}
      </Card>
      <ConfirmDialog
        open={pendingMakeCurrent !== null}
        title="Make this the current session?"
        message={pendingMakeCurrent ? `Are you sure? This will make "${pendingMakeCurrent.name}" the current academic session. Promotions and new records will use it.` : ''}
        confirmLabel="Make current"
        tone="primary"
        onConfirm={() => {
          const s = pendingMakeCurrent;
          setPendingMakeCurrent(null);
          if (s) makeCurrent(s.id);
        }}
        onCancel={() => setPendingMakeCurrent(null)}
      />
      <ConfirmDialog
        open={confirmingPromote}
        title={`Promote ${selected.size} student(s)?`}
        message={`Are you sure? This will move ${selected.size} selected student(s) to ${classes.find((c) => c.id === toClass) ? `Class ${classes.find((c) => c.id === toClass)?.name}-${classes.find((c) => c.id === toClass)?.section}` : 'the selected class'} for the current session. This changes their class enrolment.`}
        confirmLabel={`Promote ${selected.size} student(s)`}
        tone="primary"
        onConfirm={() => {
          setConfirmingPromote(false);
          promote();
        }}
        onCancel={() => setConfirmingPromote(false)}
      />
      {view}
    </div>
  );
}

/* ---------- Clerk logins ---------- */

function UsersTab() {
  const [users, setUsers] = useState<{ id: string; email: string; role: string }[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmingCreate, setConfirmingCreate] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<{ id: string; email: string } | null>(null);
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    api<PageResult<{ id: string; email: string; role: string }>>('/users')
      .then((d) => setUsers(d.items))
      .catch(() => setError('Could not load users.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const create = (e: FormEvent) => {
    e.preventDefault();
    setConfirmingCreate(true);
  };

  const doCreate = async () => {
    setConfirmingCreate(false);
    try {
      await api('/users/clerks', { method: 'POST', body: { email: email.trim(), password } });
      setEmail('');
      setPassword('');
      push('success', 'Clerk login created. Clerks can mark fees and view records — they cannot manage users, settings, links, or approve messages.');
      load();
    } catch (err) {
      push('error', errText(err));
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/users/${id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      push('error', errText(err));
    }
  };

  if (loading) return <Spinner label="Loading users…" />;

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} onRetry={load} />}
      <Card className="p-5">
        <h2 className="text-base font-semibold">Create a clerk login</h2>
        <form onSubmit={create} className="mt-3 flex flex-wrap items-end gap-3" autoComplete="off">
          <Field label="Clerk email">
            <input className={inputCls} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="clerk@school.pk" autoComplete="off" />
          </Field>
          <Field label="Password" hint="At least 8 characters.">
            <input className={inputCls} type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          </Field>
          <Button type="submit">Create clerk</Button>
        </form>
      </Card>
      <Card className="divide-y divide-slate-100">
        {users.map((u) => (
          <div key={u.id} className="flex items-center justify-between px-5 py-3 text-sm">
            <span>
              <span className="font-medium">{u.email}</span>{' '}
              <Badge tone={u.role === 'admin' ? 'blue' : 'slate'}>{u.role}</Badge>
            </span>
            {u.role !== 'admin' && (
              <button className="font-medium text-red-600 hover:underline" onClick={() => setPendingRemove({ id: u.id, email: u.email })}>Delete</button>
            )}
          </div>
        ))}
        {users.length === 0 && <p className="px-5 py-4 text-sm text-slate-500">No users yet — create the first clerk login above.</p>}
      </Card>
      <ConfirmDialog
        open={confirmingCreate}
        title="Create this clerk login?"
        message={`Are you sure? This will create a clerk login for ${email.trim() || '—'}. Clerks can mark fees and view records — they cannot manage users, settings, links, or approve messages.`}
        confirmLabel="Create clerk"
        tone="primary"
        onConfirm={doCreate}
        onCancel={() => setConfirmingCreate(false)}
      />
      <ConfirmDialog
        open={pendingRemove !== null}
        title="Delete this user?"
        message={pendingRemove ? `Are you sure? This will delete the login for ${pendingRemove.email}. That person will no longer be able to log in.` : ''}
        confirmLabel="Delete user"
        tone="danger"
        onConfirm={() => {
          const u = pendingRemove;
          setPendingRemove(null);
          if (u) remove(u.id);
        }}
        onCancel={() => setPendingRemove(null)}
      />
      {view}
    </div>
  );
}

/* ---------- Scheduled jobs ---------- */

function JobsTab() {
  const [jobs, setJobs] = useState<JobStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api<JobStatus>('/jobs/status')
      .then(setJobs)
      .catch(() => setError('Could not load job status.'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spinner label="Loading job status…" />;
  if (!jobs) return <ErrorBanner message={error || 'Job status unavailable.'} />;

  const rows: { label: string; when: string; last: string | null | undefined }[] = [
    { label: 'Monthly fee reminder', when: '1st of every month, school timezone', last: jobs.monthly_fee_reminder },
    { label: 'Daily pending-attendance check', when: 'Every school day', last: jobs.daily_pending_attendance },
    { label: 'Teacher reminders', when: 'At the set reminder time', last: jobs.teacher_reminders },
  ];

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold">Scheduled jobs</h2>
      <p className="mt-1 text-sm text-slate-500">
        These run on the server (node-cron). Fee reminders skip Sundays and holidays; paid students are never reminded.
      </p>
      <ul className="mt-4 divide-y divide-slate-100">
        {rows.map((r) => (
          <li key={r.label} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
            <div>
              <p className="font-medium">{r.label}</p>
              <p className="text-slate-500">{r.when}</p>
            </div>
            <span className="text-slate-600">Last run: {fmtDateTime(r.last)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ---------- Audit log ---------- */

function AuditTab() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [action, setAction] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api<PageResult<AuditLog>>(`/audit-logs?limit=100${action ? `&action=${encodeURIComponent(action)}` : ''}`)
      .then((d) => setLogs(d.items))
      .catch(() => setError('Could not load audit log.'))
      .finally(() => setLoading(false));
  }, [action]);

  useEffect(load, [load]);

  if (loading) return <Spinner label="Loading audit log…" />;

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} onRetry={load} />}
      <div className="flex gap-2">
        <select className={inputCls + ' w-auto'} value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All actions</option>
          <option value="attendance.submit">Attendance submitted</option>
          <option value="fee.pay">Fee paid</option>
          <option value="message.approve">Message approved</option>
          <option value="message.send">Message sent</option>
          <option value="student.create">Student created</option>
        </select>
      </div>
      {logs.length === 0 ? (
        <EmptyState title="No audit entries" body="Every change — attendance, fees, messages — is recorded here." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Actor</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Entity</th>
                <th className="px-4 py-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {logs.map((l) => (
                <tr key={l.id} className="align-top hover:bg-slate-50">
                  <td className="px-4 py-2.5 text-xs">{fmtDateTime(l.created_at)}</td>
                  <td className="px-4 py-2.5">
                    {l.actor_email ? (
                      <span className="break-all text-slate-800">{l.actor_email}</span>
                    ) : (
                      <>
                        <Badge tone="slate">{l.actor_type}</Badge>
                        {l.actor_id ? (
                          <span className="ml-2 break-all text-xs text-slate-500">{l.actor_id.slice(0, 8)}</span>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">{l.action}</td>
                  <td className="px-4 py-2.5">{l.entity}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-600">{JSON.stringify(l.details)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
