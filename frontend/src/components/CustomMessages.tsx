// Custom Messages — Section 11 (Custom Messages).
// Composer (write-your-own + variable chips + live preview) and drafts
// (save / schedule / submit-for-approval / approve-send / reject / cancel /
// delete). NOTHING sends without admin approval: approve-send shows the
// recipient list + final rendered message in a ConfirmDialog first.
// Clerk drafts go to the admin Approval Queue via submit-for-approval.
// All forms carry autoComplete="off".

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiClientError } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import type {
  ClassItem,
  MessageDraftRow,
  PreviewResult,
  RecipientType,
  Student,
} from '../lib/types';
import { MESSAGE_VARIABLES } from '../lib/types';
import { smsPartCount } from '../lib/sms';
import { fmtDateTime } from '../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Pager, Spinner, inputCls, useToast } from '../components/ui';
import Tooltip from './Tooltip'; // P8-TOUR: plain-word tooltip on "scheduled message".
import ConfirmDialog from '../components/ConfirmDialog';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

function draftStatusBadge(status: MessageDraftRow['status']) {
  if (status === 'sent') return <Badge tone="green">Sent</Badge>;
  if (status === 'scheduled') return <Badge tone="blue">Scheduled</Badge>;
  if (status === 'cancelled') return <Badge tone="slate">Cancelled</Badge>;
  return <Badge tone="amber">Draft</Badge>;
}

function recipientSummary(d: MessageDraftRow, classes: ClassItem[]): string {
  const className = (id: string | null) => {
    const c = classes.find((x) => x.id === id);
    return c ? `${c.name}-${c.section}` : '—';
  };
  switch (d.recipientType) {
    case 'all_parents':
      return 'All parents';
    case 'class':
      return `Class ${className(d.targetClassId)}`;
    case 'selected_students':
      return `${d.targetStudentIds.length} selected student(s)`;
    case 'single_parent':
      return 'Single parent';
    default:
      return d.recipientType;
  }
}

type QuickFilter = 'none' | 'absent' | 'fee_unpaid';

