# Vercel Deploy Runbook — School Management Platform (frontend)

Prepared 2026-11-06 by the VERCEL PREP agent. **Do NOT deploy until the Render
backend URL exists** — `VITE_API_URL` is baked at build time and must be the
real Render URL + `/api/v1`.

## 1. Pre-flight status (verified 2026-11-06 ~21:00 PKT)

| Check | Result |
|---|---|
| Vercel connector auth | `auth_status: connected`, `authenticated: true` — user `majiicodes@gmail.com` / `majiicodes-1537`, Hobby plan, `defaultTeamId: team_wryr3Nkqn3HADzI8a6BuW1F1` |
| Team `majiicrafts` | Exists — slug confirmed in the 403 error scope (`"scope":"majiicrafts"`, team id `team_wryr3Nkqn3HADzI8a6BuW1F1`). **Caveat:** MCP calls that pass `teamId` explicitly return **403 forbidden** ("Not authorized… re-authenticate to this scope"). Calls with **no** `teamId`/`slug` work and return team-scoped data (default scope is already the team). **Rule for every command below: omit `teamId` and `slug`.** There is no `authorize_team_access` tool in the available tool list, so do not try to "fix" the 403 — just omit the scope params. |
| Name collision | **None.** `list_projects` (no teamId) returned all 18 team projects; no project named `school-management-platform`. Existing: siones-barbershop-demo, hair-by-kc-demo, easy-bliss-demo, meow-cafe-demo, holistic-hair-demo, sabeauti-demo, aphrodite-demo, family-hair-demo, msv-demo, sava-demo, bblendz-demo, rawaiee-demo, plansathi, linkcard-studio, linkcard-studio-v2, pdf-ai-assistant-vehv, pdf-ai-assistant, pdf-ai-assistant-94np. |
| Local production build | **PASS.** `VITE_API_URL=https://placeholder.onrender.com/api/v1 npm run build` in `frontend/` exited 0 (`tsc -b && vite build`, 43 modules, ~0.6 s). `dist/` = **548 KB, 12 files**: `index.html` 0.71 kB, `assets/index-Cd_5-2HO.css` 25.87 kB (gzip 5.77 kB), `assets/index-CMKoeLAL.js` 363.24 kB (gzip 104.92 kB). **Placeholder build only — never deploy this dist.** |
| Localhost check on `dist/` | **Clean of API URLs.** The only 2 occurrences of `localhost` in the bundle are React DOM internals (`new URL('http://localhost')` as a dummy base for URL parsing) — not API calls. No `localhost:3000`, no `127.0.0.1`. The placeholder URL `https://placeholder.onrender.com/api/v1` is baked into the JS bundle as expected. |
| Env behaviour in code | `src/lib/api.ts`: `API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1'`; `MOCK_MODE = import.meta.env.VITE_MOCK_API === 'true'`. No `.env` files exist in `frontend/`. **Set only `VITE_API_URL` (Production). Do NOT set `VITE_MOCK_API`.** |
| Git state | Repo `~/workspace/school-management-platform` is on branch `main` with **no commits yet and no remote**. Git-connected deploy is therefore impossible until the code is pushed to GitHub — use the file-upload path below (primary). |

## 2. Prerequisites (before running the commands)

1. The Render backend is live. Let `RENDER_URL` = its public URL, e.g.
   `https://school-api-xxxx.onrender.com` (no trailing slash).
2. `VITE_API_URL` value will be `${RENDER_URL}/api/v1`.

## 3. Exact command sequence (run verbatim, in order)

All commands use the Vercel MCP wrapper: `/opt/hatch/bin/vercel call-tool
--name <tool> --arguments-json '<JSON>'`. Omit `teamId`/`slug` everywhere.

### Step 1 — Create the project

```bash
/opt/hatch/bin/vercel call-tool --name create_project --arguments-json '{
  "requestBody": {
    "name": "school-management-platform",
    "framework": "vite",
    "buildCommand": "npm run build",
    "installCommand": "npm ci",
    "outputDirectory": "dist",
    "ssoProtection": null
  }
}'
```

Record the returned project `id` as `PROJECT_ID`. (`ssoProtection: null`
keeps Vercel Authentication off so the production site is public. Framework
`vite` is a valid enum value; build/output/install match the local build that
already passed.)

### Step 2 — Set the Production env var (before any deployment)

```bash
/opt/hatch/bin/vercel call-tool --name create_project_env --arguments-json '{
  "idOrName": "school-management-platform",
  "requestBody": {
    "key": "VITE_API_URL",
    "value": "https://<RENDER_URL>/api/v1",
    "type": "plain",
    "target": ["production"]
  }
}'
```

Replace `<RENDER_URL>` with the real Render host (e.g.
`https://school-api-xxxx.onrender.com`). Do NOT add `VITE_MOCK_API`.

Verify it landed (read-back; value is a secret read, approval may be asked):

```bash
/opt/hatch/bin/vercel call-tool --name filter_project_envs --arguments-json '{
  "idOrName": "school-management-platform"
}'
```

Confirm one entry: key `VITE_API_URL`, target `production`, value ending
`/api/v1` — and no `VITE_MOCK_API` entry.

### Step 3 — Upload the frontend source files

The deploy is a **file upload** (no git remote exists). Upload every file
under `frontend/` **except** `node_modules/`, `dist/`, `Dockerfile`,
`nginx.conf`, `.dockerignore` (~40 files, ~508 KB total). For each file,
compute SHA1 + size and call `upload_file` with base64 content:

