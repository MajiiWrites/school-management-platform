# School Features part 2 — 6C-2 (2026-11-06)

Agent 6C-2. Backend + frontend for: fee extensions, expenses, announcements
(notice board only), events + holiday calendar, certificates + ID cards,
reports extensions, settings extensions, notification center.
Schema/migrations untouched. Every query is scoped by the JWT `school_id`;
clerk mutations go through the approval queue (202, appliers in
`modules/hardening/approvals.ts`, 6C-2 block); every edit writes
`change_logs`; `autocomplete="off"` on all new inputs; `ConfirmDialog`
for all new deletes/adds; empty states on all new pages.

## Endpoints (base `/api/v1`)

| Area | Endpoints |
|---|---|
| Fees | `GET /fees` (rows now carry `record_id`, `arrears`, `scholarship_discount`, `breakdown`), `POST /fees/:student_id/pay` (accepts `arrears`, `scholarship_discount`), `GET /fees/vouchers?month=&status=`, `POST /fees/vouchers`, `POST /fees/vouchers/by-student`, `GET /fees/vouchers/:voucher_no` (HTML / `?format=pdf`) |
| Expenses | `GET /expenses?month=&category=`, `POST /expenses`, `PATCH /expenses/:id`, `DELETE /expenses/:id`, `GET /expenses/report/income-expense?month=` |
| Announcements | `GET /announcements`, `GET /announcements/:id`, `POST /announcements`, `PATCH /announcements/:id`, `DELETE /announcements/:id`, `POST /announcements/:id/approve`, `POST /announcements/:id/send` (wired in Phase 8 QA — see hook section below) |
| Events | `GET /events`, `POST /events`, `PATCH /events/:id`, `DELETE /events/:id`, `GET /events/calendar?month=` |
| Certificates | `POST /students/:id/certificates`, `GET /students/:id/certificates`, `GET /certificates/:id` (HTML / `?format=pdf`), `POST /students/:id/issue-id-card`, `GET /students/:id/id-card` |
| Reports | `GET /reports/fees/defaulters`, `GET /reports/results/summary`, `GET /reports/classes/strength`, `GET /reports/messages/history`, `GET /reports/income-expense` — all support `?format=pdf|xlsx|csv` |
| Settings | `GET /settings`, `PATCH /settings` (+ `school_name`, `timezone`, `school_address`, `school_phone`, `logo_url`, `language`) |
| Notifications | `GET /notifications/center` (read-only aggregation) |

Frontend pages: `/expenses`, `/announcements`, `/events`, `/certificates`,
`/notifications` (all in the sidebar nav); Fees page gained a
**Vouchers** tab + a per-row **Voucher** button; Reports gained Defaulters /
Class strength / Income vs expense / Message history tabs + CSV export;
Settings gained the school-identity section (name, timezone, address,
phone, logo upload, language) + a link to message templates. The bell in
the top bar now links to the notification center page.

## Fee math rules (the contract's GENERATED status only sees amounts)

```
amount_due = monthly_amount + arrears + admission_fee (first record only)
             − sibling_discount − scholarship_discount
balance    = amount_due − amount_paid − discount   (status: paid / partial / unpaid)
```

- **Sibling discount** = `floor(monthly_amount × sibling_discount_pct / 100)`,
  applied only when another ACTIVE student in the same school shares the
  student's `parent_phone_hash` (same parent, different student).
  Implemented in `fees/service.ts`: `isSiblingStudent`,
  `feeBreakdownForStudent`, `computeFeeBreakdown`.
- **Admission fee** is one-time: added only when the student has NO prior
  `fee_record` in any month (`hasPriorFeeRecord`).
- **Arrears** = sum of the still-unpaid balances of the student's
  `fee_records` from months BEFORE the current month. Stored on the
  record's `arrears` column; computed by `priorArrears`.
- **Scholarship discount** is a per-payment input (no per-student
  scholarship column exists in the schema); folded into `amount_due` at
  record creation. On an existing record it may be restated only while
  the record is untouched (`amount_paid = 0` and `discount = 0`); after
  any payment/discount the due is locked and restating is a 400.
- **Partial payment** = `payFee` with `amount_paid < balance`; the record
  stays `partial` until the balance hits 0. Nothing special to build —
  the existing `payFee` already accumulated payments; 6C-2 proves it
  with tests and shows the remaining balance in the UI.
- All of the above are folded into `amount_due` (never written to
  `status` — the DB GENERATED column recomputes it). `listFees` returns
  the prospective `breakdown` for students with no record yet; for
  existing records the sibling/admission amounts are already inside the
  stored `amount_due` (they are not stored separately — there are no
  columns for them), while `arrears` / `scholarship_discount` are stored
  and shown.
