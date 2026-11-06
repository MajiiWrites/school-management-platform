# Custom Messages — Section 11 (2026-11-06, agent S11)

Editable Custom Messages: template CRUD (nothing locked), write-your-own
composer, 8-variable rendering, recipient picker + quick filters, live
preview with SMS-part counting, approval-before-send, drafts + scheduling,
and history with delivery status. Backend + frontend, on the existing
`message_templates` / `message_drafts` / `message_queue` schema (no new
tables; one CHECK-only migration, below).

## Endpoints (base `/api/v1`, envelope `{ok, data}`, school from JWT)

| Endpoint | Role | Notes |
|---|---|---|
| `GET /messages/templates` | any authed | All templates incl. custom; `name` + `is_custom` included |
| `POST /messages/templates` | admin | `{name, type, language, body}`; `is_custom=true` |
| `PATCH /messages/templates/:id` | admin direct; clerk → approval queue (202) | `{name?, body?, type?, language?}`; full patch goes into the queue payload so approval applies renames too |
| `POST /messages/templates/:id/duplicate` | admin | Copy is always type `custom`, name `Copy of …` |
| `DELETE /messages/templates/:id` | admin | Hard delete + `deleted_records` snapshot (recycle-bin record); nothing locked, incl. seeded defaults |
| `POST /messages/preview` | any authed | `{body? \| template_id?, recipient_type, target_class_id?, target_student_ids?, filter?, date?, month?}` → samples + counts (read-only) |
| `GET /messages/recipients` | any authed | `?filter=absent\|fee_unpaid&class_id=&date=&month=&recipient_type=&target_student_ids=`; opted-out shown, flagged |
| `GET /messages/drafts?status=` | any authed | Paginated |
| `POST /messages/drafts` | admin/clerk | `{recipient_type, target_class_id?, target_student_ids?, body, scheduled_for?}` |
| `GET /messages/drafts/:id` | any authed | Draft + latest approval request + rendered preview |
| `PATCH /messages/drafts/:id` | admin or creator | Draft/scheduled only; validates merged targeting |
| `DELETE /messages/drafts/:id` | admin or creator | Draft status only; snapshot into `deleted_records` |
| `POST /messages/drafts/:id/cancel` | admin or creator | → `cancelled` |
| `POST /messages/drafts/:id/submit-for-approval` | admin or creator | Creates an `approval_requests` row (`message_draft` / `create`); 202 `{approval_request_id, status: "pending"}`. Clerk-created drafts reach the admin Approval Queue this way |
| `POST /messages/drafts/:id/approve-send` | admin | Direct approval: records an APPROVED `approval_requests` row, then sends now or schedules (see below) |
| `POST /messages/drafts/:id/reject` | admin | Cancels the draft + rejects any pending approval request for it |
| `GET /messages/log?status=&type=&date=&class_id=` | any authed | Snake_case items with `student_name`, `parent_phone_masked`, latest `delivery` (`message_deliveries`) |
| `GET /messages/pending-approval` | any authed | Now returns the contract shape `{groups: [{group_id, class, class_id, date, absent_count, messages: [{id, student, parent_phone_masked, body, dedupe_key}]}]}` (was raw camelCase rows — the frontend expected the contract shape) |

## Render set (all 8 variables)

`{student_name}` `{father_name}` `{class}` `{section}` `{date}` `{amount}`
`{month}` `{school_name}`. The v1 renderer (`templates.renderTemplate`)
was already generic; the extension is the `TemplateVars` type + callers
passing all eight. `{class}` = class name (e.g. `5`), `{section}` = section
(e.g. `A`); `{date}` = school-local date; `{month}` = `YYYY-MM`; `{amount}`
= the student's remaining fee balance for the render month (undefined
leaves it literal). Unknown or valueless variables render literally —
never crash a send. `variablesUsed(body)` derives "variables used" by
scanning the body (no column, per SCHEMA.md §11). The v1 absent/fee
builders now also pass `father_name`/`section` when the caller supplies
them (attendance submit does).

## Approval flow (nothing sends without admin approval)

```
composer → draft (status 'draft')
   ├─ clerk/admin: POST submit-for-approval → approval_requests (pending)
   │     └─ admin: POST /approvals/:id/approve → applyApproval branch
   │        'message_draft'/'create' → applyApprovedDraft()
   └─ admin: POST approve-send → recordDraftApproval() (APPROVED row)
        └─ applyApprovedDraft()
             ├─ scheduled_for in future → status 'scheduled' (no queue rows)
             └─ otherwise → sendDraft(): resolve recipients → skip opted-out /
                missing / invalid → render per recipient → message_queue rows
                (type 'custom', dedupe `custom:{draftId}:{studentId}`,
                approved_by/at set, scheduled_for staggered 2 s) → status 'sent'
```

`sendDraft` is the ONLY path into `message_queue` for drafts — there is
no second sending path; the companion app / gateway picks approved rows up
exactly like v1. Re-send of a `sent` draft is refused (409); a second
approval of the same draft is a no-op via the dedupe key.

## Scheduling job

