# Phase 7 Integration Report — School Management Platform v2

> Module G note (2026-11-07): the application + arrival-status feature described in this historical report was removed entirely (migration `20261107154000_remove_leave_late`); mentions below are pre-removal record, not current behaviour.

Date: 2026-11-07 ~00:40 PKT. Agent: P7-INT (integration only — no new features,
no pushes, no deploys, no live-DB access). Project root:
`/home/hatch/workspace/school-management-platform`.

## 1. Date-flake fix (the only known red tests) — FIXED, verified in both timezones

**Root cause.** The fake DB stamped every created row's `createdAt` with wall-clock
`new Date()`, while the jobs under test ran with a fixed `now` of 2026-11-06. Once
the real clock crossed midnight PKT (2026-11-07), same-day dedupe broke:
`notifyOnce` / `queueRowExistsToday` compare `localDateString(createdAt, 'Asia/Karachi')`
with `localDateString(now, ...)` — Nov 7 vs Nov 6 never matched, so the second
run re-notified / re-queued instead of deduping. The dashboard test had the same
shape of bug in reverse: it computed "today" with UTC `toISOString()`, while
`getDashboard` uses the school-local day — for 19:00–24:00 UTC the two are
different calendar days.

**Fix (tests/fakes only — zero production-code changes):**
- `backend/src/modules/fees/__tests__/fake-db.ts` — `FakeCollection` gained an
  injectable clock (`nowFn`, default `() => new Date()`); `create` / `createMany` /
  `update` / `updateMany` stamp from it. `FakeDb` accepts an optional `nowFn` and
  wires it to every collection. Default behaviour is unchanged for all other
  consumers (`new FakeDb()` with no argument).
- `backend/src/jobs/__tests__/jobs.test.ts` — `freshDb()` now builds the fake with
  a fixed clock on the same school-local day as the job instants
  (`() => new Date('2026-11-06T12:00:00Z')`, 17:00 PKT Nov 6). This mirrors
  production, where `createdAt` and the job `now` come from the same wall clock.
- `backend/src/modules/isolation/__tests__/cross-tenant.test.ts` — dashboard test
  now computes today with `localDateString(new Date(), 'Asia/Karachi')` (the same
  function the production code uses) instead of UTC `toISOString()`.

**Verification:** the two files pass **57/57** with `TZ=Asia/Karachi` **and** with
`TZ=UTC`. The fixed clock is a single school-local day (2026-11-06), so the tests
cannot flake again when the real date moves.

## 2. Shared-file merge review — NO conflicts, NO fixes needed

Every file edited by 2+ parallel agents was checked mechanically (grep + a
cross-check script) and by reading the merge points:

| Shared file | Check | Result |
|---|---|---|
| `backend/src/app.ts` | Router mounts | **21 routers + messaging + OCR, each mounted exactly once.** Sessions router mounts **before** `adminRouter` (line 92 vs 96) as required. `resultsRouter` deliberately defines **no** `/exams` routes (comment at `results/routes.ts:348`), so no collision with `examsRouter`. |
| `backend/src/middleware/permissions.ts` | QUEUEABLE pairs | **38 pairs, 0 duplicates.** All 38 are used by `requireQueueable` calls. One pair, `('fees','delete')`, is listed but never used by a route — harmless reserve, left as-is. One call, `requireQueueable('settings','update')`, appears only in a hardening **test** that asserts clerks stay matrix-gated (settings are admin-only by design) — not a missing pair. |
| `backend/src/modules/hardening/approvals.ts` | `applyApproval` branches | **24 entity branches, each exactly once**, no duplicates. Every entity submitted via `queueIfClerk` anywhere in `src` (`student`, `class`, `fee_record`, `fee_structure`, `fee_voucher`, `holiday`, `message_template`, `message_draft`, `user`, `academic_session`, `exam`, `exam_datesheet`, `grading_scale`, `timetable_entry`, `staff`, `staff_assignment`, `salary_record`, `expense`, `announcement`, `event`, `certificate`, `student_id_card`, `result`, `result_sheet`) has a matching branch. |
| `contracts/API.md` | Phase appendices | Each appendix present **exactly once**: "v2 endpoints", "6C-1 additions", "6B additions", "6C-2 endpoints", "6D additions", "Custom Messages (Section 11)". ("Section 11" as a bare string appears twice only because the appendix heading and its sub-heading both name it — one appendix, not a duplicate.) |
| `frontend/src/App.tsx` | Routes | **All 28 routes exactly once**, including every new page: `sessions`, `exams`, `timetable`, `staff`, `expenses`, `announcements`, `events`, `certificates`, `leaves`, `notifications`, `results`, `security` (admin-only). |
| `frontend/src/components/Layout.tsx` | Nav entries | **Every new page has exactly one nav entry** (same 12 as above, `security` admin-only). |
| `frontend/src/lib/types.ts` + `mock.ts` | Duplicate/conflicting types or mocks | **No duplicate `interface`/`type` names** in `types.ts`; frontend `tsc` build passes, which would fail on duplicate exports. No conflicting mock entries found. |

