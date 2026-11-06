# Fees module — `backend/src/modules/fees/`

Fee structures, monthly fee listing, payments (incl. partial + discount),
printable receipts, monthly reports, and month rollover. All money is
integer PKR. All queries are scoped to `schoolId` (multi-tenant isolation).

## Endpoints (mounted at `/api/v1/fees`, see MOUNT.md)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/structures` | admin, clerk | List fee structures (latest first) |
| POST | `/structures` | admin | Create `{class_id, monthly_amount, effective_from}` |
| PATCH | `/structures/:id` | admin | Update amount / effective_from |
| DELETE | `/structures/:id` | admin | Blocked (409) once fee records exist from it |
| GET | `/?month=&class_id=&status=&search=&page=&limit=` | admin, clerk | Students with amount_due/paid/status for the month |
| POST | `/:student_id/pay` | admin, clerk | Pay `{month, amount_paid, discount?, payment_method?, receipt?}` |
| GET | `/receipts/:receipt_no` | admin, clerk | Printable receipt (HTML; `?format=pdf` for PDF) |
| GET | `/report/monthly?month=` | admin, clerk | Collected vs pending, by class |
| POST | `/rollover` | admin | Manual month rollover `{month}` |

## Rules that matter

- **Status is computed, never written.** `fee_records.status` is a
  `GENERATED ALWAYS` column in Postgres
  (`amountPaid + discount >= amountDue → paid`, `> 0 → partial`, else
  `unpaid`). The service never writes `status` in a create/update payload;
  it reads the DB-generated value back (re-fetching after a payment) and
  uses `computeFeeStatus()` only for in-memory projections of records that
  do not exist yet.
- **Receipt numbers** are `{school_slug}-{YYYYMM}-{seq}`, sequential per
  school+month (e.g. `demo-public-202611-001`), minted on the FIRST payment
  for a record and kept stable across later partial payments. The receipt
  shows cumulative paid/discount/balance.
- **Partial payments + discounts** are allowed; overpayment is rejected
  (400). `paid_at` is set when the balance reaches zero.
- **Payments before rollover**: if no fee record exists for the month, the
  payment creates it on the fly from the class's current structure.
- **Delete guard**: a fee structure cannot be deleted once fee records
  exist for its class on/after its effective month.
- **Audit**: every payment and rollover writes an `audit_logs` row.

## Files

- `service.ts` — all business logic (takes the shared `Db`, lib/db.ts).
- `routes.ts` — Express router (`feesRouter`), codebase pattern.
- `receipts.ts` — HTML receipt + pdfkit PDF (`?format=pdf`).
- `types.ts` — DTO types. `http-error.ts` was removed — errors use
  `ApiError` (lib/errors.ts) like the rest of the backend.

## Dependencies

- `pdfkit` — already in backend/package.json (used for `?format=pdf`).
  If it is ever removed, the route falls back to the HTML receipt.
- No other new dependencies.

## How to test

```bash
npx vitest run src/modules/fees/__tests__/fees.service.test.ts
```

34 tests cover status math, partial/discount payments, receipt sequencing,
rollover idempotency, paid-record protection, listing filters, and reports.
See also `src/jobs/__tests__/demo-flow.test.ts` for the scripted November
fee cycle (rollover → pay → remind → follow-up).
