# Frontend — School Management Platform

React + Vite + TypeScript + Tailwind CSS (v4). Mobile-first, role-aware SPA.
Coded against `contracts/API.md` (CONTRACT v1.0).

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc + vite build → dist/
npm run preview
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_URL` | `http://localhost:3000/api/v1` | Backend API base |
| `VITE_MOCK_API` | _(off)_ | `true` = run against the built-in demo data in `src/lib/mock.ts` (no backend needed; login `demo@school.pk` / `Demo1234!`) |

## Auth

JWT access token (15 min) in `Authorization: Bearer …`; refresh token in
localStorage, exchanged automatically on 401 with a single retry (`src/lib/api.ts`).
Routes under `/` require login; `/t/:token` (teacher attendance) is public and
token-authenticated. Settings is admin-only; clerks see the rest of the portal
but cannot approve messages, manage users, or change settings.

## Pages

| Route | Page |
| --- | --- |
| `/login`, `/signup`, `/verify-email`, `/forgot-password`, `/reset-password` | Auth |
| `/` | Dashboard — classes submitted/pending, present/absent, teachers, fees, SIM status, notification center |
| `/classes`, `/classes/:id` | Class cards with "Absent today: X" badges, teacher-link generate/copy/WhatsApp/regenerate/revoke, students |
| `/classes/:id/ocr` | OCR review — upload list photo → editable table (fix names, drop duplicates, add missing) → confirm save |
| `/students` | Searchable/filterable student table, add/edit/delete, CSV/Excel import, parent-phone flags |
| `/parents` | Students with missing / invalid / duplicate parent numbers, fix-number modal |
| `/t/:token` | Public teacher attendance — Present/Absent/Late/Leave toggles, Mark all present, offline-tolerant (localStorage queue + auto-retry) |
| `/fees` | Monthly fee table, mark-paid modal (amount/discount/partial/receipt no.), printable receipt, structures, monthly report |
| `/messages` | Pending-approval queue (edit message before approving), Approve & Send, delivery log + retry, EN/UR templates with character counter, SIM status |
| `/reports` | Daily/weekly/monthly attendance per class + per student, fee summary, PDF/Excel export |
| `/settings` | School & SMS settings, holidays, sessions + promotion, clerk logins, scheduled-job status, audit log |

## PWA / offline

`public/manifest.webmanifest` + `public/sw.js` (registered in `main.tsx`, production
only). The teacher page (`/t/:token`) is cache-first; if the teacher submits while
offline, the payload is stored in localStorage and auto-retried when connectivity
returns. API calls are network-first with cache fallback.

## "About Us" section

The last section on every public page (login, signup, verify/reset password,
teacher link) and a compact line at the bottom of the admin portal show the
developer.

- Component: `src/components/DeveloperFooter.tsx` (`full` / `compact` variants)
- Config: `src/config/developer.ts` — photo path, name, tagline, WhatsApp,
  email, built-by line.
- Layout: round-cropped photo (`border-radius: 50%`, `object-fit: cover`,
  brand-coloured ring) centered at the top of the section, then the name
  (large, bold), tagline, WhatsApp + email links, and the line
  "This application was built by Majid Ali."
- Photo: `public/images/majid-ali.jpg` (referenced as `/images/majid-ali.jpg`).
  To swap it, replace that file or change `photo` in the config — no other
  file changes.

## Notes / limits

- Phone numbers are displayed masked (`+92 3XX XXXX123`) as the API returns them;
  full numbers are never rendered.
- Report exports hit the backend (`?format=pdf|xlsx`); in mock mode they show a
  notice instead.
- The OCR page uploads an image and renders the backend's extracted rows for
  review — it does not run OCR in the browser.
