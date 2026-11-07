// Sessions page (6C-1): academic-year CRUD, archive/unarchive, make-current,
// whole-class promotion + promotion history.
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { AcademicSession, ClassItem, PageResult, PromotionBatch, PromotionItem, PromotionOutcome, PromotionPreview, Student } from '../lib/types';
import { fmtDate, todayISO } from '../lib/utils';
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
  // Promotion rebuild (Module D): preview before confirm, per-student
  // selection (unchecked = held back), graduate/hold outcomes, batch undo,
  // single-student edit. Preview and apply send the SAME mappings, so the
  // admin confirms exactly what was previewed.
  const [promoteSessionId, setPromoteSessionId] = useState('');
  const [fromClass, setFromClass] = useState('');
  const [toClass, setToClass] = useState('');
  const [outcome, setOutcome] = useState<PromotionOutcome>('promoted');
  const [fromStudents, setFromStudents] = useState<Student[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<PromotionPreview | null>(null);
  const [previewMappings, setPreviewMappings] = useState<{ student_id: string; to_class_id?: string | null; outcome?: PromotionOutcome }[]>([]);
  const [promotions, setPromotions] = useState<PromotionItem[]>([]);
  const [batches, setBatches] = useState<PromotionBatch[]>([]);
  const [undoBatch, setUndoBatch] = useState<PromotionBatch | null>(null);
  const [editingPromotion, setEditingPromotion] = useState<PromotionItem | null>(null);
  const [editToClass, setEditToClass] = useState('');
  const [editOutcome, setEditOutcome] = useState<PromotionOutcome>('promoted');
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

  const loadPromotions = useCallback((sessionId: string) => {
    Promise.all([
      api<PageResult<PromotionItem>>(`/sessions/${sessionId}/promotions?limit=100`),
      api<PageResult<PromotionBatch>>(`/sessions/${sessionId}/promotion-batches`),
    ])
      .then(([p, b]) => {
        setPromotions(p.items);
        setBatches(b.items);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!promoteSessionId) {
      setPromotions([]);
      setBatches([]);
      return;
    }
    loadPromotions(promoteSessionId);
  }, [promoteSessionId, loadPromotions]);

  // Students of the from class, for per-student selection. Non-active
  // students are shown but cannot be selected — they are never promoted.
  useEffect(() => {
    if (!fromClass) {
      setFromStudents([]);
      setSelectedIds(new Set());
      setPreview(null);
      return;
    }
    api<PageResult<Student>>(`/classes/${fromClass}/students?limit=200`)
      .then((d) => {
        setFromStudents(d.items);
        setSelectedIds(new Set(d.items.filter((s) => s.status === 'active').map((s) => s.id)));
        setPreview(null);
      })
      .catch(() => setFromStudents([]));
  }, [fromClass]);

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

  const buildMappings = (): { student_id: string; to_class_id?: string | null; outcome?: PromotionOutcome }[] => {
    // Only selected ACTIVE students are mapped; unselected ones are held
    // back, and left/struck-off/graduated students are never mappable.
    return fromStudents
      .filter((s) => selectedIds.has(s.id) && s.status === 'active')
      .map((s) => (outcome === 'promoted' ? { student_id: s.id, to_class_id: toClass, outcome } : { student_id: s.id, outcome }));
  };

  const showPreview = async () => {
    const sessionId = promoteSessionId || current?.id;
    const mappings = buildMappings();
    if (!sessionId) {
      push('error', 'Pick a session first.');
      return;
    }
    if (mappings.length === 0) {
      push('error', 'Select at least one active student to promote.');
      return;
    }
    if (outcome === 'promoted' && !toClass) {
      push('error', 'Pick a target class.');
      return;
    }
    setBusy(true);
    try {
      const data = await api<PromotionPreview>(`/sessions/${sessionId}/promotions/preview`, { method: 'POST', body: { mappings } });
      setPreview(data);
      setPreviewMappings(mappings);
    } catch (err) {
      push('error', errText(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmApply = async () => {
    const sessionId = promoteSessionId || current?.id;
    if (!sessionId || !preview) return;
    setBusy(true);
    try {
      const result = await api<{ promoted: number; graduated: number; held: number; skipped: { reason: string }[]; batch_id: string }>(
        `/sessions/${sessionId}/promotions`,
        { method: 'POST', body: { mappings: previewMappings } },
      );
      push('success', `Promotion applied: ${result.promoted} promoted, ${result.graduated} graduated, ${result.held} held${result.skipped.length ? `, ${result.skipped.length} skipped` : ''}.`);
      setPreview(null);
      setPreviewMappings([]);
      loadPromotions(sessionId);
    } catch (err) {
      push('error', errText(err));
    } finally {
      setBusy(false);
    }
  };

  const doUndoBatch = async () => {
    const batch = undoBatch;
    setUndoBatch(null);
    if (!batch) return;
    try {
      const result = await api<{ reversed: number }>(`/sessions/${batch.session_id}/promotion-batches/${batch.batch_id}/undo`, { method: 'POST' });
      push('success', `Undone: ${result.reversed} student(s) moved back.`);
      loadPromotions(batch.session_id);
    } catch (err) {
      push('error', errText(err));
    }
  };

  const savePromotionEdit = async () => {
    if (!editingPromotion) return;
    try {
      await api(`/sessions/${editingPromotion.session_id}/promotions/${editingPromotion.id}`, {
        method: 'PATCH',
        body: editOutcome === 'promoted' ? { to_class_id: editToClass, outcome: 'promoted' } : { outcome: editOutcome },
      });
      push('success', 'Promotion updated.');
      setEditingPromotion(null);
      loadPromotions(editingPromotion.session_id);
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
            {/* R2-D (h): no "Today" control existed anywhere — the native
                date input offers none — so the re-test's Today click could
                not set a date. Explicit button, school-local (PKT) today. */}
            <div className="flex gap-2">
              <input type="date" className={inputCls} value={startDate} onChange={(e) => setStartDate(e.target.value)} autoComplete="off" required />
              <Button type="button" variant="secondary" onClick={() => setStartDate(todayISO())}>Today</Button>
            </div>
          </Field>
          <Field label="End date">
            <div className="flex gap-2">
              <input type="date" className={inputCls} value={endDate} onChange={(e) => setEndDate(e.target.value)} autoComplete="off" required />
              <Button type="button" variant="secondary" onClick={() => setEndDate(todayISO())}>Today</Button>
            </div>
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
        <h2 className="text-base font-semibold">Promote students</h2>
        <p className="mt-1 text-sm text-slate-500">
          Pick a class, tick the students to move (unticked students are held back), then preview — nothing moves until you confirm the preview.
          Left, struck-off and graduated students can never be promoted. For the highest class, choose Graduate instead of a target class.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
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
          <Field label="What happens">
            <select className={inputCls} value={outcome} onChange={(e) => setOutcome(e.target.value as PromotionOutcome)}>
              <option value="promoted">Promote to next class</option>
              <option value="graduated">Graduate (highest class)</option>
              <option value="held">Hold in this class</option>
            </select>
          </Field>
          <Field label="To class">
            <select className={inputCls} value={toClass} onChange={(e) => setToClass(e.target.value)} disabled={outcome !== 'promoted'}>
              <option value="">Select…</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>Class {c.name}-{c.section}</option>
              ))}
            </select>
          </Field>
        </div>

        {fromClass && fromStudents.length > 0 && (
          <div className="mt-4">
            <p className="text-sm font-medium text-slate-700">
              Students in {classes.find((c) => c.id === fromClass) ? `Class ${classes.find((c) => c.id === fromClass)!.name}-${classes.find((c) => c.id === fromClass)!.section}` : ''} — {selectedIds.size} selected
            </p>
            <ul className="mt-2 divide-y divide-slate-100 text-sm">
              {fromStudents.map((s) => (
                <li key={s.id} className="flex items-center gap-2 py-2">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(s.id)}
                    disabled={s.status !== 'active'}
                    onChange={(e) => {
                      const next = new Set(selectedIds);
                      if (e.target.checked) next.add(s.id);
                      else next.delete(s.id);
                      setSelectedIds(next);
                    }}
                  />
                  <span className={s.status === 'active' ? '' : 'text-slate-400'}>{s.name}</span>
                  <span className="text-slate-400">Roll {s.roll_no ?? '—'}</span>
                  {s.status !== 'active' && <Badge tone="slate">{s.status.replace('_', ' ')} — never promoted</Badge>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {fromClass && fromStudents.length === 0 && (
          <p className="mt-4 text-sm text-slate-500">No students in this class.</p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={showPreview} disabled={busy || !fromClass || selectedIds.size === 0 || (outcome === 'promoted' && !toClass)}>
            Preview promotion
          </Button>
          {preview && (
            <Button variant="secondary" onClick={() => setPreview(null)}>Discard preview</Button>
          )}
        </div>

        {preview && (
          <div className="mt-4 rounded-lg border border-slate-200 p-4">
            <h3 className="text-sm font-semibold">Preview — {preview.ready} ready, {preview.skipped} skipped</h3>
            <p className="mt-1 text-xs text-slate-500">Check every row: roll numbers are assigned after the highest roll already in the target class, so nothing collides. Confirm applies exactly this.</p>
            <ul className="mt-3 divide-y divide-slate-100 text-sm">
              {preview.rows.map((r) => (
                <li key={r.student_id} className="py-2">
                  {r.student_name ?? '—'} — Roll {r.roll_no_from ?? '—'} → {r.outcome === 'promoted' ? `Roll ${r.roll_no_to ?? '—'}` : r.outcome}
                  {r.status === 'skipped' ? (
                    <span className="text-amber-600"> · Skipped: {r.skip_reason}</span>
                  ) : (
                    <span className="text-slate-400"> · {r.outcome}</span>
                  )}
                </li>
              ))}
            </ul>
            <Button className="mt-3" onClick={confirmApply} disabled={busy || preview.ready === 0}>
              Confirm — apply this promotion
            </Button>
          </div>
        )}
      </Card>

      {promoteSessionId && batches.length > 0 && (
        <Card className="p-5">
          <h2 className="text-base font-semibold">Promotion batches</h2>
          <p className="mt-1 text-sm text-slate-500">Each confirmed promotion is one batch. Undo moves every student in the batch back to their old class and roll number.</p>
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {batches.map((b) => (
              <li key={b.batch_id} className="flex flex-wrap items-center gap-2 py-2">
                <span>{fmtDate(b.promoted_at)}</span>
                <span className="text-slate-500">
                  {b.students} student(s) · {b.outcomes.promoted} promoted · {b.outcomes.graduated} graduated · {b.outcomes.held} held
                </span>
                <Badge tone={b.status === 'applied' ? 'green' : b.status === 'reversed' ? 'slate' : 'amber'}>{b.status.replace('_', ' ')}</Badge>
                {b.status !== 'reversed' && (
                  <Button variant="ghost" onClick={() => setUndoBatch(b)}>Undo batch</Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {promoteSessionId && promotions.length > 0 && (
        <Card className="p-5">
          <h2 className="text-base font-semibold">Promotion history</h2>
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {promotions.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
                <span>{p.student_name ?? '—'}</span>
                <span className="text-slate-500">{p.from_class} → {p.to_class}</span>
                <span className="text-slate-400">Roll {p.roll_no_from ?? '—'} → {p.roll_no_to ?? '—'}</span>
                <Badge tone={p.status === 'applied' ? 'green' : p.status === 'reversed' ? 'slate' : 'amber'}>{p.status}</Badge>
                <Badge tone="slate">{p.outcome}</Badge>
                <span className="text-slate-400">{fmtDate(p.promoted_at)}</span>
                {p.status === 'applied' && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEditingPromotion(p);
                      setEditToClass('');
                      setEditOutcome('promoted');
                    }}
                  >
                    Edit
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {editingPromotion && (
        <Modal title={`Edit promotion — ${editingPromotion.student_name ?? ''}`} onClose={() => setEditingPromotion(null)}>
          <p className="text-sm text-slate-500">
            Move this student to a different class (or graduate them). The old promotion is kept as superseded history; the rest of the batch is untouched.
          </p>
          <Field label="Change to">
            <select className={inputCls} value={editOutcome} onChange={(e) => setEditOutcome(e.target.value as PromotionOutcome)}>
              <option value="promoted">Promote to another class</option>
              <option value="graduated">Graduate</option>
            </select>
          </Field>
          {editOutcome === 'promoted' && (
            <Field label="To class">
              <select className={inputCls} value={editToClass} onChange={(e) => setEditToClass(e.target.value)}>
                <option value="">Select…</option>
                {classes.filter((c) => c.id !== editingPromotion.to_class_id).map((c) => (
                  <option key={c.id} value={c.id}>Class {c.name}-{c.section}</option>
                ))}
              </select>
            </Field>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditingPromotion(null)}>Cancel</Button>
            <Button onClick={savePromotionEdit} disabled={editOutcome === 'promoted' && !editToClass}>Save</Button>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={undoBatch !== null}
        title="Undo this promotion batch?"
        message={undoBatch ? `All ${undoBatch.students} student(s) in this batch move back to their old class and roll number. This is recorded in the change history.` : ''}
        confirmLabel="Undo batch"
        tone="danger"
        onConfirm={doUndoBatch}
        onCancel={() => setUndoBatch(null)}
      />

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
