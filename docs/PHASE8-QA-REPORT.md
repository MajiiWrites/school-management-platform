# Phase 8 QA Report — School Management Platform v2

Date: 2026-11-07 ~20:00 PKT. Agent: P8-QA (acceptance testing + fixes).
Project root: `/home/hatch/workspace/school-management-platform`.
Scope: QA on a SCRATCH database + local API only. Live DB never touched,
nothing pushed, nothing deployed. No schema/migration changes (code + tests
+ docs only). Phone crypto unchanged. No real SMS sent — every messaging
assertion is queue/draft state only.

## Verdict

**ACCEPTANCE: PASS — 168/168 checks, 0 failures.** Every section-9
criterion (a)–(p) passes over real HTTP against a scratch Postgres 16 DB
(all 4 migrations applied, `SEED_ON_BOOT=false`), plus the announcement
SMS hook (Phase 8 item 3) is built, tested, and verified live. No product
bug was found during acceptance that needed a fix; the only code change
in this phase is the announcement hook itself. One genuine product gap
was confirmed for a later phase: **there is no guided tour / help section
anywhere in the frontend** (Phase 10 criterion E requires one).

## 1. Acceptance pass — 168/168 PASS

Script: `backend/acceptance-8.py` (kept in the repo; run it with the API
on `:4128` against a fresh scratch DB). Two schools (QA Alpha + QA Beta),
185 HTTP requests total (under the 300/15-min API limiter), exit code 0.
Per-criterion executed checks:

| # | Criterion | Checks | Result |
|---|---|---|---|
| (a) | Two-school isolation, incl. ID tampering | 27 | PASS |
| (b) | Fresh signup creates zero records (only 6 template copies) | 14 | PASS |
| (c) | No auto-fill (API blank/null defaults + `autocomplete=off`) | 2 API + grep/bundle (below) | PASS |
| (d) | Approval queue (clerk 202, nothing applied until admin decides) | 11 | PASS |
| (e) | Recycle bin (soft delete, restore < 30d, permanent delete needs `{confirm:true}`) | part of 14 | PASS |
| (f) | Change history (per-field old/new) | part of 14 | PASS |
| (g) | Results OCR + review + toppers/positions | 10 | PASS |
| (h) | Sections independent (teachers/links/attendance per section) | 7 | PASS |
| (i) | Roles (Principal 403, Clerk gated, Admin full) | 12 | PASS |
| (j) | 2FA setup/verify/login round-trip | 7 | PASS |
| (k) | Export requires password, returns full data | 4 | PASS |
| (l) | Messaging (template edit, preview counts, draft → approval → queue, opt-out) | 13 | PASS |
| (m) | Fees (pay/partial/arrears/voucher/receipt) | 10 | PASS |
| (n) | Sessions/exams/timetable/staff/payroll happy paths | 14 | PASS |
| (o) | Backup job writes file + `school_backups` row | 3 | PASS |
| (p) | Rate limiting returns 429 | 2 | PASS |
| — | Announcement SMS hook (item 3) | 8 | PASS |
| — | Setup + manual-results scaffolding checks | 10 | PASS |

### What was actually verified (highlights)

- **(a) Isolation — 27 checks.** School B vs School A: read/update/delete
  of classes, students, results, templates, announcements, exams → all
  404; B's list of A's exam results empty; B's template list is only B's
  own 6. ID tampering: B moving A's student (403/404), paying A's fee
  (404), fetching A's receipt (404), manual results with A's `class_id`
  (404), voucher for A's student (404), preview with A's student ids
  resolves **0 recipients**. Forged `school_id` in a create body → 400.
  B can create its own `1-A` (per-school uniqueness). A's teacher
  verified unchanged after B's update attempts.
- **(b) Zero state.** After signup: classes/students/exams/results/
  announcements/expenses/staff/sessions/drafts/approvals/recycle-bin/fees
  all total 0; exactly 6 seeded message templates, this school's own
  copies (`isCustom: false`).
