# School Management Platform

A complete, production-ready platform for a school to run **attendance,
parent SMS alerts, and fee management** — with almost no manual work.

- **Teachers never log in.** The admin shares a secure link per class;
  the teacher opens it, taps Present/Absent, saves. Done.
- **Parents are told automatically.** When attendance is saved, the
  platform drafts a message for *only* the absent students' parents.
  The admin previews and approves; the message goes out through the
  admin's own SIM (Android companion app) — no SMS gateway bill.
- **Fees collect themselves.** Monthly fee records, receipts, partial
  payments, and a reminder SMS on the 1st of every month to parents of
  unpaid students only.
- **Student lists from a photo.** Upload a photo of a handwritten or
  printed list; OCR (English + Urdu) extracts the names, the admin
  reviews and fixes them on screen, then saves.

## Features (summary)

| Area | What works |
|---|---|
| Admin & classes | Signup + email verification, password reset, clerk logins, class CRUD, teacher assignment |
| Students | Manual add/edit/delete, CSV/Excel bulk import, search/filter, parent phone validation (PK, +92), duplicate + missing-number flags |
| OCR lists | Photo upload → Tesseract (eng+urd) → editable review table → merge, no duplicates |
| Attendance | Tokenized teacher links (regenerate/revoke, one submission per class per day, admin unlock), present/absent statuses, teacher attendance, offline-tolerant link page |
| Dashboard & reports | Submitted vs pending today, present/absent counts, daily/weekly/monthly reports, PDF/Excel export |
| Messages | Admin-approved absent alerts (EN/UR templates, variables), delivery log + retry, dedupe (never twice for the same student/day), opt-out respected |
| SMS via SIM | Android companion app polls the queue and sends from the admin's SIM; connection status in the portal; gateway fallback (optional) |
| Fees | Monthly structures per class, paid/partial/unpaid, receipts, printable receipt, collected-vs-pending reports, month rollover |
| Automation | 1st-of-month fee reminders, follow-up reminders, daily pending-attendance check, teacher reminders by a set time — all school-timezone aware, skipped on Sundays/holidays |
| Safety | Multi-tenant isolation, encrypted parent phones, masked numbers in responses, audit log, rate-limited login, expiring teacher links, notification centre |

## Tech stack

- **Backend:** Node.js 20 + TypeScript + Express + Prisma + PostgreSQL 16
- **Frontend:** React 19 + Vite + Tailwind CSS (PWA — the teacher link page works offline)
- **Android companion:** Kotlin + Jetpack Compose, foreground service polling every 60 s
- **OCR:** Tesseract CLI (`eng` + `urd`)
- **Scheduler:** DB-backed outbox (`message_queue`) + node-cron — no Redis needed
- **Deploy:** Docker Compose (postgres + api + web) or plain Node + Postgres

## Quick start (Docker — recommended)

```bash
cp .env.example .env          # fill in real secrets (see the comments inside)
docker compose up -d --build
# open http://localhost — sign up a school account in the UI.
# There is no demo account; demo seeding is off by default.
```

The first boot runs migrations only — the site starts empty. (For local
dev only, `SEED_ON_BOOT=true` seeds a demo school; never on live.)

## Quick start (local dev, no Docker)

See [`docs/SETUP.md`](SETUP.md). In short: install Node 20, PostgreSQL 16
and Tesseract (`eng` + `urd`), then

```bash
cd backend && cp .env.example .env   # set DATABASE_URL + secrets
npm install && npx prisma migrate deploy && npx prisma db seed
npm run dev                            # API on :4000
cd ../frontend && npm install && npm run dev   # web on :5173
```

## Documentation

| Doc | What it covers |
|---|---|
| [`docs/SETUP.md`](SETUP.md) | Local setup from zero, Tesseract install, Android app build, verify it works |
| [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) | VPS deployment, domain + HTTPS, backups, updates, monitoring, common failures |
| [`docs/ER-OVERVIEW.md`](ER-OVERVIEW.md) | Database entities, relationships, and the invariants the code must never break |
| [`docs/TEST-CHECKLIST.md`](TEST-CHECKLIST.md) | Manual test checklist (also the QA pass checklist) |
| [`backend/QA-REPORT.md`](../backend/QA-REPORT.md) | Phase-4 QA report — 66/66 live checks passed on a real database |
| [`backend/INTEGRATION.md`](../backend/INTEGRATION.md) | How the modules were merged, and the integration fixes made |
| [`contracts/`](../contracts/) | Source of truth: schema, API spec, structure & conventions |
| [`android/README.md`](../android/README.md) | Companion app: setup, permissions, build |

## Project layout

```
school-management-platform/
  contracts/        # schema, API spec, structure (do not change without the lead)
  backend/          # Express + Prisma API (src/), migrations + seed (prisma/)
  frontend/         # React + Vite SPA (src/pages: Dashboard, Classes, Students,
                    #   OCR review, TeacherLink, Fees, Messages, Parents, Settings, Reports)
  android/          # Kotlin companion app (SIM SMS sender)
  scripts/          # backup.sh / restore.sh (Postgres)
  docs/             # this documentation
  docker-compose.yml
  .env.example
```

## Demo data (local dev only)

The seed script (`backend/prisma/seed.ts`) creates a demo school
**Demo Public School** (timezone Asia/Karachi) with classes 1-A, 5-A, 6-B,
25 students with Pakistani parent numbers, fee structures, one submitted
attendance day and EN + UR message templates. The seed is idempotent —
re-running it is safe. **Local dev only — never seed on the live site.**
The live site must stay empty; there is no demo login on it. The seeded
admin credentials are documented in `backend/prisma/README.md` (local-only).

## Security notes (read before going live)

- **Back up `PHONE_ENC_KEY`.** If it is lost, every stored parent phone
  number becomes unreadable forever. Keep a copy off the server.
- Demo seeding is off (`SEED_ON_BOOT=false`) and the demo school must
  never be created on the live site — the live site stays empty.
- Login does **not** currently require email verification (open product
  decision — see `backend/QA-REPORT.md` §7). Decide before launch.
- The Android app sends SMS from a real SIM — keep the phone charged,
  online, and with SMS credit; the portal shows SIM status and alerts
  when the phone goes offline.
