# Phase 9 cleanup mechanism — DECIDED AND VERIFIED (2026-11-07 ~01:50 PKT)

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

**File (prepared, NOT pushed):**
`backend/prisma/migrations/20261107020000_remove_test_schools/migration.sql`

```sql
DELETE FROM schools WHERE slug IN ('test-school-inspection', 'test-school-isolation');
```

- The `WHERE slug IN (...)` clause is the safety guard: no other school can
  ever be affected. All tenant tables cascade from `schools`
  (`ON DELETE CASCADE`, 66 relations in the schema), so one statement removes
  the school's users, classes, students, attendance, fees, messages, results
  and everything else.
- Safe on a fresh/empty database: the DELETE affects 0 rows.

### Scratch verification (PostgreSQL 16, `smp_cleanup_scratch`, since dropped)

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

1. Confirm the live slugs first (see §4). If a slug differs, edit the
   `IN (...)` list in the migration file before pushing.
2. Push ONLY this migration to GitHub main via MCP `push-files`
   (path `backend/prisma/migrations/20261107020000_remove_test_schools/migration.sql`).
   The local VM clone has no git history/remote — do not attempt a local
   `git push`.
3. Render auto-redeploys the backend on push; the entrypoint runs
   `prisma migrate deploy`, which applies the new migration.
4. Verify live (curl): `GET /health` → 200; `POST /api/v1/auth/login`
   with each TEST admin's credentials → **401**; the live site's school
   count is 0 (fresh signup page shows the empty state). The site must be
   back to clean-empty.
5. No Vercel redeploy is needed (no frontend change).

## 4. Slug confirmation (required before pushing)

The inspection plan (`docs/V2-PROGRAM.md`) names no slugs, so the migration
uses the slugs signup produces for these exact school names
(`slugify`: lowercase, `[^a-z0-9]+` → `-`):

| Sign-up name (exact) | Slug |
|---|---|
| `TEST School – Inspection` | `test-school-inspection` |
| `TEST School – Isolation` | `test-school-isolation` |

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
