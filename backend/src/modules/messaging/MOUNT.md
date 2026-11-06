# MOUNT — Messaging module (for the Lead / Integration phase)

This module is self-contained and compiles + tests standalone. It does NOT
edit `app.ts` — wire it up as follows.

## 1. Mount the router (in `backend/src/app.ts`)

```ts
import { createMessagingRouter, createPrismaMessagingStore } from './modules/messaging';
import { authenticate } from './middleware/auth';
import { requireAdmin } from './middleware/rbac';

const messagingStore = createPrismaMessagingStore(prisma);

app.use(
  '/api/v1',
  createMessagingRouter({
    store: messagingStore,
    requireAuth: authenticate,   // populates req.schoolId + req.user (AccessPayload)
    requireAdmin,                // middleware/rbac.ts
  }),
);
```

`createMessagingRouter` takes the auth handlers as dependencies so this
module never imports the Backend agent's middleware directly.

## 2. Required env vars

| Var | Purpose |
|---|---|
| `PHONE_ENC_KEY` | 32-byte base64 AES-256-GCM key for `*_phone_enc` (SCHEMA.md). Required. |
| `SMS_DEVICE_SECRET` | HMAC secret for school-scoped device API keys. Required for device auth. |
| `SMS_GATEWAY_URL` / `SMS_GATEWAY_KEY` / `SMS_GATEWAY_FROM` | Optional gateway fallback. Until set, the gateway provider is a stub that throws a clear error. |

## 3. Call the draft builder from the attendance submit flow

After the attendance module saves an `attendance_day` + records
(`POST /t/:token/submit`), call:

```ts
import { buildAbsentDrafts } from './modules/messaging';

const result = await buildAbsentDrafts(
  { store: messagingStore },
  {
    school: { id, name, timezone, smsProvider },
    classId, className, date, records, students,
  },
);
// result.created = held drafts (approved_at NULL); result.skipped = reasons
// (not_absent / opted_out / missing_phone / invalid_phone / already_queued).
// If result.daySkipped, it was a Sunday/holiday — nothing was drafted.
```

Students passed in must carry `parentPhoneEnc` (as stored) and
`parentOptOut`. Only `status === 'absent'` records produce drafts.

## 4. Scheduler (Fee/Scheduler agent) hooks

```ts
import { buildFeeReminderDrafts, buildTeacherReminderDraft } from './modules/messaging';
// Monthly 1st: buildFeeReminderDrafts({ store }, { school, month, items })
//   — pass ONLY unpaid fee records; paid records are never re-reminded.
// Daily: buildTeacherReminderDraft({ store }, { school, classId, className, date, teacherPhoneEnc })
//   — reminder to submit attendance; never a message about teacher absence.
```

## 5. Known overlaps / decisions for the Lead

- **Phone helpers are duplicated on purpose.** `modules/messaging/phone.ts`
  re-implements normalize/encrypt/decrypt/mask so this module compiles
  standalone. The Backend agent's `src/lib/crypto.ts` has the same
  functions (plus a current tsc error at `getFinalAuthTag` — should be
  `getAuthTag`). At integration, either implementation may be kept, but
  the wire format must stay `base64(iv || tag || ciphertext)`, AES-256-GCM.
- **Prisma adapter uses `prisma: any`.** `createPrismaMessagingStore`
  maps the SCHEMA.md field names (snake_case) to the module's camelCase
  rows. Verify it against the real generated client at integration time
  (especially `messageQueue.dedupe_key` unique handling — P2002).
- **Backend `package.json` / `tsconfig.json` already existed** (Backend
  agent) — this module added nothing to them; its deps (express, vitest,
  typescript) were already present.
- **Device auth** is HMAC-derived per school (no extra DB column):
  key = `HMAC-SHA256(SMS_DEVICE_SECRET, "device:<schoolId>")`.
  The admin gets it once from `POST /sms/devices/register`.
- **Rate limiting** is server-side: approval staggers `scheduled_for` by
  2 s per message, and the device endpoint only returns rows whose
  `scheduled_for <= now` (max 10 per poll).
