# Backend Hardening — 6A (2026-11-06)

Approval queue, recycle bin, change history, roles & permissions, TOTP 2FA,
login alerts, data export / account-deletion requests / backups log.
Schema/migrations untouched; all tables already existed (v2 schema).

## Endpoints added (base `/api/v1`, envelope `{ok, data}`, school from JWT)

| Endpoint | Role | Notes |
|---|---|---|
| `POST /approvals` | any authed | Create a request directly (clerk flow; admin rarely) → 201 |
| `GET /approvals?status=` | admin all; clerk own only | Paginated |
| `GET /approvals/:id` | owner/admin | |
| `POST /approvals/:id/approve` | admin | Applies payload via the existing service fn → 200 `{..., applied}` |
| `POST /approvals/:id/reject` | admin | `{reason?}` |
| `GET /recycle-bin?entity=` | admin | 30-day window, `restore_by` per row |
| `POST /recycle-bin/:id/restore` | admin | Within 30 days; clears `deleted_at`, removes bin row |
| `POST /recycle-bin/:id/permanent-delete` | admin | **Second confirmation**: body `{confirm: true}` else 400; removes row + snapshot |
| `GET /change-history?entity=&entity_id=` | any authed | Also aliased as `GET /change-logs` (contract name). Per-field old/new, snake_case |
| `GET /roles/permissions` | any authed | School matrix (stored rows, else seeded defaults) |
| `PATCH /roles/permissions` | admin | `{role, resource, action, allowed}`; admin rows cannot be revoked |
| `GET /roles/me` | any authed | Caller's effective permissions |
| `POST /users/principals` | admin | Create principal login (view-only) |
| `POST /auth/2fa/setup` | admin | Returns `{otpauth_url, secret}` ONCE; secret held in-memory 10 min, NOT stored yet |
| `POST /auth/2fa/verify` | admin | `{code}` (+optional `secret` fallback) → enables TOTP, stores secret AES-256-GCM encrypted |
| `POST /auth/2fa/disable` | admin | `{password}` → clears secret + flag |
| `POST /auth/2fa/login` | public | `{temp_token, code}` → access + refresh JWTs |
| `POST /export/all` (+ `GET /export/all`) | admin | `{password}` required; full school data JSON, phones FULLY decrypted (own data), audit-logged |
| `POST /account/delete-request` | admin | `{password}` → `account_deletion_requests` row, status pending |
| `GET /account/delete-requests` | admin | List |
| `PATCH /account/delete-requests/:id` | admin | `{status}` pending/approved/completed/rejected |
| `GET /backups` | admin | Lists `school_backups` rows (log only) |

## Approval queue — what is wired

Clerk calls return **202** `{approval_request_id, status: "pending"}` and apply
nothing; admin calls apply directly. Approve applies the payload through the
existing service function; every request/decision writes an audit log + a
school notification to admins.

| Caller route | Queue entity / action |
|---|---|
| `POST /classes/:id/students`, `PATCH /students/:id`, `DELETE /students/:id`, `PATCH /students/:id/parent`, `POST /classes/:id/students/import-csv` (bulk) | student create/update/delete/bulk |
| `POST /classes`, `PATCH /classes/:id`, `DELETE /classes/:id` | class create/update/delete |
| `POST /fees/:student_id/pay` | fee_record update (pay) |
| `POST /fees/structures`, `PATCH /fees/structures/:id` | fee_structure create/update |
| `POST /holidays`, `DELETE /holidays/:id` | holiday create/delete |
| `PATCH /messages/templates/:id` | message_template update |
| `POST /users/clerks`, `DELETE /users/:id` | user create/delete |

Payload shapes are documented in `src/modules/hardening/approvals.ts`
(`applyApproval`). Approving a class delete still enforces "no students";
approving a student delete soft-deletes (see below).

## Recycle bin

Soft-deleted entities: students, classes, fee_records, exams, results,
result_sheets. `DELETE` sets `deleted_at` + writes a `deleted_records` row
with the full-row snapshot and `restore_by = deleted_at + 30 days`.
**All list queries** over those tables now add `deleted_at IS NULL`
(students/classes/fees/admin-dashboard services). Behaviour change: deleting
a student no longer 409s on attendance/fee history — soft delete *preserves*
that history, so the block is gone. Class delete still 409s while students
exist. Permanent delete removes the target row AND its bin row.

## Change history

`writeChangeLogs` (`helpers.ts`) writes one `change_logs` row per changed
field (field, old_value, new_value, actor, timestamp). Wired into:
student update / parent update, class update, fee pay, fee-structure update,
settings update (per key), message-template update. Phones are stored masked
in change history (never ciphertext/hash). `audit_logs` stays the per-action
log. **Implementation note:** before-values are snapshotted *before* the
update call — some DB layers mutate the fetched row in place.

## Roles & permissions — enforcement points

- `requirePermission(resource, action)` (`src/middleware/permissions.ts`):
  reads the school's `role_permissions` rows (seeded defaults apply when no
  rows exist); admin bypasses; principal non-view → 403. Applied to
  admin-only mutating routes (settings, fee-structure delete, rollover,
  attendance-link regenerate/revoke, principal creation, roles PATCH).
