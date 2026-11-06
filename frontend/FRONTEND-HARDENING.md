# Frontend Hardening — School Management Platform v2 (Phase 6A-3)

Date: 2026-11-06. Scope: frontend only. No API calls, routes, or API contracts
changed. No backend code touched. `DeveloperFooter` / About Us untouched.
Visual style unchanged (Tailwind, existing brand colors).

## 1. Shared pieces

### `src/components/ConfirmDialog.tsx` (new)
The ONLY confirmation UI in the app. Every add / delete / bulk / destructive
action opens it; the API call runs ONLY from `onConfirm`. `window.confirm`
is gone from the codebase (0 occurrences).

```tsx
<ConfirmDialog
  open={boolean}                 // dialog renders only when true
  title="Delete this class?"     // names the action
  message="Are you sure? This will remove Class 5-A …" // names exactly what happens
  confirmLabel="Delete class"    // default "Confirm"
  cancelLabel="Cancel"           // default "Cancel"
  tone="danger" | "primary"      // default "danger"; "primary" for adds/sends
  busy={boolean}                 // disables both buttons while the call runs
  onConfirm={() => void}         // <-- the API call happens here, nowhere else
  onCancel={() => void}          // closes the dialog, nothing runs
/>
```

It renders inside the existing `Modal` (Esc/backdrop close = Cancel).
Pattern at every call site: the button sets a `pending*` state variable;
the dialog's `onConfirm` clears it and calls the original handler.

### `src/components/ui.tsx` — `EmptyState` extended
New optional props, fully backward compatible (existing callers unchanged):

```tsx
<EmptyState title="…" body="…" actionLabel="Add your first class"
            onAction={() => …} />          // renders a brand button
<EmptyState title="…" body="…" actionLabel="Add your first class"
            actionHref="/classes" />       // renders a brand link instead
```

## 2. No auto-filling

- `autoComplete="off"` on **every** data-entry `<input>` / `<textarea>` and
  on every school-data `<form>` (`Classes`, `Fees`, `Parents`, `Settings` ×3,
  `StudentsPanel`, plus `OcrReview` inputs which have no `<form>`).
- Exceptions (password-manager fields only, as the task allows):
  login email (`email`) + password (`current-password`); signup email
  (`email`) + password (`new-password`); reset password (`new-password`);
  clerk-create password (`new-password`). The signup **school-name** field
  and forgot-password email are `off`. Auth `<form>` elements deliberately
  carry NO form-level `autoComplete="off"` — that would defeat the password
  manager on the login/signup forms.
- Not applicable: checkboxes (7×) and hidden file inputs (CSV import, OCR
  photo) — `autocomplete` is meaningless there.
- Pre-filled values removed: `PayModal` amount no longer defaults to the
  remaining balance and discount no longer defaults to `0` — both start
  blank; the remaining balance is shown only as hint text
  ("Remaining: PKR …"). All other new-record forms already started blank.
  Values loaded from the API for *editing existing records* (settings,
  student/class edit forms, template bodies) are real stored data, not
  demo/auto-fill, and are unchanged. Filter defaults (today's date, current
  month, first tab, payment method "Cash" dropdown) are UI defaults, not
  entered data. Placeholders are hints only (e.g. "e.g. 5", "03001234567"),
  never real values. No demo/sample rows exist anywhere.

## 3. Confirmation flow — every action → its dialog call site

