-- Fix E (Phase 9, 2026-11-07): Fix C's migration 20261107030000 created the
-- column as snake_case "attendance_token_enc", but the Prisma schema declares
-- the field attendanceTokenEnc with NO @map, and every other Class column in
-- this database is camelCase (schoolId, teacherName, ...). Prisma therefore
-- queries a column "attendanceTokenEnc" that does not exist, and ALL class
-- creation fails on a freshly migrated DB (P2022). Rename the column to the
-- name the schema expects. Safe: the column was added by 20261107030000 and
-- holds only encrypted tokens (NULL on older rows); the rename preserves data.
-- Guarded so re-running is a no-op if the column was already renamed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'classes' AND column_name = 'attendance_token_enc'
  ) THEN
    ALTER TABLE "classes" RENAME COLUMN "attendance_token_enc" TO "attendanceTokenEnc";
  END IF;
END $$;
