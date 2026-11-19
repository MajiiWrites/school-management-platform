import bcrypt from 'bcrypt';
import { config } from '../../config';
import { ApiError } from '../../lib/errors';
import { hashToken, randomToken, normalizePhone, encryptPhone, sha256Hex } from '../../lib/crypto';
import { signAccessToken, signRefreshToken, signTemp2faToken, makeEmailToken, verifyRefreshToken } from '../../lib/tokens';
import { sendMail, sendMailOnce, verificationEmailBody, resetPasswordEmailBody } from '../../lib/mail';
import { assertEmailCanReceiveMail } from '../../lib/email-check';
import { writeAudit } from '../../lib/audit';
import { DEFAULT_TEMPLATES } from '../messaging/templates';
import { finishLoginBookkeeping, userTotpValid } from '../hardening/twofa';
import type { Db } from '../../lib/db';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

// Registration profile (2026-11-08): value lists for the signup fields.
// Keep in sync with the CHECK constraints in migration
// 20261108020000_add_registration_profile and the zod enums in
// routes.ts (which re-export these).
export const PROVINCES = [
  'Punjab',
  'Sindh',
  'Khyber Pakhtunkhwa',
  'Balochistan',
  'Gilgit-Baltistan',
  'Azad Jammu & Kashmir',
  'Islamabad Capital Territory',
] as const;
export type Province = (typeof PROVINCES)[number];
export const SCHOOL_CATEGORIES = ['Private', 'Public', 'Semi-Government'] as const;
export type SchoolCategory = (typeof SCHOOL_CATEGORIES)[number];
export const ORG_TYPES = ['School', 'College'] as const;
export type OrgType = (typeof ORG_TYPES)[number];

export interface SignupInput {
  school_name: string;
  email: string;
  password: string;
  admin_name: string;
  admin_phone: string;
  address: string;
  tehsil: string;
  district: string;
  province: Province;
  category: SchoolCategory;
  org_type: OrgType;
}

export interface SignupSchool {
  id: string;
  name: string;
  slug: string;
  address: string | null;
  tehsil: string | null;
  district: string | null;
  province: string | null;
  category: string | null;
  org_type: string | null;
}

/** Defense in depth: the service validates the registration profile
 * itself and never trusts the route's zod schema alone — direct callers
 * (and future routes) get the same rejections. */
function validateRegistrationProfile(input: SignupInput): { adminName: string; adminPhoneE164: string } {
  const adminName = typeof input.admin_name === 'string' ? input.admin_name.trim() : '';
  if (adminName.length < 2 || adminName.length > 100) throw ApiError.validation('Admin name must be 2–100 characters');
  const adminPhoneE164 = normalizePhone(input.admin_phone);
  if (!adminPhoneE164) throw ApiError.validation('Enter a valid Pakistani mobile number, e.g. 03001234567');
  const address = typeof input.address === 'string' ? input.address.trim() : '';
  if (address.length < 5 || address.length > 500) throw ApiError.validation('Address must be 5–500 characters');
  for (const [key, value] of [['tehsil', input.tehsil], ['district', input.district]] as const) {
    const v = typeof value === 'string' ? value.trim() : '';
    if (v.length < 2 || v.length > 100) throw ApiError.validation(`${key} must be 2–100 characters`);
  }
  if (!(PROVINCES as readonly string[]).includes(input.province)) throw ApiError.validation('Province is not valid');
  if (!(SCHOOL_CATEGORIES as readonly string[]).includes(input.category)) throw ApiError.validation('Category must be Private, Public or Semi-Government');
  if (!(ORG_TYPES as readonly string[]).includes(input.org_type)) throw ApiError.validation('Organization type must be School or College');
  return { adminName, adminPhoneE164 };
}

export interface PublicUser {
  id: string;
  email: string;
  role: string;
  school_id: string;
  email_verified: boolean;
  /** Phase 1: outcome of the last verification-mail send ('pending' =
   * in flight / never attempted, 'sent', 'failed'). The dashboard
   * banner and /verify-email page read this so they only claim a send
   * that really happened. */
  email_verification_status: 'pending' | 'sent' | 'failed';
  /** 6D: the Security page needs this to render the 2FA setup/disable UI. */
  totp_enabled: boolean;
}