| # | Action | File:line (dialog) | Dialog names | API call (only in `onConfirm`) |
|---|--------|-------------------|--------------|-------------------------------|
| 1 | Delete class | `pages/Classes.tsx:85` | class name + student count | `DELETE /classes/:id` |
| 2 | Regenerate attendance link | `pages/Classes.tsx:216` | class; old link stops working | `POST /classes/:id/attendance-link/regenerate` |
| 3 | Revoke attendance link | `pages/Classes.tsx:216` (same dialog, `revoke` branch) | class; teachers can no longer open it | `POST /classes/:id/attendance-link/revoke` |
| 4 | Add / update class | `pages/Classes.tsx:308` | new class name/section + teacher | `POST /classes` / `PATCH /classes/:id` |
| 5 | Remove student | `pages/StudentsPanel.tsx:208` | student name | `DELETE /students/:id` |
| 6 | Import CSV/Excel (bulk) | `pages/StudentsPanel.tsx:221` | file name + target class | `POST /classes/:id/students/import-csv` |
| 7 | Add / update student | `pages/StudentsPanel.tsx:334` | student name, roll, parent | `POST /classes/:id/students` / `PATCH /students/:id` |
| 8 | OCR: confirm & save N students (bulk) | `pages/OcrReview.tsx:247` | N students + low-confidence count | `POST /classes/:id/ocr-upload/:uploadId/confirm` |
| 9 | OCR: remove draft row | `pages/OcrReview.tsx:257` | row name; notes it is unsaved draft only | local state only, no API call |
| 10 | Record fee payment | `pages/Fees.tsx:343` | student, class, month, amount, discount, method | `POST /fees/:studentId/pay` |
| 11 | Approve & send message group (bulk) | `pages/Messages.tsx:204` | N messages, class, date | `POST /messages/approve` |
| 12 | Retry failed message | `pages/Messages.tsx:221` | student + masked parent number | `POST /messages/queue/:id/retry` |
| 13 | Save edited queued message | `pages/Messages.tsx:301` | student name | `PATCH /messages/queue/:id` |
| 14 | Save message template | `pages/Messages.tsx:391` | template type + language | `PATCH /messages/templates/:id` |
| 15 | Save school settings | `pages/Settings.tsx:131` | settings areas affected | `PATCH /settings` |
| 16 | Add holiday | `pages/Settings.tsx:228` | holiday name + date | `POST /holidays` |
| 17 | Remove holiday | `pages/Settings.tsx:237` | holiday name + date | `DELETE /holidays/:id` |
| 18 | Make session current | `pages/Settings.tsx:397` | session name | `POST /sessions/:id/make-current` |
| 19 | Promote N students (bulk) | `pages/Settings.tsx:410` | N students + target class | `POST /promotions` |
| 20 | Create clerk login | `pages/Settings.tsx:507` | clerk email + clerk limits | `POST /users/clerks` |
| 21 | Delete user | `pages/Settings.tsx:516` | user email | `DELETE /users/:id` |
| 22 | Update parent number | `pages/Parents.tsx:180` | student, new number, opt-out flag | `PATCH /students/:id/parent` |
| 23 | Submit teacher attendance (bulk, locks the day) | `pages/TeacherLink.tsx:264` | class, date, present/absent/late/leave counts | `POST /t/:token/submit` |

Not gated (deliberately): report PDF/Excel export (download, not a write),
"Upload a different photo" in OCR (discards only an unsaved draft),
navigation, and read-only views. No per-page one-off dialogs were built —
all 22 call sites use the shared `ConfirmDialog`.

## 4. Empty states (all with a call-to-action, never a blank page)

| Page | Empty condition | Message | CTA |
|------|----------------|---------|-----|
| Classes | no classes | "No classes yet" | "Add your first class" (opens the form) |
| Students | no classes | "No classes yet" | "Add your first class" → `/classes` |
| StudentsPanel (Classes detail + Students) | no students in class | "No students found" | "Add your first student" (opens the form); search/filter miss shows "Try a different search or filter." with no CTA |
| Dashboard | no classes at all | "No classes yet" | "Add your first class" → `/classes` |
| Fees — monthly fees | no records this month | "No fee records for this month" | "View fee structures" (switches tab) |
| Fees — structures | no structures | "No fee structures yet" | "Add your first class" → `/classes` |
| Messages — pending | nothing to approve | "Nothing waiting for approval" | "View delivery log" (switches tab) |
| Messages — log | no messages | "No messages yet" | "Review pending approvals" (switches tab) |
| Messages — templates | none for language | "No templates for this language" | — (backend-seeded; nothing to add here) |
| Parents | no flagged students | "No students with a … phone issue" | "Go to Students" → `/students` |
| Reports — attendance | no rows; no classes | "No attendance data" | "Add your first class" → `/classes` (only when no classes exist) |
| Reports — fees | no fee data | "No fee data for this month" | "Set up fees" → `/fees` |
| OCR review | no names extracted | "No names extracted" | "Add a missing student" (adds a blank row) |
| Settings — holidays | none | "No holidays added" | form is directly above the state |
| Settings — audit | none | "No audit entries" | — (log-only view) |
| TeacherLink | no students in class | "No students in this class yet" | — (teacher cannot add students; text says to ask the admin) |

Note: the site is now completely empty by design (demo account removed
2026-11-06), so these states are what a fresh school sees on first login.

## 5. OCR draft discipline (`pages/OcrReview.tsx`)

- Already a draft: OCR output is held in local `rows` state and nothing is
  saved until the "Confirm & save N students" button → `ConfirmDialog`
  (item 8 above) → `POST …/ocr-upload/:id/confirm`. No change to the OCR API.
