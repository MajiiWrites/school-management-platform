// Events + holiday calendar (6C-2) — contracts/SCHEMA.md v2 §7, API.md
// "Expenses, announcements, events, certificates".
// Events CRUD (title, date, description) + a month calendar view that
// merges school holidays (existing `holidays` table) with events, sorted
// by date. Sundays are non-school days by convention (no row needed).
// Every query is scoped to the JWT school_id; clerk mutations go through
// the approval queue; every edit writes change_logs.

import { ApiError } from '../../lib/errors';
import { isValidDateString, monthRange, dateOnly } from '../../lib/dates';
import { isValidMonthKey } from '../../jobs/date-utils';
import { writeAudit } from '../../lib/audit';
import { writeChangeLogs, logCreate, logDelete } from '../hardening/helpers';
import type { Db } from '../../lib/db';

export interface EventView {
  id: string;
  date: string;
  title: string;
  description: string | null;
  created_at: string;
}

export interface CalendarDay {
  date: string;
  kind: 'holiday' | 'event';
  title: string;
  description: string | null;
  ref_id: string;
}

function toView(r: any): EventView {
  return {
    id: r.id,
    date: new Date(r.date).toISOString().slice(0, 10),
    title: r.title,
    description: r.description ?? null,
    created_at: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
  };
}

export async function listEvents(
  db: Db,
  schoolId: string,
  query: { month?: string; page?: number; limit?: number },
): Promise<{ items: EventView[]; total: number; page: number; pages: number }> {
  const where: Record<string, unknown> = { schoolId };
  if (query.month) {
    if (!isValidMonthKey(query.month)) throw ApiError.validation('month must be YYYY-MM');
    const { start, end } = monthRange(query.month);
    where.date = { gte: dateOnly(start), lte: dateOnly(end) };
  }
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(200, Math.max(1, query.limit ?? 50));
  const [rows, total] = await Promise.all([
    db.event.findMany({ where, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }], skip: (page - 1) * limit, take: limit }),
    db.event.count({ where }),
  ]);
  return { items: rows.map(toView), total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function createEvent(
  db: Db,
  schoolId: string,
  input: { date: string; title: string; description?: string },
  actorId: string,
): Promise<EventView> {
  if (!isValidDateString(input.date)) throw ApiError.validation('date must be a valid YYYY-MM-DD date');
  if (typeof input.title !== 'string' || input.title.trim().length < 2 || input.title.trim().length > 200) {
    throw ApiError.validation('title is required (2–200 chars)');
  }
  const created: any = await db.event.create({
    data: { schoolId, date: dateOnly(input.date), title: input.title.trim(), description: input.description?.trim() || null },
  });
  await logCreate(db, {
    schoolId,
    actorId,
    entity: 'event',
    entityId: created.id,
    after: { date: input.date, title: created.title, description: created.description ?? null },
  });
  await writeAudit(db, {
    schoolId,
    actorId,
    actorType: 'user',
    action: 'event.create',
    entity: 'event',
    entityId: created.id,
    details: { date: input.date, title: created.title },
  });
  return toView(created);
}

export async function updateEvent(
  db: Db,
  schoolId: string,
  id: string,
  patch: { date?: string; title?: string; description?: string | null },
  actorId: string,
): Promise<EventView> {
  const existing: any = await db.event.findFirst({ where: { id, schoolId } });
  if (!existing) throw ApiError.notFound('Event not found');
  const data: Record<string, unknown> = {};
  if (patch.date !== undefined) {
    if (!isValidDateString(patch.date)) throw ApiError.validation('date must be a valid YYYY-MM-DD date');
    data.date = dateOnly(patch.date);
  }
  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string' || patch.title.trim().length < 2) throw ApiError.validation('title is required (2–200 chars)');
    data.title = patch.title.trim();
  }
  if (patch.description !== undefined) data.description = patch.description?.trim() || null;
  const before = { date: toView(existing).date, title: existing.title, description: existing.description ?? null };
  const updated: any = await db.event.update({ where: { id }, data });
  await writeChangeLogs(db, {
    schoolId,
    actorId,
    entity: 'event',
    entityId: id,
    before,
    after: { date: toView(updated).date, title: updated.title, description: updated.description ?? null },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'event.update', entity: 'event', entityId: id, details: {} });
  return toView(updated);
}

export async function deleteEvent(db: Db, schoolId: string, id: string, actorId: string): Promise<void> {
  const existing: any = await db.event.findFirst({ where: { id, schoolId } });
  if (!existing) throw ApiError.notFound('Event not found');
  await db.event.delete({ where: { id } });
  await logDelete(db, {
    schoolId,
    actorId,
    entity: 'event',
    entityId: id,
    before: { date: toView(existing).date, title: existing.title, description: existing.description ?? null },
  });
  await writeAudit(db, {
    schoolId,
    actorId,
    actorType: 'user',
    action: 'event.delete',
    entity: 'event',
    entityId: id,
    details: { date: toView(existing).date, title: existing.title },
  });
}

/** Month calendar: holidays + events merged, sorted by date then kind. */
export async function monthCalendar(
  db: Db,
  schoolId: string,
  month: string,
): Promise<{ month: string; days: CalendarDay[] }> {
  if (!isValidMonthKey(month)) throw ApiError.validation('month must be YYYY-MM');
  const { start, end } = monthRange(month);
  const range = { gte: dateOnly(start), lte: dateOnly(end) };
  const [holidays, events] = await Promise.all([
    db.holiday.findMany({ where: { schoolId, date: range }, orderBy: { date: 'asc' } }),
    db.event.findMany({ where: { schoolId, date: range }, orderBy: { date: 'asc' } }),
  ]);
  const days: CalendarDay[] = [
    ...holidays.map((h: any) => ({
      date: new Date(h.date).toISOString().slice(0, 10),
      kind: 'holiday' as const,
      title: h.name,
      description: null,
      ref_id: h.id,
    })),
    ...events.map((e: any) => ({
      date: new Date(e.date).toISOString().slice(0, 10),
      kind: 'event' as const,
      title: e.title,
      description: e.description ?? null,
      ref_id: e.id,
    })),
  ];
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind < b.kind ? -1 : 1));
  return { month, days };
}