- **(c) No auto-fill.** API: a class created with a name but no phone
  returns blank/null phone and the teacher exactly as submitted (nothing
  copied from 1-A); a minimal student returns blank/null parent fields.
  Frontend: **147 `autoComplete="off"` attributes in source** (88 across
  the 12 new v2 pages) and **145 `autoComplete:"off"` in the built bundle**
  (credential fields correctly use `current-password` / `new-password` /
  `email` instead). Note: `POST /classes` requires `teacher_name`
  (VALIDATION if absent) — that is a product rule, not auto-fill.
- **(d) Approval queue.** Clerk add student → 202, absent from the list
  until admin approves → present after approve. Clerk delete → 202,
  admin rejects → student still present. Clerk fee pay → 202, `amount_paid`
  still 0 until approval, 500 after approval.
- **(e) Recycle bin.** Soft delete → 404 + excluded from lists; bin row
  carries `restore_by` (~30 days); restore → readable again; second
  delete → permanent delete without confirm → 400, with `{confirm:true}`
  → 200, row gone from the bin.
- **(f) Change history.** Editing a student (name + address) writes
  per-field rows: `name` old "Ahmed Raza" → new "Ahmed Raza Jr",
  `address` old null → new "Street 9" (`GET /change-logs`).
- **(g) Results OCR (real Tesseract eng+urd).** Generated sheet image
  (3 rows) → upload 201 → review rows with `link_preview` → confirm with
  one row edited to obtained 250 / total 200 → flagged
  (`obtained_gt_total`), ghost roll 99 saved **unlinked** (no student
  auto-created), cross-class link rejected; PATCH Bilal back to 70/200
  recomputes % (35.0) and positions; toppers Fatima 187 (pos 1), Ahmed
  175 (pos 2), Bilal 70 (pos 3); summary threshold **50** (seeded grading
  scales override the 33% default — verified as 33% on school B, which
  has no grading scales); publish → SMS drafts created.
- **(h) Sections.** 1-A and 1-B have different teachers and different
  attendance links; revoking 1-A's link leaves 1-B's working (200);
  attendance submitted via the 1-B link lands in the 1-B daily report.
- **(i) Roles.** Principal: create class / update student / pay fee →
  403; views 200; `/roles/me` reports view-only. Clerk: PATCH settings →
  403; create class → 202 (queued). Admin: full.
- **(j) 2FA.** Setup returns secret + `otpauth_url`; verify enables TOTP
  (`/auth/me` shows `totp_enabled: true`); password-only login returns
  `needs_2fa` + temp token; `POST /auth/2fa/login` exchanges it for JWTs;
  inline `totp_code` login works; disable with password works.
- **(k) Export.** No password → 400; wrong password → 401; correct
  password → 200, 41-table export incl. 7 students and 6 templates, with
  the parent phone decrypted (`+92…`) for the school's own data.
- **(l) Messaging.** Seeded template editable; preview: 2 sendable,
  3 skipped (1 opted-out, 2 no phone), samples rendered with real names,
  char/SMS-part counts; Urdu preview counts as Unicode (70/67). Draft →
  submit-for-approval (202) → **log unchanged (nothing queued)** →
  admin approve → 2 queue rows. Direct approve-send: queued 2,
  `skipped_opted_out` 1. Template duplicate + delete work (nothing locked).
- **(m) Fees.** Structure 2500 + 500 admission → Ahmed Nov due 3000;
  partial 1000 → status `partial`; remainder 2000 → `paid`; receipt HTML
  contains the receipt number. Fatima Oct partial (1000 of 3000) →
  Nov row carries **arrears 2000**. Voucher by-student + printable HTML.
- **(n) Sessions/exams/timetable/staff/payroll.** Session create +
  make-current; exam + datesheet; grading seed-defaults → passing marks
  50; timetable create + double-book 409 + class view; staff create +
  assign; payroll net_pay 58000 (60000 − 2000); payslip HTML.
- **(o) Backup.** `POST /backups/run` → 200, file
  `backups/qa-alpha-school/2026-11-07.json` (103,619 bytes on disk, 41
  tables, 7 students) + `GET /backups` lists the row; `GET /jobs/status`
  lists `school_backup` and `scheduled_messages`, scoped to school A.