- `requireQueueable(resource, action)`: the variant for queue-gated routes.
  The seeded matrix governs **direct application**; a clerk has no direct
  `students.delete` / `classes.*` / `users.*` cells, but may *submit* those
  actions to the queue — submission applies nothing until an admin approves.
  Queueable set is in `middleware/permissions.ts` (`QUEUEABLE`). Principals
  are 403 on every queueable route (also blocked by `requireAdminOrClerk`).
- Principal: `POST /users/principals` (admin); login works like a clerk's;
  every mutation 403s; `GET /roles/me` reports 12 view permissions.

## 2FA & login security

- TOTP via **otplib v13** (added to `package.json`, no native deps):
  `generateSecret` / `generateURI` / `verifySync` with ±1-step tolerance.
  Secret encrypted with the same AES-256-GCM pattern as phones
  (`users.totp_secret_enc`); never returned after setup.
- Login: `totp_enabled` + no valid `totp_code` → `{needs_2fa: true,
  temp_token}` (5-min JWT, type `2fa-temp`); `POST /auth/2fa/login`
  exchanges it for access/refresh JWTs. `POST /auth/login` also accepts an
  inline `totp_code`.
- Login alerts: on every login, if `last_login_ip` is set and differs from
  the request IP, a `login_alert` notification `"New login from <ip>"` is
  created and `last_login_ip` updated (alert failure never breaks login).
- Session timeout: access JWT 15 min / refresh JWT 7 days (unchanged,
  `config.ts` + `lib/tokens.ts`; refresh tokens older than 7 days are
  rejected by JWT expiry). **No server-side session store was built** (per
  task); there is no `last_activity` column, so no per-refresh activity
  timestamp exists — refresh re-issues tokens only.

## Data ownership

- Export is JSON (not ZIP — keeps the endpoint dependency-free), 41 tables
  incl. `attendance_records` / `message_deliveries` (scoped via parents),
  users scrubbed of `passwordHash` / token hashes / `totpSecretEnc`, phones
  decrypted. Requires the admin password; logged as `data.export`.
- Account deletion: request only. `POST /account/delete-request` creates a
  `pending` row; **actual deletion is a separate manual step** — deciding a
  request `approved`/`completed` changes only the row status and deletes
  nothing. A human (or a future Phase 7/8 job) must perform and verify the
  deletion, then mark it `completed`.
- Backups: `GET /backups` reads `school_backups` only; the backup job itself
  is Phase 6D/DevOps (no job exists yet, so the list is normally empty).

## Also touched (v1 services, same PR)

- `lib/db.ts`: v2 delegates added to the `Db` interface (no schema change).
- `lib/tokens.ts`: role union + `'principal'`; `signTemp2faToken` /
  `verifyTemp2faToken` (5 min). `middleware/rbac.ts`: `Role` += principal.
- Students: extended profile fields accepted on create/update
  (`father_name`, `admission_no`, `date_of_birth`, `gender`, `address`,
  `admission_date`, `parent2_*`); `status` += `struck_off`;
  `GET /students/:id` added.
- Fees: structures accept `admission_fee`, `sibling_discount_pct`; pay
  accepts `arrears`, `scholarship_discount` (folded into `amount_due` at
  record creation, per contract — they do not feed the GENERATED status).
  Fee GET routes now allow any authed role (principal view-only).
- Fake DBs in existing tests: `field: null` now matches unset fields
  (Prisma IS NULL semantics), and the cross-tenant fake gained the v2
  collections — required because services now filter on `deletedAt`.

## Verification

- `npx tsc --noEmit` — 0 errors.
- `npx vitest run` — **10 files, 151 tests, all pass** (was 125; +26 new:
  25 hardening + 1 queueable test). New tests in
  `src/modules/hardening/__tests__/hardening.test.ts` (fake in-memory DB):
  clerk add → queue → admin approve applies; clerk delete queued not
  applied; soft delete + restore + permanent delete with/without second
  confirm; change history old/new; principal mutations 403; 2FA
  setup/verify/login; export requires password; approval reject/409/scope;
  roles PATCH; login alerts; account-deletion request stays manual.
- Live-DB smoke (fresh scratch DB `school_6a_smoke`, migrate deploy + seed,
  real server on :4123, then DB dropped): full HTTP flow verified — clerk
  create 202 → approve → listed; clerk delete 202 → approve → recycle bin
  → permanent delete 400 without confirm / 200 with; restore; change
  history; principal 403 mutation / 200 view; roles 105 rows + PATCH;
  export 400/401/200 with decrypted phone; delete-request pending; 2FA
  setup → verify → `needs_2fa` → 2fa login; clerk fee-pay and template
  update queued + approved. Two bugs found by the smoke and fixed:
  clerk delete/update 403 (matrix has no direct cell — solved with
  `requireQueueable`) and export 500 (schools table keyed by `id`, not
  `schoolId`).

## What is still manual / unfinished

- Account deletion execution (see above) — request + status workflow only.
- Backup job (Phase 6D/DevOps) — `GET /backups` only reads the log.
- Results module (`results`/`exams`/`result_sheets` soft delete + change
  history) — those endpoints belong to Phase 6B; the recycle-bin helpers
  already support the entities, they just have no routes yet.
- No server-side session store / `last_activity` (deliberately not built).
- The 2FA pending-secret map is process-local (single instance); a
  multi-instance deploy would need it in Redis/DB. `verify` also accepts the
  secret back from the client as a fallback.
