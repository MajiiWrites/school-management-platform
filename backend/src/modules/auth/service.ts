import bcrypt from 'bcrypt';
import { config } from '../../config';
import { ApiError } from '../../lib/errors';
import { hashToken, randomToken } from '../../lib/crypto';
import { signAccessToken, signRefreshToken, makeEmailToken, verifyRefreshToken } from '../../lib/tokens';
import { sendMail, verificationEmailBody, resetPasswordEmailBody } from '../../lib/mail';
import { writeAudit } from '../../lib/audit';
import { DEFAULT_TEMPLATES } from '../messaging/templates';
import type { Db } from '../../lib/db';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

export interface PublicUser {
  id: string;
  email: string;
  role: string;
  school_id: string;
  email_verified: boolean;
}

export function toPublicUser(u: any): PublicUser {
  return { id: u.id, email: u.email, role: u.role, school_id: u.schoolId, email_verified: u.emailVerified };
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
  input: { school_name: string; email: string; password: string },
): Promise<{ user: PublicUser; school: { id: string; name: string; slug: string }; dev_token?: string }> {
  const email = input.email.trim().toLowerCase();
  const existing = await db.user.findFirst({ where: { email } });
  if (existing) throw ApiError.conflict('An account with this email already exists');

  const passwordHash = await bcrypt.hash(input.password, config.bcryptRounds);
  const { token, hash } = makeEmailToken();
  const slug = await uniqueSlug(db, input.school_name);

  const school = await db.school.create({
    data: { name: input.school_name.trim(), slug, timezone: 'Asia/Karachi', country: 'PK', settings: {} },
  });
  const user = await db.user.create({
    data: {
      schoolId: school.id,
      email,
      passwordHash: passwordHash,
      role: 'admin',
      emailVerified: false,
      verifyTokenHash: hash,
      verifyExpiresAt: new Date(Date.now() + VERIFY_TTL_MS),
    },
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
  await sendMail({ to: email, ...mail });

  const out: { user: PublicUser; school: { id: string; name: string; slug: string }; dev_token?: string } = {
    user: toPublicUser(user),
    school: { id: school.id, name: school.name, slug: school.slug },
  };
  if (config.nodeEnv !== 'production') out.dev_token = token;
  return out;
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
): Promise<{ access: string; refresh: string; user: PublicUser }> {
  const email = input.email.trim().toLowerCase();
  const user = await db.user.findFirst({ where: { email } });
  if (!user) throw ApiError.unauthorized('Invalid email or password');
  const ok = await bcrypt.compare(input.password, user.passwordHash);
  if (!ok) throw ApiError.unauthorized('Invalid email or password');
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
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
  return {
    access: signAccessToken(user),
    refresh: signRefreshToken(user),
    user: toPublicUser(user),
  };
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
  await sendMail({ to: normalized, ...mail });
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