- **(p) Rate limiting.** 9× 401 wrong-password logins, then **429 with
  `code: RATE_LIMITED`** (auth limiter; shared across auth endpoints —
  known 6D behaviour). The 300/15-min API limiter was not exhausted
  deliberately (185 requests total); its 429 is covered by the 6D unit
  tests (`rate-limit.test.ts`).

### First runs were not clean — and why that is fine

Run 1 crashed on two script bugs (template field is camelCase
`isCustom`; `POST /classes` requires `teacher_name`). Run 2: 157/168 —
all 6 failures were script-expectation bugs, each confirmed against the
code/DB before fixing the script (details in §2). Run 3 (fresh scratch
DB): **168/168, exit 0.**

## 2. Bugs found

### Fixed in this phase (the assigned item)

**B1 — Announcement SMS hook: `POST /announcements/:id/send` returned 501.**
Wired to the Section 11 flow (see §4). New tests:
`backend/src/modules/announcements/__tests__/announcements-send.test.ts`
(9 new tests). Frontend Announcements page gained a "Send SMS" button
(ConfirmDialog) for approved + `sms_send` notices; stale "later step"
copy removed. Docs updated (`FEATURES-6C2.md`, `contracts/API.md`,
`RESULTS.md` note).

### Found during acceptance — all script-side, NOT product bugs

- **S1.** Acceptance script read `is_custom` (snake_case) — the API
  returns camelCase `isCustom`. Fixed the script.
- **S2.** Script created a class with no `teacher_name` — the API
  correctly requires it (VALIDATION). Fixed the script to test the
  no-phone case instead.
- **S3.** Script paid Fatima for Oct 2026 while the fee structure was
  effective 2026-11-01 — the API correctly 409s ("No fee structure
  exists for this class/month yet"). Fixed the script (structure
  effective 2026-10-01). This 409 is correct behaviour, worth knowing.
- **S4.** Script expected preview `skippedCount == 2` but 1-A also holds
  the "Bare Minimal" no-phone student created earlier in the script, so
  the correct count is 3. Fixed the script.
- **S5.** Script treated confirm-response `flagged` as a count; it is a
  list. Fixed the script.
- **S6.** Script expected toppers Fatima-first while Bilal was confirmed
  at 250/200 (125%) to test the flag — Bilal is genuinely first until
  corrected. Fixed the script (PATCH Bilal to 70 first, then rank).
- **S7.** Script expected summary threshold 33% on school A, but school A
  had seeded grading scales (passing 50), which correctly override the
  default. Fixed the script (expect 50 on A; 33% verified on school B,
  which has no scales).
- **S8.** Script read `totp_enabled` / `file_ref` / error code from the
  wrong envelope level (`/auth/me` nests under `data.user`; backups row
  uses camelCase `fileRef`; the 429 envelope has no `data` key). Fixed
  the script.
- **S9.** Script read the duplicate-template id from `data.id`; the
  endpoint returns `{template: {...}}`. The duplicate was therefore
  never deleted in run 2, which made the export template count 7
  instead of 6 and briefly looked like a delete bug. Re-checked the
  route + store code and the live DB: `DELETE /messages/templates/:id`
  is correct (scoped lookup + hard delete); run 3 deletes the copy
  properly and the export count is 6. **No product bug.**

### Bugs left for Phase 9 / later — none from acceptance

No product bug found in acceptance is left unfixed. Known pre-existing
limitations (not found by this pass, carried forward from phase docs):

- **L1 — No guided tour / help section (CONFIRMED in this phase).**
  Grep over `frontend/src`: zero matches for tour/guided/help; tooltips
  exist only as ConfirmDialog titles. Phase 10 criterion E requires a
  guided tour/help section a first-time non-technical admin can follow.
  Owner: Phase 10 (or a Phase 9 follow-up if the parent wants it sooner).
- **L2 — Template recycle-bin restore not wired** (known S11 limitation):
  `message_templates` has no `deleted_at`; restore = re-create from the
  `deleted_records` snapshot (manual step). Doc: `CUSTOM-MESSAGES.md`.
