import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { MessageLogItem, MessageTemplate, PendingGroup, SmsStatus } from '../lib/types';
import { fmtDateTime } from '../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Spinner, Tabs, inputCls, useToast } from '../components/ui';

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
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [sms, setSms] = useState<SmsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [logFilter, setLogFilter] = useState<'all' | 'sent' | 'failed' | 'queued'>('all');
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<PendingGroup[]>('/messages/pending-approval'),
      api<{ items: MessageLogItem[] }>('/messages/log?limit=100'),
      api<MessageTemplate[]>('/messages/templates'),
      api<SmsStatus>('/sms/status'),
    ])
      .then(([p, l, t, s]) => {
        setPending(p);
        setLog(l.items);
        setTemplates(t);
        setSms(s);
        setError('');
      })
      .catch(() => setError('Could not load messages.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const approveGroup = async (g: PendingGroup) => {
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
          { key: 'log', label: 'Delivery log' },
          { key: 'templates', label: 'Templates' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'pending' && (
        <>
          {pending.length === 0 ? (
            <EmptyState title="Nothing waiting for approval" body="When a class submits attendance with absent students, their messages appear here first." />
          ) : (
            pending.map((g) => (
              <PendingGroupCard key={g.group_id ?? `${g.class}-${g.date}`} group={g} onApprove={() => approveGroup(g)} onEditBody={editBody} />
            ))
          )}
        </>
      )}

      {tab === 'log' && (
        <>
          <div className="flex gap-2">
            <select className={inputCls + ' w-auto'} value={logFilter} onChange={(e) => setLogFilter(e.target.value as typeof logFilter)}>
              <option value="all">All statuses</option>
              <option value="sent">Sent</option>
              <option value="queued">Queued</option>
              <option value="failed">Failed</option>
            </select>
          </div>
          {filteredLog.length === 0 ? (
            <EmptyState title="No messages yet" body="Sent, queued and failed messages will be listed here with their status." />
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
                      </td>
                      <td className="px-4 py-2.5 text-xs">{fmtDateTime(m.sent_at)}</td>
                      <td className="px-4 py-2.5 text-right">
                        {m.status === 'failed' && (
                          <Button variant="secondary" onClick={() => retry(m.id)}>Retry</Button>
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

      {tab === 'templates' && <TemplatesEditor templates={templates} onSaved={load} push={push} />}
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
                <textarea className={inputCls} rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
                <p className="mt-1 text-xs text-slate-500">{draft.length} characters (SMS: 160 chars per segment)</p>
                <div className="mt-2 flex gap-2">
                  <Button onClick={() => { onEditBody(m.id, draft); setEditingId(null); }}>Save</Button>
                  <Button variant="secondary" onClick={() => setEditingId(null)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <p className="mt-1 text-sm text-slate-600">{m.body}</p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TemplatesEditor({
  templates,
  onSaved,
  push,
}: {
  templates: MessageTemplate[];
  onSaved: () => void;
  push: (kind: 'success' | 'error', text: string) => void;
}) {
  const [lang, setLang] = useState<'en' | 'ur'>('en');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const save = async (t: MessageTemplate) => {
    const body = drafts[t.id] ?? t.body;
    setBusy(t.id);
    try {
      await api(`/messages/templates/${t.id}`, { method: 'PATCH', body: { body } });
      push('success', 'Template saved.');
      onSaved();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBusy(null);
    }
  };

  const shown = templates.filter((t) => t.language === lang);
  const typeLabel: Record<string, string> = {
    absent: 'Absent alert',
    fee_reminder: 'Fee reminder',
    teacher_reminder: 'Teacher reminder',
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Button variant={lang === 'en' ? 'primary' : 'secondary'} onClick={() => setLang('en')}>English</Button>
        <Button variant={lang === 'ur' ? 'primary' : 'secondary'} onClick={() => setLang('ur')}>اردو</Button>
      </div>
      <p className="text-sm text-slate-500">
        Variables: {'{student_name}'} {'{class}'} {'{date}'} {'{month}'} {'{amount}'} {'{school_name}'}
      </p>
      {shown.length === 0 && <EmptyState title="No templates for this language" body="Templates are seeded for English and Urdu by the backend." />}
      {shown.map((t) => {
        const body = drafts[t.id] ?? t.body;
        return (
          <Card key={t.id} className="p-5">
            <h3 className="text-sm font-semibold text-slate-900">{typeLabel[t.type] ?? t.type}</h3>
            <textarea
              className={`${inputCls} mt-2 ${lang === 'ur' ? 'urdu' : ''}`}
              dir={lang === 'ur' ? 'rtl' : 'ltr'}
              rows={4}
              value={body}
              onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
            />
            <div className="mt-2 flex items-center justify-between">
              <p className="text-xs text-slate-500">
                {body.length} characters · {Math.max(1, Math.ceil(body.length / 160))} SMS segment(s)
                {body.length > 160 ? ' — long messages cost more and may arrive split.' : ''}
              </p>
              <Button disabled={busy === t.id || body === t.body} onClick={() => save(t)}>
                {busy === t.id ? 'Saving…' : 'Save template'}
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
