# Phase 9 cleanup mechanism — DECIDED AND VERIFIED (2026-11-07 ~01:50 PKT)

> Module G note (2026-11-07): the application + arrival-status feature described in this historical report was removed entirely (migration `20261107154000_remove_leave_late`); mentions below are pre-removal record, not current behaviour.

## Verdict

**The built-in account-deletion path does NOT delete anything. The working
cleanup mechanism is a slug-scoped one-time Prisma migration** — same pattern
as the demo deletion that already ran live.

## 1. Why the account-deletion path cannot be used

- Backend: `POST /account/delete-request` only inserts an
  `account_deletion_requests` row (`status: 'pending'`).
  `PATCH /account/delete-requests/:id` only flips that row's status
  (`pending` / `approved` / `completed` / `rejected`) — see
  `backend/src/modules/hardening/service.ts`, `decideAccountDeletionRequest`.
  No code anywhere calls `prisma.school.delete` (grep-verified).
- Frontend: `frontend/src/pages/Security.tsx` only submits requests and
  changes their status. The Security page shows no "account deleted" state
  because nothing is ever deleted.
- Verified on scratch Postgres with the REAL service functions: created a
  deletion request for TEST school 1, approved it, then counted rows —
  **school=1, students=2, classes=2, users=1, fee_records=1 — all still
  present.** Approving a deletion request deletes nothing. The audit note in
  the code itself says: "Request only — actual deletion is a separate
  manual/approved step". V2-PROGRAM.md line 27 confirms: "Still manual:
  account-deletion execution".
- Do NOT use the Security-page deletion flow for Phase 9 cleanup. It is
  harmless (status-only) but it will not remove a TEST school.

## 2. Working mechanism — slug-scoped one-time migration

**File (PUSHED 2026-11-07 ~11:45 PKT, commit `bf9c9a21eb33353acb02c349c1fcd0f39b1d6381`):**
`backend/prisma/migrations/20261107020000_remove_test_schools/migration.sql`

```sql
-- One-time Phase 9 cleanup (TEST schools only).
-- Deletes ONLY the TEST schools below. The WHERE clause is the safety
-- guard, so no other school can ever be affected.
-- All tenant tables cascade from schools (ON DELETE CASCADE), so each
-- school's users, classes, students, attendance, fees, messages, results
-- and every other record go with it in the same statement.
-- Safe on a fresh/empty database: the DELETE simply affects 0 rows.
--
-- SCHOOLS (7 slugs):
--   "TEST School – Inspection" -> test-school-inspection (verified via cert no.)
--   "TEST School – Isolation"  -> test-school-isolation  (verified via cert no.)
--   "TEST School – Retest"     -> test-school-retest     (NOT verified — code-derived slug)
--   "TEST Retest2 School"      -> test-retest2-school    (VERIFIED via data-export JSON)
--   "TEST Retest3 School"      -> test-retest3-school    (VERIFIED via data-export JSON)
--   "TEST Retest4 School"      -> test-retest4-school    (VERIFIED via data-export JSON)
--   "TEST Retest5 School"      -> test-retest5-school    (NOT verified — pattern-derived slug)
-- The 3 email fallbacks cover the unverified slugs: deleting by school id
-- via users.email (test-retest@example.com, test-retest4@example.com,
-- test-retest5@example.com) — the migration runs once, so the fallback
-- must be present BEFORE the push. test-retest4's fallback is belt-and-
-- braces (its slug is verified); test-retest5's is the only safety net.
-- test-retest2@example.com and test-retest3@example.com need NO fallback
-- (slugs verified) but are covered by the slug list.

DELETE FROM schools
WHERE slug IN (
  'test-school-inspection',
  'test-school-isolation',
  'test-school-retest',
  'test-retest2-school',
  'test-retest3-school',
  'test-retest4-school',
  'test-retest5-school'
)
OR id IN (
  SELECT "schoolId" FROM users WHERE email IN (
    'test-retest@example.com',
    'test-retest4@example.com',
    'test-retest5@example.com'
  )
);
```

- The `WHERE` clause is the safety guard: no other school can ever be
  affected. All tenant tables cascade from `schools`
  (`ON DELETE CASCADE`), so one statement removes the school's users,
  classes, students, attendance, fees, messages, results and everything
  else.
- Safe on a fresh/empty database: the DELETE affects 0 rows.
- Column names verified against the init migration DDL before the rewrite
  (`users."schoolId"`, `schools."slug"`). Static FK audit: all 38 FKs
  referencing `schools` are `ON DELETE CASCADE`; the only 3 `RESTRICT`
  FKs (`students.classId`, `promotions.fromClassId/toClassId`) point at
  `classes`, not `schools` — proven non-blocking by the live scratch test
  below (classes cascade from schools first, so their RESTRICT targets
  disappear in the same statement). 14 FKs are `SET NULL`.

### Scratch verification (PostgreSQL 16.4, `smp_cleanup_scratch2`, 2026-11-07 ~11:35 PKT)

