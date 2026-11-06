import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/errors';
import { verifyAccessToken } from '../lib/tokens';

/** Aliases used by sibling modules (fees/ocr) — same semantics as authenticate / rbac.requireRole. */
export { requireRole } from './rbac';

/** Require a valid Bearer access JWT; attaches req.user. */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    next(ApiError.unauthorized('Missing or invalid Authorization header'));
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    next(ApiError.unauthorized('Invalid or expired access token'));
  }
}

/** Alias for authenticate (used by sibling modules). */
export const requireAuth = authenticate;
