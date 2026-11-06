# Messaging module

Parent SMS alerts for the School Management Platform — absent-message
approval flow, SMS queue/outbox, templates, and the Android SIM-SMS
companion device API.

## Rules enforced (API.md)

1. Messages go ONLY to parents of ABSENT students, ONLY after admin
   approval, NEVER twice for the same (student, day) — `dedupe_key`
   (`absent:{student_id}:{date}`) is checked in the service and enforced
   by the DB unique constraint as backstop.
2. Teacher absence NEVER creates messages (no code path reads
   `teacher_attendance` for messaging).
3. No messages on Sundays or holidays (checked at draft creation and
   again at approval).
4. Full phone numbers are never logged or returned to humans — masked as
   `+92 3XX XXXX567`. The Android device is the only caller that receives
   a full number, because it is the sender.
5. Every mutation writes an `audit_logs` row.

## Draft lifecycle

```
attendance submit
  -> buildAbsentDrafts()            status='queued', approved_at=NULL (HELD)
  -> admin reviews /messages/pending-approval (grouped by class/day)
  -> admin edits a body (PATCH /messages/queue/:id) — optional
  -> admin approves (POST /messages/approve)
       sets approved_by/at; scheduled_for staggered 2 s apart (SIM rate limit)
  -> Android device polls GET /sms/devices/:device_id/queue (max 10, due only)
  -> device sends via SmsManager, reports POST .../delivery (sent|failed)
  -> failed rows can be retried (POST /messages/queue/:id/retry)
```

## Endpoints (all under `/api/v1`, mounted by app.ts — see MOUNT.md)

| Method & path | Role | Purpose |
|---|---|---|
| GET /messages/pending-approval | admin/clerk | Draft groups per class/day, masked numbers, editable bodies |
| POST /messages/approve `{dedupe_keys[] \| group_id}` | admin | Approve + enqueue (staggered) |
| PATCH /messages/queue/:id `{body}` | admin | Edit a held/queued body |
| GET /messages/log `?status&type&date&page&limit` | admin/clerk | Every send with status |
| POST /messages/queue/:id/retry | admin | Failed -> queued again |
| GET /messages/templates | admin/clerk | EN+UR templates |
| PATCH /messages/templates/:id `{body}` | admin | Edit a template (Unicode supported) |
| GET /sms/status | admin/clerk | `{provider, sim_connected, last_seen_at, queued_count}` |
| POST /sms/devices/register `{device_id, name}` | admin | Register phone, returns device API key (shown once) |
| GET /sms/devices/:device_id/queue | device key | Next batch (max 10, approved + due) |
| POST /sms/devices/:device_id/delivery | device key | Report sent/failed |

Device auth: header `X-Device-Key: <key>`, where key =
`HMAC-SHA256(SMS_DEVICE_SECRET, "device:<schoolId>")`.

## Providers

- `sim` (primary): the Android app sends from the admin's SIM. Server-side
  there is nothing to send — the queue is the handoff.
- `gateway` (fallback): Twilio-compatible HTTP stub in `providers.ts`.
  Throws a clear error until `SMS_GATEWAY_URL` + `SMS_GATEWAY_KEY` are set.

## Files

| File | What it is |
|---|---|
| `phone.ts` | PK E.164 normalize/validate, SHA-256 hash, mask, AES-256-GCM encrypt/decrypt, device-key derivation |
| `templates.ts` | EN+UR defaults for absent / fee_reminder / teacher_reminder + `{var}` rendering |
| `store.ts` | `MessagingStore` interface + `createPrismaMessagingStore(prisma)` adapter |
| `service.ts` | Draft builders, approval flow, device queue, delivery reporting, SMS status |
| `providers.ts` | `sim` + `gateway` (stub) provider abstraction |
| `routes.ts` | `createMessagingRouter(deps)` — all endpoints above |
| `index.ts` | Public exports |
| `__tests__/service.test.ts` | 16 unit tests (fake in-memory store) |

## Env vars

`PHONE_ENC_KEY` (required), `SMS_DEVICE_SECRET` (required for device auth),
`SMS_GATEWAY_URL` / `SMS_GATEWAY_KEY` / `SMS_GATEWAY_FROM` (optional).

## Test

```bash
cd backend
npm test -- src/modules/messaging/__tests__/service.test.ts
npx tsc --noEmit   # module must show zero errors under src/modules/messaging/
```
