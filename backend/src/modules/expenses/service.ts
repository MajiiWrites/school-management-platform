// Expenses (6C-2) — contracts/SCHEMA.md v2 §7, API.md "Expenses…".
// CRUD: date, category, amount (integer PKR), note/description, paid_by.
// NOTE on `paid_by`: the v2 `expenses` table has no paid_by column — it has
// `created_by` (the user who recorded the expense). A caller-supplied
// `paid_by` (who physically paid, e.g. "Admin" / a staff name) is therefore
// recorded as a "Paid by …" prefix on the description, never dropped, and
// the API echoes it back as `paid_by` parsed from that prefix. `created_by`
// stays the actor id. Money is integer PKR; every query is scoped to the
// JWT school_id. Clerk creates/updates/deletes go through the approval
// queue (routes); every edit writes change_logs; deletes are hard deletes
// (expenses are NOT in the v2 soft-delete list, SCHEMA.md §10) with an
// audit-log row.

import { ApiError } from '../../lib/errors';
import { isValidDateString, monthRange, dateOnly } from '../../lib/dates';
import { isValidMonthKey } from '../../jobs/date-utils';
import { writeAudit } from '../../lib/audit';
import { writeChangeLogs, logCreate, logDelete } from '../hardening/helpers';
import type { Db } from '../../lib/db';

export interface ExpenseView {
  id: string;
  date: string;
  category: string;
  description: string | null;
  paid_by: string | null;
  amount: number;
  created_by: string | null;
  created_at: string;
}

const PAID_BY_PREFIX = /^Paid by ([^:]+): /;

export function splitPaidBy(description: string | null): { description: string | null; paid_by: string | null } {
  if (!description) return { description: null, paid_by: null };
  const m = description.match(PAID_BY_PREFIX);
  if (!m) return { description, paid_by: null };
  return { description: description.slice(m[0].length) || null, paid_by: m[1] };
}

function toView(r: any): ExpenseView {
  const { description, paid_by } = splitPaidBy(r.description ?? null);
  return {
    id: r.id,
    date: new Date(r.date).toISOString().slice(0, 10),
    category: r.category,
    description,
    paid_by,
    amount: r.amount,
    created_by: r.createdBy ?? null,
    created_at: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
  };
}

function assertAmount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw ApiError.validation('amount must be a positive integer (PKR)');
  }
  return value;
}

function buildDescription(description: string | undefined, paidBy: string | undefined): string | null {
  const desc = (description ?? '').trim() || null;
  const paid = (paidBy ?? '').trim();
  if (paid) return `Paid by ${paid}: ${desc ?? ''}`.trimEnd();
  return desc;
}

