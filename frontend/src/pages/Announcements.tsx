// Announcements — notice board + SMS send (Phase 8 QA).
// Approving posts the notice; an approved announcement with sms_send on
// can be sent by SMS, which routes through the Section 11 message-draft
// approval flow (POST /announcements/:id/send). Nothing is texted before
// the admin confirms the send.
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { ClassItem, PageResult } from '../lib/types';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Spinner, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';
import { useLanguage } from '../lib/i18n';
import { fmtDateTz } from '../lib/utils';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

interface Announcement {
  id: string;
  title: string;
  body: string;
  target_type: 'all' | 'class';
  target_class_id: string | null;
  target_class_name: string | null;
  sms_send: boolean;
  status: 'draft' | 'approved' | 'sent';
  created_at: string;
}

export default function AnnouncementsPage() {
  const { title } = useLanguage();
  const [items, setItems] = useState<Announcement[]>([]);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [aTitle, setATitle] = useState('');
  const [body, setBody] = useState('');
  const [targetType, setTargetType] = useState<'all' | 'class'>('all');
  const [targetClass, setTargetClass] = useState('');
  const [smsSend, setSmsSend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [approving, setApproving] = useState<Announcement | null>(null);
  const [sending, setSending] = useState<Announcement | null>(null);
  const [deleting, setDeleting] = useState<Announcement | null>(null);
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<PageResult<Announcement>>('/announcements?limit=200'),
      api<PageResult<ClassItem>>('/classes'),
    ])
      .then(([a, c]) => {
        setItems(a.items);
        setClasses(c.items);
        setError('');
      })
      .catch(() => setError('Could not load announcements.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (aTitle.trim().length < 2 || !body.trim()) {
      setError('Enter a title and a message.');
      return;
    }
    if (targetType === 'class' && !targetClass) {
      setError('Pick a class for a class-only announcement.');
      return;
    }
    setConfirming(true);
  };

  const doCreate = async () => {
    setBusy(true);
    setConfirming(false);
    try {
      await api('/announcements', {
        method: 'POST',
        body: {
          title: aTitle.trim(),
          body: body.trim(),
          target_type: targetType,
          target_class_id: targetType === 'class' ? targetClass : undefined,
          sms_send: smsSend,
        },
      });
      push('success', 'Announcement saved as a draft.');
      setATitle('');
      setBody('');
      setTargetType('all');
      setTargetClass('');
      setSmsSend(false);
      load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const doApprove = async () => {
    if (!approving) return;
    setBusy(true);
    try {
      await api(`/announcements/${approving.id}/approve`, { method: 'POST' });
      push('success', 'Announcement approved for the notice board.');
      setApproving(null);
      load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/announcements/${deleting.id}`, { method: 'DELETE' });
      push('success', 'Announcement deleted.');
      setDeleting(null);
      load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const doSendSms = async () => {
    if (!sending) return;
    setBusy(true);
    try {
      const res = await api<{ queued: number; skipped_opted_out: number; skipped: unknown[] }>(`/announcements/${sending.id}/send`, { method: 'POST' });
      push('success', `SMS sent to ${res.queued} parent(s)${res.skipped_opted_out ? ` (${res.skipped_opted_out} opted out)` : ''}.`);
      setSending(null);
      load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner label="Loading announcements…" />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{title('announcements')}</h1>
        <p className="text-sm text-slate-500">Notices for parents and students. Approving posts the notice; an approved notice marked for SMS can then be texted to parents.</p>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      <Card className="p-5">
        <h2 className="text-base font-semibold">New announcement</h2>
        <form onSubmit={submit} className="mt-4 space-y-3" autoComplete="off">
          <Field label="Title">
            <input className={inputCls} value={aTitle} onChange={(e) => setATitle(e.target.value)} placeholder="e.g. Parent-teacher meeting on Friday" autoComplete="off" />
          </Field>
          <Field label="Message">
            <textarea className={inputCls} rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write the notice…" autoComplete="off" />
          </Field>
          <div className="flex flex-wrap gap-3">
            <Field label="Audience">
              <select className={inputCls} value={targetType} onChange={(e) => setTargetType(e.target.value as 'all' | 'class')}>
                <option value="all">All classes</option>
                <option value="class">One class</option>
              </select>
            </Field>
            {targetType === 'class' && (
              <Field label="Class">
                <select className={inputCls} value={targetClass} onChange={(e) => setTargetClass(e.target.value)}>
                  <option value="">Pick a class</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>Class {c.name}-{c.section}</option>
                  ))}
                </select>
              </Field>
            )}
            <label className="flex items-end gap-2 pb-2 text-sm text-slate-700">
              <input type="checkbox" checked={smsSend} onChange={(e) => setSmsSend(e.target.checked)} />
              Also send by SMS (after approving, from the notice below)
            </label>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save draft'}</Button>
          </div>
        </form>
      </Card>

      {items.length === 0 ? (
        <EmptyState title="No announcements yet" body="Post notices here — exam dates, holidays, meetings, anything parents should see." />
      ) : (
        <div className="space-y-3">
          {items.map((a) => (
            <Card key={a.id} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-slate-900">{a.title}</p>
                  <p className="mt-1 text-sm text-slate-600">{a.body}</p>
                  <p className="mt-2 text-xs text-slate-500">
                    {a.target_type === 'all' ? 'All classes' : `Class ${a.target_class_name ?? ''}`} · {fmtDateTz(a.created_at)}
                    {a.sms_send ? ' · SMS requested' : ''}
                    {a.status === 'sent' ? ' · SMS sent' : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={a.status === 'approved' ? 'green' : a.status === 'sent' ? 'green' : 'amber'}>{a.status}</Badge>
                  {a.status === 'draft' && (
                    <Button variant="secondary" onClick={() => setApproving(a)}>Approve</Button>
                  )}
                  {a.status === 'approved' && a.sms_send && (
                    <Button variant="secondary" onClick={() => setSending(a)}>Send SMS</Button>
                  )}
                  <button className="font-medium text-red-600 hover:underline" onClick={() => setDeleting(a)}>Delete</button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        title="Save this announcement?"
        message={`Are you sure? This will save "${aTitle.trim()}" as a draft for ${targetType === 'all' ? 'all classes' : 'one class'}. It will not be posted until approved.`}
        confirmLabel="Save draft"
        tone="primary"
        busy={busy}
        onConfirm={doCreate}
        onCancel={() => setConfirming(false)}
      />
      <ConfirmDialog
        open={approving !== null}
        title="Approve this announcement?"
        message={approving ? `Are you sure? This will post "${approving.title}" on the notice board.${approving.sms_send ? ' You can then send it by SMS from the notice.' : ''}` : ''}
        confirmLabel="Approve & post"
        tone="primary"
        busy={busy}
        onConfirm={doApprove}
        onCancel={() => setApproving(null)}
      />
      <ConfirmDialog
        open={sending !== null}
        title="Send this announcement by SMS?"
        message={sending ? `Are you sure? This will text "${sending.title}" to ${sending.target_type === 'all' ? 'all parents' : `parents of class ${sending.target_class_name ?? ''}`} (opted-out parents are skipped).` : ''}
        confirmLabel="Send SMS"
        tone="primary"
        busy={busy}
        onConfirm={doSendSms}
        onCancel={() => setSending(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this announcement?"
        message={deleting ? `Are you sure? This will delete "${deleting.title}". This cannot be undone.` : ''}
        confirmLabel="Delete announcement"
        busy={busy}
        onConfirm={doDelete}
        onCancel={() => setDeleting(null)}
      />
      {view}
    </div>
  );
}
