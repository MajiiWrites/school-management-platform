import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/errors';

export type Role = 'admin' | 'clerk' | 'principal';

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

export const requireAdmin = requireRole('admin');
export const requireAdminOrClerk = requireRole('admin', 'clerk');