- **Rollover** (`rolloverMonth`) now creates records with the same
  breakdown (arrears + admission − sibling), so a fresh month's dues are
  correct without a payment first.
- **Vouchers** (`fees/vouchers.ts`): one per record+month (re-generate
  returns the existing number). Number:
  `{school_slug}-{YYYYMM}-V{seq:03d}`. `amount_due` on the voucher is the
  REMAINING balance (payable now), not the original due. Status mirrors
  the fee record: re-derived on read and re-synced by `payFee` after
  every payment. Printable HTML + real PDF (pdfkit, same pattern as
  receipts). Receipts now also show arrears / scholarship lines when
  nonzero.
- **Fee `paid_by` note**: expenses accept `paid_by` (who physically
  paid). The v2 `expenses` table has NO `paid_by` column — only
  `created_by` (the recording user). A supplied `paid_by` is stored as a
  `"Paid by <name>: "` prefix on `description` (parsed back on read),
  never dropped. If a real column is ever added, `splitPaidBy` /
  `buildDescription` in `expenses/service.ts` are the only places to
  change.

## Announcement-SMS hook point (WIRED in Phase 8 QA — was 501)

Announcements are NOTICE BOARD ONLY until sent. `sms_send` is accepted
and stored; `POST /announcements/:id/approve` flips `draft → approved`
and writes an audit note — it creates NO `message_queue` rows.
`POST /announcements/:id/send` (admin only, Phase 8) now works: the
announcement must be `approved` AND `sms_send = true` (otherwise 409);
it creates a Section 11 message draft (`recipient_type: 'all_parents'`
or `'class'` + `target_class_id`, `body` = title + body) and routes it
through the existing draft → approval → queue flow via
`approveDraftForSending` — queue rows are type `'announcement'`
(dedupe `announcement:{draftId}:{studentId}`), opted-out parents
auto-excluded with a skipped count. There is NO second sending path —
announcement SMS never writes `message_queue` directly. The
announcement flips to `sent` only when >= 1 row is queued; with zero
queueable recipients it stays `approved` so the admin can retry. The
frontend Announcements page has a "Send SMS" button (ConfirmDialog)
on approved + sms_send notices. See
`backend/src/modules/announcements/service.ts: sendAnnouncementSms`
and `backend/src/modules/announcements/__tests__/announcements-send.test.ts`.

## Applications + arrival status — REMOVED (Module G, 2026-11-07)

The application feature (`LeaveApplication` / `leave_applications`) and the
extra attendance statuses were deleted entirely: the table is dropped by
migration `20261107154000_remove_leave_late`, the frontend page, its route
and its sidebar item are gone, and student/teacher attendance is
present/absent only. The section this replaced described the pre-removal
design and is superseded by this note.

## Certificates — derived number, no photo column

- The v2 `certificates` table has **no `certificate_no` column**, so the
  number is DERIVED deterministically from the row:
  `{SLUG}-{TYPE3}-{first 8 of id, upper}` (e.g. `DEMO-LEA-3F9A1C2E`).
  Unique per row, stable across re-prints, never stored (so it cannot
  drift). `certificates/service.ts: certificateNo`.
- The `students` table has **no photo column**, so ID cards render a
  **photo placeholder** (name / class / roll / admission no are real).
  Issuing an ID card sets `students.id_card_issued_at` (the schema flag)
  and writes a change log. Certificates and ID cards have no delete
  endpoint (issued documents are immutable history).

## Announcements — pinning

The v2 `announcements` table has **no `pinned` column**, so there is no
persisted pin. The list orders by `created_at` desc. If a persisted pin
is ever needed it is one nullable boolean column away.

## Language coverage (honest)

`PATCH /settings {language: 'en'|'ur'}` persists; `frontend/src/lib/i18n.tsx`
(`LanguageProvider`, wrapped around the portal in `App.tsx`) reads it and
translates **navigation labels + the six new 6C-2 page headings** (EN/UR
dictionary in the same file). Everything else — forms, tables, validation
messages, all pre-existing pages — stays in English. `message_language`
(v1, the SMS template language) is independent of `language` (the UI
language). Translating the rest of the UI is a separate pass.

## Settings — where things live

`school_name` and `timezone` are columns on the `schools` row
(`admin/service.ts: updateSettings` splits them out of the settings
JSONB so the JSON can never shadow the row); `school_address`,
`school_phone`, `logo_url`, `language` live in `settings` JSONB.
`logo_url` is an `https://` URL or a `data:image/*` URL (frontend
FileReader upload, capped at ~500 KB, shown on certificates/ID cards).
`getSettings` returns row values first, then JSONB defaults.

## Notification center — read-only