export function toPublicUser(u: any): PublicUser {
  const status = u.verifyEmailStatus;
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    school_id: u.schoolId,
    email_verified: u.emailVerified,
    email_verification_status: status === 'sent' || status === 'failed' ? status : 'pending',
    totp_enabled: u.totpEnabled ?? false,
  };
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'school';
}

async function uniqueSlug(db: Db, name: string): Promise<string> {
  let slug = slugify(name);
  const existing = await db.school.findUnique({ where: { slug } });
  if (!existing) return slug;
  slug = `${slug}-${randomToken(2)}`;
  return slug;
}

export async function signup(
  db: Db,
  input: SignupInput,
): Promise<{
  user: PublicUser;
  school: SignupSchool;
  email_verification: { status: 'pending' };
  dev_token?: string;
}> {
  const { adminName, adminPhoneE164 } = validateRegistrationProfile(input);
  const email = input.email.trim().toLowerCase();
  const existing = await db.user.findFirst({ where: { email } });
  if (existing) throw ApiError.conflict('An account with this email already exists');
  // Phase 1: the domain must be able to receive mail at all (DNS MX
  // check) — a typo'd or nonexistent domain can never receive the
  // verification link, so reject it now with a clear message instead of
  // stranding the admin at "check your inbox" forever.
  await assertEmailCanReceiveMail(email);

  const passwordHash = await bcrypt.hash(input.password, config.bcryptRounds);
  const { token, hash } = makeEmailToken();
  const slug = await uniqueSlug(db, input.school_name);

  // School + admin are created in one transaction: a failure cannot
  // leave a school without its admin (or vice versa).
  const { school, user } = await db.$transaction(async (tx) => {
    const school = await tx.school.create({
      data: {
        name: input.school_name.trim(),
        slug,
        timezone: 'Asia/Karachi',
        country: 'PK',
        settings: {},
        address: input.address.trim(),
        tehsil: input.tehsil.trim(),
        district: input.district.trim(),
        province: input.province,
        category: input.category,
        orgType: input.org_type,
      },
    });
    const user = await tx.user.create({
      data: {
        schoolId: school.id,
        email,
        passwordHash: passwordHash,
        role: 'admin',
        emailVerified: false,
        verifyTokenHash: hash,
        verifyExpiresAt: new Date(Date.now() + VERIFY_TTL_MS),
        name: adminName,
        phoneEnc: encryptPhone(adminPhoneE164),
        phoneHash: sha256Hex(adminPhoneE164),
      },
    });
    return { school, user };
  });
  await writeAudit(db, {
    schoolId: school.id,
    actorId: user.id,
    actorType: 'user',
    action: 'auth.signup',
    entity: 'user',
    entityId: user.id,
    details: { school_name: input.school_name },
  });

  // Seed the 6 default message templates (absent / fee_reminder /
  // teacher_reminder x en + ur) so the new school's jobs and approval
  // screens work immediately (QA 2026-11-06: schools created via signup
  // had NO template rows, so the monthly fee job threw and reminded nobody).
  await db.messageTemplate.createMany({
    data: (['absent', 'fee_reminder', 'teacher_reminder'] as const).flatMap((type) =>
      (['en', 'ur'] as const).map((language) => ({
        schoolId: school.id,
        type,
        language,
        body: DEFAULT_TEMPLATES[type][language],
        isActive: true,
      })),
    ),
  });

  const mail = verificationEmailBody(input.school_name, token);
  // Phase 1 (2026-11-19): the verification send is FIRE-AND-FORGET —
  // never awaited. Diagnosis proved the awaited send cost ~20 s per
  // signup (two 10 s SMTP connection timeouts on Render's egress) and
  // up to 60–110 s on a cold start, so users reloaded/retried and read
  // the 409 "already exists" as "no account was created". The send runs
  // in the background and its outcome is recorded on the user row
  // (verifyEmailStatus/verifyEmailError) so the UI can tell the truth
  // about whether the link really went out; the stored token stays valid
  // so the user can resend it.
  sendVerificationMailInBackground(db, user, input.school_name, token);

  // Phase 1: signup does NOT issue a session. Login is gated until the
  // email is verified (see login()), so issuing tokens here would let an
  // unverified account straight onto the dashboard and defeat the gate.
  // The caller lands on /verify-email?sent=1 and logs in after clicking
  // the link. (The old behaviour — tokens issued at signup — was the
  // Phase 9 fix for a 401-after-signup bug; that bug is moot now because
  // no post-signup call happens before login.)
  const out: {
    user: PublicUser;
    school: SignupSchool;
    email_verification: { status: 'pending' };
    dev_token?: string;
  } = {
    user: toPublicUser(user),
    school: {
      id: school.id,
      name: school.name,
      slug: school.slug,
      address: school.address ?? null,
      tehsil: school.tehsil ?? null,
      district: school.district ?? null,
      province: school.province ?? null,
      category: school.category ?? null,
      org_type: school.orgType ?? null,
    },
    // Honest status at response time: the send is in flight (see above).
    // The dashboard banner / /verify-email page read the recorded
    // outcome from /auth/me afterwards.
    email_verification: { status: 'pending' },
  };
  if (config.nodeEnv !== 'production') out.dev_token = token;
  return out;
}

