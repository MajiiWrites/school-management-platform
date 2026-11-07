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