- Warning banner (exact text, shown whenever a draft is open):
  > "⚠️ Review before saving — OCR may contain errors. Nothing is saved
  > until you confirm." plus a live count of low-confidence rows, or
  > "All rows are above the confidence threshold."
- Low-confidence highlighting: threshold `0.7`, exported as
  `OCR_LOW_CONFIDENCE_THRESHOLD`, applied to the `confidence` value the API
  returns. Rows below threshold get a red-tinted row background, red-bordered
  inputs, a red "NN% — check" badge, and a tooltip
  ("Low confidence (NN%) — please check this row before saving.").
  Duplicate rows keep their amber highlight. The save dialog also names the
  low-confidence count before confirming.

## 6. Changes per page

- **Auth** — signup school-name + forgot-password email set to
  `autoComplete="off"`; login/signup/reset credential fields unchanged.
- **Classes** — dialogs 1–4; empty-state CTA; form inputs `off`.
- **Students / StudentsPanel** — dialogs 5–7; empty-state CTAs; form +
  search inputs `off`. CSV import now confirms with the file name first.
- **OcrReview** — dialogs 8–9; warning banner; low-confidence highlighting;
  empty-state CTA; row inputs `off`.
- **Fees** — dialog 10; amount/discount now blank by default (remaining
  shown as hint); empty-state CTAs on both tabs; month filter `off`.
- **Messages** — dialogs 11–14; empty-state CTAs; both textareas `off`.
- **Parents** — dialog 22; empty-state CTA; form inputs `off`.
- **Reports** — empty-state CTAs; date/month filters `off`.
- **Settings** — dialogs 15–21; holiday empty state clarified; all form
  inputs `off` (clerk password keeps `new-password`).
- **TeacherLink** — dialog 23 (submit attendance with counts); no text
  inputs on this page. Offline-cached submit behaviour unchanged.
- **Dashboard** — empty-state CTA when the school has no classes.
- **Layout / DeveloperFooter / api.ts / types.ts / App.tsx** — untouched.

## 7. Verification

Build (run 2026-11-06, in `frontend/`):

```
$ npm run build        # tsc -b && vite build
✓ built in ~1.7s, exit 0 (44 modules; no tsc errors)
```

Autocomplete grep proof — a plain `grep` cannot tell a real tag end from the
`>` inside an arrow function (`(e) => …`), so verification used a small
JSX-aware tag parser (tracks `{}` depth and quotes) over `src/**/*.tsx`:

```
inputs+textareas: total=43  autoComplete="off":31  credential-values:5
n/a (checkbox/file):7  uncovered:0
```

- 31× `autoComplete="off"` — every school-data input/textarea.
- 5× credential values — login email/password, signup email/password, reset
  password (Auth only, password-manager fields).
- 7× n/a — checkboxes and hidden file inputs.
- 0 uncovered. Every school-data `<form>` (7) carries `autoComplete="off"`;
  the 4 Auth forms intentionally do not (password manager).
- Reproduce with: `grep -rn 'autoComplete' src --include='*.tsx' | wc -l`
  (= 43 lines: 36 input/textarea attributes + 7 form-level attributes) and
  `grep -rn 'autoComplete="off"' src --include='*.tsx' | wc -l` (= 38:
  31 inputs/textareas + 7 forms); `grep -rn 'window.confirm' src
  --include='*.tsx'` → 0 hits outside the `ConfirmDialog` doc comment.
  (The exact off/credential/n-a split needs the JSX-aware parser above,
  because plain grep cannot see multi-line tags or `=>` correctly.)

Confirmation walk: every row of the table in §3 was traced in code —
button → `setPending*` state → `<ConfirmDialog … onConfirm={handler}>` →
API call. No add/delete/bulk handler is reachable from a button without
passing through the dialog.

## 8. Unfinished / blocked

- Nothing unfinished in this task's scope. Not verified in a live browser
  (subagent has no browser): the dialogs, empty states, and banner were
  verified by code walk + successful `tsc`/`vite` build only — a click-through
  on the live site is still worth doing during Phase 8 QA.
- Known cosmetic note: the first autofill pass used a naive regex that
  corrupted `onChange={(e) => …}` arrows (inserted the attribute inside the
  arrow); all 36 corrupted spots were found, reverted, and re-applied with
  the JSX-aware parser — the passing build and the 0-uncovered grep above
  are the proof. No corruption remains.