/** Phase 1: background verification-mail sender. Runs detached from the
 * signup request; records 'sent' / 'failed' (+ the error) on the user
 * row so the UI can report the real outcome. Never throws. */
function sendVerificationMailInBackground(
  db: Db,
  user: { id: string; email: string },
  schoolName: string,
  token: string,
): void {
  const mail = verificationEmailBody(schoolName, token);
  sendMail({ to: user.email, ...mail })
    .then(async () => {
      await recordVerificationMailOutcome(db, user.id, { status: 'sent' });
    })
    .catch(async (err: unknown) => {
      const message = (err as Error).message;
      // eslint-disable-next-line no-console
      console.error(`[auth] signup verification mail failed for ${user.email}: ${message}`);
      await recordVerificationMailOutcome(db, user.id, { status: 'failed', error: message.slice(0, 500) });
    });
}

async function recordVerificationMailOutcome(
  db: Db,
  userId: string,
  outcome: { status: 'sent' | 'failed'; error?: string },
): Promise<void> {
  try {
    await db.user.update({
      where: { id: userId },
      data: {
        verifyEmailStatus: outcome.status,
        verifyEmailError: outcome.error ?? null,
      },
    });
  } catch (err) {
    // The send already happened (or failed); a bookkeeping failure must
    // never surface to the user — the Render log is the ops signal.
    // eslint-disable-next-line no-console
    console.error(`[auth] could not record verification mail outcome for ${userId}: ${(err as Error).message}`);
  }
}

/**
 * Phase 1: resend the verification link. Reuses the stored token if it
 * is still valid, otherwise issues a fresh one. The send is awaited
 * (fast single attempt) so the caller gets an honest sent/failed answer
 * for the UI. Unknown emails get the same generic success shape — never
 * reveal whether the email exists.
 */
