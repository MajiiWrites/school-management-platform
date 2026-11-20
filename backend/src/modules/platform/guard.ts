/**
 * Platform Admin Panel guard (2026-11-20).
 *
 * requirePlatformAdmin = authenticate (JWT) + load the user from the DB +
 * role === 'platform_admin' + TOTP enabled. The 2FA gate is on PANEL
 * routes, NOT on login: a platform admin without 2FA can still log in
 * normally and enable it in Security — only the panel refuses them.
 *
 * Never use requireSchool / tenant middleware on platform routes:
 * platform admins are cross-school by design.
 */
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../../lib/errors';
import { getDb } from '../../lib/db';
import { authenticate } from '../../middleware/auth';

export const PLATFORM_2FA_MESSAGE =
  'Enable two-factor authentication in Security before using the Platform Admin Panel';

export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): void {
  authenticate(req, res, (err?: unknown) => {
    if (err) return next(err as Error);
    void (async () => {
      try {
        const user = await getDb().user.findUnique({ where: { id: req.user!.sub } });
        if (!user || user.role !== 'platform_admin') {
          next(ApiError.forbidden('This action requires the platform administrator role'));
          return;
        }
        if (!user.totpEnabled) {
          next(ApiError.forbidden(PLATFORM_2FA_MESSAGE));
          return;
        }
        (req as any).platformAdmin = user;
        next();
      } catch (e) {
        next(e as Error);
      }
    })();
  });
}