```bash
cd ~/workspace/school-management-platform/frontend
python3 - <<'EOF'
import base64, hashlib, json, os, subprocess
files = []
for root, dirs, fs in os.walk('.'):
    dirs[:] = [d for d in dirs if d not in ('node_modules', 'dist')]
    for f in fs:
        p = os.path.join(root, f)
        rel = os.path.relpath(p, '.')
        if rel in ('Dockerfile', 'nginx.conf', '.dockerignore'):
            continue
        data = open(p, 'rb').read()
        sha1 = hashlib.sha1(data).hexdigest()
        args = {"contentLength": len(data), "xVercelDigest": sha1,
                "requestBody": base64.b64encode(data).decode()}
        r = subprocess.run(['/opt/hatch/bin/vercel', 'call-tool',
                            '--name', 'upload_file',
                            '--arguments-json', json.dumps(args)],
                           capture_output=True, text=True)
        if r.returncode != 0 or '"ok":false' in r.stdout:
            print('FAILED', rel, r.stdout[:300], r.stderr[:300]); raise SystemExit(1)
        files.append({"file": rel, "sha": sha1, "size": len(data)})
        print('ok', rel, len(data))
json.dump(files, open('/tmp/smp_vercel_files.json', 'w'))
print('uploaded', len(files), 'files')
EOF
```

### Step 4 — Create the production deployment

```bash
python3 - <<'EOF'
import json, subprocess
files = json.load(open('/tmp/smp_vercel_files.json'))
body = {
  "name": "school-management-platform",
  "project": "<PROJECT_ID>",
  "target": "production",
  "files": files,
  "projectSettings": {
    "framework": "vite",
    "buildCommand": "npm run build",
    "installCommand": "npm ci",
    "outputDirectory": "dist"
  }
}
r = subprocess.run(['/opt/hatch/bin/vercel', 'call-tool',
                    '--name', 'create_deployment',
                    '--arguments-json', json.dumps({"requestBody": body})],
                   capture_output=True, text=True)
print(r.stdout)
print(r.stderr, file=__import__('sys').stderr)
EOF
```

Record the returned deployment `id` as `DEPLOYMENT_ID` and its `url`.

### Step 5 — Wait for READY, check build logs on failure

```bash
/opt/hatch/bin/vercel call-tool --name get_deployment --arguments-json '{
  "idOrUrl": "<DEPLOYMENT_ID>"
}'
```

Repeat until `state` is `READY` (build takes ~1–2 min). If it fails:

```bash
/opt/hatch/bin/vercel call-tool --name list_deployment_events --arguments-json '{
  "idOrUrl": "<DEPLOYMENT_ID>", "builds": 1, "limit": 100
}'
```

### Step 6 — SSO-off / public-access check

```bash
/opt/hatch/bin/vercel call-tool --name get_project --arguments-json '{
  "idOrName": "school-management-platform"
}'
```

Confirm `ssoProtection` is `null`/absent (public). If protection is on,
turn it off:

```bash
/opt/hatch/bin/vercel call-tool --name update_project --arguments-json '{
  "idOrName": "school-management-platform",
  "requestBody": { "ssoProtection": null }
}'
```

### Step 7 — Fresh-fetch verification (public, no auth bypass)

Fetch the production URL from a fresh, unauthenticated context and confirm
the app shell loads (do NOT use `web_fetch_vercel_url` for this check — it
creates a share link that bypasses protection and would hide an auth wall):

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<DEPLOYMENT_URL>/
```

Then fetch the page text (e.g. `browser.open` on the URL) and confirm:
HTTP 200, the `<title>School Manager — Attendance, SMS & Fees</title>` /
app shell present, **no Vercel Authentication login wall**. Finally confirm
the served JS bundle contains the real Render URL
(`https://<RENDER_URL>/api/v1`) and **no** `placeholder.onrender.com` and
no `localhost:3000`:

```bash
curl -s https://<DEPLOYMENT_URL>/ | grep -o '<title>[^<]*</title>'
curl -s https://<DEPLOYMENT_URL>/assets/<JS_FILE_FROM_BUILD_LOG> | grep -o 'https://[^"]*onrender\.com/api/v1' | head -1
```

## 4. Alternative path (only if the repo is pushed to GitHub first)

If `school-management-platform` is committed and pushed to GitHub
(`git remote` set, default branch `main`), replace Steps 3–4 with a
git-connected project: `create_git_project` (or create the project with
`gitRepository` in `requestBody`), then `create_deployment` with
`requestBody.gitSource: {"type": "github", "repoId": "<vercel repo id>",
"ref": "main"}` and `target: "production"`. The env-var step (Step 2) and
verification steps (5–7) are unchanged. This path is preferable long-term
(auto-deploys on push); the file-upload path above is the one that works
today with zero git setup.

## 5. Do-nots

- Do NOT deploy with the placeholder URL or with `VITE_API_URL` unset (the
  app would fall back to `http://localhost:3000/api/v1` and login would fail
  with "Failed to fetch").
- Do NOT set `VITE_MOCK_API` (mock mode would serve fake data and disable
  real login/downloads).
- Do NOT pass `teamId`/`slug` to any MCP call (403 on this connection).
- Do NOT spend money: Hobby plan, no domain purchase in this sequence.
