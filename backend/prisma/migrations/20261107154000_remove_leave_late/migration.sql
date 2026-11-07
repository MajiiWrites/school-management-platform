-- Module G (2026-11-07): remove Late + Leave completely.
-- Drops the leave_applications table (LeaveApplication model deleted from
-- schema.prisma). Student/teacher attendance is present/absent only; no
-- other schema change in this migration.
-- NOTE: the v1 CHECK constraints on attendance_records.status
-- ('present','absent','late','leave') and teacher_attendance.status
-- ('present','absent','leave') are intentionally left in place — the code
-- can no longer produce 'late'/'leave' values, so they are unreachable;
-- tightening them is a separate follow-up if wanted.
DROP TABLE IF EXISTS "leave_applications";
