# Reports module

Attendance (daily / weekly / monthly) and monthly fee reports, with PDF + Excel export.

## Endpoints (mounted at `/api/v1/reports`, JWT + tenant-scoped, admin/clerk)

| Method | Path | Description |
|---|---|---|
| GET | /attendance/daily?date=YYYY-MM-DD&class_id= | Per-class + per-student summary for one day; totals present/absent/late/leave; `classes_submitted`. |
| GET | /attendance/weekly?week_start=YYYY-MM-DD&class_id= | 7 days from the Monday of the given week. |
| GET | /attendance/monthly?month=YYYY-MM&class_id= | Whole month. |
| GET | /fees/monthly?month=YYYY-MM | `{collected, pending, students, by_class:[{display_name, collected, pending, students}]}`. Collected = sum of `amount_paid`; pending = `amount_due − discount − amount_paid` (floored at 0). |
| All | `?format=pdf\|xlsx` | Downloads the report as a PDF (pdfkit) or Excel file (exceljs) instead of JSON. |

## Notes

- Attendance rate = present / (present + absent), as a percentage with one decimal; `null` when a student/class has no submitted days in the range.
- Days with no submission simply have no records — they do not count as absent.
- Fee reports read `fee_records` (created by the Fee/Scheduler Agent's monthly job); an empty month reports zeros.
- Export tables are class-level summaries; per-student detail is in the JSON response.
