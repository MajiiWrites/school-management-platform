-- Module E FINAL REBUILD — simplify payroll (20261107152000).
-- One SalaryRecord row is now ONE payment: month + staff + amount
-- (+ "paidAt" = the payment date). The old unique index on
-- ("staffId", month) is dropped so several partial payments in one month
-- add up.
--
-- Data migration:
--   * Rows with "paidAt" set WERE real payments: they become payment rows
--     with amount = "netPay" (the amount actually paid), "paidAt" kept.
--   * Rows with "paidAt" NULL were only "amount due" placeholders — no
--     money ever moved — and the amount due is now derived from
--     Staff."salaryMonthly", so they are deleted. The month then correctly
--     shows as Unpaid (no payments) instead of keeping a phantom row.
--   * "baseSalary" / deductions / "netPay" / "payslipNo" are dropped: the
--     agreed monthly salary lives only on Staff."salaryMonthly"; there are
--     no deductions, allowances, bonuses, tax, or payslip numbers any more.
--     (The old amounts CHECK constraint references those columns, so it
--     goes first.)
ALTER TABLE "salary_records" ADD COLUMN "amount" INTEGER;
UPDATE "salary_records" SET "amount" = "netPay" WHERE "paidAt" IS NOT NULL;
DELETE FROM "salary_records" WHERE "paidAt" IS NULL;
ALTER TABLE "salary_records" ALTER COLUMN "amount" SET NOT NULL;
ALTER TABLE "salary_records" DROP CONSTRAINT "salary_records_amounts_check";
ALTER TABLE "salary_records" DROP COLUMN "baseSalary";
ALTER TABLE "salary_records" DROP COLUMN "deductions";
ALTER TABLE "salary_records" DROP COLUMN "netPay";
ALTER TABLE "salary_records" DROP COLUMN "payslipNo";
DROP INDEX "salary_records_staffId_month_key";
CREATE INDEX "salary_records_schoolId_staffId_month_idx" ON "salary_records"("schoolId", "staffId", "month");
