-- Platform Admin Panel (2026-11-20): platform_settings, platform_audit_logs,
-- users.tokenVersion / disabledAt, schools.suspendedAt / suspendedReason,
-- users_role_check widened to 'platform_admin', one-time promotion of the
-- owner's account.
--
-- CHECK constraints live here in migration SQL only (Prisma 6.x has no
-- @@check). Safe on an empty database: CREATE TABLE IF NOT EXISTS, ADD
-- COLUMN IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING.
--
-- COLUMN-NAME RULE (2026-11-20 fix — the original draft used snake_case
-- column names here and would have 500'd every login): schema.prisma has
-- NO field-level @map anywhere (only model-level @@map for table names),
-- so Prisma expects the camelCase field names as the actual column names
-- — same convention as the Phase 1 migration's "verifyEmailStatus".
-- Every column below is therefore quoted camelCase: "updatedAt",
-- "actorId", "entityId", "createdAt", "tokenVersion", "disabledAt",
-- "suspendedAt", "suspendedReason".
--
-- SCHOOL-DELETE AUDIT (for the platform DELETE /schools/:id endpoint):
-- every school-scoped table's FK to schools is ON DELETE CASCADE (verified
-- against schema.prisma: 85x onDelete Cascade; the only Restrict FKs are
-- Student->Class and Promotion->Class, both inside one school and removed
-- by the school cascade itself). The service still deletes tenant rows
-- explicitly in dependency order inside one transaction before deleting
-- the school row, so the delete does not depend on cascade behaviour alone.
--
-- ONE-TIME PROMOTION — idempotent, affects at most ONE row:
--   UPDATE users SET role='platform_admin', "emailVerified" = true,
--     "verifyTokenHash" = NULL, "verifyExpiresAt" = NULL
--   WHERE email='majidalioffical0@gmail.com' AND role='admin';
-- Only that email, only if it currently holds role 'admin'. It creates NO
-- account, NO password, NO backdoor — if no such user exists the statement
-- affects 0 rows. adminmailx@gmail.com is NEVER touched by this migration
-- (the user confirmed 2026-11-19 23:35 PKT "Keep it").
--
-- OWNER VERIFICATION BYPASS (2026-11-20, fast path — user chose this over
-- the Resend route): the owner signed up on the live site with this email,
-- but Gmail SMTP is dead from Render on both ports (587 + 465), so no
-- verification mail can ever arrive and login would stay blocked with
-- EMAIL_NOT_VERIFIED. This migration therefore also marks ONLY this one
-- account verified and clears its (never-deliverable) token, so the owner
-- can log in right after the push. It deliberately does NOT touch
-- verifyEmailStatus: no mail was sent, so claiming 'sent' would be a
-- lie — the field stays 'pending'/'failed', honest about the mail. The
-- panel itself still requires 2FA for this account.
--
-- Column names are the Prisma field names (camelCase, no @map in
-- schema.prisma — same convention as the Phase 1 migration's
-- "verifyEmailStatus"): "emailVerified", "verifyTokenHash",
-- "verifyExpiresAt".

CREATE TABLE IF NOT EXISTS "platform_settings" (
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

INSERT INTO "platform_settings" ("key", "value") VALUES
  ('registration_open', 'true'::jsonb),
  ('maintenance_mode', 'false'::jsonb),
  ('platform_notice', 'null'::jsonb)
ON CONFLICT ("key") DO NOTHING;

CREATE TABLE IF NOT EXISTS "platform_audit_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "actorId" UUID,
  "action" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "entityId" UUID,
  "details" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "platform_audit_logs_createdAt_idx" ON "platform_audit_logs" ("createdAt");
CREATE INDEX IF NOT EXISTS "platform_audit_logs_actorId_idx" ON "platform_audit_logs" ("actorId");

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "disabledAt" TIMESTAMPTZ(6);
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "suspendedAt" TIMESTAMPTZ(6);
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "suspendedReason" TEXT;

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_token_version_check";
ALTER TABLE "users" ADD CONSTRAINT "users_token_version_check" CHECK ("tokenVersion" >= 0);

-- Widen the role CHECK: 'platform_admin' joins 'admin' | 'clerk' | 'principal'.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_role_check";
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" IN ('admin', 'clerk', 'principal', 'platform_admin'));

-- One-time promotion of the owner's account (see header comment).
-- Idempotent. Also marks ONLY this account verified + clears its token
-- (owner-verification bypass, 2026-11-20 — see header). verifyEmailStatus
-- is deliberately NOT touched: no mail was sent, so it must stay honest.
-- Column names are Prisma camelCase (see header note).
UPDATE "users" SET "role" = 'platform_admin', "emailVerified" = true,
  "verifyTokenHash" = NULL, "verifyExpiresAt" = NULL
WHERE "email" = 'majidalioffical0@gmail.com' AND "role" = 'admin';
