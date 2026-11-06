# Students module

Student CRUD, search/filter, bulk CSV/Excel import, and the Parents section.

## Endpoints (mounted at `/api/v1`, all JWT + tenant-scoped)

| Method | Path | Role | Description |
|---|---|---|---|
| POST | /classes/:id/students | admin | Create a student `{name, name_ur?, roll_no?, parent_name?, parent_phone?}`. Duplicate name in class (or same name + parent number in school) → 409. Invalid parent phone → 400. |
| GET | /classes/:id/students?search=&status=&page=&limit= | admin/clerk | Search by name / parent name / roll number; filter by status. |
| PATCH | /students/:id | admin | Edit student (incl. moving to another class via `class_id`, status active/left/graduated). |
| DELETE | /students/:id | admin | Blocked with 409 if the student has attendance or fee history — mark as `left` instead. |
| PATCH | /students/:id/parent | admin | Update parent name / phone / `opt_out`. |
| POST | /classes/:id/students/import-csv | admin | Multipart `file` (CSV or .xlsx, ≤5 MB) with columns `name, name_ur, roll_no, parent_name, parent_phone`. Returns `{imported, duplicates_flagged, invalid_rows:[{row, reason}]}`. |
| GET | /parents?flag=missing\|invalid\|duplicate | admin/clerk | Students with parent-number problems. |

## Duplicate rule (SCHEMA.md)

Same `(class_id, name-normalized)` OR same `(school_id, parent_phone_hash + name-normalized)` is flagged, never silently merged — in manual create (409) and in bulk import (`duplicates_flagged`).

## Notes

- Parent phones are normalized to E.164 (`+92…`), encrypted (AES-256-GCM), and only ever returned masked (`+92 3XX XXXX123`).
- `parent_opt_out = true` is respected by every messaging flow (enforced in the messaging module; the flag is stored here).
- Bulk import is transactional per row (not all-or-nothing): valid rows are saved, bad rows are reported with their row number and reason.
- Every mutation writes an `audit_logs` row.
