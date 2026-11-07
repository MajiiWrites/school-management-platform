-- Tighten attendance status CHECKs to present/absent only (late/leave removed
-- in 20261107154000_remove_leave_late) and include 'struck_off' in the student
-- status CHECK (the code already allows struck_off; the old CHECK did not,
-- so setting a student struck_off would 500 on live).
--
-- Historical late/leave rows are re-mapped to 'absent' first: a late or
-- on-leave student was not present that day, and no late/leave value may
-- remain once the CHECKs are tightened. All live rows are test data.

UPDATE "attendance_records" SET "status" = 'absent' WHERE "status" IN ('late', 'leave');
UPDATE "teacher_attendance" SET "status" = 'absent' WHERE "status" = 'leave';

ALTER TABLE "attendance_records" DROP CONSTRAINT "attendance_records_status_check";
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_status_check" CHECK ("status" IN ('present', 'absent'));

ALTER TABLE "teacher_attendance" DROP CONSTRAINT "teacher_attendance_status_check";
ALTER TABLE "teacher_attendance" ADD CONSTRAINT "teacher_attendance_status_check" CHECK ("status" IN ('present', 'absent'));

ALTER TABLE "students" DROP CONSTRAINT "students_status_check";
ALTER TABLE "students" ADD CONSTRAINT "students_status_check" CHECK ("status" IN ('active', 'left', 'struck_off', 'graduated'));
