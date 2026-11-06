# Deployment Guide — School Management Platform

Deploy the platform on a VPS (Ubuntu 22.04 / 24.04) with Docker Compose,
a domain, and automatic HTTPS. The whole platform runs from one origin:
`https://yourschool.pk` serves the web app, and `/api/*` is proxied to
the API container.

## 1. Server preparation

```bash
# On the VPS (Ubuntu 24.04)
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git ufw
sudo systemctl enable --now docker
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw --force enable
# Add your user to the docker group (log out/in afterwards):
sudo usermod -aG docker $USER
```

## 2. Install the platform

```bash
git clone <repo-url> /opt/school-management-platform
cd /opt/school-management-platform
cp .env.example .env
nano .env
```

Set in `.env` (all required — compose refuses to start without the
`?`-marked ones):

| Variable | Value |
|---|---|
| `POSTGRES_PASSWORD` | Long random password (generate: `openssl rand -hex 24`) |
| `JWT_SECRET`, `JWT_REFRESH_SECRET`, `SMS_DEVICE_SECRET` | Long random hex strings, each different |
| `PHONE_ENC_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` — **back it up off-server now** (see §6) |
| `FRONTEND_URL` | `https://yourschool.pk` (your real domain) |
| `SEED_ON_BOOT` | `true` for the first boot (demo school), then set `false` |
| `SMTP_*` | Your mail provider (optional; verification/reset links are logged if unset) |
| `SMS_GATEWAY_*` | Only if you use the gateway fallback instead of the SIM app |

Then:

```bash
docker compose up -d --build
docker compose logs -f api     # wait for "listening on :4000", then Ctrl-C
curl http://localhost:4000/health
# First boot: log in as demo@school.pk / Demo1234!, change the password,
# then set SEED_ON_BOOT=false in .env (demo data stays until you delete it).
```

## 3. Domain + HTTPS (Caddy — automatic certificates)

Install Caddy and point it at the web container:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```caddy
yourschool.pk {
  reverse_proxy localhost:80
}
```

```bash
sudo systemctl reload caddy
# Open https://yourschool.pk — Caddy fetches a Let's Encrypt certificate
# automatically. The Android app's server URL becomes https://yourschool.pk
# (the API is reached at https://yourschool.pk/api/v1 through the web proxy).
```

Point your domain's DNS `A` record at the VPS IP first. (Alternative:
nginx + certbot — `sudo apt install -y nginx certbot python3-certbot-nginx`,
`sudo certbot --nginx -d yourschool.pk`, proxy_pass to `localhost:80`.)

## 4. Updates (deploy a new version)

```bash
cd /opt/school-management-platform
git pull
docker compose up -d --build     # rebuilds api + web; migrations run on api boot
docker compose logs -f api        # confirm it comes up healthy
```

Database migrations are applied automatically on every api boot
(`prisma migrate deploy` in the entrypoint), so a plain rebuild is a
safe update path. Always take a backup first (§5).

## 5. Backups

Daily backup via cron (02:00) — the script keeps 7 days:

```bash
crontab -e
# add:
0 2 * * * cd /opt/school-management-platform && ./scripts/backup.sh >> /var/log/school-backup.log 2>&1
```

What is backed up: the Postgres database only (all school data).
Uploaded OCR images live in the `uploads` Docker volume — back that up
too if you care about re-reviewing old uploads:

```bash
docker run --rm -v school-management-platform_uploads:/data -v /opt/backups:/out \
  alpine tar czf /out/uploads-$(date +%Y%m%d).tar.gz -C /data .
```

**Restore:** `./scripts/restore.sh backups/school-YYYYMMDD-HHMM.sql.gz`
(it stops the API, recreates the DB, restores, restarts — see the script
header). Test a restore on a spare machine at least once before you
need it for real.

## 6. The one secret you must never lose: PHONE_ENC_KEY

Every parent phone number is encrypted with `PHONE_ENC_KEY`
(AES-256-GCM). If it is lost:

- stored numbers can **never** be decrypted again,
- SMS can never be sent to existing parents,
- the only fix is re-entering every parent's number by hand.

Store a copy **off the server** (password manager / printed in a safe).
Rotating the key is not supported — it would orphan all existing numbers.

## 7. Monitoring (what to watch)

| What | How | Healthy looks like |
|---|---|---|
| API up | `curl http://localhost:4000/health` on the server, or `docker compose ps` | `{"ok":true,"data":{"status":"up"}}`, containers `Up (healthy)` |
| SIM connected | Portal → Messages → SMS status, or `GET /api/v1/sms/status` (admin) | `sim_connected: true`, `last_seen_at` < 90 s ago, `queuedCount` small |
| Jobs running | `GET /api/v1/jobs/status` (admin) | `monthly_fee_reminder`, `fee_followup`, `daily_pending_attendance`, `teacher_reminders` each show a recent `lastRunAt` |
| Disk | `df -h` / `docker system df` | Postgres volume + uploads have room; `docker system prune` occasionally |
| Backups | `ls -lt backups/ \| head` | A fresh `school-YYYYMMDD-HHMM.sql.gz` every day |

**Alerts worth setting up (manual for now):** if the SIM phone goes
offline, the portal shows "SIM offline" and creates a notification —
check the notification centre daily. If the 1st-of-month fee job ever
shows a stale `lastRunAt`, run it manually:

```bash
cd backend
npx tsx src/jobs/run-manual.ts monthly_fee_reminder --school=<school-slug> --at=2026-11-01T08:00:00Z
# Job names: monthly_fee_reminder | fee_followup | daily_pending_attendance | teacher_reminders
```

## 8. Common failures and fixes

| Symptom | Cause / fix |
|---|---|
| `docker compose up` fails: `POSTGRES_PASSWORD is not set` | `.env` missing or incomplete — `cp .env.example .env` and fill it in. |
| API container restarts in a loop | Read `docker compose logs api` — usually a bad `DATABASE_URL` or a missing/invalid `PHONE_ENC_KEY` (production refuses to boot without it). |
| API healthy but OCR upload → 503 | Tesseract missing from the image (shouldn't happen — the Dockerfile installs it). Rebuild: `docker compose up -d --build api`. |
| Web loads but login fails with "Failed to fetch" | `VITE_API_URL` baked at build time doesn't match reality. In compose it's `/api/v1` (proxied). If you built the frontend elsewhere, rebuild with the full API URL. |
| SMS not sending, portal says "SIM offline" | Phone off / app killed / no data. Open the app, check it shows connected; the WorkManager watchdog restarts the service every 15 min. Also check SMS credit on the SIM. |
| Messages stuck `queued` | No device online (SIM path) or no gateway configured (gateway path). Check `GET /api/v1/sms/status`. |
| Forgot `PHONE_ENC_KEY` | See §6 — there is no recovery. Re-enter parent numbers manually. |
| Disk full | Postgres volume or uploads volume grew. Check `docker system df`; prune old backups; `docker compose down -v` only if you are sure (deletes ALL data). |
| 429 on login after many failures | In-memory rate limiter (20 failed logins / 15 min). Wait, or restart the api container. |

## 9. Without Docker (alternative)

If you prefer plain processes: follow `docs/SETUP.md` Path B on the
server, run Postgres from the OS package, run the API under `pm2`
(`pm2 start dist/server.js --name school-api`) or a systemd unit, and
serve the frontend build with nginx (root = `frontend/dist`, SPA
fallback, `/api/` proxied to `localhost:4000`). Keep the same `.env`
variables, backups (`scripts/backup.sh` works with `DATABASE_URL`
when compose isn't running), and the same Caddy/HTTPS step above.
