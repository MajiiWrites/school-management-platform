// Homework diary (Gap #3, 2026-11-20) — admin page: add homework per
// class, edit/delete, and "Notify parents" (queues one held SMS draft
// per eligible parent — the admin still approves it in Messages).
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { homeworkApi, ApiClientError, api } from '../lib/api';
import type { HomeworkItem, ClassItem, PageResult } from '../lib/types';
import { Badge, Button, EmptyState, ErrorBanner, Field, inputCls, Modal, Spinner, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

/** True when the API answered with a clerk 202 (queued for admin approval). */
function isQueued(res: unknown): boolean {
  return typeof res === 'object' && res !== null && 'approval_request_id' in res;
}

export default function HomeworkPage() {
  const [items, setItems] = useState<HomeworkItem[]>([]);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [classFilter, setClassFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<HomeworkItem | null>(null);
  const [deleting, setDeleting] = useState<HomeworkItem | null>(null);
  const [notifying, setNotifying] = useState<HomeworkItem | null>(null);
  const [notifyBusy, setNotifyBusy] = useState(false);
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    homeworkApi
      .list(classFilter || undefined)
      .then((d) => {
        setItems(d.items);
        setError('');
      })
      .catch(() => setError('Could not load homework.'))
      .finally(() => setLoading(false));
  }, [classFilter]);

  useEffect(load, [load]);

  useEffect(() => {
    api<PageResult<ClassItem>>('/classes')
      .then((d) => setClasses(d.items))
      .catch(() => undefined);
  }, []);

  const doNotify = async (hw: HomeworkItem) => {
    setNotifyBusy(true);
    try {
      const res = await homeworkApi.notify(hw.id);
      push(
        'success',
        `Queued ${res.drafted} parent message(s) for approval in Messages (${res.skipped} skipped — no number or opted out).`,
      );
    } catch (e) {
      push('error', errText(e));
    } finally {
      setNotifyBusy(false);
      setNotifying(null);
    }
  };

  const doDelete = async (hw: HomeworkItem) => {
    try {
      const res = await homeworkApi.remove(hw.id);
      if (isQueued(res)) push('success', 'Submitted for admin approval — nothing was applied yet.');
      else push('success', 'Homework deleted (moved to recycle bin — restorable for 30 days).');
      load();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setDeleting(null);
    }
  };

  if (loading) return <Spinner label="Loading homework…" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Homework diary</h1>
          <p className="text-sm text-slate-500">
            Homework per class — parents see it in the parent portal. "Notify parents" queues SMS drafts for approval;
            nothing is sent automatically.
          </p>
        </div>
        <Button onClick={() => setShowForm(true)}>Add homework</Button>
      </div>
      {error && <ErrorBanner message={error} onRetry={load} />}

      <div className="flex flex-wrap gap-2">
        <select
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          value={classFilter}
          onChange={(e) => setClassFilter(e.target.value)}
          aria-label="Filter by class"
        >
          <option value="">All classes</option>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              Class {c.name}-{c.section}
            </option>
          ))}
        </select>
      </div>

      {items.length === 0 ? (
        <EmptyState title="No homework yet" body="Add the first homework entry for a class — it will show in the parent portal." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Due</th>
                <th className="px-4 py-3">Class</th>
                <th className="px-4 py-3">Subject</th>
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Teacher</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((h) => (
                <tr key={h.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-medium text-slate-900">{h.due_date}</td>
                  <td className="px-4 py-2.5">{h.class_name ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone="blue">{h.subject}</Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    {h.title}
                    {h.description && <p className="max-w-xs truncate text-xs text-slate-500">{h.description}</p>}
                  </td>
                  <td className="px-4 py-2.5">{h.teacher}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="secondary" disabled={notifyBusy} onClick={() => setNotifying(h)}>
                        Notify parents
                      </Button>
                      <Button variant="secondary" onClick={() => setEditing(h)}>Edit</Button>
                      <Button variant="secondary" onClick={() => setDeleting(h)}>Delete</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(showForm || editing) && (
        <HomeworkFormModal
          classes={classes}
          initial={editing ?? undefined}
          onClose={() => {
            setShowForm(false);
            setEditing(null);
          }}
          onSaved={(queued) => {
            setShowForm(false);
            setEditing(null);
            push('success', queued ? 'Submitted for admin approval — nothing was applied yet.' : editing ? 'Homework updated.' : 'Homework added — parents can see it in the portal.');
            load();
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={deleting ? `Delete "${deleting.title}"?` : ''}
        message="This moves the homework to the recycle bin — it disappears from the parent portal, and an admin can restore it within 30 days."
        confirmLabel="Delete homework"
        tone="danger"
        onConfirm={() => {
          const hw = deleting;
          setDeleting(null);
          if (hw) void doDelete(hw);
        }}
        onCancel={() => setDeleting(null)}
      />

      <ConfirmDialog
        open={notifying !== null}
        title={notifying ? `Notify parents about "${notifying.title}"?` : ''}
        message="This queues one SMS draft per parent with a valid number (opted-out parents are skipped). Nothing is sent until you approve the drafts in Messages."
        confirmLabel="Queue parent messages"
        tone="primary"
        busy={notifyBusy}
        onConfirm={() => {
          const hw = notifying;
          if (hw) void doNotify(hw);
        }}
        onCancel={() => setNotifying(null)}
      />
      {view}
    </div>
  );
}

function HomeworkFormModal({
  classes,
  initial,
  onClose,
  onSaved,
}: {
  classes: ClassItem[];
  initial?: HomeworkItem;
  onClose: () => void;
  onSaved: (queued: boolean) => void;
}) {
  const [classId, setClassId] = useState(initial?.class_id ?? '');
  const [subject, setSubject] = useState(initial?.subject ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [dueDate, setDueDate] = useState(initial?.due_date ?? '');
  const [teacher, setTeacher] = useState(initial?.teacher ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = {
        class_id: classId,
        subject: subject.trim(),
        title: title.trim(),
        description: description.trim() || null,
        due_date: dueDate,
        teacher: teacher.trim(),
      };
      const res = initial
        ? await homeworkApi.update(initial.id, body)
        : await homeworkApi.create(body);
      onSaved(isQueued(res));
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={initial ? `Edit homework — ${initial.title}` : 'Add homework'} onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <form onSubmit={submit} className="space-y-4" autoComplete="off">
        <Field label="Class">
          <select className={inputCls} value={classId} onChange={(e) => setClassId(e.target.value)} required>
            <option value="">Choose a class…</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                Class {c.name}-{c.section}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Subject">
          <input className={inputCls} value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={120} />
        </Field>
        <Field label="Title">
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </Field>
        <Field label="Description (optional)">
          <textarea className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={3} />
        </Field>
        <Field label="Due date">
          <input className={inputCls} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
        </Field>
        <Field label="Teacher">
          <input className={inputCls} value={teacher} onChange={(e) => setTeacher(e.target.value)} required maxLength={120} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : initial ? 'Save changes' : 'Add homework'}</Button>
        </div>
      </form>
    </Modal>
  );
}
