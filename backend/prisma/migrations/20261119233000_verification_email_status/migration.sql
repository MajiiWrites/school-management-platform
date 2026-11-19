-- Phase 1 (real email verification, 2026-11-19): record the outcome of
-- the last verification-mail send per user, so the UI can tell the truth
-- instead of claiming "we sent it" unconditionally.
--
-- verifyEmailStatus: 'pending' (send in flight, or never attempted),
-- 'sent' (SMTP accepted it), 'failed' (SMTP failed — verifyEmailError
-- carries the message). New users start at 'pending'; existing rows get
-- 'pending' too, which is honest (no send was ever recorded for them).
-- CHECK constraint lives in migration SQL only (Prisma 6.x has no
-- @@check) — same pattern as the registration-profile migration.

ALTER TABLE users
  ADD COLUMN "verifyEmailStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "verifyEmailError" TEXT;

ALTER TABLE users
  ADD CONSTRAINT users_verify_email_status_check CHECK ("verifyEmailStatus" IN (
    'pending', 'sent', 'failed'
  ));
