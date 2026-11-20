import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Round-3: sendMail must fail fast (short SMTP timeouts, not nodemailer's
 * 2-min connection default) and retry once on a fresh transporter. */
const mocks = vi.hoisted(() => {
  const sendMailMock = vi.fn();
  const createTransportMock = vi.fn((_opts: any) => ({ sendMail: sendMailMock }));
  return { sendMailMock, createTransportMock };
});

vi.mock('nodemailer', () => ({
  default: { createTransport: mocks.createTransportMock },
}));

describe('sendMail via Brevo (HTTPS transport)', () => {
  const fetchMock = vi.fn();

  function brevoResponse(status: number, body: unknown): Response {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(text),
      text: async () => text,
    } as Response;
  }

  beforeEach(() => {
    vi.resetModules();
    mocks.sendMailMock.mockReset();
    mocks.createTransportMock.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.MAIL_FROM;
    process.env.BREVO_API_KEY = 'xkeysib-test-key';
    delete process.env.BREVO_SENDER_EMAIL;
    delete process.env.BREVO_SENDER_NAME;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BREVO_API_KEY;
    delete process.env.BREVO_SENDER_EMAIL;
    delete process.env.BREVO_SENDER_NAME;
  });

  it('POSTs the documented Brevo shape and resolves on 201', async () => {
    const { sendMail } = await import('./mail');
    fetchMock.mockResolvedValueOnce(brevoResponse(201, { messageId: 'msg-1' }));
    await sendMail({ to: 'a@b.pk', subject: 's', text: 't' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['api-key']).toBe('xkeysib-test-key');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.sender).toEqual({ name: 'Student Manager', email: 'majidalioffical0@gmail.com' });
    expect(body.to).toEqual([{ email: 'a@b.pk' }]);
    expect(body.subject).toBe('s');
    expect(body.textContent).toBe('t');
    expect(mocks.createTransportMock).not.toHaveBeenCalled();
  });

  it('uses BREVO_SENDER_EMAIL / BREVO_SENDER_NAME when set', async () => {
    process.env.BREVO_SENDER_EMAIL = 'school@example.test';
    process.env.BREVO_SENDER_NAME = 'My School';
    const { sendMail } = await import('./mail');
    fetchMock.mockResolvedValueOnce(brevoResponse(201, { messageId: 'msg-2' }));
    await sendMail({ to: 'a@b.pk', subject: 's', text: 't' });
    const [, init] = fetchMock.mock.calls[0] as [string, Record<string, unknown>];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.sender).toEqual({ name: 'My School', email: 'school@example.test' });
  });

  it('throws with the provider message on 401 and does NOT retry 4xx', async () => {
    const { sendMail } = await import('./mail');
    fetchMock.mockResolvedValueOnce(
      brevoResponse(401, { message: 'Invalid API key', code: 'unauthorized' }),
    );
    await expect(sendMail({ to: 'a@b.pk', subject: 's', text: 't' })).rejects.toThrow(
      'Brevo 401: Invalid API key',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once on 500, then throws with the provider message', async () => {
    const { sendMail } = await import('./mail');
    fetchMock
      .mockResolvedValueOnce(brevoResponse(500, { message: 'Server error', code: 'server_error' }))
      .mockResolvedValueOnce(brevoResponse(500, { message: 'Server error', code: 'server_error' }));
    await expect(sendMail({ to: 'a@b.pk', subject: 's', text: 't' })).rejects.toThrow(
      'Brevo 500: Server error',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on a network error, then throws', async () => {
    const { sendMail } = await import('./mail');
    fetchMock.mockRejectedValueOnce(new Error('fetch failed')).mockRejectedValueOnce(new Error('fetch failed'));
    await expect(sendMail({ to: 'a@b.pk', subject: 's', text: 't' })).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sendMailOnce makes a single Brevo attempt (no retry) with a 10s timeout', async () => {
    const { sendMailOnce } = await import('./mail');
    fetchMock.mockResolvedValueOnce(brevoResponse(500, { message: 'Server error', code: 'server_error' }));
    await expect(sendMailOnce({ to: 'a@b.pk', subject: 's', text: 't' })).rejects.toThrow(
      'Brevo 500: Server error',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Brevo wins over SMTP when both are configured', async () => {
    process.env.SMTP_HOST = 'smtp.example.test';
    const { sendMail } = await import('./mail');
    fetchMock.mockResolvedValueOnce(brevoResponse(201, { messageId: 'msg-3' }));
    await sendMail({ to: 'a@b.pk', subject: 's', text: 't' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.createTransportMock).not.toHaveBeenCalled();
  });
});

describe('sendMail with no transport configured (dev log)', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.sendMailMock.mockReset();
    mocks.createTransportMock.mockClear();
    delete process.env.SMTP_HOST;
    delete process.env.BREVO_API_KEY;
  });

  it('resolves without sending anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { sendMail, sendMailOnce } = await import('./mail');
    await sendMail({ to: 'a@b.pk', subject: 's', text: 't' });
    await sendMailOnce({ to: 'a@b.pk', subject: 's', text: 't' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.createTransportMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('sendMail (round 3: fail-fast SMTP)', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.sendMailMock.mockReset();
    mocks.createTransportMock.mockClear();
    process.env.SMTP_HOST = 'smtp.example.test';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'u@example.test';
    process.env.SMTP_PASS = 'secret';
    process.env.MAIL_FROM = 'School <noreply@example.test>';
  });

  afterEach(() => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.MAIL_FROM;
  });

  it('creates the transporter with short timeouts, not the 2-min nodemailer default', async () => {
    const { sendMail } = await import('./mail');
    mocks.sendMailMock.mockResolvedValueOnce(undefined);
    await sendMail({ to: 'a@b.pk', subject: 's', text: 't' });
    expect(mocks.createTransportMock).toHaveBeenCalledTimes(1);
    const opts = mocks.createTransportMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.connectionTimeout).toBeLessThanOrEqual(10_000);
    expect(opts.greetingTimeout).toBeLessThanOrEqual(10_000);
    expect(opts.socketTimeout).toBeLessThanOrEqual(30_000);
    expect(opts.host).toBe('smtp.example.test');
  });

  it('retries once with a fresh transporter after a transient failure', async () => {
    const { sendMail } = await import('./mail');
    mocks.sendMailMock.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(undefined);
    await sendMail({ to: 'a@b.pk', subject: 's', text: 't' });
    expect(mocks.sendMailMock).toHaveBeenCalledTimes(2);
    expect(mocks.createTransportMock).toHaveBeenCalledTimes(2);
  });

  it('throws after both attempts fail', async () => {
    const { sendMail } = await import('./mail');
    mocks.sendMailMock.mockRejectedValue(new Error('SMTP down'));
    await expect(sendMail({ to: 'a@b.pk', subject: 's', text: 't' })).rejects.toThrow('SMTP down');
    expect(mocks.sendMailMock).toHaveBeenCalledTimes(2);
  });
});
