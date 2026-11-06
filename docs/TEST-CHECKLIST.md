# Test Checklist — School Management Platform

A walk-through checklist for testing the platform by hand (or for re-running
the QA pass). Tick each item; anything that fails goes in `backend/QA-REPORT.md`
with file, line, reproduction steps and severity.

**Setup:** fresh database (`npx prisma migrate deploy && npx prisma db seed` —
local dev only), API on `:4000`, frontend built (`npm run build`). Log in
with the locally seeded demo admin (credentials in `backend/prisma/README.md`,
local-only) or sign up a new school. Automated version of most items below:
`~/workspace/tmp/qa-e2e.sh` (log: `~/workspace/tmp/qa-e2e.log`).

## A. Admin signup & classes

- [ ] Sign up a new school → 201, verification token returned; verify email → 200; login → access token.
- [ ] A brand-new school has 6 message templates (absent / fee_reminder / teacher_reminder × en + ur).
- [ ] Create a class → 201. Create the same name + section again → 409.
- [ ] Create a class with a forged `school_id` in the body → 400.
- [ ] Log in as a different school's admin → the first school's classes are invisible; `GET` one → 404.

## B. Students & OCR

- [ ] Add a student with a valid PK number → 201.
- [ ] Add a student with an invalid number (`12345`) → 400.
- [ ] Add a duplicate (same name + phone) → 409. Same roll number, different name → 409.
- [ ] Upload a student-list photo → 201, rows extracted (fixture: 12 rows).
- [ ] Review the extracted rows, confirm → students saved; re-confirm the same upload → 0 saved, all skipped as duplicates.
- [ ] Upload a non-image file → 400.
- [ ] Set a parent opt-out → no drafts and no reminders for that student afterwards.

## C. Teacher link & attendance

- [ ] Regenerate the teacher link → token + link returned. Open `GET /t/:token` with no login → 200, students listed, `already_submitted=false`.
- [ ] Submit attendance with 2 absent → 201; dashboard shows the absent count.
- [ ] Submit again the same day → 409. Open the link again → `already_submitted=true`.
- [ ] Submit with a revoked token → 404. With a random token → 404.
- [ ] Submit on a Sunday → 409 "No attendance on Sundays or holidays".
- [ ] Create a holiday for today, unlock the day (PATCH), submit → 409 naming the holiday rule; delete the holiday.
- [ ] Submit with `late` and `leave` statuses → counts recorded correctly.
- [ ] Create a leave application → 201.
- [ ] Mark a teacher absent → 200/201 and **no** new messages in the queue.

## D. Messages (approval-gated)

- [ ] After an absent submit, pending-approval shows a draft ONLY for absent students with a valid, opted-in parent number.
- [ ] No draft for opt-out parents, missing numbers, or invalid numbers.
- [ ] Parent phone in the pending list is masked (`+92 3XX XXXX333`); no full number anywhere in the response.
- [ ] Approve the drafts → approved count matches; approve again → 0 newly approved (idempotent).
- [ ] Register an Android device → API key shown once. Poll the device queue with ONLY the device key → the approved message is returned (no staff JWT needed). Wrong key → 401.
- [ ] Report delivery `sent` → message log shows status `sent`.
- [ ] Clerk user: cannot approve (403), cannot create clerks (403), CAN mark a fee paid.

## E. Fees & reminders

- [ ] Create a fee structure → 201. Pay in full → 201, receipt number generated.
- [ ] Partial pay (500/2000) → status `partial`; pay the rest → `paid`; receipt number unchanged.
- [ ] Overpay → 400.
- [ ] Printable receipt → 200 HTML.
- [ ] Run the monthly fee-reminder job for the 1st of the month → paid students skipped, opt-out skipped, no-phone skipped; counts exact (demo school: created 21, skipped_paid 2, skipped_opt_out 1, skipped_no_phone 1).
- [ ] Re-run the same job → `ran: false, reason: already-ran-this-month`.
- [ ] Pay 5 students in rapid succession → all receipt numbers distinct.

## F. Security & privacy

- [ ] No token → 401; bad token → 401 on every admin route.
- [ ] ~20 rapid failed logins → 429 (rate limit). (Run last — it locks logins for up to 15 min; restart the server to clear it.)
- [ ] Phones are encrypted at rest: no plaintext `0300`/`032` in the `students` table; device poll decrypts the number correctly.
- [ ] Audit log (`GET /audit-logs`) contains `attendance.submit`, `fee.pay`, `message.approve`, `student.create`, `class.link_regenerate`.
- [ ] Email verification: confirm whether an unverified admin can use the platform (currently YES — open product decision, see QA-REPORT §7).

## G. Static checks (run before every release)

- [ ] `cd backend && npm run build` — tsc, 0 errors.
- [ ] `cd backend && npx vitest run` — 80/80 pass.
- [ ] `cd backend/src/modules/ocr/tests && npm run test` — 27/27; `npm run test:e2e` — 1/1; `npx tsx smoke.ts` — PASS.
- [ ] `cd frontend && npm run build` — builds clean.
