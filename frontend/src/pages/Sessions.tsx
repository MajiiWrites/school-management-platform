// Sessions page (6C-1): academic-year CRUD, archive/unarchive, make-current,
// whole-class promotion + promotion history.
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { AcademicSession, ClassItem, PageResult } from '../lib/types';
import { fmtDate } from '../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Modal, Spinner, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

function queuedToast(push: (tone: 'success' | 'error', message: string) => void, result: unknown, doneMsg: string): void {
  if ((result as { status?: string } | null)?.status === 'pending') push('success', 'Submitted for admin approval — nothing was applied yet.');
  else push('success', doneMsg);
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [editing, setEditing] = useState<AcademicSession | null>(null);
  const [editName, setEditName] = useState('');
  const [pendingAction, setPendingAction] = useState<{ kind: 'make-current' | 'archive' | 'unarchive' | 'delete'; session: AcademicSession } | null>(null);
  const [promoteSessionId, setPromoteSessionId] = useState('');
  const [fromClass, setFromClass] = useState('');
  const [toClass, setToClass] = useState('');
  const [promotions, setPromotions] = useState<{ student_name: string | null; from_class: string | null; to_class: string | null; promoted_at: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<PageResult<AcademicSession>>('/sessions?limit=100'),
      api<PageResult<ClassItem>>('/classes?limit=200'),
    ])
      .then(([ss, cc]) => {
        setSessions(ss.items);
        setClasses(cc.items);
        setError('');
      })
      .catch(() => setError('Could not load sessions.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    if (!promoteSessionId) {
      setPromotions([]);
      return;
    }
    api<PageResult<{ student_name: string | null; from_class: string | null; to_class: string | null; promoted_at: string }>>(
      `/sessions/${promoteSessionId}/promotions?limit=100`,
    )
      .then((d) => setPromotions(d.items))
      .catch(() => undefined);
  }, [promoteSessionId]);

  const visible = showArchived ? sessions : sessions.filter((s) => !s.is_archived);
  const current = sessions.find((s) => s.is_current);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const result = await api('/sessions', { method: 'POST', body: { name: name.trim(), start_date: startDate, end_date: endDate } });
      queuedToast(push, result, 'Session created.');
      setName('');
      setStartDate('');
      setEndDate('');
      load();
    } catch (err) {
      push('error', errText(err));
    } finally {
      setBusy(false);
    }
  };

  const doAction = async () => {
    const action = pendingAction;
    setPendingAction(null);
    if (!action) return;
    try {
      if (action.kind === 'make-current') {
        await api(`/sessions/${action.session.id}/make-current`, { method: 'POST' });
        push('success', 'Session set as current.');
      } else if (action.kind === 'archive') {
        const r = await api(`/sessions/${action.session.id}/archive`, { method: 'POST' });
        queuedToast(push, r, 'Session archived — it is now read-only.');
      } else if (action.kind === 'unarchive') {
        await api(`/sessions/${action.session.id}/unarchive`, { method: 'POST' });
        push('success', 'Session unarchived.');
      } else {
        const r = await api(`/sessions/${action.session.id}`, { method: 'DELETE' });
        queuedToast(push, r, 'Session deleted.');
      }
      load();
    } catch (err) {
      push('error', errText(err));
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      const r = await api(`/sessions/${editing.id}`, { method: 'PATCH', body: { name: editName.trim() } });
      queuedToast(push, r, 'Session updated.');
      setEditing(null);
      load();
    } catch (err) {
      push('error', errText(err));
    }
  };

  const promote = async () => {
    const sessionId = promoteSessionId || current?.id;
    if (!sessionId || !fromClass || !toClass) {
      push('error', 'Pick a session, a from class and a to class.');
      return;
    }
    try {
      const result = await api<{ promoted: number }>(`/sessions/${sessionId}/promote`, {
        method: 'POST',
        body: { from_class_id: fromClass, to_class_id: toClass },
      });
      push('success', `${result.promoted} student(s) promoted.`);
      setFromClass('');
      setToClass('');
    } catch (err) {
      push('error', errText(err));
    }
  };

  if (loading) return <Spinner label="Loading sessions…" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Academic sessions</h1>
          <p className="text-sm text-slate-500">Years, set-current, archive, and class promotion.</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      <Card className="p-5">
        <h2 className="text-base font-semibold">New session</h2>
        <form onSubmit={create} autoComplete="off" className="mt-3 grid gap-3 sm:grid-cols-4">
          <Field label="Name">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 2026-27" autoComplete="off" required />
          </Field>
          <Field label="Start date">
            <input type="date" className={inputCls} value={startDate} onChange={(e) => setStartDate(e.target.value)} autoComplete="off" required />
          </Field>
          <Field label="End date">
            <input type="date" className={inputCls} value={endDate} onChange={(e) => setEndDate(e.target.value)} autoComplete="off" required />
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={busy}>Add session</Button>
          </div>
        </form>
      </Card>

      {visible.length === 0 ? (
        <EmptyState title="No sessions yet" body="Add your first academic year above — for example 2026-27." />
      ) : (
        <Card className="p-5">
          <ul className="divide-y divide-slate-100">
            {visible.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 py-3 text-sm">
                <span className="font-medium">{s.name}</span>
                <span className="text-slate-500">{fmtDate(s.start_date)} → {fmtDate(s.end_date)}</span>
                {s.is_current && <Badge tone="green">Current</Badge>}
                {s.is_archived && <Badge tone="slate">Archived — read-only</Badge>}
                <span className="ml-auto flex flex-wrap gap-1">
                  {!s.is_current && !s.is_archived && (
                    <Button variant="ghost" onClick={() => setPendingAction({ kind: 'make-current', session: s })}>Make current</Button>
                  )}
                  {!s.is_archived && (
                    <>
                      <Button variant="ghost" onClick={() => { setEditing(s); setEditName(s.name); }}>Edit</Button>
                      <Button variant="ghost" onClick={() => setPendingAction({ kind: 'archive', session: s })}>Archive</Button>
                    </>
                  )}
                  {s.is_archived && (
                    <Button variant="ghost" onClick={() => setPendingAction({ kind: 'unarchive', session: s })}>Unarchive</Button>
                  )}
                  {!s.is_current && (
                    <Button variant="ghost" onClick={() => setPendingAction({ kind: 'delete', session: s })}>Delete</Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-5">
        <h2 className="text-base font-semibold">Promote a whole class to the next class</h2>
        <p className="mt-1 text-sm text-slate-500">Every active student in the from class moves to the to class, in the selected session.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Field label="Session">
            <select className={inputCls} value={promoteSessionId} onChange={(e) => setPromoteSessionId(e.target.value)}>
              <option value="">Current session{current ? ` (${current.name})` : ''}</option>
              {sessions.filter((s) => !s.is_archived).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="From class">
            <select className={inputCls} value={fromClass} onChange={(e) => setFromClass(e.target.value)}>
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
        <Button className="mt-4" onClick={promote} disabled={!fromClass || !toClass}>Promote class</Button>
        {promoteSessionId && promotions.length > 0 && (
          <ul className="mt-4 divide-y divide-slate-100 text-sm">
            {promotions.map((p, i) => (
              <li key={i} className="py-2">
                {p.student_name ?? '—'} — {p.from_class} → {p.to_class}
                <span className="text-slate-400"> · {fmtDate(p.promoted_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {editing && (
        <Modal title="Edit session" onClose={() => setEditing(null)}>
          <form
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              saveEdit();
            }}
          >
            <Field label="Name">
              <input className={inputCls} value={editName} onChange={(e) => setEditName(e.target.value)} autoComplete="off" required />
            </Field>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
              <Button type="submit">Save</Button>
            </div>
          </form>
        </Modal>
      )}

      <ConfirmDialog
        open={pendingAction !== null}
        title={
          pendingAction?.kind === 'make-current'
            ? 'Make this the current session?'
            : pendingAction?.kind === 'archive'
              ? 'Archive this session?'
              : pendingAction?.kind === 'unarchive'
                ? 'Unarchive this session?'
                : 'Delete this session?'
        }
        message={
          pendingAction
            ? pendingAction.kind === 'archive'
              ? `Are you sure? "${pendingAction.session.name}" will become read-only — no promotions, edits, or new exams in it.`
              : pendingAction.kind === 'delete'
                ? `Are you sure? "${pendingAction.session.name}" will be deleted. Sessions with exams or promotion records cannot be deleted.`
                : `Are you sure? This will ${pendingAction.kind === 'make-current' ? `make "${pendingAction.session.name}" the current session` : `unarchive "${pendingAction.session.name}"`}.`
            : ''
        }
        confirmLabel={pendingAction?.kind === 'delete' ? 'Delete session' : 'Confirm'}
        tone={pendingAction?.kind === 'delete' ? 'danger' : 'primary'}
        onConfirm={doAction}
        onCancel={() => setPendingAction(null)}
      />
      {view}
    </div>
  );
}
