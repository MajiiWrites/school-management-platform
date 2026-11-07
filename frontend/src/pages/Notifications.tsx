// Notification center (6C-2) — one read-only aggregation: pending
// approvals, failed messages, OCR items needing review, fee dues.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { NotificationItem } from '../lib/types';
import { fmtDateTz, fmtPKR } from '../lib/utils';
import { Card, EmptyState, ErrorBanner, Spinner } from '../components/ui';
import { useLanguage } from '../lib/i18n';

interface Center {
  month: string;
  counts: {
    pending_approvals: number;
    failed_messages: number;
    ocr_needing_review: number;
    fee_dues: number;
    fee_dues_amount: number;
    unread_notifications: number;
  };
  items: {
    pending_approvals: { id: string; action_type: string; entity: string; requested_by: string | null; created_at: string }[];
    failed_messages: { id: string; type: string; student_id: string | null; error: string | null; created_at: string }[];
    ocr_needing_review: { id: string; kind: string; class_id: string | null; created_at: string }[];
    fee_dues: { student_id: string; student_name: string; class_name: string | null; month: string; balance: number; status: string }[];
  };
}

export default function NotificationsPage() {
  const { title } = useLanguage();
  const [center, setCenter] = useState<Center | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api<Center>('/notifications/center')
      .then((d) => {
        setCenter(d);
        setError('');
      })
      .catch(() => setError('Could not load the notification center.'))
      .finally(() => setLoading(false));
    // Phase 9 fix (stale header badge): opening the notification center
    // counts as viewing the notifications, so mark the unread ones read
    // — the header badge (refetched on navigation) then clears instead
    // of staying stuck at the old count.
    // R2-D (i): the old fire-and-forget loop raced the header's refetch
    // on navigation, so the badge only cleared after a reload. Await all
    // mark-read calls, then tell the header (Layout listens for
    // 'notifications-read') so it clears the badge immediately, no reload.
    api<{ items: NotificationItem[] }>('/notifications?limit=100')
      .then(async (d) => {
        const unread = d.items.filter((x) => !x.is_read);
        await Promise.allSettled(
          unread.map((n) => api(`/notifications/${n.id}/read`, { method: 'POST' })),
        );
        if (unread.length > 0) window.dispatchEvent(new Event('notifications-read'));
      })
      .catch(() => undefined);
  }, []);

  useEffect(load, [load]);

  if (loading) return <Spinner label="Loading notifications…" />;
  if (error) return <ErrorBanner message={error} onRetry={load} />;
  if (!center) return <EmptyState title="Nothing here yet" body="When there is something that needs attention it shows up here." />;

  const c = center.counts;
  const allClear = c.pending_approvals === 0 && c.failed_messages === 0 && c.ocr_needing_review === 0 && c.fee_dues === 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{title('notifications')}</h1>
        <p className="text-sm text-slate-500">Everything that needs your attention, in one place — {center.month}.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Pending approvals</p>
          <p className="mt-1 text-2xl font-bold text-amber-600">{c.pending_approvals}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Failed messages</p>
          <p className="mt-1 text-2xl font-bold text-red-600">{c.failed_messages}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">OCR to review</p>
          <p className="mt-1 text-2xl font-bold text-slate-900">{c.ocr_needing_review}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Fee dues ({fmtPKR(c.fee_dues_amount)})</p>
          <p className="mt-1 text-2xl font-bold text-slate-900">{c.fee_dues}</p>
        </Card>
      </div>

      {allClear ? (
        <EmptyState title="All clear" body="No pending approvals, failed messages, OCR reviews or fee dues right now." />
      ) : (
        <div className="space-y-4">
          {center.items.pending_approvals.length > 0 && (
            <Card className="p-5">
              <h2 className="text-base font-semibold">Pending approvals</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {center.items.pending_approvals.map((a) => (
                  <li key={a.id} className="flex justify-between gap-3">
                    <span>{a.action_type} {a.entity}</span>
                    <span className="text-slate-500">{fmtDateTz(a.created_at)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {center.items.failed_messages.length > 0 && (
            <Card className="p-5">
              <h2 className="text-base font-semibold">Failed messages</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {center.items.failed_messages.map((m) => (
                  <li key={m.id} className="flex justify-between gap-3">
                    <span>{m.type}{m.error ? ` — ${m.error}` : ''}</span>
                    <span className="text-slate-500">{fmtDateTz(m.created_at)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {center.items.ocr_needing_review.length > 0 && (
            <Card className="p-5">
              <h2 className="text-base font-semibold">OCR items needing review</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {center.items.ocr_needing_review.map((o) => (
                  <li key={o.id} className="flex justify-between gap-3">
                    <span>{o.kind === 'result_sheet' ? 'Result sheet' : 'Student list'} — needs review</span>
                    <span className="text-slate-500">{fmtDateTz(o.created_at)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {center.items.fee_dues.length > 0 && (
            <Card className="p-5">
              <h2 className="text-base font-semibold">Fee dues — {center.month}</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {center.items.fee_dues.map((f) => (
                  <li key={f.student_id} className="flex justify-between gap-3">
                    <span>{f.student_name}{f.class_name ? ` (${f.class_name})` : ''}</span>
                    <span className="font-medium">{fmtPKR(f.balance)} · {f.status}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