**No duplication or lost block was found anywhere; no merge fix was required.**
Every agent's marked block is intact.

## 3. Green-suite gate — ALL GREEN

| Gate | Command | Result |
|---|---|---|
| Backend typecheck | `npx tsc --noEmit` (backend) | **0 errors** |
| Full backend suite | `npx vitest run` (TZ=Asia/Karachi) | **19 files, 294/294 tests pass** (was 291/294 with the 3 date flakes) |
| Frontend build | `npm run build` (frontend) | **Clean** — 62 modules, built in ~1s. Only the pre-existing >500 kB chunk-size warning. |

No integration failure was found; nothing was left for Phase 8 from the gate.

## 4. Scratch-DB smoke — 51/51 PASS (live DB never touched)

Scratch DB `school_p7_smoke` (PostgreSQL 16, local cluster), role `p7smoke`,
API on `:4127` with scratch env (`SEED_ON_BOOT=false`). Smoke script:
`/tmp/p7-smoke/smoke-p7.py` (kept in /tmp; not added to the repo).

- `npx prisma migrate deploy` — **all 4 migrations applied in order**
  (`20261106120000_init`, `20261106230000_v2_schema`, `20261106231000_v2_messages`,
  `20261106232000_v2_queue_custom_type`); `migrate status` up to date.
- `npx prisma generate` — clean.
- HTTP smoke, **51/51 checks pass**, including:
  - Auth: signup 201 → verify-email 200 → login 200 (access token returned).
  - Sessions: create / list / make-current / archive / unarchive — all 200/201.
  - Exams: create, datesheet create + list, grading seed-defaults,
    passing marks **50** (school default).
  - Timetable: create 201, duplicate class+day+period → **409**, class view 200.
  - Staff/payroll: create, assign, payroll `net_pay = 58000` (60000 − 2000), payslip 200.
  - Results: manual entry (saved 1, linked 1), list, toppers, summary — all 200.
  - Messages (§11): templates list (6 seeded + custom create), live preview with
    rendered samples, draft create, **approve-send 200** (queue rows built).
  - Fees: structure, pay (201, receipt `p7-smoke-school-202611-001`),
    voucher by-student (`…-202611-V001`), voucher print 200.
  - Expenses: create/list + income-expense report (income 2500, expense 1500,
    balance 1000). Announcements create + approve. Events create + calendar.
    Certificates create (`P7-SMOKE-SCHOOL-CHA-…`) + print 200.
  - Security: `POST /export/all` 200 (41 tables), `POST /backups/run` 200
    (file `backups/p7-smoke-school/2026-11-07.json`, 40,307 bytes),
    `GET /backups` lists the row.
  - `GET /jobs/status` lists **`school_backup`** and **`scheduled_messages`**.
- **First smoke run was 46/51** — all 5 failures were script-side expectation
  mismatches (response keys `templates`/`samples`/`draft.id`/`data.id`,
  fee-pay returning 201), not product bugs. Fixed the script, re-ran on a
  **freshly recreated scratch DB: 51/51**.
