// Parent-portal inbox (Messaging Center, 2026-11-20).
//
// Parents see the messages the school sent about their child — absent
// alerts, fee reminders, custom messages — plus school announcements, in
// one list. Read-only, token-gated (same token as the portal page).
// Fetched with plain fetch because this is a public endpoint (no login).
//
// NOTE (wiring): ParentPortal.tsx is staged in the union push, so this
// component is not wired into the portal page yet — one import + one tab
// after the push lands. Until then it is used by tests and ready to drop in.
import { useEffect, useState } from 'react';
import { API_BASE } from '../lib/api';
import { fmtDateTime } from '../lib/utils';
import { Badge, Card, EmptyState, Spinner } from './ui';

export interface PortalInboxItem {
  id: string;
  kind: 'message' | 'announcement';
  channel?: 'SMS' | 'WhatsApp' | 'Email';
  type?: string;
  title?: string | null;
  body: string;
  sent_at: string;
  delivery_status?: string;
  /** True once this token has marked the item read (Messages tab). */
  read?: boolean;
}

export interface PortalInboxData {
  school: { name: string };
  student: { id: string; name: string; class_name: string };
  messages: PortalInboxItem[];
}

function channelBadge(item: PortalInboxItem) {
  if (item.kind === 'announcement') return <Badge tone="slate">Announcement</Badge>;
  if (item.channel === 'WhatsApp') return <Badge tone="green">WhatsApp</Badge>;
  if (item.channel === 'Email') return <Badge tone="blue">Email</Badge>;
  return <Badge tone="slate">SMS</Badge>;
}

export default function PortalInbox({ token }: { token: string }) {
  const [data, setData] = useState<PortalInboxData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/portal/${encodeURIComponent(token)}/inbox`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { data: PortalInboxData };
        if (cancelled) return;
        setData(json.data);
        // Mark what this parent just saw as read (fire-and-forget: the
        // "New" badges above come from this same load, so a failure here
        // only means the badges show again next time — never an error).
        const unread = json.data.messages.filter((m) => m.read === false);
        if (unread.length > 0) {
          void fetch(`${API_BASE}/portal/${encodeURIComponent(token)}/inbox/read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: unread.map((m) => ({ kind: m.kind, id: m.id })) }),
          }).catch(() => undefined);
        }
      } catch {
        if (!cancelled) setError('Could not load messages. Check your connection and try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (loading) return <Spinner label="Loading messages…" />;
  if (error || !data) {
    return <EmptyState title="Messages could not be loaded" body={error || 'Try again later.'} />;
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">
        Messages from {data.school.name} for {data.student.name} ({data.student.class_name}).
      </p>
      {data.messages.length === 0 ? (
        <EmptyState title="No messages yet" body="When the school sends a message about your child, it will appear here." />
      ) : (
        data.messages.map((item) => (
          <Card key={`${item.kind}-${item.id}`} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {channelBadge(item)}
                {item.read === false && <Badge tone="green">New</Badge>}
                {item.type && (
                  <span className="text-xs capitalize text-slate-500">{item.type.replace('_', ' ')}</span>
                )}
              </div>
              <span className="text-xs text-slate-500">{fmtDateTime(item.sent_at)}</span>
            </div>
            {item.title && <p className="mt-2 text-sm font-semibold text-slate-900">{item.title}</p>}
            <p className="mt-1 text-sm text-slate-700">{item.body}</p>
            {item.delivery_status === 'opened' && (
              <p className="mt-1 text-xs text-slate-500">Opened in WhatsApp — delivery not confirmed.</p>
            )}
          </Card>
        ))
      )}
    </div>
  );
}
