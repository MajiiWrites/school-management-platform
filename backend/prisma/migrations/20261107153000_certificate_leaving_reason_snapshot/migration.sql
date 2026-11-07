-- Module F (Point 9): Certificates & Cards.
-- Add the leaving reason + frozen student-data snapshot to certificates.
-- All three columns are nullable: certificates issued before this
-- migration keep working (views fall back to the live student record),
-- and only School Leaving Certificates carry a reason.
ALTER TABLE "certificates" ADD COLUMN "leavingReason" TEXT;
ALTER TABLE "certificates" ADD COLUMN "leavingReasonOption" TEXT;
ALTER TABLE "certificates" ADD COLUMN "studentSnapshot" JSONB;
