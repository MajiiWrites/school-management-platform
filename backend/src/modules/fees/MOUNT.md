# MOUNT.md — Fees module (integration notes for the Lead / Phase 3)

## Mount the router (app.ts)

The router already matches the commented template in `src/app.ts`:

```ts
import { feesRouter } from './modules/fees/routes';
app.use('/api/v1/fees', feesRouter);
```

No factory, no extra wiring: the router uses `getDb()` (lib/db.ts),
`authenticate` + `requireSchool`, and `requireAdmin` /
`requireAdminOrClerk` (middleware/rbac.ts) like the other modules.

## Things the integrator must know

1. **No new runtime dependency for fees.** `pdfkit` is already in
   `backend/package.json`. If it is removed, `GET /fees/receipts/:no?format=pdf`
   falls back to the HTML receipt (no crash).
2. **`fee_records.status` is GENERATED.** The migration defines it as
   `GENERATED ALWAYS AS (CASE ...) STORED`. The service never writes it.
   Do not "fix" this by adding `status` to a create/update payload —
   Postgres will reject the write.
3. **Receipt-number uniqueness is by convention, not constraint.** The
   service mints the next sequence inside the payment transaction
   (`findFirst ... orderBy receiptNo desc`). For absolute safety under
   concurrent payments, the Database Agent may add
   `@@unique([schoolId, receiptNo])` to `fee_records` — the service already
   handles the resulting `P2002` as a 409 via the shared error middleware,
   and the client can retry the payment (the payment itself is not applied
   twice because the transaction rolls back).
4. **School timezone** for the default month in `GET /fees` is read from the
   `schools` row (not from the JWT), so non-Karachi schools get the right
   default month.
5. **Success envelope**: handlers return `{ ok: true, data }` per
   contracts/API.md. If a global response wrapper is ever added, these
   handlers must not be double-wrapped.
6. **Roles**: clerk can read fees and record payments, but cannot manage
   fee structures, run rollover, or approve messages (enforced here and in
   the contracts).
