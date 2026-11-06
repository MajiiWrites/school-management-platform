import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/errors';

/** Renders every error as the contract envelope {ok:false, error:{code, message}}. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message } });
    return;
  }
  // Prisma unique-constraint violations surface as CONFLICT (duplicate day / dedupe key).
  const anyErr = err as { code?: string; message?: string };
  if (anyErr && anyErr.code === 'P2002') {
    res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: 'A record with these values already exists' } });
    return;
  }
  // Plain Errors carrying a contract error code (thrown by the Messaging
  // module, OCR service and device auth): map the code to its HTTP status
  // instead of collapsing everything to 500.
  if (anyErr && typeof anyErr.code === 'string') {
    const statusByCode: Record<string, number> = {
      VALIDATION: 400,
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      RATE_LIMITED: 429,
    };
    const status = statusByCode[anyErr.code];
    if (status) {
      res.status(status).json({ ok: false, error: { code: anyErr.code, message: anyErr.message ?? anyErr.code } });
      return;
    }
  }
  // eslint-disable-next-line no-console
  console.error('[error]', err);
  res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Internal server error' } });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
}