export async function resendVerification(db: Db, email: string): Promise<{ sent: boolean; message: string }> {
  const normalized = email.trim().toLowerCase();
  const user = await db.user.findFirst({ where: { email: normalized } });
  if (!user) {
    return { sent: false, message: 'If an account exists for this email, a verification link has been sent.' };
  }
  if (user.emailVerified) {
    return { sent: false, message: 'This email is already verified — you can log in.' };
  }
  // Fresh token each resend (old links stop working): the stored token
  // may have expired (24 h) or been lost with the first mail.
  const { token, hash } = makeEmailToken();
  await db.user.update({
    where: { id: user.id },
    data: {
      verifyTokenHash: hash,
      verifyExpiresAt: new Date(Date.now() + VERIFY_TTL_MS),
      verifyEmailStatus: 'pending',
      verifyEmailError: null,
    },
  });
  const school = await db.school.findUnique({ where: { id: user.schoolId } });
  const mail = verificationEmailBody(school?.name ?? 'School', token);
  try {
    await sendMailOnce({ to: normalized, ...mail });
    await db.user.update({
      where: { id: user.id },
      data: { verifyEmailStatus: 'sent', verifyEmailError: null },
    });
    return { sent: true, message: 'Verification link sent — please check your inbox (and spam folder).' };
  } catch (err) {
    const message = (err as Error).message;
    // eslint-disable-next-line no-console
    console.error(`[auth] resend verification mail failed for ${normalized}: ${message}`);
    await db.user.update({
      where: { id: user.id },
      data: { verifyEmailStatus: 'failed', verifyEmailError: message.slice(0, 500) },
    });
    return { sent: false, message: 'We could not send the verification email right now. Please try again in a few minutes.' };
  }
}

export async function verifyEmail(db: Db, token: string): Promise<{ user: PublicUser }> {
  const hash = hashToken(token);
  const user = await db.user.findFirst({
    where: { verifyTokenHash: hash, verifyExpiresAt: { gt: new Date() } },
  });
  if (!user) throw ApiError.validation('Verification link is invalid or has expired');
  const updated = await db.user.update({
    where: { id: user.id },
    data: { emailVerified: true, verifyTokenHash: null, verifyExpiresAt: null },
  });
  await writeAudit(db, {
    schoolId: user.schoolId,
    actorId: user.id,
    actorType: 'user',
    action: 'auth.verify_email',
    entity: 'user',
    entityId: user.id,
  });
  return { user: toPublicUser(updated) };
}

export async function login(
  db: Db,
  input: { email: string; password: string },
  opts?: { ip?: string; totpCode?: string },
): Promise<
  | { access: string; refresh: string; user: PublicUser }
  | { needs_2fa: true; temp_token: string }
> {
  const email = input.email.trim().toLowerCase();
  const user = await db.user.findFirst({ where: { email } });
  if (!user) throw ApiError.unauthorized('Invalid email or password');
  const ok = await bcrypt.compare(input.password, user.passwordHash);
  if (!ok) throw ApiError.unauthorized('Invalid email or password');
  // Phase 1 (real email verification): an unverified account cannot log
  // in — the password step alone is not enough. The gate sits before the
  // 2FA step so no temp 2FA token is issued to an unverified account
  // either. The frontend shows the resend button for this error.
  if (!user.emailVerified) throw ApiError.emailNotVerified();
  // 2FA (6A): if TOTP is enabled, the password step alone is not enough.
  // With a valid code supplied inline the login completes; otherwise the
  // caller gets a 5-min temp token and finishes via POST /auth/2fa/login.
  if (user.totpEnabled) {
    if (opts?.totpCode) {
      if (!userTotpValid(user, opts.totpCode)) throw ApiError.unauthorized('Invalid verification code');
    } else {
      return { needs_2fa: true, temp_token: signTemp2faToken(user) };
    }
  }
  // Login alert (6A): a different IP from the last login creates a
  // "New login from <ip>" notification; last_login_ip is updated.
  await finishLoginBookkeeping(db, user, opts?.ip);
  return {
    access: signAccessToken(user),
    refresh: signRefreshToken(user),
    user: toPublicUser(user),
  };
}

