// Messaging Center frontend tests (2026-11-20): WhatsApp send panel
// (open link → record opened, honest "opened" badge) and the parent-portal
// inbox (messages + announcements, one student's data only). API/fetch mocked.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: apiMock };
});

import WhatsAppSendPanel from '../components/WhatsAppSendPanel';
import PortalInbox from '../components/PortalInbox';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const LINKS = [
  {
    queue_id: 'q-1',
    student: 'Ayesha Khan',
    parent_phone_masked: '+92 3XX XXXX567',
    body: 'Dear Parent, Ayesha Khan was absent today.',
    wa_url: 'https://wa.me/923001234567?text=Dear%20Parent',
  },
  {
    queue_id: 'q-2',
    student: 'Bilal Ahmed',
    parent_phone_masked: '+92 3XX XXXX568',
    body: 'Dear Parent, Bilal Ahmed was absent today.',
    wa_url: 'https://wa.me/923001234568?text=Dear%20Parent',
  },
];

describe('WhatsAppSendPanel', () => {
  it('opens the wa.me link and records "opened" — never "delivered"', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    apiMock.mockResolvedValueOnce({ queue: { id: 'q-1', status: 'sent' } });
    render(<WhatsAppSendPanel links={LINKS} />);

    const buttons = screen.getAllByText('Open in WhatsApp');
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);

    expect(openSpy).toHaveBeenCalledWith(
      'https://wa.me/923001234567?text=Dear%20Parent',
      '_blank',
      'noopener',
    );
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/messages/queue/q-1/whatsapp-opened', { method: 'POST' }),
    );
    await waitFor(() => expect(screen.getByText('Opened in WhatsApp')).toBeTruthy());
    // The second link is still unopened.
    expect(screen.getAllByText('Open in WhatsApp')).toHaveLength(1);
    expect(screen.queryByText('Delivered')).toBeNull();
  });

  it('explains that opening is recorded as opened, not delivered', () => {
    render(<WhatsAppSendPanel links={LINKS} />);
    expect(screen.getByText(/records.*opened in WhatsApp/i)).toBeTruthy();
  });
});

describe('PortalInbox', () => {
  const INBOX = {
    school: { name: 'Test School' },
    student: { id: 'stu-1', name: 'Ayesha Khan', class_name: '5-A' },
    messages: [
      {
        id: 'q-1',
        kind: 'message',
        channel: 'WhatsApp',
        type: 'absent',
        body: 'Ayesha was absent.',
        sent_at: '2026-11-19T08:00:00Z',
        delivery_status: 'opened',
      },
      {
        id: 'a-1',
        kind: 'announcement',
        title: 'PTM Friday',
        body: 'Meeting at 10am.',
        sent_at: '2026-11-18T00:00:00Z',
      },
    ],
  };

  function mockFetchOk(data: unknown) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data }),
    } as Response);
  }

  it('lists the student’s messages with channel + honest WhatsApp state', async () => {
    mockFetchOk(INBOX);
    render(<PortalInbox token="tok-1" />);
    await waitFor(() => expect(screen.getByText('Ayesha was absent.')).toBeTruthy());
    expect(screen.getByText('WhatsApp')).toBeTruthy();
    expect(screen.getByText('PTM Friday')).toBeTruthy();
    expect(screen.getByText(/Opened in WhatsApp — delivery not confirmed/)).toBeTruthy();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/portal/tok-1/inbox'),
    );
  });

  it('shows an empty state when there are no messages', async () => {
    mockFetchOk({ ...INBOX, messages: [] });
    render(<PortalInbox token="tok-1" />);
    await waitFor(() => expect(screen.getByText('No messages yet')).toBeTruthy());
  });

  it('shows an error state when the inbox cannot load', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404 } as Response);
    render(<PortalInbox token="bad-token" />);
    await waitFor(() => expect(screen.getByText('Messages could not be loaded')).toBeTruthy());
  });
});
