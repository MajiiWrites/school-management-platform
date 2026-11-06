-- AlterTable
ALTER TABLE "message_templates" ADD COLUMN     "isCustom" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "name" TEXT;

-- CreateTable
CREATE TABLE "message_drafts" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "createdBy" UUID,
    "recipientType" TEXT NOT NULL,
    "targetClassId" UUID,
    "targetStudentIds" JSONB NOT NULL DEFAULT '[]',
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "scheduledFor" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "message_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_drafts_schoolId_status_createdAt_idx" ON "message_drafts"("schoolId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "message_drafts_schoolId_createdBy_idx" ON "message_drafts"("schoolId", "createdBy");

-- AddForeignKey
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_targetClassId_fkey" FOREIGN KEY ("targetClassId") REFERENCES "classes"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ============================================================================
-- HAND-ADDED (v2 Section 11 — Custom Messages): CHECK constraints + backfill.
-- Prisma 6.x does not support @@check, so the CHECKs live here (same pattern
-- as v1/v2_schema). If the schema is regenerated with `prisma migrate diff`,
-- re-apply this block.
-- ============================================================================
-- message_templates.type gains 'result', 'announcement', 'custom' (v1 CHECK
-- only allowed absent/fee_reminder/teacher_reminder).
ALTER TABLE "message_templates" DROP CONSTRAINT IF EXISTS "message_templates_type_check";
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_type_check" CHECK ("type" IN ('absent', 'fee_reminder', 'teacher_reminder', 'result', 'announcement', 'custom'));

-- message_drafts enums.
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_recipient_type_check" CHECK ("recipientType" IN ('all_parents', 'class', 'selected_students', 'single_parent'));
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_status_check" CHECK ("status" IN ('draft', 'scheduled', 'sent', 'cancelled'));

-- Backfill a display name for pre-existing (v1-seeded) templates, whose name
-- is NULL. New templates always carry an admin-chosen name; nothing is
-- locked, so the admin may rename these afterwards.
UPDATE "message_templates" SET "name" =
  CASE "type"
    WHEN 'absent' THEN 'Absent Alert'
    WHEN 'fee_reminder' THEN 'Fee Reminder'
    WHEN 'teacher_reminder' THEN 'Teacher Reminder'
    ELSE INITCAP("type")
  END || ' (' || UPPER("language") || ')'
WHERE "name" IS NULL;
