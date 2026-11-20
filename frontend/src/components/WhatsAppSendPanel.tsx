// WhatsApp send panel (Messaging Center, 2026-11-20).
//
// WhatsApp is the default delivery channel now: the admin taps each link,
// WhatsApp opens with the message pre-filled, and one tap in WhatsApp
// sends it. The panel records each tap as "opened in WhatsApp" — the site
// cannot confirm WhatsApp delivery, so nothing here ever says "delivered".
import { useState } from 'react';
import { api, ApiClientError } from '../lib/api';
import { Badge, Button, Card, useToast } from './ui';

export interface WhatsAppLinkItem {
  queue_id: string;
  student: string | null;
  parent_phone_masked: string;
  body: string;
  wa_url: string;
}

export default function WhatsAppSendPanel({
  links,
  onClose,
}: {
  links: WhatsAppLinkItem[];
  onClose?: () => void;
}) {
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const { push } = useToast();

  const openLink = async (link: WhatsAppLinkItem) => {
    window.open(link.wa_url, '_blank', 'noopener');
    try {
      await api(`/messages/queue/${link.queue_id}/whatsapp-opened`, { method: 'POST' });
      setOpened((prev) => new Set(prev).add(link.queue_id));
    } catch (e) {
      const msg = e instanceof ApiClientError ? e.message : 'Could not record that the link was opened.';
      setError(msg);
      push('error', msg);
    }
  };

  return (
    <Card className="border-green-200 bg-green-50 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Send via WhatsApp ({links.length})</h2>
          <p className="text-sm text-slate-600">
            Tap each link — WhatsApp opens with the message ready; tap send in WhatsApp. The site records
            “opened in WhatsApp”, not delivered: it cannot confirm the send inside WhatsApp.
          </p>
        </div>
        {onClose && (
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <ul className="mt-4 space-y-3">
        {links.map((link) => {
          const isOpened = opened.has(link.queue_id);
          return (
            <li key={link.queue_id} className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-800">
                  {link.student ?? '—'} ·{' '}
                  <span className="font-mono text-xs text-slate-500">{link.parent_phone_masked}</span>
                </p>
                {isOpened ? (
                  <Badge tone="green">Opened in WhatsApp</Badge>
                ) : (
                  <Button onClick={() => void openLink(link)}>Open in WhatsApp</Button>
                )}
              </div>
              <p className="mt-1 text-sm text-slate-600">{link.body}</p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
