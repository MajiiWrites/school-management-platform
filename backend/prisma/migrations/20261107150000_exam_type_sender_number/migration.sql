-- FINAL REBUILD (Module C): exam types + per-school SMS sender number.
--
-- 1. Exam.type: exactly three types — monthly | midterm | annual.
--    New exams default to 'monthly'. Existing rows are backfilled from
--    their free-text names (Midterm -> midterm, Annual/Final -> annual,
--    everything else stays monthly); the name itself is untouched.
-- 2. School.smsSenderNumber: the personal/school number SMS is sent from,
--    editable per school. NULL = not set yet. Plain TEXT (same precedent
--    as the school_phone settings value): it is the school's own sending
--    number, shown back to its admin; parent numbers stay encrypted.
CREATE TYPE "ExamType" AS ENUM ('monthly', 'midterm', 'annual');

ALTER TABLE "exams" ADD COLUMN "type" "ExamType" NOT NULL DEFAULT 'monthly';

UPDATE "exams" SET "type" = 'midterm' WHERE "name" ILIKE '%midterm%';
UPDATE "exams" SET "type" = 'annual' WHERE "name" ILIKE '%annual%' OR "name" ILIKE '%final%';

CREATE INDEX "exams_schoolId_type_idx" ON "exams"("schoolId", "type");

ALTER TABLE "schools" ADD COLUMN "smsSenderNumber" TEXT;
