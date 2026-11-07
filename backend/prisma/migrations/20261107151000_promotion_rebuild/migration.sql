-- Module D (2026-11-07) — promotion rebuild, root-cause fix.
-- The old promotion wrote one bare row per student (session, from/to
-- class, at/by) and mutated student.classId in place. That made the
-- following defects possible; each is fixed in sessions/service.ts and
-- this migration supplies the columns the fix needs:
--   * no batch id  -> a decision could not be undone as a unit;
--   * no status    -> a student could be promoted twice in one session
--                     (two live rows, inflated counts, second move
--                     overwriting the first with no trace of which won);
--   * no outcome   -> the highest class had no graduate/hold path, so a
--                     10th grader could be silently sent to a lower class;
--   * no roll snapshot -> roll numbers were copied unchanged into the
--                     target class, colliding with the UNIQUE
--                     (class_id, roll_no) index (P2002 on real Postgres)
--                     or duplicating rolls wherever the index was not
--                     enforced; undo could never restore the old roll.
-- Existing rows: each keeps its own batch (a fresh uuid per row) and
-- status 'applied', so history is preserved and the partial unique index
-- below still holds (one live row per student per session).
ALTER TABLE "promotions" ADD COLUMN "batchId" TEXT NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE "promotions" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'applied';
ALTER TABLE "promotions" ADD COLUMN "outcome" TEXT NOT NULL DEFAULT 'promoted';
ALTER TABLE "promotions" ADD COLUMN "rollNoFrom" INTEGER;
ALTER TABLE "promotions" ADD COLUMN "rollNoTo" INTEGER;

-- Defence in depth for the app-layer guard: at most ONE live ('applied')
-- promotion row per student per session. Reversed / superseded rows are
-- history and do not count. Backfill note: pre-migration rows are all
-- 'applied', so if a student was (defectively) promoted twice in one
-- session this index will fail to build — find and reverse the duplicate
-- first (SELECT "schoolId","sessionId","studentId", COUNT(*) FROM
-- "promotions" WHERE "status"='applied' GROUP BY 1,2,3 HAVING COUNT(*)>1).
CREATE UNIQUE INDEX "promotions_live_one_per_session_student"
  ON "promotions"("schoolId", "sessionId", "studentId")
  WHERE "status" = 'applied';
CREATE INDEX "promotions_schoolId_batchId_idx" ON "promotions"("schoolId", "batchId");
CREATE INDEX "promotions_schoolId_sessionId_status_idx" ON "promotions"("schoolId", "sessionId", "status");
