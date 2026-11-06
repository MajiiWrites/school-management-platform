# Prisma — schema, migrations, seed

Source of truth: `../../contracts/SCHEMA.md` (v1.0). This folder contains:

- `schema.prisma` — all 20 tables, relations, unique constraints, indexes.
- `migrations/20261106120000_init/migration.sql` — initial migration (generated with
  `prisma migrate diff`, then hand-edited — see below).
- `migrations/migration_lock.toml` — `provider = "postgresql"`.
- `seed.ts` — idempotent demo seed (run with `tsx`, see below).

## Environment

```bash
# backend/.env (or export in shell)
DATABASE_URL="postgresql://<user>:<pass>@<host>:5432/<db>"
PHONE_ENC_KEY="<32 random bytes, base64>"   # required in production; seed warns if unset
```

## Migrate + seed

```bash
cd backend
npx prisma migrate dev          # applies migrations, needs a live Postgres 16
DATABASE_URL="postgresql://..." npx tsx prisma/seed.ts
```

Seed is idempotent (upserts) — safe to re-run. **LOCAL DEV ONLY — never seed
on the live site; the live site must stay empty.** Demo login after seeding
(a local database only):
`demo@school.pk` / `Demo1234!` — school "Demo Public School" (Asia/Karachi),
classes 1-A, 5-A, 6-B, 25 students, fee structures 1500/2000/2500 PKR,
one submitted attendance day (5-A, 2026-11-05: 7 present, 2 absent),
EN+UR templates for absent / fee_reminder / teacher_reminder.

If you prefer `prisma db seed`, add to `backend/package.json`:
`"prisma": { "seed": "tsx prisma/seed.ts" }` (tsx is already a devDependency).

## Hand edits in the migration (do NOT lose them on regeneration)

`prisma migrate diff` output was edited by hand for three things Prisma cannot
express. If you regenerate the migration, re-apply all three:

1. **citext extension** — `CREATE EXTENSION IF NOT EXISTS "citext";` at the top
   (needed for `users.email CITEXT`; `migrate diff` does not emit it).
2. **`fee_records.status` is a GENERATED column** —
   `GENERATED ALWAYS AS (CASE WHEN "amountPaid" + "discount" >= "amountDue" THEN 'paid'
   WHEN "amountPaid" + "discount" > 0 THEN 'partial' ELSE 'unpaid' END) STORED`.
   The schema declares it as a plain field so Prisma Client can read it.
   **RULE: never pass `status` in a FeeRecord create/update** — Postgres rejects
   writes to a generated column. The Fee Agent must omit it; the seed already does.
3. **CHECK constraints** — Prisma 6.x has no `@@check` support, so all 14 contract
   CHECKs (roles, statuses, types, languages, actor types) are appended at the end
   of `migration.sql` as `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)`.

## Verification status (2026-11-06, this sandbox)

- `prisma validate` ✅ passes.
- `prisma generate` ✅ passes (Prisma Client 6.19.3).
- `migration.sql` ✅ parses cleanly under the real PostgreSQL parser
  (`pglast`/libpg_query): 92 statements, 20 tables, 1 extension, 14 CHECKs,
  generated `fee_records.status` confirmed. **No live Postgres was available in
  this sandbox (no server on localhost:5432, no Docker), so the migration has NOT
  been applied to a real database yet.** First `prisma migrate dev` against a real
  Postgres 16 is still required — it will also prove the generated-column insert
  path (seed omits `status`; if Prisma ever sent it, the seed fails loudly there).
- `seed.ts` ✅ typechecks (`tsc --noEmit`), bcrypt hash/verify ✅, phone
  normalize → E.164 → AES-256-GCM encrypt/decrypt round-trip ✅ for
  `03XX`, `+92`, `92`, spaces/dashes. Seed run itself stops at the first query
  with P1001 (no DB) — expected here.

## Sandbox quirk: Prisma engine downloads abort

In this sandbox the egress proxy resets long downloads, so `npm install`'s
`@prisma/engines` postinstall fails (`ECONNRESET`) and the CLI then tries to
re-download engines on every run. Workaround used here (repeat on a fresh
`npm install` until the proxy is fixed):

```bash
# 1. Install packages without scripts, then fetch the two engine binaries manually.
npm install --save-dev --ignore-scripts prisma@6.19.3
cd node_modules/@prisma/engines
BASE="https://binaries.prisma.sh/all_commits/c2990dca591cba766e3b7ef5d9e8a84796e47ab7/debian-openssl-3.0.x"
curl -sL --retry 8 -C - -o schema-engine.gz "$BASE/schema-engine.gz"
curl -sL --retry 8 -C - -o libquery_engine.so.node.gz "$BASE/libquery_engine.so.node.gz"
gunzip -f schema-engine.gz libquery_engine.so.node.gz
chmod +x schema-engine
# 2. The CLI looks for the PLATFORM-SUFFIXED names — copy them:
cp schema-engine schema-engine-debian-openssl-3.0.x
cp libquery_engine.so.node libquery_engine-debian-openssl-3.0.x.so.node
# 3. `prisma generate` also wants the query engine in the CLI package dir:
cp libquery_engine.so.node ../../prisma/libquery_engine-debian-openssl-3.0.x.so.node
# 4. Verify:
npx prisma --version   # must print 6.19.3 + engine paths, no download attempt
```

(Engine commit `c2990dca...` = Prisma 6.19.3. For other Prisma versions, use that
version's engines commit — see `@prisma/engines-version` in node_modules.)

## Phone crypto layout (must match `src/lib/crypto.ts`)

Seed encrypts with AES-256-GCM, key = `PHONE_ENC_KEY` (32 bytes, base64).
Stored value: `base64(iv[12] || tag[16] || ciphertext)`.
Hash: `SHA-256 hex` of the E.164-normalized number (`+92` + 10 digits).
`src/lib/crypto.ts` (Backend Agent) MUST use this exact layout, or seeded phone
numbers will not decrypt. Never log or return full numbers — mask as
`+92 3XX XXXX123` (API contract).
