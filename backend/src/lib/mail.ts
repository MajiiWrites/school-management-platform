import nodemailer from 'nodemailer';
import { config } from '../config';

/**
 * Email sender. Transport precedence:
 * 1. Brevo HTTP API (BREVO_API_KEY set) — the only working path from
 *    Render: its free tier blocks outbound SMTP ports 25/465/587, so
 *    Gmail SMTP times out on both 587 and 465. Brevo goes over HTTPS
 *    (port 443). Free plan: 300 emails/day, no card, no domain needed;
 *    the sender address must be verified in Brevo (email click).
 * 2. SMTP (SMTP_HOST set) — kept as the fallback for environments
 *    where SMTP egress works.
 * 3. Dev log (neither set) — the message is logged to the console and
 *    the function resolves; verification and reset tokens are never
 *    lost in dev (contracts/STRUCTURE.md).
 *
 * Round-3 fix (forgot-password hung ~2 min, then "Internal server error"
 * on live, twice): nodemailer's defaults wait 2 min for the TCP connection
 * (CONNECTION_TIMEOUT = 2*60*1000) and 10 min for socket inactivity, so a
 * stalled SMTP connection hung the whole request until the error middleware
 * 500'd it. Explicit short timeouts make a stalled send fail fast, and one
 * retry on a fresh transporter covers a transient egress/DNS blip on the
 * free tier instead of losing a reset/verification email to it.
 */
const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
};

/** Phase 1 (real email verification): the resend endpoint awaits its send
 * so it can report honestly whether the mail went out. A 2-attempt /
 * 20 s send is too slow to await — one attempt with short timeouts
 * bounds it at ~10 s worst case (typically <1 s on a working SMTP
 * path). A transient failure just means the user retries the resend. */
const FAST_SMTP_TIMEOUTS = {
  connectionTimeout: 5_000,
  greetingTimeout: 5_000,
  socketTimeout: 10_000,
};

/** Two send attempts total: the first try plus one retry. */
const SEND_ATTEMPTS = 2;

/** Brevo transactional email API (POST /v3/smtp/email, api-key header,
 * JSON body with sender / to / subject / textContent). Success is 201
 * with a messageId. Error bodies are JSON: { message, code }. */
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

function brevoErrorMessage(status: number, bodyText: string): string {
  let detail = '';
  try {
    const data = JSON.parse(bodyText) as { message?: unknown };
    if (typeof data?.message === 'string' && data.message) detail = data.message;
  } catch {
    // Non-JSON error body — fall back to the status alone.
  }
  return `Brevo ${status}${detail ? `: ${detail}` : ''}`;
}

function isBrevoRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Brevo send with bounded attempts. Retries only on network errors
 * (including timeouts), 5xx and 429 — never on 4xx (bad key, unverified
 * sender, bad request), which would fail identically on retry. Throws an
 * Error carrying the provider's message so callers can record the
 * outcome honestly (verifyEmailStatus / resend UI). */
async function sendViaBrevo(
  opts: { to: string; subject: string; text: string },
  timeoutMs: number,
  maxAttempts: number,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(BREVO_URL, {
        method: 'POST',
        headers: {
          'api-key': config.brevoApiKey as string,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender: { name: config.brevoSenderName, email: config.brevoSenderEmail },
          to: [{ email: opts.to }],
          subject: opts.subject,
          textContent: opts.text,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Network error or timeout — retryable.
      lastErr = err;
      // eslint-disable-next-line no-console
      console.error(`[mail] brevo attempt ${attempt}/${maxAttempts} failed (to ${opts.to}): ${(err as Error).message}`);
      continue;
    }
    if (res.ok) {
      let messageId = '';
      try {
        const data = (await res.json()) as { messageId?: unknown };
        if (typeof data?.messageId === 'string') messageId = data.messageId;
      } catch {
        // Success without a parseable body — still a send.
      }
      // eslint-disable-next-line no-console
      console.log(`[mail] brevo sent (to ${opts.to}${messageId ? `, messageId ${messageId}` : ''})`);
      return;
    }
    const err = new Error(brevoErrorMessage(res.status, await res.text()));
    if (!isBrevoRetryable(res.status)) throw err;
    lastErr = err;
    // eslint-disable-next-line no-console
    console.error(`[mail] brevo attempt ${attempt}/${maxAttempts} failed (to ${opts.to}): ${err.message}`);
  }
  throw lastErr;
}

function createTransporter(timeouts: typeof SMTP_TIMEOUTS = SMTP_TIMEOUTS) {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    // Phase 1: port 465 means implicit TLS (secure: true). Port 587
    // (default) stays STARTTLS. The Render SMTP_PORT env var selects the
    // path — no code change is needed to switch ports.
    secure: config.smtpPort === 465,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
    ...timeouts,
  });
}

export async function sendMail(opts: { to: string; subject: string; text: string }): Promise<void> {
  if (config.brevoApiKey) {
    await sendViaBrevo(opts, 30_000, SEND_ATTEMPTS);
    return;
  }
  if (!config.smtpHost) {
    // eslint-disable-next-line no-console
    console.log(`[dev-mail] To: ${opts.to}\nSubject: ${opts.subject}\n${opts.text}\n`);
    return;
  }
  let lastErr: unknown;
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    try {
      const transporter = createTransporter();
      await transporter.sendMail({ from: config.mailFrom, ...opts });
      return;
    } catch (err) {
      lastErr = err;
      // eslint-disable-next-line no-console
      console.error(`[mail] send attempt ${attempt}/${SEND_ATTEMPTS} failed (to ${opts.to}): ${(err as Error).message}`);
    }
  }
  throw lastErr;
}

/** Single fast attempt (see FAST_SMTP_TIMEOUTS) — for endpoints that
 * await the send and must report the outcome honestly (resend
 * verification). Throws on failure like sendMail does. */
export async function sendMailOnce(opts: { to: string; subject: string; text: string }): Promise<void> {
  if (config.brevoApiKey) {
    await sendViaBrevo(opts, 10_000, 1);
    return;
  }
  if (!config.smtpHost) {
    // eslint-disable-next-line no-console
    console.log(`[dev-mail] To: ${opts.to}\nSubject: ${opts.subject}\n${opts.text}\n`);
    return;
  }
  const transporter = createTransporter(FAST_SMTP_TIMEOUTS);
  await transporter.sendMail({ from: config.mailFrom, ...opts });
}

export function verificationEmailBody(schoolName: string, token: string): { subject: string; text: string } {
  const link = `${config.frontendUrl}/verify-email?token=${token}`;
  return {
    subject: `Verify your email — ${schoolName} (School Management)`,
    text: `Welcome to School Management Platform!\n\nPlease verify your email for ${schoolName} by opening this link:\n${link}\n\nThe link expires in 24 hours.\n\nIf you did not create this account, please ignore this email.`,
  };
}

export function resetPasswordEmailBody(schoolName: string, token: string): { subject: string; text: string } {
  const link = `${config.frontendUrl}/reset-password?token=${token}`;
  return {
    subject: `Reset your password — ${schoolName} (School Management)`,
    text: `You asked to reset your password for ${schoolName}.\n\nOpen this link to set a new password:\n${link}\n\nThe link expires in 1 hour. If you did not ask for this, please ignore this email.`,
  };
}
