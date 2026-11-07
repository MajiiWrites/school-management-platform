# Promotion rebuild — Module D (2026-11-07)

Root-cause fix of the class-promotion flow. The old flow (`admin.promoteStudents`
+ `sessions.promoteClassSection`) is replaced by a single canonical engine in
`backend/src/modules/sessions/service.ts`; `admin.promoteStudents` is now a
thin delegate to it so `POST /admin/promotions` keeps its contract.

## Defects found (each reproduced before the fix)

Repro suite `promotion-repro.test.ts` (fake DB) — 6/6 reproducing, removed after
the fix; the same cases are now asserted with correct behaviour in
`promotion.test.ts`. Real-Postgres proofs are in the scratch verification below.

| # | Defect | Reproduction | Root cause |
|---|--------|--------------|------------|
| D1 | Left / struck-off students could be promoted | `admin.promoteStudents` moved a `status='left'` and a `status='struck_off'` student to 6-A (promoted: 2) | No status / `deletedAt` check on the student load — only the whole-class path filtered `status='active'` |
| D2 | Roll numbers collided in the target class | Promoting rolls 1, 2 into 6-A (which already held roll 1) left two students on roll 1 (fake DB); on real PG the `UNIQUE (class_id, roll_no)` index rejects it with P2002/23505 and the whole transaction fails with a 500 | Roll number copied unchanged; no target-roll computation |
| D3 | Same student promotable twice in one session; no undo/edit | Second promotion accepted (2 live rows, inflated count); no `previewPromotion` / `undoPromotion` / `editPromotion` existed | Promotion row had no batch id, no status, no outcome — nothing said which row was current |
| D4 | Highest class had no graduate/hold path | A 10th grader was silently "promoted" to 9th, status stayed `active` | No outcome concept; any target class accepted |
| D5 | History mixed by in-place `classId` mutation | After promotion the 5-A roster was empty while the old attendance day still belonged to 5-A; the promotion row recorded no old roll, no batch | No session-scoped snapshot; `student.classId` was the only record of class membership |
| D6 | Audit written after the transaction | Change logs + audit outside `$transaction`; validation reads outside it too | A promotion could land with no log; TOCTOU between pre-check and write |
| D7 | Undo restored the intermediate class, not the pre-batch state | (Found by the real-Postgres exercise, after the first fix) Promote 5-A→6-A, edit Ali to 7-A, undo → Ali landed in 6-A | First undo inverted only the latest row; the superseded row's `fromClassId` (5-A) was ignored |

## Fix

- **One decision = one batch.** `batchId` (random UUID) shared by every row of a
  confirm; `status` (`applied` | `reversed` | `superseded`); `outcome`
  (`promoted` | `graduated` | `held`). Migration `20261107151000_promotion_rebuild`
  adds `batchId`, `status`, `outcome`, `rollNoFrom`, `rollNoTo` + a partial
  unique index `promotions_live_one_per_session_student`
  (`schoolId, sessionId, studentId WHERE status='applied'`) — at most one live
  promotion per student per session, enforced in the DB as well as in code.
  Existing rows keep their own batch (fresh UUID per row) and stay `applied`.
- **Preview before confirm.** `previewPromotion` computes every row (target
  roll, outcome, skip reason) without mutating anything; `applyPromotion`
  applies exactly the previewed mappings. Both share `buildPreview`.
- **One transaction.** Validation re-reads, student moves, promotion rows,
  change logs and audit all run inside a single `$transaction` — a promotion
  can never land without its log. (Note: `change_logs`/`audit_logs.actorId`
  is a FK to `users`, so the actor must be a real user id — in production it
  is always `req.user.sub`. A failed statement inside the transaction aborts
  it; that is the point, not a bug.)
- **Eligibility.** Only `status='active'` AND `deletedAt IS NULL` students move.
  Left / struck-off / graduated / deleted students, students already promoted
  in the session, and same-class mappings are **skipped with a reason** in the
  preview — never silently moved, never silently dropped. Duplicate students in
  one request are a 400.
- **Roll-number rule (deterministic, collision-free).** Per target class, ready
  students are ordered by old roll (nulls last) then name, and receive
  `max(existing rolls in target) + 1, + 2, …`. Rolls are never copied across and
  never reused from gaps. Old/new rolls are snapshotted (`rollNoFrom/To`) so
  undo restores them exactly; if the old roll was taken meanwhile, undo assigns
  the next free roll and reports it in `roll_no_reassigned`.
- **Highest class is explicit.** `outcome: 'graduated'` (status → `graduated`,
  class unchanged, no target class) or `'held'` (stays in class, row recorded).
  A `promoted` mapping always needs a real target class. Graduated students
  are never re-promoted (they fail the active check with a reason).
