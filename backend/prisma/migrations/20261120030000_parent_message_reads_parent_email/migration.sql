-- Messaging Center wiring (2026-11-20): parent-portal inbox read state +
-- Student.parentEmail (used for email delivery when the admin does not
-- type an address per send).
--
-- CHECK constraints live here in migration SQL only (Prisma 6.x has no
-- @@check). Safe on an empty database: CREATE TABLE IF NOT EXISTS + one
-- nullable column, no data migration. All FKs cascade from schools (ON
-- DELETE CASCADE), matching the rest of the schema.
-- Runs AFTER 20261120000000_remove_phase1_test_schools in the chain, so
-- the cleanup deletes the six TEST schools before this migration lands.

CREATE TABLE IF NOT EXISTS "parent_message_reads" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "tokenId" UUID NOT NULL,
  "studentId" UUID NOT NULL,
  "itemKind" TEXT NOT NULL,
  "itemId" UUID NOT NULL,
  "readAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "parent_message_reads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "parent_message_reads_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "parent_message_reads_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "parent_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "parent_message_reads_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "parent_message_reads_tokenId_itemKind_itemId_key" UNIQUE ("tokenId", "itemKind", "itemId"),
  CONSTRAINT "parent_message_reads_item_kind_check" CHECK ("itemKind" IN ('message', 'announcement'))
);
CREATE INDEX IF NOT EXISTS "parent_message_reads_schoolId_studentId_idx" ON "parent_message_reads"("schoolId", "studentId");

ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "parentEmail" TEXT;
