# Auth module

Signup creates a school + admin user, login issues JWT access (15 min) + refresh (7 d) tokens.

## Endpoints (mounted at `/api/v1/auth`)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /signup | — (rate-limited) | `{school_name, email, password}` → creates school + admin, sends verification email. 201. In non-production the response also carries `dev_token` (the verification token) because email is logged, not sent, in dev. |
| POST | /verify-email | — | `{token}` → marks email verified. |
| POST | /login | — (rate-limited) | `{email, password}` → `{access, refresh, user}`. Login is allowed before verification; the `user.email_verified` flag tells the frontend to prompt for verification. |
| POST | /refresh | — | `{refresh}` → new access + refresh (rotated). |
| POST | /logout | — | Stateless: client discards tokens. No server state. |
| POST | /forgot-password | — (rate-limited) | `{email}` → always 200 (no user enumeration); sends reset link if the account exists. |
| POST | /reset-password | — | `{token, password}` → resets password (token valid 1 h). |
| GET | /me | JWT | Current user. |

## Notes

- Passwords: bcrypt, 12 rounds. Minimum 8 characters.
- Verification/reset tokens: 32 random bytes, only the SHA-256 hash is stored; verify 24 h, reset 1 h.
- School slug is generated from the school name (`my-school`, with a random suffix on collision).
- Email is sent via SMTP when `SMTP_HOST` is set; otherwise the message is logged to the console (dev mode) — see `src/lib/mail.ts`.
- Every signup / verify / reset writes an `audit_logs` row.

## Test

`npm test -- src/modules/auth/auth.test.ts` — signup duplicate-email rejection, login success/failure, token hashing.
