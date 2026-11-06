# School Management Platform — Structure, Stack & Conventions (CONTRACT v1.0)

## Stack (decided by Lead; change only with Lead approval)
- Backend: Node.js 20 + TypeScript + Express, Prisma ORM, PostgreSQL 16 (docker-compose for local dev).
- Queue/scheduler: DB-backed outbox (`message_queue`) + node-cron. NO Redis required (keeps deploy simple).
- OCR: Tesseract CLI (`eng` + `urd` trained data) as primary; optional AI-vision provider behind `OCR_PROVIDER` env (never required).
- Frontend: React + Vite + Tailwind CSS (SPA). No Next.js — faster build, same result. Served as static files (or Vercel).
- Android companion: Kotlin + Jetpack Compose, WorkManager polling every 60s, SmsManager send, reports delivery.
- Auth: JWT access (15 min) + refresh (7 d), bcrypt (12 rounds). Email via SMTP env; in dev, verification/reset tokens are logged, never emailed.
- Env: `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `PHONE_ENC_KEY` (32-byte base64), `OCR_PROVIDER`, `SMS_GATEWAY_*` (optional), `FRONTEND_URL`, `UPLOAD_DIR`.

## Folder layout
```
school-management-platform/
  contracts/            # THIS folder — source of truth. Do not change without Lead approval.
  backend/
    prisma/schema.prisma  # DATABASE AGENT ONLY
    prisma/migrations/    # DATABASE AGENT ONLY
    prisma/seed.ts        # DATABASE AGENT ONLY
    src/
      app.ts              # BACKEND AGENT ONLY (mounts routers; module agents must NOT edit)
      server.ts           # BACKEND AGENT ONLY
      config.ts           # BACKEND AGENT ONLY
      middleware/         # auth.ts, tenant.ts, errors.ts, rateLimit.ts — BACKEND AGENT
      lib/                # crypto.ts (phone enc), dates.ts (school tz), pagination.ts — BACKEND AGENT
      modules/
        auth/             # BACKEND AGENT
        classes/          # BACKEND AGENT
        students/         # BACKEND AGENT
        attendance/       # BACKEND AGENT (incl. public /t/:token routes)
        reports/          # BACKEND AGENT
        ocr/              # OCR AGENT ONLY
        messaging/        # MESSAGING AGENT ONLY (queue, templates, device endpoints)
        fees/             # FEE AGENT ONLY (fees + receipts)
      jobs/               # FEE AGENT ONLY (monthly fee reminder, daily pending-attendance, teacher reminders)
    tests/                # QA AGENT (supplements module tests; module agents write their own unit tests beside code)
    .env.example          # DEVOPS AGENT
    Dockerfile            # DEVOPS AGENT
  frontend/
    src/                  # FRONTEND AGENT ONLY (pages: Login, Dashboard, Classes, Students+OCR review,
                          #   TeacherLink (public), Fees, Messages, Parents, Settings, Reports)
    public/               # PWA manifest + service worker for offline teacher page
  android/                # MESSAGING AGENT ONLY (Kotlin companion app)
  docs/                   # DEVOPS AGENT (README, SETUP, DEPLOYMENT, TEST-CHECKLIST)
  docker-compose.yml      # DEVOPS AGENT (postgres + api + web)
  .env.example            # DEVOPS AGENT
```

## Conventions
- TypeScript strict. REST under /api/v1 (see API.md). File names kebab-case. Every module exports an Express `Router` from `modules/<name>/routes.ts` and registers itself ONLY via a `MOUNT.md` note (Integration phase wires `app.ts` — module agents never edit it).
- Every module has a `README.md` in its folder: what it does, endpoints, env vars, how to test.
- Errors: use the shared error middleware format `{ok:false, error:{code, message}}`; codes: VALIDATION, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, CONFLICT (duplicates/already-submitted), RATE_LIMITED.
- Phone numbers: normalize at the boundary (lib), store encrypted, mask in all responses/logs.
- Dates: always compute "today" in the school's timezone (lib/dates.ts). Never use server-local date for business rules.
- Tests: each module ships unit tests for its service functions; QA agent adds end-to-end tests per the acceptance criteria.
- Seed data (Database Agent): 1 demo school ("Demo Public School", Asia/Karachi), admin demo@school.pk / Demo1234!, 3 classes (1-A, 5-A, 6-B) with teachers, ~25 students with Pakistani names + parent numbers, fee structures, one submitted attendance day, EN+UR templates.
