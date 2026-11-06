# Setup Guide — School Management Platform

Get the platform running from zero. Two paths: **Docker** (easiest, one
command) or **local dev** (Node + Postgres on your machine). Pick one.

## Path A — Docker (recommended)

### Prerequisites

- Docker Engine + Docker Compose v2 (Docker Desktop on macOS/Windows,
  or `docker.io` + `docker-compose-plugin` on Ubuntu)
- Git

### Steps

```bash
git clone <repo-url> school-management-platform
cd school-management-platform
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, JWT_SECRET, JWT_REFRESH_SECRET,
# SMS_DEVICE_SECRET, and PHONE_ENC_KEY (generate it — see the comment in
# .env.example). BACK UP PHONE_ENC_KEY off-server; losing it makes every
# stored parent phone number unreadable forever.
docker compose up -d --build
docker compose logs -f api        # watch migrations + seed, then Ctrl-C
curl http://localhost:4000/health # {"ok":true,"data":{"status":"up",...}}
# Open http://localhost  →  sign up a school account in the UI.
# There is no demo account (demo seeding is off by default).
```

Useful commands: `docker compose ps`, `docker compose logs -f api`,
`docker compose down` (keeps data), `docker compose down -v` (deletes
all data — only for a fresh start), `docker compose up -d --build api`
(rebuild the API after a code change).

## Path B — Local dev (no Docker)

### Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 20+ | `node --version` |
| PostgreSQL | 16 | `psql --version` |
| Tesseract (+ Urdu data) | 5.x, langs `eng` + `urd` | `tesseract --list-langs` |
| Git | any | `git --version` |
| Android Studio + JDK 17 + SDK 34 | only for the companion app | — |

**Install Tesseract with Urdu:**

```bash
# Ubuntu / Debian
sudo apt update && sudo apt install -y tesseract-ocr tesseract-ocr-urd
tesseract --list-langs          # must show: eng  osd  urd

# macOS (Homebrew)
brew install tesseract
brew install tesseract-lang     # provides urd trained data
```

Without `urd`, OCR uploads return **503 `OCR_UNAVAILABLE`** by design —
English-only lists still work once `eng` is present.

### Steps

```bash
git clone <repo-url> school-management-platform
cd school-management-platform

# 1. Database — create role + database (adjust the password)
sudo -u postgres psql -c "CREATE ROLE school LOGIN PASSWORD 'change-me';"
sudo -u postgres psql -c "CREATE DATABASE school OWNER school;"

# 2. Backend
cd backend
cp .env.example .env
# Edit .env: DATABASE_URL=postgresql://school:change-me@localhost:5432/school
# and set JWT_SECRET, JWT_REFRESH_SECRET, SMS_DEVICE_SECRET, PHONE_ENC_KEY.
# Generate PHONE_ENC_KEY with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npm install
npx prisma migrate deploy
npx prisma db seed              # local dev only: seeds the demo school
                                # (see backend/prisma/README.md) — never on live
npm run dev                     # API on http://localhost:4000

# 3. Frontend (new terminal, from the project root)
cd frontend
npm install
# Point at the API (dev default is http://localhost:3000/api/v1 — override it):
VITE_API_URL=http://localhost:4000/api/v1 npm run dev
# Web on http://localhost:5173
```

Production build check (both must pass with zero errors):

```bash
cd backend && npm run build     # tsc
cd ../frontend && npm run build # tsc + vite build
```

## Android companion app (SIM SMS sender)

The platform queues approved messages; this app (on a phone with the
admin's SIM) polls the queue every 60 s, sends each SMS, and reports
delivery back. Full details: `android/README.md`.

1. **Portal first:** log in as admin → Messages → SMS status →
   Register device. Enter a device ID (e.g. `admin-phone-1`) and a name.
   Copy the **API key shown once** — it is never shown again.
2. **Build the app** (needs Android Studio Hedgehog or newer, JDK 17,
   Android SDK 34):
   ```bash
   cd android
   ./gradlew assembleDebug
   # APK: app/build/outputs/apk/debug/app-debug.apk
   ./gradlew installDebug       # install on a connected device/emulator
   ```
   > No Gradle wrapper jar is bundled — Android Studio generates it on
   > first import, or run `gradle wrapper` with a local Gradle 8.5 install.
3. **On the phone:** open the app, enter server URL
   (e.g. `https://api.yourschool.pk` — or `http://YOUR_PC_IP:4000` on the
   same Wi-Fi for testing), device ID, device name, API key. Tap
   **Connect & start sending**. Grant **SEND_SMS** when asked.
4. **Verify:** the portal shows "SIM connected" when the phone polls
   (last seen within 90 s). Send a test absent message and watch the
   delivery log turn `sent`.

The app was **not compiled in this environment** (no Android SDK/JDK
here) — build it in Android Studio before distributing the APK. The
backend device API it talks to is fully tested (register → poll →
delivery → `sent` in the log).

## Verify it works

Run through [`docs/TEST-CHECKLIST.md`](TEST-CHECKLIST.md) — or the
automated version used in QA (adapt paths to your machine). The shortest
smoke test:

1. Sign up a new school (or log in with the locally seeded demo admin — local dev only, see `backend/prisma/README.md`) → dashboard loads.
2. Classes → 5-A → regenerate the teacher link → open it in a private
   browser window (no login) → mark 1 student absent → Save → 201.
3. Dashboard shows "Absent today: 1" on class 5-A.
4. Messages → pending approval → exactly 1 draft (the absent student) →
   Approve → status becomes approved.
5. Fees → pick a student → Mark paid → receipt number appears.
6. `GET /api/v1/jobs/status` (logged in as admin) → last runs listed.

## Troubleshooting (local setup)

| Symptom | Fix |
|---|---|
| `prisma migrate deploy` fails: connection refused | Postgres isn't running, or `DATABASE_URL` is wrong. Check `pg_isready` / `sudo service postgresql status`. |
| `npx prisma db seed` exits silently / empty DB | Use `npx prisma db seed` (the `prisma.seed` config is set in `backend/package.json`). Do not run `tsx prisma/seed.ts` without `DATABASE_URL` exported. |
| API boots but encrypted phones don't decrypt | `PHONE_ENC_KEY` changed since the data was seeded. Restore the original key from backup, or re-seed (demo data only). |
| OCR upload → 503 `OCR_UNAVAILABLE` | `tesseract` binary or `urd` data missing. Install per the Tesseract section above. |
| Frontend shows "Failed to fetch" | API not running, or `VITE_API_URL` wrong. Dev: `VITE_API_URL=http://localhost:4000/api/v1`. |
| Login 429 after failed attempts | Rate limiter (20 failed logins / 15 min, in-memory). Wait 15 min or restart the API. |
| Port 4000/5173 already in use | Change `PORT` in `backend/.env` / run Vite with `--port 5180`. |
