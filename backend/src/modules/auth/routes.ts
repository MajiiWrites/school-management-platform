import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../lib/db';
import { parseBody, passwordSchema, emailSchema } from '../../lib/validate';
import { ApiError, asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { authLimiter } from '../../middleware/rateLimit';
import * as service from './service';

export const authRouter = Router();

const signupSchema = z.object({
  school_name: z.string().min(2, 'School name is required').max(120),
  email: emailSchema,
  password: passwordSchema,
});
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1, 'Password is required') });
const tokenSchema = z.object({ token: z.string().min(10, 'Token is required') });
const forgotSchema = z.object({ email: emailSchema });
const resetSchema = z.object({ token: z.string().min(10, 'Token is required'), password: passwordSchema });
const refreshSchema = z.object({ refresh: z.string().min(10, 'Refresh token is required') });

authRouter.post(
  '/signup',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(signupSchema, req.body);
    const result = await service.signup(getDb(), body);
    res.status(201).json({ ok: true, data: result });
  }),
);

authRouter.post(
  '/verify-email',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(tokenSchema, req.body);
    const result = await service.verifyEmail(getDb(), body.token);
    res.json({ ok: true, data: result });
  }),
);

authRouter.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(loginSchema, req.body);
    const result = await service.login(getDb(), body);
    res.json({ ok: true, data: result });
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const body = parseBody(refreshSchema, req.body);
    const result = await service.refreshTokens(getDb(), body.refresh);
    res.json({ ok: true, data: result });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (_req, res) => {
    // Access/refresh tokens are stateless JWTs; logout is client-side
    // (discard tokens). No server state to clear — documented in README.
    res.json({ ok: true, data: { message: 'Logged out' } });
  }),
);

authRouter.post(
  '/forgot-password',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(forgotSchema, req.body);
    const result = await service.forgotPassword(getDb(), body.email);
    res.json({ ok: true, data: { message: 'If an account exists for this email, a reset link has been sent', ...result } });
  }),
);

authRouter.post(
  '/reset-password',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(resetSchema, req.body);
    const result = await service.resetPassword(getDb(), body.token, body.password);
    res.json({ ok: true, data: result });
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    if (!req.user) throw ApiError.unauthorized();
    const user = await getDb().user.findUnique({ where: { id: req.user.sub } });
    if (!user) throw ApiError.unauthorized();
    res.json({ ok: true, data: { user: service.toPublicUser(user) } });
  }),
);