- **L3 — Session archive flag lives in school settings JSONB**
  (`archived_session_ids`); a future migration should add a real
  `is_archived` column. Doc: `FEATURES-6C1.md`.
- **L4 — No QR code for 2FA setup** (secret + otpauth URL are copyable;
  no QR library bundled). Doc: `SECURITY-6D.md`.
- **L5 — Tesseract `urd` dual-pass can hallucinate Urdu over Latin
  headers** (falls back to free-form + warning; the review table is the
  safety net). Doc: `RESULTS.md`.
- **L6 — Backup files live on ephemeral Render disk** (nightly job file
  is not durable by itself; the durable copy is the admin's manual
  export). Doc: `SECURITY-6D.md`.

## 3. Verification gates (before reporting done)

| Gate | Command | Result |
|---|---|---|
| Backend typecheck | `npx tsc --noEmit` (backend) | **0 errors** |
| Full backend suite | `npx vitest run` (backend) | **20 files, 319/319 pass** (was 294/294; +9 new announcement-hook tests — the new file reports 25 because vitest also collects the 16 `service.test.ts` tests via the imported FakeStore, the same double-count the messaging suite already had) |
| Frontend build | `npm run build` (frontend) | **Clean** — built in ~0.8s; only the pre-existing >500 kB chunk-size warning |
| Acceptance script | `python3 backend/acceptance-8.py` (scratch DB, API :4128) | **168/168 PASS, exit 0** (185 HTTP requests) |
| Backup file on disk | `ls` + JSON parse of the run's backup | 103,619 bytes, 41 tables, 7 students |

## 4. Announcement SMS hook — what was built (Phase 8 item 3)

`POST /announcements/:id/send` no longer returns 501.

- **Service** (`backend/src/modules/announcements/service.ts`,
  `sendAnnouncementSms`): guards in order — announcement exists in this
  school (404), not already sent (409), `approved` (409 otherwise),
  `sms_send=true` (409 otherwise). Creates a Section 11 `message_draft`
  (recipient `all_parents`, or `class` + `target_class_id` per the
  announcement's audience; body = title + body, so `{school_name}` etc.
  still render per recipient), then routes it through the existing
  draft → approval → queue path via `approveDraftForSending` — the same
  path as `POST /messages/drafts/:id/approve-send`. The admin already
  approved the announcement, so that same approval is recorded on the
  draft (APPROVED `approval_requests` row). Queue rows are type
  `'announcement'` (dedupe `announcement:{draftId}:{studentId}`); the
  messaging service gained an optional `queueType` parameter
  (`custom-messages.ts`: `sendDraft` / `applyApprovedDraft` /
  `approveDraftForSending`, default `'custom'` — existing behaviour
  unchanged, incl. the `custom:{draftId}:{studentId}` dedupe).
  Opted-out / missing / invalid numbers are auto-excluded with a skipped
  count, exactly as for custom drafts. **No second sending path:** this
  module never writes `message_queue` rows directly. The announcement
  flips to `sent` only when >= 1 row is queued; with zero queueable
  recipients it stays `approved` (retryable) and the audit row is
  `announcement.send_no_recipients`.
- **Route** (`backend/src/modules/announcements/routes.ts`): admin-only,
  builds the real Prisma messaging store + `approveDraftForSending`.
- **Tests** (`backend/src/modules/announcements/__tests__/announcements-send.test.ts`,
  9 tests): guards (draft / `sms_send=false` / already-sent → 409, no
  draft created; foreign school → 404), class targeting, zero-recipient
  retryable case, and FakeStore end-to-end checks that `queueType:
  'announcement'` lands type-`announcement` queue rows with the
  announcement dedupe key and opt-out skipping — and that the default
  stays `custom`.
- **Frontend** (`frontend/src/pages/Announcements.tsx`): "Send SMS"
  button on approved + `sms_send` notices (ConfirmDialog naming the
  audience; success toast reports queued + opted-out counts).
- **Docs updated:** `FEATURES-6C2.md` hook section,
  `contracts/API.md` 6C-2 line, `RESULTS.md` queue-type note.