export async function listExpenses(
  db: Db,
  schoolId: string,
  query: { month?: string; category?: string; page?: number; limit?: number },
): Promise<{ items: ExpenseView[]; total: number; page: number; pages: number }> {
  const where: Record<string, unknown> = { schoolId };
  if (query.month) {
    if (!isValidMonthKey(query.month)) throw ApiError.validation('month must be YYYY-MM');
    const { start, end } = monthRange(query.month);
    where.date = { gte: dateOnly(start), lte: dateOnly(end) };
  }
  if (query.category) where.category = query.category;
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(200, Math.max(1, query.limit ?? 50));
  const [rows, total] = await Promise.all([
    db.expense.findMany({ where, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
    db.expense.count({ where }),
  ]);
  return { items: rows.map(toView), total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function createExpense(
  db: Db,
  schoolId: string,
  input: { date: string; category: string; description?: string; amount: number; paid_by?: string },
  actorId: string,
): Promise<ExpenseView> {
  if (!isValidDateString(input.date)) throw ApiError.validation('date must be a valid YYYY-MM-DD date');
  if (typeof input.category !== 'string' || input.category.trim().length === 0 || input.category.trim().length > 80) {
    throw ApiError.validation('category is required (max 80 chars)');
  }
  const amount = assertAmount(input.amount);
  const created: any = await db.expense.create({
    data: {
      schoolId,
      date: dateOnly(input.date),
      category: input.category.trim(),
      description: buildDescription(input.description, input.paid_by),
      amount,
      createdBy: actorId,
    },
  });
  await logCreate(db, {
    schoolId,
    actorId,
    entity: 'expense',
    entityId: created.id,
    after: { date: input.date, category: input.category.trim(), description: created.description ?? null, amount },
  });
  await writeAudit(db, {
    schoolId,
    actorId,
    actorType: 'user',
    action: 'expense.create',
    entity: 'expense',
    entityId: created.id,
    details: { date: input.date, category: input.category.trim(), amount },
  });
  return toView(created);
}

export async function updateExpense(
  db: Db,
  schoolId: string,
  id: string,
  patch: { date?: string; category?: string; description?: string; amount?: number; paid_by?: string },
  actorId: string,
): Promise<ExpenseView> {
  const existing: any = await db.expense.findFirst({ where: { id, schoolId } });
  if (!existing) throw ApiError.notFound('Expense not found');
  const data: Record<string, unknown> = {};
  if (patch.date !== undefined) {
    if (!isValidDateString(patch.date)) throw ApiError.validation('date must be a valid YYYY-MM-DD date');
    data.date = dateOnly(patch.date);
  }
  if (patch.category !== undefined) {
    if (typeof patch.category !== 'string' || patch.category.trim().length === 0) throw ApiError.validation('category is required');
    data.category = patch.category.trim();
  }
  if (patch.amount !== undefined) data.amount = assertAmount(patch.amount);
  if (patch.description !== undefined || patch.paid_by !== undefined) {
    const current = splitPaidBy(existing.description ?? null);
    data.description = buildDescription(
      patch.description !== undefined ? patch.description : current.description ?? undefined,
      patch.paid_by !== undefined ? patch.paid_by : current.paid_by ?? undefined,
    );
  }
  const before = {
    date: toView(existing).date,
    category: existing.category,
    description: existing.description ?? null,
    amount: existing.amount,
  };
  const updated: any = await db.expense.update({ where: { id }, data });
  await writeChangeLogs(db, {
    schoolId,
    actorId,
    entity: 'expense',
    entityId: id,
    before,
    after: {
      date: toView(updated).date,
      category: updated.category,
      description: updated.description ?? null,
      amount: updated.amount,
    },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'expense.update', entity: 'expense', entityId: id, details: {} });
  return toView(updated);
}

export async function deleteExpense(db: Db, schoolId: string, id: string, actorId: string): Promise<void> {
  const existing: any = await db.expense.findFirst({ where: { id, schoolId } });
  if (!existing) throw ApiError.notFound('Expense not found');
  await db.expense.delete({ where: { id } });
  await logDelete(db, {
    schoolId,
    actorId,
    entity: 'expense',
    entityId: id,
    before: { date: toView(existing).date, category: existing.category, description: existing.description ?? null, amount: existing.amount },
  });
  await writeAudit(db, {
    schoolId,
    actorId,
    actorType: 'user',
    action: 'expense.delete',
    entity: 'expense',
    entityId: id,
    details: { date: toView(existing).date, category: existing.category, amount: existing.amount },
  });
}

// ---------------------------------------------------------------------------
// Income vs expense report — income = fees collected (amount_paid on
// fee_records of the month), expense = expenses table. Shared by the
// reports module (GET /reports/income-expense) and this module's own route.
// ---------------------------------------------------------------------------

export interface IncomeVsExpense {
  month: string;
  income: number;
  expense: number;
  balance: number;
  by_category: Array<{ category: string; total: number; count: number }>;
  by_day: Array<{ date: string; income: number; expense: number }>;
}

export async function incomeVsExpense(db: Db, schoolId: string, month: string): Promise<IncomeVsExpense> {
  if (!isValidMonthKey(month)) throw ApiError.validation('month must be YYYY-MM');
  const { start, end } = monthRange(month);
  const [records, expenses] = await Promise.all([
    db.feeRecord.findMany({ where: { schoolId, month, deletedAt: null } }),
    db.expense.findMany({ where: { schoolId, date: { gte: dateOnly(start), lte: dateOnly(end) } } }),
  ]);
  const income = records.reduce((a: number, r: any) => a + (r.amountPaid ?? 0), 0);
  const byCategory = new Map<string, { total: number; count: number }>();
  const byDay = new Map<string, { income: number; expense: number }>();
  let expenseTotal = 0;
  for (const e of expenses) {
    expenseTotal += e.amount ?? 0;
    const cat = byCategory.get(e.category) ?? { total: 0, count: 0 };
    cat.total += e.amount ?? 0;
    cat.count += 1;
    byCategory.set(e.category, cat);
    const d = new Date(e.date).toISOString().slice(0, 10);
    const day = byDay.get(d) ?? { income: 0, expense: 0 };
    day.expense += e.amount ?? 0;
    byDay.set(d, day);
  }
  // Fees collected are attributed to the month of the fee record (the
  // record's month), so the whole month's income lands on the 1st in the
  // daily view — the daily split is only meaningful for expenses.
  const day1 = byDay.get(start) ?? { income: 0, expense: 0 };
  day1.income += income;
  byDay.set(start, day1);
  return {
    month,
    income,
    expense: expenseTotal,
    balance: income - expenseTotal,
    by_category: [...byCategory.entries()]
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.total - a.total),
    by_day: [...byDay.entries()]
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}