export default function CustomMessages() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [drafts, setDrafts] = useState<MessageDraftRow[]>([]);
  // Round 5 (F1): server-side pagination for the drafts list — it
  // fetched ?limit=100 with no pager, so drafts past the cap were
  // unreachable. The backend already paginates (total/pages).
  const [draftPage, setDraftPage] = useState(1);
  const [draftTotal, setDraftTotal] = useState(0);
  const [draftPages, setDraftPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [students, setStudents] = useState<Student[]>([]);
  const [studentsLoading, setStudentsLoading] = useState(false);

  // Composer state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [recipientType, setRecipientType] = useState<RecipientType>('all_parents');
  const [classId, setClassId] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('none');
  const [body, setBody] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  // Dialogs (API calls run ONLY from onConfirm)
  const [pendingDelete, setPendingDelete] = useState<MessageDraftRow | null>(null);
  const [pendingCancel, setPendingCancel] = useState<MessageDraftRow | null>(null);
  const [pendingSubmit, setPendingSubmit] = useState<MessageDraftRow | null>(null);
  const [pendingReject, setPendingReject] = useState<MessageDraftRow | null>(null);
  const [pendingApprove, setPendingApprove] = useState<{ draft: MessageDraftRow; preview: PreviewResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<{ items: ClassItem[] }>('/classes'),
      api<{ items: MessageDraftRow[]; total: number; page: number; pages: number }>(`/messages/drafts?page=${draftPage}&limit=50`),
    ])
      .then(([c, d]) => {
        setClasses(c.items ?? []);
        setDrafts(d.items ?? []);
        setDraftTotal(d.total ?? 0);
        setDraftPages(d.pages ?? 1);
        setError('');
      })
      .catch(() => setError('Could not load custom messages.'))
      .finally(() => setLoading(false));
  }, [draftPage]);

  useEffect(load, [load]);

  const loadStudents = useCallback((cid: string) => {
    if (!cid) {
      setStudents([]);
      return;
    }
    setStudentsLoading(true);
    api<{ items: Student[] }>(`/classes/${cid}/students?limit=200`)
      .then((r) => setStudents(r.items ?? []))
      .catch(() => push('error', 'Could not load students for this class.'))
      .finally(() => setStudentsLoading(false));
  }, [push]);

  useEffect(() => {
    if (recipientType === 'class' || recipientType === 'selected_students' || recipientType === 'single_parent') {
      loadStudents(classId);
    }
  }, [recipientType, classId, loadStudents]);

  const targeting = () => {
    const base: Record<string, unknown> = { recipient_type: recipientType };
    if (recipientType === 'class') base.target_class_id = classId;
    if (recipientType === 'selected_students') base.target_student_ids = selectedIds;
    if (recipientType === 'single_parent') base.target_student_ids = selectedIds.slice(0, 1);
    if (quickFilter !== 'none') {
      base.filter = quickFilter;
      if (classId) base.target_class_id = classId;
    }
    return base;
  };

  const runPreview = async () => {
    if (!body.trim()) {
      push('error', 'Write a message first.');
      return;
    }
    if (recipientType === 'class' && !classId) {
      push('error', 'Pick a class first.');
      return;
    }
    if ((recipientType === 'selected_students' || recipientType === 'single_parent') && selectedIds.length === 0) {
      push('error', 'Pick at least one student first.');
      return;
    }
    setPreviewLoading(true);
    try {
      const res = await api<PreviewResult>('/messages/preview', {
        method: 'POST',
        body: { body: body.trim(), ...targeting() },
      });
      setPreview(res);
    } catch (e) {
      push('error', errText(e));
    } finally {
      setPreviewLoading(false);
    }
  };

  const resetComposer = () => {
    setEditingId(null);
    setRecipientType('all_parents');
    setClassId('');
    setSelectedIds([]);
    setQuickFilter('none');
    setBody('');
    setScheduledFor('');
    setPreview(null);
  };

  const saveDraft = async () => {
    if (!body.trim()) {
      push('error', 'Write a message first.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...targeting(),
        body: body.trim(),
        ...(scheduledFor ? { scheduled_for: new Date(scheduledFor).toISOString() } : {}),
      };
      if (editingId) {
        await api(`/messages/drafts/${editingId}`, { method: 'PATCH', body: payload });
        push('success', 'Draft updated.');
      } else {
        await api('/messages/drafts', { method: 'POST', body: payload });
        push('success', 'Draft saved. Nothing will send until it is approved.');
      }
      resetComposer();
      // A new draft lands on page 1; go there so the user sees it.
      setDraftPage(1);
      load();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setSaving(false);
    }
  };

  const editDraft = (d: MessageDraftRow) => {
    setEditingId(d.id);
    setRecipientType(d.recipientType);
    setClassId(d.targetClassId ?? '');
    setSelectedIds(d.targetStudentIds);
    setQuickFilter('none');
    setBody(d.body);
    setScheduledFor(d.scheduledFor ? d.scheduledFor.slice(0, 16) : '');
    setPreview(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const submitForApproval = async (d: MessageDraftRow) => {
    setBusy(true);
    try {
      await api(`/messages/drafts/${d.id}/submit-for-approval`, { method: 'POST' });
      push('success', 'Submitted for admin approval — nothing will send until it is approved.');
      load();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const openApprove = async (d: MessageDraftRow) => {
    setBusy(true);
    try {
      const res = await api<PreviewResult>('/messages/preview', {
        method: 'POST',
        body: {
          body: d.body,
          recipient_type: d.recipientType,
          target_class_id: d.targetClassId ?? undefined,
          target_student_ids: d.targetStudentIds.length ? d.targetStudentIds : undefined,
        },
      });
      setPendingApprove({ draft: d, preview: res });
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const approveSend = async (d: MessageDraftRow) => {
    setBusy(true);
    try {
      const result = await api<{ queued?: number; scheduled?: boolean; skipped?: unknown[]; skippedOptedOut?: number }>(
        `/messages/drafts/${d.id}/approve-send`,
        { method: 'POST' },
      );
      if (result.scheduled) {
        push('success', 'Approved and scheduled — it will send at the scheduled time.');
      } else {
        push('success', `${result.queued ?? 0} message(s) approved and queued for sending.`);
      }
      load();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const rejectDraft = async (d: MessageDraftRow) => {
    setBusy(true);
    try {
      await api(`/messages/drafts/${d.id}/reject`, { method: 'POST', body: {} });
      push('success', 'Draft rejected and cancelled.');
      load();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const cancelDraft = async (d: MessageDraftRow) => {
    setBusy(true);
    try {
      await api(`/messages/drafts/${d.id}/cancel`, { method: 'POST' });
      push('success', 'Draft cancelled.');
      load();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteDraft = async (d: MessageDraftRow) => {
    setBusy(true);
    try {
      await api(`/messages/drafts/${d.id}`, { method: 'DELETE' });
      push('success', 'Draft deleted.');
      load();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const insertVariable = (v: string) => {
    const el = bodyRef.current;
    const token = `{${v}}`;
    if (!el) {
      setBody((b) => b + token);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const toggleStudent = (id: string) => {
    setSelectedIds((prev) =>
      recipientType === 'single_parent'
        ? [id]
        : prev.includes(id)
          ? prev.filter((x) => x !== id)
          : [...prev, id],
    );
  };

  if (loading) return <Spinner label="Loading custom messages…" />;

  const count = smsPartCount(body);

  return (
    <div className="space-y-5">
      {error && <ErrorBanner message={error} onRetry={load} />}

      {/* ------------------------------ composer ------------------------------ */}
      <Card className="p-5">
        <h2 className="text-base font-semibold text-slate-900">
          {editingId ? 'Edit draft' : 'Write a message'}
        </h2>
        <p className="text-sm text-slate-500">
          Write your own message — no template needed. Nothing sends until an admin approves it.
        </p>

        <form autoComplete="off" onSubmit={(e) => { e.preventDefault(); saveDraft(); }}>
          <label className="mt-4 block text-xs font-medium text-slate-600">Send to</label>
          <select
            className={inputCls}
            value={recipientType}
            onChange={(e) => {
              setRecipientType(e.target.value as RecipientType);
              setSelectedIds([]);
            }}
            autoComplete="off"
          >
            <option value="all_parents">All parents</option>
            <option value="class">One class / section</option>
            <option value="selected_students">Selected students</option>
            <option value="single_parent">A single parent</option>
          </select>

          {(recipientType === 'class' || recipientType === 'selected_students' || recipientType === 'single_parent') && (
            <>
              <label className="mt-3 block text-xs font-medium text-slate-600">Class</label>
              <select className={inputCls} value={classId} onChange={(e) => setClassId(e.target.value)} autoComplete="off">
                <option value="">Pick a class…</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}-{c.section}</option>
                ))}
              </select>
            </>
          )}

          {(recipientType === 'selected_students' || recipientType === 'single_parent') && (
            <div className="mt-3">
              <p className="text-xs font-medium text-slate-600">
                {recipientType === 'single_parent' ? 'Pick one student' : 'Pick students'}
              </p>
              {studentsLoading ? (
                <p className="mt-1 text-sm text-slate-500">Loading students…</p>
              ) : students.length === 0 ? (
                <p className="mt-1 text-sm text-slate-500">{classId ? 'No students in this class.' : 'Pick a class first.'}</p>
              ) : (
                <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
                  {students.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50">
                      <input
                        type={recipientType === 'single_parent' ? 'radio' : 'checkbox'}
                        name="custom-recipient"
                        checked={selectedIds.includes(s.id)}
                        onChange={() => toggleStudent(s.id)}
                      />
                      <span>{s.name}</span>
                      {s.parent_opt_out && <span className="text-xs text-red-600">(opted out — will be skipped)</span>}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          <label className="mt-3 block text-xs font-medium text-slate-600">Quick filter</label>
          <div className="mt-1 flex flex-wrap gap-2">
            <Button variant={quickFilter === 'none' ? 'primary' : 'secondary'} onClick={() => setQuickFilter('none')}>No filter</Button>
            <Button variant={quickFilter === 'absent' ? 'primary' : 'secondary'} onClick={() => setQuickFilter('absent')}>Absent today</Button>
            <Button variant={quickFilter === 'fee_unpaid' ? 'primary' : 'secondary'} onClick={() => setQuickFilter('fee_unpaid')}>Fee unpaid</Button>
          </div>
          {quickFilter !== 'none' && (
            <p className="mt-1 text-xs text-slate-500">
              {quickFilter === 'absent'
                ? "Only parents of students marked absent today will receive this."
                : "Only parents with an unpaid fee for the current month will receive this."}
              {classId ? ' Limited to the class picked above.' : ''}
            </p>
          )}

          <label className="mt-4 block text-xs font-medium text-slate-600">Message</label>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {MESSAGE_VARIABLES.map((v) => (
              <button
                key={v}
                type="button"
                className="rounded-full border border-slate-300 bg-slate-50 px-2.5 py-1 font-mono text-xs text-slate-700 hover:border-brand-500 hover:text-brand-700"
                onClick={() => insertVariable(v)}
                title={`Insert {${v}}`}
              >
                {`{${v}}`}
              </button>
            ))}
          </div>
          <textarea
            ref={bodyRef}
            className={`${inputCls} mt-2`}
            rows={5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Type your message… tap a variable above to insert it."
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-slate-500">
            {count.length} characters · {count.parts} SMS part(s) · {count.isUnicode ? 'Unicode (70 chars/part)' : 'GSM (160 chars/part)'}
            {count.parts > 1 ? ' — long messages cost more and may arrive split.' : ''}
          </p>

          <label className="mt-3 block text-xs font-medium text-slate-600">
            Schedule for later (optional)
            <Tooltip text="A scheduled message is sent at the date and time you pick — but only after an admin approves it. An unapproved scheduled message never sends." />
          </label>
          <input
            type="datetime-local"
            className={inputCls}
            value={scheduledFor}
            onChange={(e) => setScheduledFor(e.target.value)}
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-slate-500">
            Scheduled drafts still need approval first — an unapproved scheduled draft never sends.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button disabled={saving || !body.trim()} onClick={() => void saveDraft()}>
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Save draft'}
            </Button>
            <Button variant="secondary" disabled={previewLoading || !body.trim()} onClick={() => void runPreview()}>
              {previewLoading ? 'Previewing…' : 'Live preview'}
            </Button>
            {editingId && (
              <Button variant="secondary" onClick={resetComposer}>Cancel edit</Button>
            )}
          </div>
        </form>

        {preview && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <h3 className="text-sm font-semibold text-slate-900">Preview — exactly what parents will receive</h3>
            <p className="mt-1 text-sm text-slate-600">
              {preview.recipientCount} recipient(s) · {preview.skippedCount} skipped
              {preview.skippedCount > 0 && (
                <> ({preview.skipped.filter((s) => s.reason === 'opted_out').length} opted out)</>
              )}
              {' · '}{preview.charCount} characters · {preview.smsParts} SMS part(s) · {preview.isUnicode ? 'Unicode' : 'GSM'}
            </p>
            {preview.samples.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">No recipients match — nobody will receive this message.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {preview.samples.map((s) => (
                  <li key={s.studentId} className="rounded-lg border border-slate-200 bg-white p-3">
                    <p className="text-xs font-medium text-slate-500">
                      To {s.studentName} ({s.parentPhoneMasked}) · {s.charCount} chars · {s.smsParts} part(s)
                    </p>
                    <p className="mt-1 text-sm text-slate-800">{s.body}</p>
                  </li>
                ))}
              </ul>
            )}
            {preview.skipped.length > 0 && (
              <p className="mt-2 text-xs text-slate-500">
                Skipped: {preview.skipped.map((s) => `${s.studentName} (${s.reason.replace('_', ' ')})`).join(', ')}
              </p>
            )}
          </div>
        )}
      </Card>

      {/* ------------------------------ drafts ------------------------------ */}
      <h2 className="text-base font-semibold text-slate-900">Drafts</h2>
      {drafts.length === 0 ? (
        <EmptyState
          title="No drafts yet"
          body="Write a message above and save it as a draft. Drafts only send after admin approval."
          actionLabel="Write your first message"
          onAction={() => bodyRef.current?.focus()}
        />
      ) : (
        drafts.map((d) => (
          <Card key={d.id} className="p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-900">{recipientSummary(d, classes)}</h3>
              {draftStatusBadge(d.status)}
              {d.scheduledFor && <Badge tone="blue">Scheduled {fmtDateTime(d.scheduledFor)}</Badge>}
              <span className="flex-1" />
              <span className="text-xs text-slate-500">{fmtDateTime(d.createdAt)}</span>
            </div>
            <p className="mt-2 text-sm text-slate-600">{d.body}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {(d.status === 'draft' || d.status === 'scheduled') && (
                <Button variant="secondary" onClick={() => editDraft(d)}>Edit</Button>
              )}
              {(d.status === 'draft' || d.status === 'scheduled') && (
                <Button variant="secondary" disabled={busy} onClick={() => setPendingSubmit(d)}>Submit for approval</Button>
              )}
              {isAdmin && (d.status === 'draft' || d.status === 'scheduled') && (
                <Button disabled={busy} onClick={() => void openApprove(d)}>Approve &amp; send</Button>
              )}
              {isAdmin && (d.status === 'draft' || d.status === 'scheduled') && (
                <Button variant="secondary" disabled={busy} onClick={() => setPendingReject(d)}>Reject</Button>
              )}
              {(d.status === 'draft' || d.status === 'scheduled') && (
                <Button variant="secondary" disabled={busy} onClick={() => setPendingCancel(d)}>Cancel</Button>
              )}
              {d.status === 'draft' && (
                <Button variant="secondary" disabled={busy} onClick={() => setPendingDelete(d)}>Delete</Button>
              )}
              {!isAdmin && d.status === 'draft' && (
                <span className="self-center text-xs text-slate-500">Only an admin can approve and send.</span>
              )}
            </div>
          </Card>
        ))
      )}
      {drafts.length > 0 && (
        <Pager page={draftPage} pages={draftPages} total={draftTotal} itemLabel="drafts" itemLabelSingular="draft" onPage={setDraftPage} />
      )}

      {/* ------------------------------ dialogs ------------------------------ */}
      <ConfirmDialog
        open={pendingSubmit !== null}
        title="Submit this draft for approval?"
        message={
          pendingSubmit
            ? `Are you sure? "${pendingSubmit.body.slice(0, 80)}${pendingSubmit.body.length > 80 ? '…' : ''}" will go to the admin Approval Queue. Nothing will send until an admin approves it.`
            : ''
        }
        confirmLabel="Submit for approval"
        tone="primary"
        busy={busy}
        onConfirm={() => {
          const d = pendingSubmit;
          setPendingSubmit(null);
          if (d) void submitForApproval(d);
        }}
        onCancel={() => setPendingSubmit(null)}
      />
      <ConfirmDialog
        open={pendingApprove !== null}
        title="Approve & send this message?"
        message={
          pendingApprove
            ? `This will send to ${pendingApprove.preview.recipientCount} parent(s)` +
              (pendingApprove.preview.skippedCount > 0 ? ` (${pendingApprove.preview.skippedCount} skipped — ${pendingApprove.preview.skipped.filter((s) => s.reason === 'opted_out').length} opted out)` : '') +
              (pendingApprove.draft.scheduledFor ? ` at the scheduled time (${fmtDateTime(pendingApprove.draft.scheduledFor)}).` : ' now.') +
              (pendingApprove.preview.samples[0]
                ? `\n\nFirst message — to ${pendingApprove.preview.samples[0].studentName} (${pendingApprove.preview.samples[0].parentPhoneMasked}):\n"${pendingApprove.preview.samples[0].body}"`
                : '')
            : ''
        }
        confirmLabel={
          pendingApprove?.draft.scheduledFor ? 'Approve & schedule' : `Approve & send (${pendingApprove?.preview.recipientCount ?? 0})`
        }
        tone="primary"
        busy={busy}
        onConfirm={() => {
          const p = pendingApprove;
          setPendingApprove(null);
          if (p) void approveSend(p.draft);
        }}
        onCancel={() => setPendingApprove(null)}
      />
      <ConfirmDialog
        open={pendingReject !== null}
        title="Reject this draft?"
        message={
          pendingReject
            ? `Are you sure? This draft will be cancelled and will never send. Any pending approval request for it is rejected too.`
            : ''
        }
        confirmLabel="Reject draft"
        tone="danger"
        busy={busy}
        onConfirm={() => {
          const d = pendingReject;
          setPendingReject(null);
          if (d) void rejectDraft(d);
        }}
        onCancel={() => setPendingReject(null)}
      />
      <ConfirmDialog
        open={pendingCancel !== null}
        title="Cancel this draft?"
        message={
          pendingCancel
            ? `Are you sure? This draft will be cancelled and will never send.`
            : ''
        }
        confirmLabel="Cancel draft"
        tone="danger"
        busy={busy}
        onConfirm={() => {
          const d = pendingCancel;
          setPendingCancel(null);
          if (d) void cancelDraft(d);
        }}
        onCancel={() => setPendingCancel(null)}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this draft?"
        message={
          pendingDelete
            ? `Are you sure? This draft will be permanently deleted.`
            : ''
        }
        confirmLabel="Delete draft"
        tone="danger"
        busy={busy}
        onConfirm={() => {
          const d = pendingDelete;
          setPendingDelete(null);
          if (d) void deleteDraft(d);
        }}
        onCancel={() => setPendingDelete(null)}
      />
      {view}
    </div>
  );
}