`scheduled_messages` (`backend/src/jobs/scheduled-messages.ts`, registered
in `jobs/registry.ts`, `*/5 * * * *` UTC): per school, picks up due
`scheduled` drafts and sends them — but ONLY when an approved
`approval_requests` row exists for the draft
(`store.hasApprovedDraftApproval`). A scheduled draft without approval
stays `scheduled` and is reported as `skipped_unapproved`, never sent.
Core: `processDueScheduledDrafts()` in `custom-messages.ts`. Idempotent:
sent drafts leave the `scheduled` set, and the queue dedupe key is the
backstop.

## SMS-part counting rule

`templates.smsPartCount(body)` (mirrored in `frontend/src/lib/sms.ts`
for the live composer counter):
- GSM 03.38 7-bit alphabet → 160 chars in one SMS, 153 per part when
  concatenated. Extension-table chars (`^{}\[~]|€`) cost 2 septets each.
- Anything outside GSM-7 (Urdu/Arabic script, emoji, en dash, …) forces
  UCS-2 → 70 chars in one SMS, 67 per part (length in UTF-16 code units,
  so an astral emoji counts 2).
- Preview returns the worst-case counts over the rendered samples (longest
  body); each sample also carries its own counts.

## Recipient picker

`GET /messages/recipients` resolves over existing data (school-scoped,
active, not soft-deleted students):
- `all_parents` / `class` / `selected_students` / `single_parent`
- Quick filters: `filter=absent` (today's absent list, `date` param) and
  `filter=fee_unpaid` (unpaid `fee_records` for `month`), optionally
  limited to one class. `{amount}` is enriched from the remaining fee
  balance for the render month.
- Opted-out parents (`parent_opt_out`) are auto-excluded at queue-build
  time; preview/send responses state the skipped count and per-student
  reasons (`opted_out` / `missing_phone` / `invalid_phone` /
  `already_queued`).

## Schema notes

- Migration `20261106232000_v2_queue_custom_type` extends ONLY the
  `message_queue.type` CHECK to
  `('absent','fee_reminder','teacher_reminder','result','announcement','custom')`.
  The v2_messages migration extended `message_templates.type` but left the
  queue at the v1 three — custom drafts need `type='custom'` in the queue.
  Additive, CHECK-only; re-apply the block if the schema is regenerated
  (same pattern as v1/v2 CHECKs; strip any `fee_records.status` drift).
- `message_templates` keeps its UNIQUE `(school_id, type, language)`: at
  most one template per type+language. Creating a second `custom`/`en`
  (or duplicating when one exists) returns 409 CONFLICT — the admin edits
  the existing one instead. Duplicates are always type `custom`.
- Template deletes are hard deletes + a `deleted_records` snapshot
  (recycle-bin record). `message_templates` has no `deleted_at` column,
  so the 6A recycle-bin restore (soft-delete entities only) does not
  restore templates — re-creation from the snapshot is a manual step.
- Change history: every template/draft create/edit/delete writes
  `change_logs` (per-field old/new) + an `audit_logs` row.

## Frontend

`frontend/src/pages/Messages.tsx` gains a **Custom messages** tab
(`frontend/src/components/CustomMessages.tsx`: composer with variable
chips that insert at the cursor, quick filters, live preview with
samples + skipped list, drafts list with submit/approve/reject/cancel/
delete, approve dialog shows the recipient list + final rendered message
first) and a full template manager
(`frontend/src/components/TemplateManager.tsx`: create / rename / edit /
duplicate / delete, ConfirmDialog on delete). The delivery-log tab now
filters by type (incl. `result`/`announcement`/`custom`) and class, and
shows the latest delivery attempt per row. All new forms carry
`autoComplete="off"`; empty states on drafts/templates. New types in
`frontend/src/lib/types.ts` (Section 11 block) mirror the real backend
wire shapes.

## Files

- `backend/src/modules/messaging/custom-messages.ts` — preview / send /
  approve / scheduled-pickup service (school-scoped, phone crypto unchanged)
- `backend/src/modules/messaging/templates.ts` — 6 template types, 8-var
  `TemplateVars`, `variablesUsed`, `smsPartCount`
- `backend/src/modules/messaging/store.ts` — template create/delete,
  drafts, recipients, deliveries, draft approvals; `listQueue` + `classId`
- `backend/src/modules/messaging/routes.ts` — Section 11 block; PATCH
  template accepts name/type/language; log serializes to the contract
  shape with student names + masked phones + delivery detail
- `backend/src/modules/hardening/approvals.ts` — `applyApproval` branch
  for `message_draft`/`create` (marked Section 11 block)
- `backend/src/jobs/scheduled-messages.ts` + `jobs/registry.ts` —
  `scheduled_messages` job
- `backend/prisma/migrations/20261106232000_v2_queue_custom_type/migration.sql`
- `backend/src/modules/messaging/__tests__/custom-messages.test.ts` — 35 tests
- `frontend/src/components/CustomMessages.tsx`,
  `frontend/src/components/TemplateManager.tsx`,
  `frontend/src/lib/sms.ts`, `frontend/src/lib/types.ts` (Section 11 block),
  `frontend/src/pages/Messages.tsx` (Custom messages tab + log filters),
  `frontend/src/lib/mock.ts` (mock envelopes + Section 11 stubs)
