import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/errors';

/**
 * Multi-tenant guard (contracts/API.md): school_id is resolved ONLY from the
 * JWT — never from client input. Any school_id in body/query/params that the
 * client supplies is rejected with 400.
 */
export function requireSchool(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(ApiError.unauthorized());
    return;
  }
  const supplied =
    (req.body && typeof req.body === 'object' && 'school_id' in req.body) ||
    'school_id' in (req.query ?? {});
  if (supplied) {
    next(ApiError.validation('school_id must not be supplied by the client; it is resolved from your login'));
    return;
  }
  req.schoolId = req.user.school_id;
  next();
}

/** Helper for services: the resolved tenant id (throws if middleware was skipped). */
export function schoolIdOf(req: Request): string {
  if (!req.schoolId) throw ApiError.unauthorized('Tenant could not be resolved');
  return req.schoolId;
}
