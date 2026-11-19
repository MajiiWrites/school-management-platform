import { resolveMx } from 'node:dns/promises';
import { ApiError } from './errors';

/**
 * Email deliverability check, used at signup (Phase 1, real email
 * verification, 2026-11-19).
 *
 * The check is DNS MX only: a domain that has no MX records (or does not
 * exist at all) cannot receive mail, so the signup is rejected with a
 * clear message instead of letting the admin wait forever for a
 * verification link that can never arrive.
 *
 * What this check deliberately does NOT do — a disposable / temp-mail
 * domain blocklist. There is no reliable free list, and the user
 * explicitly ordered a temp-mail signup test for this round: temp-mail
 * domains DO have MX records (they really receive mail), so they pass
 * this check, and the verification link itself is the proof the mailbox
 * exists. MX + the clicked verification link are the existence proof;
 * no third-party mailbox-verification API is used (all of them are paid
 * or rate-limited to uselessness on the free tier).
 *
 * Failure policy: a positive "no MX" answer (empty record set, ENODATA,
 * ENOTFOUND) rejects. A transient DNS failure (timeout, EAI_AGAIN, …)
 * fails OPEN — a flaky resolver must never block a real signup; the
 * verification link still has to be clicked before the account can log
 * in, so a bad address is caught there instead.
 */
const MX_TIMEOUT_MS = 5_000;

const TRANSIENT_DNS_CODES = new Set(['ETIMEOUT', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH']);

export async function domainHasMx(domain: string): Promise<boolean> {
  const records = await Promise.race([
    resolveMx(domain),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(Object.assign(new Error('MX lookup timed out'), { code: 'ETIMEOUT' })), MX_TIMEOUT_MS),
    ),
  ]);
  return records.length > 0;
}

export async function assertEmailCanReceiveMail(email: string): Promise<void> {
  const domain = email.split('@')[1]?.trim().toLowerCase();
  if (!domain) throw ApiError.validation('Enter a valid email address');
  try {
    const hasMx = await domainHasMx(domain);
    if (!hasMx) {
      throw ApiError.validation(
        'This email address cannot receive mail — its domain has no mail server. Please check the address and try again.',
      );
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const code = (err as NodeJS.ErrnoException)?.code;
    // Positive "no mail here" answers reject; transient resolver trouble
    // fails open (see header comment).
    if (code === 'ENODATA' || code === 'ENOTFOUND') {
      throw ApiError.validation(
        'This email address cannot receive mail — its domain does not exist or has no mail server. Please check the address and try again.',
      );
    }
    if (code && TRANSIENT_DNS_CODES.has(code)) {
      // eslint-disable-next-line no-console
      console.warn(`[email-check] MX lookup for ${domain} failed transiently (${code}) — allowing signup, verification link is the fallback proof`);
      return;
    }
    // Unknown DNS errors: fail open too — never block a real signup on a
    // resolver quirk; the verification click is the backstop.
    // eslint-disable-next-line no-console
    console.warn(`[email-check] MX lookup for ${domain} errored (${code ?? (err as Error).message}) — allowing signup`);
  }
}
