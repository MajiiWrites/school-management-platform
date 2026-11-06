import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { ClassItem, MessageLogItem, MessageTemplateRow, MessageType, PendingGroup, SmsStatus } from '../lib/types';
import { fmtDateTime } from '../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Spinner, Tabs, inputCls, useToast } from '../components/ui';
import Tooltip from '../components/Tooltip'; // P8-TOUR: plain-word tooltip on "dedupe key".
import ConfirmDialog from '../components/ConfirmDialog';
import CustomMessages from '../components/CustomMessages';
import TemplateManager from '../components/TemplateManager';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

function statusBadge(s: MessageLogItem['status']) {
  if (s === 'sent') return <Badge tone="green">Sent</Badge>;
  if (s === 'failed') return <Badge tone="red">Failed</Badge>;
  if (s === 'cancelled') return <Badge tone="slate">Cancelled</Badge>;
  return <Badge tone="amber">Queued</Badge>;
}

export default function MessagesPage() {
  const [tab, setTab] = useState('pending');
  const [pending, setPending] = useState<PendingGroup[]>([]);
  const [log, setLog] = useState<MessageLogItem[]>([]);
  const [templates, setTemplates] = useState<MessageTemplateRow[]>([]);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [sms, setSms] = useState<SmsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [logFilter, setLogFilter] = useState<'all' | 'sent' | 'failed' | 'queued'>('all');
  const [logType, setLogType] = useState<'all' | MessageType>('all');
  const [logClass, setLogClass] = useState('');
  const [pendingApprove, setPendingApprove] = useState<PendingGroup | null>(null);
  const [pendingRetry, setPendingRetry] = useState<MessageLogItem | null>(null);
  const { push, view } = useToast();

  // Section 11: the delivery log is filtered server-side by type + class.
  const loadLog = useCallback(() => {
    const params = new URLSearchParams({ limit: '100' });
    if (logType !== 'all') params.set('type', logType);
    if (logClass) params.set('class_id', logClass);
    api<{ items: MessageLogItem[] }>(`/messages/log?${params.toString()}`)
      .then((l) => setLog(l.items))
      .catch(() => setError('Could not load the delivery log.'));
  }, [logType, logClass]);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<{ groups: PendingGroup[] }>('/messages/pending-approval'),
      api<{ templates: MessageTemplateRow[] }>('/messages/templates'),
      api<SmsStatus>('/sms/status'),
      api<{ items: ClassItem[] }>('/classes'),
    ])
      .then(([p, t, s, c]) => {
        setPending(p.groups ?? []);
        setTemplates(t.templates ?? []);
        setSms(s);
        setClasses(c.items ?? []);
        setError('');
      })
      .catch(() => setError('Could not load messages.'))
      .finally(() => setLoading(false));
    loadLog();
  }, [loadLog]);

  useEffect(load, [load]);
  useEffect(loadLog, [loadLog]);

  const approveGroup = async (g: PendingGroup) => {
    // Runs ONLY from the ConfirmDialog onConfirm below — never directly from a button.
    try {
      await api('/messages/approve', {
        method: 'POST',
        body: { dedupe_keys: g.messages.map((m) => m.dedupe_key) },
      });
      push('success', `${g.messages.length} message(s) approved and queued for sending.`);
      load();
    } catch (e) {
      push('error', errText(e));
    }
  };

  const editBody = async (id: string, body: string) => {
    try {
      await api(`/messages/queue/${id}`, { method: 'PATCH', body: { body } });
      push('success', 'Message updated.');
      load();
    } catch (e) {
      push('error', errText(e));
    }
  };

  const retry = async (id: string) => {
    try {
      await api(`/messages/queue/${id}/retry`, { method: 'POST' });
      push('success', 'Retry queued.');
      load();
    } catch (e) {
      push('error', errText(e));
    }
  };

  if (loading) return <Spinner label="Loading messages…" />;

  const filteredLog = log.filter((m) => (logFilter === 'all' ? true : m.status === logFilter));
  const totalPending = pending.reduce((a, g) => a + g.absent_count, 0);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Messages</h1>
        <p className="text-sm text-slate-500">
          Absent alerts go only to parents of absent students — and only after you approve them here.
        </p>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={sms?.sim_connected ? 'green' : 'red'}>
            {sms?.sim_connected ? 'SIM connected' : 'SIM offline'}
          </Badge>
          <span className="text-sm text-slate-600">
            Provider: {sms?.provider === 'gateway' ? 'SMS gateway' : 'Admin SIM'} · {sms?.queued_count ?? 0} message(s) queued
          </span>
          {sms && !sms.sim_connected && (
            <span className="text-sm text-red-600">
              The companion phone is offline — approved messages will wait until it reconnects.
            </span>
          )}
        </div>
      </Card>

      <Tabs
        tabs={[
          { key: 'pending', label: `Pending approval (${totalPending})` },
          { key: 'custom', label: 'Custom messages' },
          { key: 'log', label: 'Delivery log' },
          { key: 'templates', label: 'Templates' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'custom' && <CustomMessages />}

      {tab === 'pending' && (
        <>
          {pending.length === 0 ? (
            <EmptyState
              title="Nothing waiting for approval"
              body="When a class submits attendance with absent students, their messages appear here first."
              actionLabel="View delivery log"
              onAction={() => setTab('log')}
            />
          ) : (
            pending.map((g) => (
              <PendingGroupCard key={g.group_id ?? `${g.class}-${g.date}`} group={g} onApprove={() => setPendingApprove(g)} onEditBody={editBody} />
            ))
          )}
        </>
      )}

      {tab === 'log' && (
        <>
          {/* P8-TOUR: dedupe key, explained in plain words. */}
          <p className="text-sm text-slate-500">
            Every message has a dedupe key
            <Tooltip text="Dedupe means 'remove duplicates'. The key is a unique label for one message to one parent — the system uses it to make sure the same message is never sent twice to the same parent, even if it is approved twice." />
            {' '}— the same message is never sent twice to the same parent.
          </p>
          <div className="flex flex-wrap gap-2">
            <select className={inputCls + ' w-auto'} value={logFilter} onChange={(e) => setLogFilter(e.target.value as typeof logFilter)} autoComplete="off">
              <option value="all">All statuses</option>
              <option value="sent">Sent</option>
              <option value="queued">Queued</option>
              <option value="failed">Failed</option>
            </select>
            <select className={inputCls + ' w-auto'} value={logType} onChange={(e) => setLogType(e.target.value as typeof logType)} autoComplete="off">
              <option value="all">All types</option>
              <option value="absent">Absent</option>
              <option value="fee_reminder">Fee reminder</option>
              <option value="teacher_reminder">Teacher reminder</option>
              <option value="result">Result</option>
              <option value="announcement">Announcement</option>
              <option value="custom">Custom</option>
            </select>
            <select className={inputCls + ' w-auto'} value={logClass} onChange={(e) => setLogClass(e.target.value)} autoComplete="off">
              <option value="">All classes</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>{c.name}-{c.section}</option>
              ))}
            </select>
          </div>
          {filteredLog.length === 0 ? (
            <EmptyState
              title="No messages yet"
              body="Sent, queued and failed messages will be listed here with their status."
              actionLabel="Review pending approvals"
              onAction={() => setTab('pending')}
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Student</th>
                    <th className="px-4 py-3">Parent</th>
                    <th className="px-4 py-3">Message</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Sent at</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredLog.map((m) => (
                    <tr key={m.id} className="align-top hover:bg-slate-50">
                      <td className="px-4 py-2.5 capitalize">{m.type.replace('_', ' ')}</td>
                      <td className="px-4 py-2.5 font-medium">{m.student_name ?? '—'}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">{m.parent_phone_masked}</td>
                      <td className="max-w-xs px-4 py-2.5 text-xs text-slate-600">{m.body}</td>
                      <td className="px-4 py-2.5">
                        {statusBadge(m.status)}
                        {m.error && <p className="mt-1 text-xs text-red-600">{m.error}</p>}
                        {m.delivery && (
                          <p className="mt-1 text-xs text-slate-500">
                            Delivery: {m.delivery.status}
                            {m.delivery.error ? ` — ${m.delivery.error}` : ''}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs">{fmtDateTime(m.sent_at)}</td>
                      <td className="px-4 py-2.5 text-right">
                        {m.status === 'failed' && (
                          <Button variant="secondary" onClick={() => setPendingRetry(m)}>Retry</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'templates' && <TemplateManager templates={templates} onSaved={load} />}
      <ConfirmDialog
        open={pendingApprove !== null}
        title="Approve & send these messages?"
        message={
          pendingApprove
            ? `Are you sure? This will approve and queue ${pendingApprove.messages.length} message(s) for Class ${pendingApprove.class} (${pendingApprove.date}) — they will be sent to the parents of absent students.`
            : ''
        }
        confirmLabel={`Approve & send ${pendingApprove?.messages.length ?? 0}`}
        tone="primary"
        onConfirm={() => {
          const g = pendingApprove;
          setPendingApprove(null);
          if (g) approveGroup(g);
        }}
        onCancel={() => setPendingApprove(null)}
      />
      <ConfirmDialog
        open={pendingRetry !== null}
        title="Retry this message?"
        message={
          pendingRetry
            ? `Are you sure? This will retry sending the failed message to ${pendingRetry.student_name ?? 'this parent'} (${pendingRetry.parent_phone_masked}).`
            : ''
        }
        confirmLabel="Retry message"
        tone="primary"
        onConfirm={() => {
          const m = pendingRetry;
          setPendingRetry(null);
          if (m) retry(m.id);
        }}
        onCancel={() => setPendingRetry(null)}
      />
      {view}
    </div>
  );
}

function PendingGroupCard({
  group,
  onApprove,
  onEditBody,
}: {
  group: PendingGroup;
  onApprove: () => void;
  onEditBody: (id: string, body: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmingEdit, setConfirmingEdit] = useState<{ id: string; body: string; student: string } | null>(null);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Class {group.class} — {group.date}
          </h2>
          <p className="text-sm text-slate-500">
            {group.absent_count} absent student{group.absent_count === 1 ? '' : 's'} — messages will go only to their parents.
          </p>
        </div>
        <Button onClick={onApprove}>Approve & send all ({group.messages.length})</Button>
      </div>
      <ul className="mt-4 space-y-3">
        {group.messages.map((m) => (
          <li key={m.id} className="rounded-lg border border-slate-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-slate-800">
                {m.student} · <span className="font-mono text-xs text-slate-500">{m.parent_phone_masked}</span>
              </p>
              <button
                className="text-sm font-medium text-brand-700 hover:underline"
                onClick={() => {
                  setEditingId(m.id);
                  setDraft(m.body);
                }}
              >
                Edit message
              </button>
            </div>
            {editingId === m.id ? (
              <div className="mt-2">
                <textarea className={inputCls} rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off" />
                <p className="mt-1 text-xs text-slate-500">{draft.length} characters (SMS: 160 chars per segment)</p>
                <div className="mt-2 flex gap-2">
                  <Button onClick={() => setConfirmingEdit({ id: m.id, body: draft, student: m.student })}>Save</Button>
                  <Button variant="secondary" onClick={() => setEditingId(null)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <p className="mt-1 text-sm text-slate-600">{m.body}</p>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirmingEdit !== null}
        title="Save this edited message?"
        message={
          confirmingEdit
            ? `Are you sure? This will replace the queued message for ${confirmingEdit.student} with your edited text.`
            : ''
        }
        confirmLabel="Save message"
        tone="primary"
        onConfirm={() => {
          const c = confirmingEdit;
          setConfirmingEdit(null);
          setEditingId(null);
          if (c) onEditBody(c.id, c.body);
        }}
        onCancel={() => setConfirmingEdit(null)}
      />
    </Card>
  );
}
