// Events + holiday calendar (6C-2) — month view merging holidays + events.
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api';
import type { PageResult } from '../lib/types';
import { currentMonth, todayISO } from '../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Spinner, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';
import { useLanguage } from '../lib/i18n';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

interface CalendarDay {
  date: string;
  kind: 'holiday' | 'event';
  title: string;
  description: string | null;
  ref_id: string;
}

interface EventItem {
  id: string;
  date: string;
  title: string;
  description: string | null;
}

export default function EventsPage() {
  const { title } = useLanguage();
  const [month, setMonth] = useState(currentMonth());
  const [days, setDays] = useState<CalendarDay[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [date, setDate] = useState(todayISO());
  const [eTitle, setETitle] = useState('');
  const [description, setDescription] = useState('');
  // Phase 9 fix: the form could only create events — a holiday could only
  // be added from Settings. The type selector below creates a holiday
  // (POST /holidays, the same endpoint Settings uses) so it lands in the
  // holidays table: no attendance reminders or messages on that date, and
  // it shows on this calendar as a Holiday.
  const [kind, setKind] = useState<'event' | 'holiday'>('event');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState<EventItem | null>(null);
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<{ month: string; days: CalendarDay[] }>(`/events/calendar?month=${month}`),
      api<PageResult<EventItem>>(`/events?month=${month}&limit=200`),
    ])
      .then(([c, e]) => {
        setDays(c.days);
        setEvents(e.items);
        setError('');
      })
      .catch(() => setError('Could not load the calendar.'))
      .finally(() => setLoading(false));
  }, [month]);

  useEffect(load, [load]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (eTitle.trim().length < 2) {
      setError('Enter a title for the event.');
      return;
    }
    setConfirming(true);
  };

  const doCreate = async () => {
    setBusy(true);
    setConfirming(false);
    try {
      if (kind === 'holiday') {
        const r = await api<{ status?: string }>('/holidays', { method: 'POST', body: { date, name: eTitle.trim() } });
        if (r?.status === 'pending') push('success', 'Holiday submitted for admin approval — nothing was applied yet.');
        else push('success', 'Holiday added — no attendance reminders or messages on that date.');
      } else {
        const r = await api<{ status?: string }>('/events', { method: 'POST', body: { date, title: eTitle.trim(), description: description.trim() || undefined } });
        if ((r as { status?: string })?.status === 'pending') push('success', 'Submitted for admin approval — nothing was applied yet.');
        else push('success', 'Event added.');
      }
      setETitle('');
      setDescription('');
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
      await api(`/events/${deleting.id}`, { method: 'DELETE' });
      push('success', 'Event deleted.');
      setDeleting(null);
      load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner label="Loading calendar…" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{title('events')}</h1>
          <p className="text-sm text-slate-500">School events and holidays for the month, in one place.</p>
        </div>
        <input type="month" className={inputCls + ' w-auto'} value={month} onChange={(e) => setMonth(e.target.value || currentMonth())} autoComplete="off" />
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      <Card className="p-5">
        <h2 className="text-base font-semibold">Add an event or holiday</h2>
        <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-4" autoComplete="off">
          <Field label="Type">
            <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as 'event' | 'holiday')}>
              <option value="event">Event</option>
              <option value="holiday">Holiday (no school that day)</option>
            </select>
          </Field>
          <Field label="Date">
            <input className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value || todayISO())} autoComplete="off" />
          </Field>
          <Field label="Title">
            <input className={inputCls} value={eTitle} onChange={(e) => setETitle(e.target.value)} placeholder={kind === 'holiday' ? 'e.g. Eid-ul-Fitr' : 'e.g. Sports Day'} autoComplete="off" />
          </Field>
          <Field label="Details">
            <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional details" autoComplete="off" disabled={kind === 'holiday'} />
          </Field>
          <div className="flex items-end sm:col-span-4">
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : kind === 'holiday' ? 'Add holiday' : 'Add event'}</Button>
          </div>
        </form>
      </Card>

      {days.length === 0 ? (
        <EmptyState title="Nothing on the calendar this month" body="Add an event or a holiday with the form above — both show up here." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Details</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {days.map((d) => {
                const ev = d.kind === 'event' ? events.find((x) => x.id === d.ref_id) : undefined;
                return (
                  <tr key={`${d.date}-${d.kind}-${d.ref_id}`} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-medium">{d.date}</td>
                    <td className="px-4 py-2.5"><Badge tone={d.kind === 'holiday' ? 'amber' : 'green'}>{d.kind === 'holiday' ? 'Holiday' : 'Event'}</Badge></td>
                    <td className="px-4 py-2.5">{d.title}</td>
                    <td className="px-4 py-2.5">{d.description ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right">
                      {ev ? (
                        <button className="font-medium text-red-600 hover:underline" onClick={() => setDeleting(ev)}>Delete</button>
                      ) : (
                        <span className="text-xs text-slate-400">Manage in Settings</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        title={kind === 'holiday' ? 'Add this holiday?' : 'Add this event?'}
        message={`Are you sure? This will add "${eTitle.trim()}" on ${date} to the school calendar${kind === 'holiday' ? ' as a holiday — no attendance reminders or messages will be sent that day' : ''}.`}
        confirmLabel={kind === 'holiday' ? 'Add holiday' : 'Add event'}
        tone="primary"
        busy={busy}
        onConfirm={doCreate}
        onCancel={() => setConfirming(false)}
      />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this event?"
        message={deleting ? `Are you sure? This will delete "${deleting.title}" on ${deleting.date}. This cannot be undone.` : ''}
        confirmLabel="Delete event"
        busy={busy}
        onConfirm={doDelete}
        onCancel={() => setDeleting(null)}
      />
      {view}
    </div>
  );
}