- **History preserved, never rewritten.** Promotion touches only the student row
  (`classId`/`rollNo`/`status`) and promotion rows. Attendance days/records
  (by class + date), fee records (by student + month) and result sheets (by
  session + class) are never created, moved or deleted — the new session starts
  clean (zero new rows). The class a student belonged to in an old session is
  recoverable from the promotion row via `getStudentClassInSession` — never
  from today's `student.classId`.
- **Undo reverses the whole batch to the pre-batch state** (D7): per student the
  earliest row in the batch is the pre-state; all rows (applied + superseded)
  are marked `reversed`. Blocked with a 409 naming the student if they moved
  on by any other means — then nothing is reversed (atomic).
- **Edit supersedes one row.** `editPromotion` moves a single student to a
  different class (or graduates them); the old row becomes `superseded` and a
  new `applied` row is written in the same batch. Other students untouched.

## API (all under `/api/v1`, admin-only mutations)

- `POST /sessions/:id/promotions/preview` `{mappings}` → preview rows + counts
- `POST /sessions/:id/promotions` `{mappings}` → `{batch_id, promoted, graduated, held, skipped[]}`
- `POST /sessions/:id/promote` `{from_class_id, to_class_id?, student_ids?, outcome?}` — whole class / selection / graduate / hold (backwards-compatible with the old `{from_class_id, to_class_id}` shape)
- `GET /sessions/:id/promotion-batches` → batch summaries with undo state
- `POST /sessions/:id/promotion-batches/:batchId/undo` → `{batch_id, reversed /* students */, roll_no_reassigned[]}`
- `PATCH /sessions/:id/promotions/:promotionId` `{to_class_id?, outcome?}` → new applied row
- `GET /sessions/:id/promotions` — now includes `batch_id, status, outcome, roll_no_from, roll_no_to`; filter by `?status=&batch_id=&outcome=`

`POST /admin/promotions` keeps its old contract (`{promoted}`) via the delegate.

## Frontend (`frontend/src/pages/Sessions.tsx`)

Class picker → student checklist (unchecked = held back; non-active students
shown disabled, "never promoted") → outcome selector (Promote / Graduate /
Hold) → **Preview** table (roll from → to, outcome, skip reasons) → **Confirm**
applies exactly the previewed mappings → batch list with **Undo batch** →
history with per-row **Edit** (move to another class / graduate).

## Verification

- `backend/src/modules/sessions/__tests__/promotion.test.ts`: **11 tests pass**
  (the five required: promote, undo, edit, partial promotion, highest class —
  plus preview, double-promotion guard, admin delegate, undo-blocked, cross-tenant,
  batch list). Old `sessions.test.ts`: 10 pass. Full backend suite: 479/483 —
  the 4 failures are 5000 ms timeouts in bcrypt-heavy auth/hardening/isolation
  signup tests under parallel load; they pass in isolation and touch no
  promotion code.
- `npx tsc --noEmit` (backend): 0 errors in sessions/ + admin/service.ts
  (1 remaining repo-wide error is in another agent's in-flight
  `timetable/__tests__/photo.test.ts`, not this module).
- Frontend `npm run build`: clean.
- **Scratch Postgres 16.4** (`~/workspace/tmp/pg16/verify-promo-migration.sh`,
  port 54334, scratch DB only, cluster stopped + data removed afterwards):
  `prisma migrate deploy` applied all migrations incl. `20261107151000`;
  5 new columns + partial unique index verified; duplicate
  `(classId, rollNo)` rejected with 23505 (D2 proof); second live promotion
  rejected with 23505; applied + reversed rows coexist. Real-client exercise
  (`exercise-promo-real.mts`, via `getDb()` + the service): promote rolls
  2/3/4 with no duplicates, double-promotion refused at preview, edit + undo
  exact restore (D7 regression caught here), graduation, change history present.

## Not done / known limits

- Archived sessions still store `is_archived` in school `settings` JSONB
  (6C-1 design, pre-existing) — not changed; promotion refuses archived
  sessions with a 409 either way.
- No numeric class ordering exists (class names are free strings), so the
  engine does not block an admin explicitly mapping a top-class student to a
  lower class — graduate/hold is the explicit path, and the preview shows the
  mapping before it is confirmed.
- `undoPromotion` orders a student's batch rows by `promotedAt`; an edit made
  within the same millisecond as the apply would be ambiguous — negligible in
  practice (edits are separate admin actions).
- No `late`/`leave` attendance statuses are referenced anywhere in the new code.
