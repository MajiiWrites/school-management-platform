import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { ClassItem, MessageLogItem, MessageTemplateRow, MessageType, PendingGroup, SmsStatus } from '../lib/types';
import { fmtDateTime } from '../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Pager, Spinner, Tabs, inputCls, useToast } from '../components/ui';
import Tooltip from '../components/Tooltip'; // P8-TOUR: plain-word tooltip on "dedupe key".
import ConfirmDialog from '../components/ConfirmDialog';
import CustomMessages from '../components/CustomMessages';
import TemplateManager from '../components/TemplateManager';
import WhatsAppSendPanel, { type WhatsAppLinkItem } from '../components/WhatsAppSendPanel';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

/** Log rows carry two fields the shared type does not declare yet
 * (backend-added): approval time + delivery provider. Cast at use-site. */
type LogItemWithChannel = MessageLogItem & {
  approved_at?: string | null;
  delivery?: {
    provider?: string;
    status: string;
    delivered_at?: string | null;
    deliveredAt?: string | null;
    error: string | null;
  } | null;
};

function deliveryLabel(d: NonNullable<LogItemWithChannel['delivery']>): string {
  if (d.status === 'opened') return 'Opened in WhatsApp — delivery not confirmed';
  if (d.status === 'pending') return 'Waiting in WhatsApp';
  if (d.status === 'sent') {
    if (d.provider === 'email') return 'Sent by email';
    if (d.provider === 'whatsapp') return 'Opened in WhatsApp';
    return 'Sent by SMS';
  }
  if (d.status === 'failed') return 'Delivery failed';
  return `Delivery: ${d.status}`;
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
  const [pendingWhatsApp, setPendingWhatsApp] = useState<PendingGroup | null>(null);
  const [pendingRetry, setPendingRetry] = useState<MessageLogItem | null>(null);
  const [waLinks, setWaLinks] = useState<WhatsAppLinkItem[] | null>(null);
  const [emailFor, setEmailFor] = useState<{ id: string; to: string } | null>(null);
  const { push, view } = useToast();

  // Section 11: the delivery log is filtered server-side by status +
  // type + class. Round 5 (F1): server-side pagination too — it fetched
  // ?limit=100 with no pager and filtered status in the browser, so log
  // rows past the cap were unreachable. The backend already paginates
  // (/messages/log returns total/pages).
  const [logPage, setLogPage] = useState(1);
  const [logTotal, setLogTotal] = useState(0);
  const [logPages, setLogPages] = useState(1);
  const loadLog = useCallback(() => {
    const params = new URLSearchParams({ page: String(logPage), limit: '50' });
    if (logFilter !== 'all') params.set('status', logFilter);
    if (logType !== 'all') params.set('type', logType);
    if (logClass) params.set('class_id', logClass);
    api<{ items: MessageLogItem[]; total: number; page: number; pages: number }>(`/messages/log?${params.toString()}`)
      .then((l) => {
        setLog(l.items);
        setLogTotal(l.total ?? 0);
        setLogPages(l.pages ?? 1);
      })
      .catch(() => setError('Could not load the delivery log.'));
  }, [logType, logClass, logFilter, logPage]);

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

  // Messaging Center: ONE TAP — approve the held drafts AND get wa.me
  // links. WhatsApp is the default channel now; the SIM path above stays
  // for schools with a linked companion device.
  const approveWhatsApp = async (g: PendingGroup) => {
    try {
      const res = await api<{ approved: number; cancelled: number; links: WhatsAppLinkItem[]; skipped: Array<{ queueId: string; reason: string }> }>('/messages/whatsapp-links', {
        method: 'POST',
        body: { group_id: g.group_id },
      });
      setWaLinks(res.links ?? []);
      if (res.cancelled > 0) {
        push('error', `${res.cancelled} message(s) were for a non-school day and were cancelled.`);
      }
      push('success', `${res.approved} message(s) approved — tap each WhatsApp link below to send.`);
      load();
    } catch (e) {
      push('error', errText(e));
    }
  };

  const whatsappRow = async (m: MessageLogItem) => {
    try {
      const res = await api<{ links: WhatsAppLinkItem[] }>('/messages/whatsapp-links', {
        method: 'POST',
        body: { queue_ids: [m.id] },
      });
      setWaLinks(res.links ?? []);
      push('success', 'WhatsApp link ready below — tap it to send.');
    } catch (e) {
      push('error', errText(e));
    }
  };

  const sendEmail = async (id: string, to: string) => {
    try {
      const res = await api<{ sent: boolean; error?: string }>(`/messages/queue/${id}/send-email`, {
        method: 'POST',
        body: { to },
      });
      if (res.sent) push('success', 'Email sent.');
      else push('error', `Email could not be sent: ${res.error ?? 'unknown error'}`);
      setEmailFor(null);
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
        {/* FINAL REBUILD (Module C): which number/SIM sends the SMS. When
            a companion device is linked the line names that SIM; otherwise
            the saved sender number itself is shown. */}
        <p className="mt-2 text-sm text-slate-600">
          {sms?.device_name ? (
            <>
              Sending from <strong>{sms.device_name}</strong> (SIM {sms.device_online ? 'online' : 'offline'})
              {sms.sender_number_masked ? <> · <span className="font-mono text-xs">{sms.sender_number_masked}</span></> : ' · sender number not set'}
            </>
          ) : sms?.sender_number_masked ? (
            <>
              Sending from <span className="font-mono text-xs">{sms.sender_number_masked}</span> · no companion phone linked
            </>
          ) : (
            <>No sender number set — add one in <a className="font-medium text-brand-700 hover:underline" href="/settings">Settings → School &amp; SMS</a>.</>
          )}
          {' · '}
          <a className="font-medium text-brand-700 hover:underline" href="/settings">Change sender number</a>
        </p>
        {/* Messaging Center: the companion app is legacy — WhatsApp is now
            the default. The device/SIM path stays for schools already set up. */}
        <p className="mt-2 text-xs text-slate-500">
          Companion app (legacy): the Android app is no longer needed — WhatsApp is now the default way to
          send. Schools with a linked device can keep using it for SMS.
        </p>
      </Card>

      {waLinks && (
        <WhatsAppSendPanel links={waLinks} onClose={() => setWaLinks(null)} />
      )}

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
              <PendingGroupCard key={g.group_id ?? `${g.class}-${g.date}`} group={g} onApprove={() => setPendingApprove(g)} onApproveWhatsApp={() => setPendingWhatsApp(g)} onEditBody={editBody} />
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
            <select className={inputCls + ' w-auto'} value={logFilter} onChange={(e) => { setLogFilter(e.target.value as typeof logFilter); setLogPage(1); }} autoComplete="off">
              <option value="all">All statuses</option>
              <option value="sent">Sent</option>
              <option value="queued">Queued</option>
              <option value="failed">Failed</option>
            </select>
            <select className={inputCls + ' w-auto'} value={logType} onChange={(e) => { setLogType(e.target.value as typeof logType); setLogPage(1); }} autoComplete="off">
              <option value="all">All types</option>
              <option value="absent">Absent</option>
              <option value="fee_reminder">Fee reminder</option>
              <option value="teacher_reminder">Teacher reminder</option>
              <option value="result">Result</option>
              <option value="announcement">Announcement</option>
              <option value="custom">Custom</option>
            </select>
            <select className={inputCls + ' w-auto'} value={logClass} onChange={(e) => { setLogClass(e.target.value); setLogPage(1); }} autoComplete="off">
              <option value="">All classes</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>{c.name}-{c.section}</option>
              ))}
            </select>
          </div>
          {log.length === 0 ? (
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
                  {log.map((m) => {
                    const item = m as LogItemWithChannel;
                    const approved = Boolean(item.approved_at);
                    return (
                    <tr key={m.id} className="align-top hover:bg-slate-50">
                      <td className="px-4 py-2.5 capitalize">{m.type.replace('_', ' ')}</td>
                      <td className="px-4 py-2.5 font-medium">{m.student_name ?? '—'}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">{m.parent_phone_masked}</td>
                      <td className="max-w-xs px-4 py-2.5 text-xs text-slate-600">{m.body}</td>
                      <td className="px-4 py-2.5">
                        {statusBadge(m.status)}
                        {m.error && <p className="mt-1 text-xs text-red-600">{m.error}</p>}
                        {item.delivery && (
                          <p className="mt-1 text-xs text-slate-500">
                            {deliveryLabel(item.delivery)}
                            {item.delivery.error ? ` — ${item.delivery.error}` : ''}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs">{fmtDateTime(m.sent_at)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          {m.status === 'queued' && approved && (
                            <Button variant="secondary" onClick={() => void whatsappRow(m)}>WhatsApp</Button>
                          )}
                          {(m.status === 'queued' || m.status === 'failed') && (
                            <Button variant="secondary" onClick={() => setEmailFor({ id: m.id, to: '' })}>Email</Button>
                          )}
                          {m.status === 'failed' && (
                            <Button variant="secondary" onClick={() => setPendingRetry(m)}>Retry</Button>
                          )}
                        </div>
                        {emailFor?.id === m.id && (
                          <div className="mt-2 flex gap-2">
                            <input
                              className={inputCls}
                              type="email"
                              placeholder="Leave blank to use the parent's saved email"
                              value={emailFor.to}
                              onChange={(e) => setEmailFor({ id: m.id, to: e.target.value })}
                              autoComplete="off"
                            />
                            <Button onClick={() => void sendEmail(m.id, emailFor.to)}>Send</Button>
                          </div>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {log.length > 0 && (
            <Pager page={logPage} pages={logPages} total={logTotal} itemLabel="messages" itemLabelSingular="message" onPage={setLogPage} />
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
        open={pendingWhatsApp !== null}
        title="Approve & send via WhatsApp?"
        message={
          pendingWhatsApp
            ? `Are you sure? This will approve ${pendingWhatsApp.messages.length} message(s) for Class ${pendingWhatsApp.class} (${pendingWhatsApp.date}) and show a WhatsApp link for each parent — tap a link, WhatsApp opens with the message ready, and you send it there. No companion app needed.`
            : ''
        }
        confirmLabel={`Approve & WhatsApp ${pendingWhatsApp?.messages.length ?? 0}`}
        tone="primary"
        onConfirm={() => {
          const g = pendingWhatsApp;
          setPendingWhatsApp(null);
          if (g) void approveWhatsApp(g);
        }}
        onCancel={() => setPendingWhatsApp(null)}
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
  onApproveWhatsApp,
  onEditBody,
}: {
  group: PendingGroup;
  onApprove: () => void;
  onApproveWhatsApp: () => void;
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
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onApproveWhatsApp}>Approve & WhatsApp ({group.messages.length})</Button>
          <Button onClick={onApprove}>Approve & send all ({group.messages.length})</Button>
        </div>
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
