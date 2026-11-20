// Messaging Center wiring frontend tests (2026-11-20): StudentsPanel
// collects a parent email and submits it; the Parents modal offers
// "Send link via WhatsApp" next to SMS and opens the wa.me link.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { apiMock, sendLinkWhatsAppMock } = vi.hoisted(() => ({
  apiMock: vi.fn((url: string, opts?: { method?: string; body?: unknown }) => {
    if (url === '/classes') return Promise.resolve({ items: [] });
    if (url === '/parents?flag=missing&page=1&limit=50') {
      return Promise.resolve({
        items: [
          {
            id: 'stu-1',
            class_id: 'class-1',
            roll_no: 1,
            name: 'Ayesha Khan',
            parent_name: 'Ahmed Khan',
            parent_phone_masked: '+92 3XX XXXX567',
            parent_has_phone: true,
            parent_opt_out: false,
            status: 'active',
            phone_flag: null,
          },
        ],
        total: 1,
        page: 1,
        pages: 1,
      });
    }
    if (url === '/classes/class-1/students' && opts?.method === 'POST') {
      const body = opts.body as Record<string, unknown>;
      return Promise.resolve({ id: 'stu-new', class_id: 'class-1', status: 'active', ...body });
    }
    return Promise.resolve({ items: [], total: 0, page: 1, pages: 1 });
  }),
  sendLinkWhatsAppMock: vi.fn(() =>
    Promise.resolve({ wa_url: 'https://wa.me/923001234567?text=Dear%20Parent', phone_masked: '+92 3XX XXXX567' }),
  ),
}));

vi.mock('../lib/api', () => ({
  ApiClientError: class MockApiError extends Error {
    status = 200;
    code = 'OK';
  },
  api: apiMock,
  portalApi: {
    getTokenInfo: vi.fn(() =>
      Promise.resolve({ exists: true, url: 'http://test/p/tok-1', expires_at: '2027-11-20T00:00:00Z' }),
    ),
    createToken: vi.fn(),
    revokeToken: vi.fn(),
    sendLinkSms: vi.fn(),
    sendLinkWhatsApp: sendLinkWhatsAppMock,
  },
  cachedApiGet: vi.fn(),
}));

vi.mock('../lib/college', () => ({
  useIsCollege: () => ({ isCollege: false, loading: false }),
}));

import StudentsPanel from '../pages/StudentsPanel';
import ParentsPage from '../pages/Parents';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StudentsPanel parent email (Messaging Center wiring)', () => {
  it('shows the Parent email field and submits it with the new student', async () => {
    render(
      <MemoryRouter>
        <StudentsPanel classId="class-1" students={[]} setStudents={() => undefined} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('+ Add student'));
    await waitFor(() => expect(screen.getByText('Parent email (optional)')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('e.g. Ahmed Raza'), { target: { value: 'New Kid' } });
    fireEvent.change(screen.getByPlaceholderText('father@example.com'), {
      target: { value: 'Father@Example.com' },
    });
    fireEvent.click(screen.getByText('Save student'));
    await waitFor(() => expect(screen.getByText('Add this student?')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Add student' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/classes/class-1/students',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ name: 'New Kid', parent_email: 'Father@Example.com' }),
        }),
      ),
    );
  });

  it('rejects a malformed parent email in the form', async () => {
    render(
      <MemoryRouter>
        <StudentsPanel classId="class-1" students={[]} setStudents={() => undefined} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('+ Add student'));
    await waitFor(() => expect(screen.getByText('Parent email (optional)')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('e.g. Ahmed Raza'), { target: { value: 'New Kid' } });
    // 'a@b.c' is a valid HTML email value (jsdom keeps it) but fails the
    // app's stricter rule — a one-letter TLD is not a real address.
    fireEvent.change(screen.getByPlaceholderText('father@example.com'), { target: { value: 'a@b.c' } });
    fireEvent.click(screen.getByText('Save student'));
    await waitFor(() => expect(screen.getByText(/Parent email looks invalid/)).toBeTruthy());
    expect(apiMock).not.toHaveBeenCalledWith(
      '/classes/class-1/students',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('Parents modal — Send link via WhatsApp', () => {
  it('opens the wa.me link from the server (never builds it from the masked number)', async () => {
    const openMock = vi.fn(() => null);
    vi.stubGlobal('open', openMock);
    const realOpen = window.open;
    window.open = openMock as unknown as typeof window.open;
    try {
      render(
        <MemoryRouter>
          <ParentsPage />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByText('Ayesha Khan')).toBeTruthy());
      fireEvent.click(screen.getByText('Parent link'));
      await waitFor(() => expect(screen.getByText('Send link via WhatsApp')).toBeTruthy());
      expect(screen.getByText('Send link via SMS')).toBeTruthy();
      fireEvent.click(screen.getByText('Send link via WhatsApp'));
      await waitFor(() => expect(sendLinkWhatsAppMock).toHaveBeenCalledWith('stu-1'));
      expect(openMock).toHaveBeenCalledWith('https://wa.me/923001234567?text=Dear%20Parent', '_blank', 'noopener');
    } finally {
      window.open = realOpen;
      vi.unstubAllGlobals();
    }
  });
});