- **Acceptance evidence:** send before approval → 409; after approval →
  200 `{queued: 2, draft_id}`; announcement status `sent`; log filtered
  `?type=announcement` shows the 2 rows; second send → 409;
  `sms_send=false` → 409; school B send → 404. DB check: draft is
  `recipientType: 'class'`, status `sent`; queue holds 2 `announcement`
  + 4 `custom` rows for school A.

## 5. Browser checklist — for the parent to run in a live browser (NOT tested by this agent)

This agent has no live browser. Nothing in this section was clicked,
seen, or verified — it is the checklist Phase 8 owes the parent, to run
against the live site (or a staging deploy) with TEST data only. SMS only
to +923242699437 if any send is exercised.

### Every new page — open, read, act

- [ ] **Sessions** (`/sessions`): list, create, edit, archive/unarchive,
  make-current (exactly one current), whole-class promotion, promotion
  history. Archived session refuses edits/promotion with a friendly error.
- [ ] **Exams** (`/exams`): create/edit/delete exam, datesheet add/edit/
  delete per class, grading-scale manager + seed defaults, passing-marks
  display (50 after seeding).
- [ ] **Timetable** (`/timetable`): class-wise and teacher-wise views,
  add entry, conflict error shown inline on double-booking.
- [ ] **Staff** (`/staff`): create/edit/delete staff, assign to class,
  payroll tab (create, mark paid/unpaid, printable payslip modal).
- [ ] **Results** (`/results`): manual entry, OCR upload → review table
  (low-confidence red highlight, mismatch flags) → confirm → toppers /
  summary / report card / export. ConfirmDialog names low-confidence +
  flagged counts.
- [ ] **Messages → Custom messages tab** (`/messages`): composer with
  variable chips, quick filters (absent / fee-unpaid), live preview with
  samples + skipped list + SMS-part counter, drafts list
  (submit/approve/reject/cancel/delete), approve dialog shows recipient
  list + final rendered message first. Template manager: create / rename /
  edit / duplicate / delete a seeded default.
- [ ] **Security** (`/security`, admin only): 2FA tab (setup shows secret
  + otpauth URL, verify, disable behind ConfirmDialog), roles matrix +
  create-Principal, data & privacy (password-confirmed export, deletion
  request), login alerts, backups (run-now + history).
- [ ] **Expenses** (`/expenses`): create/edit/delete, income-vs-expense
  report, `paid_by` round-trips on the description.
- [ ] **Announcements** (`/announcements`): create draft → approve →
  **Send SMS** button appears only on approved + SMS notices; ConfirmDialog
  names the audience; toast reports queued/opted-out counts; status becomes
  `sent`; second send is refused.
- [ ] **Events** (`/events`): create/edit/delete, calendar merges holidays
  + events in date order.
- [ ] **Certificates** (`/certificates`): issue leaving/character/bonafide,
  derived certificate number, printable certificate + ID card (photo
  placeholder, since students have no photo column).
- [ ] **Leaves** (`/leaves`): apply, approve/reject, late-arrivals list
  (from attendance status `late`).
- [ ] **Notifications** (`/notifications`): center aggregates pending
  approvals, failed messages, OCR needing review, fee dues.
- [ ] **Fees → Vouchers tab**: voucher per student, printable voucher;
  receipt shows arrears/scholarship lines when nonzero.
- [ ] **Reports**: Defaulters / Class strength / Income vs expense /
  Message history tabs + CSV export.
- [ ] **Settings**: school identity (name, timezone, address, phone, logo
  upload), language EN/UR (nav labels + 6 new page headings translate;
  the rest of the UI stays English — honest coverage per FEATURES-6C2.md),
  session-timeout field.

### Cross-cutting

- [ ] **Empty states:** every list above shows a friendly empty state
  with a call-to-action when it has no rows (23/24 pages carry
  `EmptyState` in code; Auth is the exception by design). Verify visually,
  incl. drafts/templates/approvals/recycle bin/backups.