- Scratch setup: zonky PostgreSQL 16.4 binaries from Maven Central
  (`~/workspace/tmp/pg16/pgsql`, 58M; data in `/tmp/pg16work`; server as
  user `pgtest` uid 1000, port 54333, DB `smp_cleanup_scratch2`; SQL via
  Node + `pg` 8.23.1 — no system psql, apt has no postgres packages).
  Driver `~/workspace/tmp/pg16/run-cleanup-verify.sh`, seed
  `~/workspace/tmp/pg16/seed-cleanup-scratch.mts`, verify
  `~/workspace/tmp/pg16/verify-cleanup.mjs`.
- Seeded **8 schools** (the 7 TEST slugs + 1 `survivor-school`), 2 classes
  + 4 students each, plus 1 row each in the other 36 school-scoped
  tables (38 total) and 1 row each in the 2 indirect tables
  (`attendance_records`, `message_deliveries` — no direct `school_id`).
- Before migration: all 8 schools present everywhere.
- Applied the ACTUAL migration file (`npx prisma migrate deploy`
  equivalent — the file itself, executed against the real schema).
- After migration: **TEST schools = 0 rows in ALL 38 school-scoped tables
  + both indirect tables; `schools` table contains ONLY `survivor-school`,
  fully intact (42 mentions, 1 school, 4 students, 2 classes, all child
  rows).** Migration file itself executed OK against the real schema.

### Earlier scratch verification (PostgreSQL 16, `smp_cleanup_scratch`, since dropped) — 3-slug version

- Seeded 3 schools with a broad spread of rows: TEST School – Inspection
  (`test-school-inspection`), TEST School – Isolation
  (`test-school-isolation`), Survivor School (`survivor-school`) — 2 classes
  + 2 students each, plus 1 row each in 36 other school-scoped tables
  (fees, templates, queue, notifications, exams, results, staff, payroll,
  expenses, announcements, events, certificates, timetable, leave, OCR,
  audit, drafts, backups, vouchers, roles, approvals, recycle-bin rows,
  change history, …).
- Before migration: all **38** school-scoped tables held TEST rows
  (audit_logs 3 for the inspection school — the deletion-request flow wrote
  2 extra audit rows — 1 elsewhere; 2 students/classes per school).
- Applied the migration with `npx prisma migrate deploy` (the actual file).
- After migration: **TEST schools = 0 in all 38 tables** (plus
  `attendance_records` and `message_deliveries`, which have no direct
  `school_id` — verified by join: their only remaining rows belong to the
  survivor). `schools` table contains only `survivor-school`, fully intact
  (1 row per table, 2 students/classes).
- Login check: the TEST admins' `users` rows are gone (0), so login must
  401 — same as the live demo deletion, after which the demo login returned
  401 (2026-11-07 01:32 PKT).

## 3. Push procedure (do AFTER Phase 9 inspection finishes)

**TIMING — CRITICAL:** push this migration ONLY after the inspection is done
and the TEST schools exist in the live DB. Prisma migrations run once, at
deploy time (`npx prisma migrate deploy` in `backend/docker-entrypoint.sh`).
If pushed before the TEST schools are created, it deletes 0 rows and will
NOT clean them up later.

### DONE — pushed 2026-11-07 ~11:45 PKT (commit `bf9c9a21eb33353acb02c349c1fcd0f39b1d6381`)

1. Remote head re-verified before push: `c6416b1ccdd23ca2ac1f6d5cbe22ea3f6deab692`
   (round-4 commit). Migration file confirmed ABSENT remotely at that head
   (clean addition, no divergence).
2. Pushed ONLY this migration via MCP `push-files` (manifest
   `~/workspace/tmp/smp-paths-cleanup.txt`, 1 file). User tapped the approval
   card; `userConfirmationStatus: approved`. New head `bf9c9a21` verified
   remotely — migration file present at that head (SHA
   `bd64dd690b4f78e626579a628951ddaef120f721`). Sync record updated (10 entries).
3. Render auto-redeploy on push; the entrypoint runs `prisma migrate deploy`,
   which applies the new migration. **Render deploy ID/status still to be
   confirmed on the dashboard (browser check — parent).** Live signals so
   far: `/health` 200 at 06:57 and 06:59 UTC; all 5 TEST admin logins 401
   (see §3.1).
4. No Vercel redeploy needed (no frontend change).

### 3.1 Live verification (curl, 2026-11-07 ~11:59 PKT / 06:59 UTC)

- `GET /health` → **200**.
- `POST /api/v1/auth/login` with a wrong password for each TEST admin →
  **401 `{"code": "UNAUTHORIZED", "message": "Invalid email or password"}`**
  for all five: `test-retest@example.com`, `test-retest2@example.com`,
  `test-retest3@example.com`, `test-retest4@example.com`,
  `test-retest5@example.com`.
- **Caveat (honest):** the login handler returns the identical 401 for a
  missing user and a wrong password (`auth/service.ts` lines 159/161), so
  these 401s are a necessary condition, not standalone proof of deletion.
  The proof chain is: (a) the migration SQL was scratch-verified against a
  real Postgres schema with all 7 slugs + survivor intact (§2); (b) the
  exact file is at head `bf9c9a21`; (c) Render runs `prisma migrate deploy`
  on every push (same mechanism as the demo deletion, which worked live).
  The Render deploy log showing the migration applied is the remaining
  confirmation — parent to check the dashboard in a browser.