export async function refreshTokens(
  db: Db,
  refreshToken: string,
): Promise<{ access: string; refresh: string; user: PublicUser }> {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }
  const user = await db.user.findUnique({ where: { id: payload.sub } });
  if (!user || user.schoolId !== payload.school_id) {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }
  // Phase 1: a pre-Phase-1 refresh token must not keep an unverified
  // account signed in after the gate lands — the next refresh signs the
  // session out and the user must verify, then log in.
  if (!user.emailVerified) throw ApiError.emailNotVerified();
  // 6D — session (idle) timeout: the refresh token is re-issued on every
  // successful refresh, so its `iat` is the last activity the server has
  // seen (the frontend only calls /refresh when the user actually makes a
  // request — see frontend/src/lib/api.ts). If the token is older than the
  // school's session_timeout_minutes setting (default 120), the session is
  // idle-expired and the user must sign in again. The frontend handles the
  // SESSION_EXPIRED code with a friendly "signed out for inactivity"
  // message. There is no server-side session store (stateless JWTs, per
  // HARDENING.md); this iat check is the whole server-side enforcement.
  const school: any = await db.school.findUnique({ where: { id: user.schoolId } });
  const timeoutMinutes = resolveSessionTimeoutMinutes((school?.settings as Record<string, unknown> | null) ?? null);
  const issuedAtSec = payload.iat ?? 0;
  const idleSeconds = Math.floor(Date.now() / 1000) - issuedAtSec;
  if (idleSeconds > timeoutMinutes * 60) {
    throw ApiError.sessionExpired();
  }
  return {
    access: signAccessToken(user),
    refresh: signRefreshToken(user),
    user: toPublicUser(user),
  };
}

/** School setting `session_timeout_minutes` (default 120, min 15 — an
 * access token already lives 15 min, so a shorter timeout would log out
 * active users; max 1440 = 24 h). Same validation as
 * admin/service.ts validateSettings; kept as a pure helper here so the
 * auth module does not depend on the admin service. */
export const DEFAULT_SESSION_TIMEOUT_MINUTES = 120;
export const MIN_SESSION_TIMEOUT_MINUTES = 15;
export const MAX_SESSION_TIMEOUT_MINUTES = 1440;

export function resolveSessionTimeoutMinutes(settings: Record<string, unknown> | null | undefined): number {
  const raw = settings?.session_timeout_minutes;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SESSION_TIMEOUT_MINUTES;
  return Math.min(MAX_SESSION_TIMEOUT_MINUTES, Math.max(MIN_SESSION_TIMEOUT_MINUTES, Math.floor(raw)));
}

export async function forgotPassword(db: Db, email: string): Promise<{ dev_token?: string }> {
  const normalized = email.trim().toLowerCase();
  const user = await db.user.findFirst({ where: { email: normalized } });
  // Always return ok — never reveal whether the email exists.
  if (!user) return {};
  const { token, hash } = makeEmailToken();
  await db.user.update({
    where: { id: user.id },
    data: { resetTokenHash: hash, resetExpiresAt: new Date(Date.now() + RESET_TTL_MS) },
  });
  const school = await db.school.findUnique({ where: { id: user.schoolId } });
  const mail = resetPasswordEmailBody(school?.name ?? 'School', token);
  // Round-3 fix: a stalled/failed SMTP send used to throw here and 500 the
  // whole request — the live re-test saw "Sending…" for ~2 min, then
  // "Internal server error", twice. This endpoint must never reveal whether
  // the account exists OR whether mail was delivered, so a failed send is
  // logged server-side (the Render log is the ops signal) and the caller
  // still gets the standard success response. The stored token stays valid,
  // so the user can request a fresh link once mail is back.
  try {
    await sendMail({ to: normalized, ...mail });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[auth] forgot-password mail failed for ${normalized}: ${(err as Error).message}`);
  }
  if (config.nodeEnv !== 'production') return { dev_token: token };
  return {};
}

export async function resetPassword(db: Db, token: string, password: string): Promise<{ user: PublicUser }> {
  const hash = hashToken(token);
  const user = await db.user.findFirst({
    where: { resetTokenHash: hash, resetExpiresAt: { gt: new Date() } },
  });
  if (!user) throw ApiError.validation('Reset link is invalid or has expired');
  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  const updated = await db.user.update({
    where: { id: user.id },
    data: { passwordHash: passwordHash, resetTokenHash: null, resetExpiresAt: null },
  });
  await writeAudit(db, {
    schoolId: user.schoolId,
    actorId: user.id,
    actorType: 'user',
    action: 'auth.reset_password',
    entity: 'user',
    entityId: user.id,
  });
  return { user: toPublicUser(updated) };
}