- [ ] **Dialogs:** every destructive action goes through `ConfirmDialog`
  (no `window.confirm` in code — grep verified 0 outside ConfirmDialog in
  6A-3; re-check visually that dialogs name what they will do).
- [ ] **Urdu display:** a message template/draft with Urdu text renders
  correctly (right script, no tofu boxes) in the composer preview, the
  drafts list, and the log; Urdu SMS-part counting shows 70/67.
- [ ] **Responsive spot-checks:** 360 / 414 / 768 / 1366 / 1920 px,
  portrait + landscape; tables scroll/reformat, no horizontal scroll or
  overlap; tap targets feel ≥ 44 px on the teacher-link page.
- [ ] **Guided tour / help:** ⚠️ **none exists in code** (see L1) — do not
  mark Phase 10 criterion E passed until one is built and checked here.
- [ ] **Errors:** invalid actions show friendly, fixable messages (no
  stack traces / blank pages); every error banner has retry/back.
- [ ] **Data consistency:** data saved on one page shows on all others
  (e.g. a student created in Students appears in Fees, Results, Messages
  recipient picker); refresh mid-save loses nothing.
- [ ] **Session timeout:** idle warning modal appears ~2 min before the
  configured timeout; "Stay signed in" resets it; expiry lands on the
  login page with the session-expired message.
- [ ] **Deep links:** direct URL open of `/login`, `/results`,
  `/security` returns the app (SPA fallback via `vercel.json`), not a 404.
