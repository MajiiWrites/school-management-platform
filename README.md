# School Management Platform

Attendance, parent SMS alerts, and fee management for schools — built for
Pakistan. Teachers mark attendance from a secure link (no login). Parents
of absent students get an SMS after admin approval, sent from the school's
own SIM via a companion Android app. Fees, receipts, and 1st-of-month
reminders included.

## Features

- **Attendance** — tokenized teacher links (one submission per class per day), offline-tolerant teacher page, absent badges on the dashboard
- **OCR student lists** — upload a photo of a class list (English + Urdu), review, save; duplicates merged
- **Parent SMS** — admin-approved absent alerts + monthly fee reminders, sent via the school's own SIM (Android companion app) or a gateway fallback
- **Fees** — monthly structures, partial payments, discounts, printable receipts, collected-vs-pending reports
- **Admin portal** — classes, students, parents, reports (PDF/Excel), holidays, sessions, audit log, multi-tenant isolation

## Tech stack

Node.js 20 + TypeScript + Express + Prisma + PostgreSQL 16 · React + Vite +
Tailwind · Tesseract OCR (eng+urd) · Kotlin + Jetpack Compose (Android)

## Quick start

```bash
cp .env.example .env   # fill in secrets (never commit .env)
docker compose up -d --build
# open http://localhost — demo login: demo@school.pk / Demo1234!
```

Full guides: [`docs/SETUP.md`](docs/SETUP.md) · [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) ·
[`docs/ER-OVERVIEW.md`](docs/ER-OVERVIEW.md) · [`docs/TEST-CHECKLIST.md`](docs/TEST-CHECKLIST.md)

## Deploy (free tier)

- **Backend + DB:** Render Blueprint — see [`render.yaml`](render.yaml) (free
  web service with Docker + free Postgres). Set `PHONE_ENC_KEY` (32-byte
  base64) and `FRONTEND_URL` in the Render dashboard after deploy.
- **Frontend:** Vercel, with `VITE_API_URL` set to the live Render API URL
  (`https://<service>.onrender.com/api/v1`).

## Status

Built and QA-verified on live PostgreSQL (all 6 acceptance criteria pass,
66/66 end-to-end checks). Android APK must be built in Android Studio
(no SDK in CI here). Render free tier sleeps when idle; free Postgres
expires after 90 days — back up with `scripts/backup.sh`.
