# Classes module

CRUD for classes + secure teacher attendance links.

## Endpoints (mounted at `/api/v1/classes`, all JWT + tenant-scoped)

| Method | Path | Role | Description |
|---|---|---|---|
| POST | / | admin | Create a class `{name, section, teacher_name, teacher_phone?}`. Unique `(school_id, name, section)` — 409 on duplicate. Teacher phone is normalized to E.164 and encrypted. |
| GET | / | admin/clerk | List classes with `student_count` and link status. |
| GET | /:id | admin/clerk | One class. |
| PATCH | /:id | admin | Update name/section/teacher. |
| DELETE | /:id | admin | Blocked with 409 if the class has students. |
| POST | /:id/attendance-link/regenerate | admin | New 32-byte token (SHA-256 stored, old token invalidated), expires in `ATTENDANCE_LINK_TTL_DAYS` (default 90). Returns `{link, token, expires_at}` — the raw token is shown once. |
| POST | /:id/attendance-link/revoke | admin | Revokes the current link immediately. |

## Link security

- Tokens are crypto-random (32 bytes), stored only as SHA-256 hashes, expire, and can be revoked/regenerated at any time.
- The raw token is never stored or logged; only the full link is returned once at regeneration.
- The public link flow (`GET/POST /t/:token`) lives in the attendance module and resolves the token via `resolveLinkToken()`.

## Notes

- Teacher phone numbers are masked in every response (`+92 3XX XXXX123`); the plaintext is never returned.
- Display name is `name-section` (e.g. `5-A`).
- Every mutation writes an `audit_logs` row.
