-- Section 11 (Custom Messages) — message_queue.type gains 'result',
-- 'announcement', 'custom'.
--
-- The v2_messages migration extended message_templates.type to the same six
-- values but left message_queue.type at the v1 three. Custom drafts send
-- through the EXISTING message_queue (SCHEMA.md §11: no second sending
-- path), so the queue must accept the same types. Additive only: no column
-- is renamed, retyped, or dropped, and the CHECK is re-applied in full
-- (same hand-added pattern as the v1/v2 migrations — Prisma 6.x has no
-- @@check, so if the schema is regenerated with `prisma migrate diff`,
-- re-apply this block and strip any fee_records.status drift).
ALTER TABLE "message_queue" DROP CONSTRAINT IF EXISTS "message_queue_type_check";
ALTER TABLE "message_queue" ADD CONSTRAINT "message_queue_type_check" CHECK ("type" IN ('absent', 'fee_reminder', 'teacher_reminder', 'result', 'announcement', 'custom'));