`GET /notifications/center` aggregates existing tables only: pending
`approval_requests`, `failed` `message_queue` rows, `ocr_uploads` +
`result_sheets` with `status = 'review'`, current-month `fee_records`
with a remaining balance, unread `notifications` count. It creates
nothing and changes no creation flow (6A-4 owns that).

## Files

Backend (new): `backend/src/modules/expenses/{service,routes}.ts`,
`backend/src/modules/announcements/{service,routes}.ts`,
`backend/src/modules/events/{service,routes}.ts`,
`backend/src/modules/certificates/{service,routes}.ts`,
`backend/src/modules/notifications/{service,routes}.ts`,
`backend/src/modules/fees/vouchers.ts`.
Backend (extended): `backend/src/modules/fees/{service,types,routes,receipts}.ts`,
`backend/src/modules/reports/{service,routes}.ts`,
`backend/src/modules/admin/{service,routes}.ts` (settings keys),
`backend/src/modules/hardening/approvals.ts` (6C-2 applier block),
`backend/src/middleware/permissions.ts` (QUEUEABLE: expenses /
announcements / events / certificates), `backend/src/app.ts` (6C-2
mount block), `contracts/API.md` (6C-2 endpoints).
Tests: `backend/src/modules/expenses/__tests__/features-6c2.test.ts`
(30 tests, in-memory fake DB).
Frontend (new): `frontend/src/pages/{Expenses,Announcements,Events,Certificates,Notifications}.tsx`,
`frontend/src/lib/i18n.tsx`, `frontend/src/lib/api.ts: apiPrint`
(authenticated printable-page opener — a plain link would 401).
Frontend (extended): `frontend/src/App.tsx` (routes + LanguageProvider),
`frontend/src/components/Layout.tsx` (nav + bell link),
`frontend/src/pages/{Fees,Reports,Settings}.tsx`,
`frontend/src/lib/types.ts` (settings + fee-row fields).

## Verification (this pass)

- `npx tsc --noEmit` (backend): **0 errors** (final run 2026-11-06
  ~19:12 PKT). The 12 errors seen mid-pass were the Section 11 agent's
  in-flight messaging test fakes; that agent has since fixed them.
- `npx vitest run`: **30 new 6C-2 tests pass**
  (`src/modules/expenses/__tests__/features-6c2.test.ts`), 21 existing
  fees tests pass alongside them (51/51). Full suite: 286/293 pass.
  The 7 remaining failures are NOT 6C-2: `jobs` (daily pending
  attendance / teacher reminders), `isolation` cross-tenant dashboard +
  signup-templates, `hardening` createPrincipal, `auth` login — all in
  files this phase did not touch. Evidence they are pre-existing flakes,
  not regressions: (a) the full suite passed 192/192 at 18:51 PKT, after
  most 6C-2 backend edits had landed; (b) the dashboard failure is a
  wall-clock/timezone flake — the test compares the UTC date with the
  school-local (Asia/Karachi) date, and it started failing only after
  midnight PKT (2026-11-07 00:xx) while the seeded attendance day is
  2026-11-06; (c) the signup-templates failure takes ~5,003 ms (a
  timeout under parallel load — several agents are running builds/tests
  on this VM at once). Left untouched for the owning agents / Phase 8 QA.
- Frontend build (`npm run build`: `tsc -b && vite build`): **clean**,
  62 modules, built in ~2.5 s (only the pre-existing >500 kB chunk-size
  warning).
- Live-DB smoke: **NOT run — blocked by environment, not by code.**
  There is no PostgreSQL on this VM (`pg_ctlcluster`/`psql`/`pg_ctl`
  all absent, no clusters, no `DATABASE_URL`); the task's "start local
  Postgres" step cannot run here. Verification therefore rests on the
  in-memory fake-DB tests above + typecheck + frontend build. The live
  DB was never touched. A scratch-DB HTTP smoke (migrate deploy + seed
  + curl the new endpoints) is still worth doing on a machine that has
  Postgres, before Phase 7.

## Bugs found while testing (fixed)

1. `decideLeave` wrote no change log: the `before` values were read
   from the fetched row AFTER the update, and the fake DB (like some
   real layers) mutates the row in place — before == after. Fixed by
   snapshotting `beforeStatus`/`beforeDecidedBy` before the update
   (the 6A lesson, re-applied).
2. `computeFeeBreakdown` returned NaN when a structure row lacked the
   v2 defaulted fields (fake-DB seed rows predate them). Fixed with
   defensive `Number(...) || 0` coercion in `computeFeeBreakdown`.
3. `toCertificateView` crashed on a missing `issuedAt` (fake DB does
   not apply Prisma `@default(now())`). Fixed with a now() fallback.
