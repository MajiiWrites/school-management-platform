import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/errors';

export type Role = 'admin' | 'clerk' | 'principal' | 'platform_admin';

/** Role-based access control. Use after authenticate(). */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(ApiError.unauthorized());
      return;
    }
    if (!roles.includes(req.user.role as Role)) {
      next(ApiError.forbidden(`This action requires role: ${roles.join(' or ')}`));
      return;
    }
    next();
  };
}

/**
 * Platform Admin Panel (2026-11-20): `platform_admin` is included in the
 * admin shortcuts. The owner is a full admin of their OWN school too —
 * school routes still scope by the JWT's `school_id` (requireSchool), so
 * a platform-admin token on school routes sees ONLY its own school, never
 * another school. Cross-school work goes through /platform/* instead.
 */
export const requireAdmin = requireRole('admin', 'platform_admin');
export const requireAdminOrClerk = requireRole('admin', 'clerk', 'platform_admin');