- OCR upload was **not** re-smoked here (already covered 48/48 by the 6B agent
  on scratch DB, incl. real Tesseract eng+urd). Results manual entry + review
  flow were covered instead.
- Cleanup done: scratch server stopped, scratch DB **dropped**, scratch role
  dropped (verified: no `school_p7%` database remains), backup/upload scratch
  dirs removed.

## 5. Deploy package (prepared, NOT executed)

- **Manifest regenerated:** `~/workspace/tmp/smp-paths-text.txt` — **276 files**,
  verified byte-identical (`diff` clean) to a full-tree listing excluding
  `node_modules/`, `.git/`, `dist/`, `backend/backups/`, `uploads/`, `.env`.
  The old manifest was **empty (0 lines)**. The new one includes everything it
  missed: `backend/DEMO-REMOVAL-RUNBOOK.md`, `frontend/vercel.json`, all new
  modules, all 4 migrations, and docs (including this report and the deploy plan).
- **Local-git caveat (important for the push step):** this VM's clone has **no git
  history and no remote configured** (`git log` → "no commits yet"; the last pushed
  commit `6962d9c4` is not present locally). The push must go through the
  established GitHub push path (MCP push-files / parent-handled approvals) using
  the manifest as the file list — a plain `git push` from this clone is not possible.
- **`render.yaml`:** `SEED_ON_BOOT` is **absent** (verified by grep). Root
  `.env.example` and `backend/.env.example` both have `SEED_ON_BOOT=false`
  (local-dev only); `docker-compose.yml` defaults to `false`; the entrypoint only
  seeds when explicitly `SEED_ON_BOOT=true`. Consistent with the seed-off decision.
  `backend/prisma/seed.ts` itself is intentionally kept as-is for local dev
  (it still names the demo credentials — local-dev only, never runs on live
  with seeding off).
- **Live-migration plan:** `docs/PHASE7-DEPLOY-PLAN.md` — exact order:
  1. demo deletion via Render dashboard FIRST, 2. GitHub push, 3. Render
  auto-redeploy runs `migrate deploy`, 4. Vercel redeploy via file-upload path
  (with `vercel.json`), 5. live verification checklist (`/health` 200, login
  page, fresh signup empty, demo login 401, smoke of new features).

## 6. Left for Phase 8 (QA) — nothing blocking

- Browser click-through of the new pages (Sessions/Exams/Timetable/Staff/
  Results/Custom Messages/Security) — owed per each phase's notes; no live
  browser is available to this agent.
- Template recycle-bin restore is not wired (no `deleted_at` on templates;
  restore = re-create from snapshot) — known S11 limitation, documented in
  `CUSTOM-MESSAGES.md`.
- Announcement SMS send (`POST /announcements/:id/send`) returns **501** by
  design — the Phase 7 hook to §11 drafts was noted by 6C-2 but **not** built
  here (integration only; it is a feature, not a merge fix). If wanted, it is
  a small Phase 8 item: on approved + `sms_send`, create a §11 draft and
  submit for approval.
- `('fees','delete')` QUEUEABLE pair is unused — harmless; remove or wire a
  route in a later cleanup if desired.
- Archive flag for sessions lives in school settings JSONB
  (`archived_session_ids`) — a future migration should add a real
  `is_archived` column (documented in `FEATURES-6C1.md`).

## Files changed by this agent

- `backend/src/modules/fees/__tests__/fake-db.ts` — injectable fake clock.
- `backend/src/jobs/__tests__/jobs.test.ts` — fixed fake clock (2026-11-06 PKT).
- `backend/src/modules/isolation/__tests__/cross-tenant.test.ts` — PKT-local today.
- `docs/PHASE7-DEPLOY-PLAN.md` — new (live-migration plan).
- `docs/PHASE7-INTEGRATION-REPORT.md` — this file.
- `~/workspace/tmp/smp-paths-text.txt` — regenerated manifest (276 files).
- Smoke script (ephemeral): `/tmp/p7-smoke/smoke-p7.py`.