- [ ] **Demo login:** `demo@school.pk` must still 401 on the live site
  (demo removal is the pending morning-tap step — do not run this
  checklist's data checks against any demo data).

## 6. Scratch-DB cleanup confirmation

- Scratch DB `school_p8_qa` — **dropped** (verified: no `school_p8%`
  database remains; `psql -l` check after drop returned 0 rows).
- Scratch role `p8qa` — **dropped** (verified: no such role remains).
- Scratch API server (`:4128`) — **stopped** (0 processes; `/health`
  connection refused afterwards).
- Scratch files (`/tmp/p8-qa`: server log, backup dir, upload dir,
  phone key) — **removed**.
- Live DB: never connected to, never touched. No pushes, no deploys.
- Repo state: `backend/backups/` untouched (backups went to the scratch
  `BACKUP_DIR`); `backend/uploads/` holds only the pre-existing `ocr/` +
  `result-sheets/` dirs.

## 8. Guided tour (post-QA addition)

Date: 2026-11-07 ~21:00 PKT. Agent: P8-TOUR. This closes gap **L1** (§2):
there is now a guided tour and a help section in the frontend, as Phase 10
criterion E requires. Frontend only — no backend changes, no schema
changes, no new dependencies, no live-DB work, nothing pushed or deployed.

### What was built

- **Guided tour** (`frontend/src/components/GuidedTour.tsx`, new).
  Modal-based, deliberately NO tour library and NO element highlighting or
  DOM queries: each of the 8 steps navigates to the real page it talks
  about (Dashboard → Classes & sections → Students → Attendance links →
  Messages → Messages/approve → Fees → Results → Settings & Security) and
  shows a short plain-word explanation in the shared `Modal` (bottom
  sheet on mobile, so it works at 360 px). Back / Next / Skip tour /
  Finish; a progress bar shows "step N of 8". Because the modal IS the
  tour, a missing page element can never block or break it. Auto-opens
  once on first login for an admin who has never seen it; "seen" is stored
  per user in localStorage (`smp_tour_seen_<userId>`). Finishing or
  skipping marks it seen — it never nags again. Relaunch anytime via
  `startGuidedTour()` (window event `smp:start-tour`).
- **Relaunch points.** A "?" button in the header (next to the bell) and a
  "Take the tour" button on the Help page both call `startGuidedTour()`.
  The tour component is mounted in `Layout.tsx` (marked `P8-TOUR` block).
- **Help page** (`frontend/src/pages/Help.tsx`, new; route `/help`, nav
  entry "Help" for admin + clerk, `help` label added to `i18n.tsx`).
  Seven how-tos, each 5 steps or fewer, in plain words: add a class, add a
  student, send attendance (teacher link), approve a message, collect a
  fee, upload a result sheet, set up 2FA. A "what do the words mean"
  glossary: section, roll number, admission number, voucher, challan,
  dedupe, arrears, sibling discount, scheduled message, recycle bin.
  Contact line is the support email from the project config
  (`frontend/src/config/developer.ts` → `DEVELOPER.email`,
  majidalioffical0@gmail.com) — no invented contacts. "Take the tour"
  button at the top.
- **Tooltips** (`frontend/src/components/Tooltip.tsx`, new). A small "?"
  button: `title` attribute as the hover fallback, tap opens a short
  bubble (works on touch, where hover does not); Esc / outside-tap closes
  it. Placed on the confusing labels, each in plain words:
  - Fees → Vouchers tab: voucher (challan).
  - Fees → Monthly report: arrears.
  - Fees → PayModal "Discount (PKR)": sibling discount.
  - Custom Messages composer "Schedule for later": scheduled message.
  - Messages → Delivery log: dedupe key.
  - Templates tab intro: recycle bin (30-day keep).
  The same wordings appear in the Help-page glossary.

### Conventions kept

- `ConfirmDialog` untouched; no `window.confirm` anywhere in the new
  code. No new `<input>`/`<form>` elements added (the tour and Help page
  add no data-entry fields), so the `autoComplete="off"` coverage from
  6A-3 is unaffected. Empty states untouched. Urdu display unaffected
  (tour/help text is English; the Help nav label has an Urdu translation
  in `i18n.tsx`, matching the existing nav coverage).
- Shared files touched only in marked `P8-TOUR` blocks: `App.tsx`
  (import + `/help` route), `Layout.tsx` (nav entry, header "?" button,
  `<GuidedTour />` mount), `i18n.tsx` (one nav label).

### Verification (this phase)

| Gate | Command | Result |
|---|---|---|
| Backend typecheck | `npx tsc --noEmit` (backend) | **0 errors** (no backend files changed) |
| Full backend suite | `npx vitest run` (backend) | **20 files, 319/319 pass** (unchanged) |
| Frontend build | `npm run build` (frontend) | **Clean** — `tsc -b && vite build`, 65 modules; only the pre-existing >500 kB chunk-size warning |
| Bundle smoke | `grep` built bundle | Contains "Take the tour", "What do the words mean", `smp_tour_seen_` |

### Not verified (still owed to the live-browser checklist, §5)

- The tour was verified by code walk + build only (this agent has no live
  browser): nobody has clicked through the 8 steps, confirmed the
  auto-open on a genuinely first login, or checked the modal at 360 px on
  a real phone. Add to the §5 checklist: tour auto-opens for a new admin,
  each step shows the right page behind the modal, Skip/Finish never show
  it again, header "?" and Help-page buttons relaunch it, Help page reads
  clearly at 360 px, tooltips open on tap.
- The Help how-to steps describe the UI as built; if a later phase moves
  a button, the wording needs a matching edit (the file header says so).

## 7. Files changed by this agent

- `backend/src/modules/messaging/custom-messages.ts` — optional
  `queueType` (`custom` default) through `sendDraft` /
  `applyApprovedDraft` / `approveDraftForSending` + `dedupeKeyForQueueType`.
- `backend/src/modules/announcements/service.ts` — `sendAnnouncementSms`
  (+ deps interface/result type); header comment updated from the 501 note.
- `backend/src/modules/announcements/routes.ts` — `POST /:id/send` wired
  to the draft → approval → queue flow (was 501).
- `backend/src/modules/announcements/__tests__/announcements-send.test.ts`
  — new, 9 tests.
- `backend/acceptance-8.py` — new, the 168-check acceptance script.
- `frontend/src/pages/Announcements.tsx` — "Send SMS" button + dialog,
  stale "later step" copy removed.
- `contracts/API.md`, `backend/src/modules/expenses/FEATURES-6C2.md`,
  `backend/src/modules/results/RESULTS.md` — 501 notes updated.
- `docs/PHASE8-QA-REPORT.md` — this file.
- No migration, no schema change, no `render.yaml`/env change.
