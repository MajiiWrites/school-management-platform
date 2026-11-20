/**
 * requirePermission(resource, action) middleware (6A).
 * Reads the school's role_permissions rows (via permissions.ts); admin
 * bypasses with all allowed; principal is view-only (any non-view action
 * is 403). Apply to every mutating route, after authenticate+requireSchool.
 *
 * requireQueueable(resource, action) is the variant for the approval-queue
 * routes: a clerk may SUBMIT a queue-gated action (students/classes/fees
 * create/update/delete, fee pay, holiday create/delete, template update,
 * user create/delete) even when the matrix has no direct-apply cell for it
 * — the matrix governs direct application, and a queued request applies
 * nothing until an admin approves it. Principals are still 403 (view-only).
 */
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/errors';
import { getDb } from '../lib/db';
import { isAllowed } from '../modules/hardening/permissions';

/** (resource, action) pairs a clerk may submit to the approval queue. */
export const QUEUEABLE: Array<[string, string]> = [
  ['students', 'create'],
  ['students', 'update'],
  ['students', 'delete'],
  ['classes', 'create'],
  ['classes', 'update'],
  ['classes', 'delete'],
  ['fees', 'create'],
  ['fees', 'update'],
  ['fees', 'delete'],
  ['holidays', 'create'],
  ['holidays', 'delete'],
  ['messages', 'update'],
  ['users', 'create'],
  ['users', 'delete'],
  // 6C-2: clerk mutations in the new feature modules go to the approval queue.
  ['expenses', 'create'],
  ['expenses', 'update'],
  ['expenses', 'delete'],
  ['announcements', 'create'],
  ['announcements', 'update'],
  ['announcements', 'delete'],
  ['events', 'create'],
  ['events', 'update'],
  ['events', 'delete'],
  ['certificates', 'create'],
  // 6C-1: clerk mutations in sessions / exams / timetable / staff / payroll.
  ['academic_sessions', 'update'],
  ['academic_sessions', 'delete'],
  ['exams', 'create'],
  ['exams', 'update'],
  ['exams', 'delete'],
  ['timetable', 'create'],
  ['timetable', 'update'],
  ['timetable', 'delete'],
  ['staff', 'create'],
  ['staff', 'update'],
  ['staff', 'delete'],
  // 6B: clerk result/sheet/exam writes go through the approval queue too.
  ['results', 'create'],
  ['results', 'update'],
  ['results', 'delete'],
  // College Mode (2026-11-20): clerk program/semester/course/enrollment/
  // course-mark writes go through the approval queue, like classes.
  ['college', 'create'],
  ['college', 'update'],
  ['college', 'delete'],
  // Gaps Top 3 (2026-11-20): parent-portal tokens, admissions pipeline,
  // homework diary — clerk writes queue like everything else.
  ['parent_tokens', 'create'],
  ['parent_tokens', 'delete'],
  ['admission_inquiry', 'create'],
  ['admission_inquiry', 'update'],
  ['homework', 'create'],
  ['homework', 'update'],
  ['homework', 'delete'],
];

export function requireQueueable(resource: string, action: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user || !req.schoolId) {
      next(ApiError.unauthorized());
      return;
    }
    if (req.user.role === 'admin' || req.user.role === 'platform_admin') {
      next();
      return;
    }
    if (req.user.role === 'principal') {
      next(ApiError.forbidden('Principal accounts are view-only'));
      return;
    }
    if (req.user.role === 'clerk' && QUEUEABLE.some(([r, a]) => r === resource && a === action)) {
      next();
      return;
    }
    next(ApiError.forbidden(`Your role cannot ${action} ${resource}`));
  };
}

export function requirePermission(resource: string, action: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user || !req.schoolId) {
      next(ApiError.unauthorized());
      return;
    }
    // Platform Admin Panel (2026-11-20): the owner bypasses like an admin
    // — within their own school only (requireSchool already scoped it).
    if (req.user.role === 'admin' || req.user.role === 'platform_admin') {
      next();
      return;
    }
    if (req.user.role === 'principal' && action !== 'view') {
      next(ApiError.forbidden('Principal accounts are view-only'));
      return;
    }
    isAllowed(getDb(), req.schoolId, req.user.role, resource, action)
      .then((allowed) => {
        if (!allowed) next(ApiError.forbidden(`Your role cannot ${action} ${resource}`));
        else next();
      })
      .catch(next);
  };
}