- Inspection/isolation admins' emails were never recorded, so no login
  check exists for those two — they are covered by the verified slugs +
  the migration's own scratch verification.

## 4. Slug confirmation (required before pushing)

The inspection plan (`docs/V2-PROGRAM.md`) names no slugs, so the migration
uses the slugs signup produces for these exact school names
(`slugify`: lowercase, `[^a-z0-9]+` → `-`):

| Sign-up name (exact) | Slug | Status |
|---|---|---|
| `TEST School – Inspection` | `test-school-inspection` | VERIFIED via cert no. |
| `TEST School – Isolation` | `test-school-isolation` | VERIFIED via cert no. |
| `TEST School – Retest` | `test-school-retest` | UNVERIFIED (code-derived); email fallback `test-retest@example.com` |
| `TEST Retest2 School` | `test-retest2-school` | VERIFIED via data-export JSON |
| `TEST Retest3 School` | `test-retest3-school` | VERIFIED via data-export JSON |
| `TEST Retest4 School` | `test-retest4-school` | VERIFIED via data-export JSON; email fallback `test-retest4@example.com` (belt-and-braces) |
| `TEST Retest5 School` | `test-retest5-school` | UNVERIFIED (pattern-derived); email fallback `test-retest5@example.com` (only safety net) |

- The browser task MUST use exactly these names. Any name that slugifies
  the same way also works (e.g. ASCII hyphen instead of en-dash).
- **Risk:** if a slug already exists, signup appends `-<2 random chars>`
  (`uniqueSlug` in `backend/src/modules/auth/service.ts`) and the migration
  would MISS that school. On the empty live site this cannot happen for the
  first TEST school, but the inspector must record the exact slug returned
  by each signup (signup response / Settings page) and compare it with the
  table above before §3 step 1. If it differs, update the `IN (...)` list.
- The migration is idempotent-safe: re-running it deletes 0 rows.

## 5. What is NOT needed

- No new endpoint, no code change, no Render upgrade (PKR 0), no Shell
  access. The demo deletion used exactly this mechanism live and worked.
- Do not delete TEST data by hand in the UI (too many tables) and do not
  insert anything directly into the live DB.

## 6. Phase 10 cleanup (TEST Finalcheck School + TEST Round5 School + TEST Round5b School) — migration written + scratch-verified, NOT pushed

- **Migration:** `backend/prisma/migrations/20261107090300_remove_finalcheck_test_school/migration.sql` — deletes ONLY the three slugs `test-finalcheck-school`, `test-round5-school`, `test-round5b-school` (+ email fallbacks `test-finalcheck@example.com`, `test-round5@example.com`, `test-round5b@example.com`). Same ON DELETE CASCADE pattern as §3. Slugs: finalcheck VERIFIED (signup 201 + export JSONs); round5 VERIFIED (signup 201 + export JSON); round5b INFERRED from the naming convention (created 2026-11-07 14:40 PKT by the round-5 UI re-test browser task for the signup-landing check — auth.signup in its audit log) — the email fallback is the safety net if the inferred slug is wrong.
- **Scratch verification (2026-11-07 ~14:05 PKT, coordinator; UPDATED ~14:45 PKT for the Round5 school; UPDATED AGAIN ~14:50 PKT for the Round5b school):** fresh PostgreSQL 16.4, base `migrate deploy` WITHOUT the cleanup migration, seeded 5 schools (test-finalcheck-school + test-round5-school + test-round5b-school + survivor-school + other-school), each with rows in all 38 school-scoped tables + indirect tables (attendance_records, message_deliveries). BEFORE: all 3 TEST slugs present (42 mentions each for finalcheck/round5b, 84 for round5 — the round5 count includes round5b matches). AFTER applying the migration file: **0 rows for ALL THREE TEST slugs in ALL tables, survivors intact (84 mentions), schools remaining: other-school + survivor-school. VERDICT: PASS.** Driver `~/workspace/tmp/pg16/run-cleanup-verify-p10.sh`, seed `seed-cleanup-scratch-p10.mts`, evidence `~/workspace/tmp/pg16/verify-before-p10.txt` + `verify-after-p10.txt`, log `/tmp/p10-cleanup-verify-3school.log`.
- **Push order (CRITICAL):** push this migration LAST — only AFTER the fix-round-5 code has been pushed, deployed, and re-tested live (re-testing creates new data in the same TEST schools; migrations run once, so an early push would delete 0 rows and never clean the school up). **DO NOT PUSH while the user is inspecting the site himself** (he is logged in as test-round5@example.com since 14:45 PKT) — the push must wait for his go-ahead. Manifest: `~/workspace/tmp/smp-paths-cleanup-p10.txt` (this migration + this doc + `docs/V2-PROGRAM.md`).
- **After the cleanup push:** live-verify the same way as Phase 9 — `/health` 200 + the TEST admin logins `test-finalcheck@example.com`, `test-round5@example.com` AND `test-round5b@example.com` return 401.
