import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../lib/db';
import { parseBody, passwordSchema, emailSchema } from '../../lib/validate';
import { ApiError, asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/rbac';
import { authLimiter } from '../../middleware/rateLimit';
import * as service from './service';
import * as twofa from '../hardening/twofa';

export const authRouter = Router();

const signupSchema = z.object({
  school_name: z.string().min(2, 'School name is required').max(120),
  email: emailSchema,
  password: passwordSchema,
});
const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
  totp_code: z.string().regex(/^\d{6}$/, 'TOTP code must be 6 digits').optional(),
});
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
    const result = await service.login(getDb(), body, { ip: req.ip, totpCode: body.totp_code });
    res.json({ ok: true, data: result });
  }),
);

// --- 2FA (TOTP, optional, admin) ------------------------------------------
// Setup returns the otpauth URL + secret ONCE; the secret is stored
// encrypted only after a successful verify. Login with 2FA enabled returns
// {needs_2fa: true, temp_token} from the password step; the second step
// exchanges the temp token + code for the JWTs.
async function loadAuthedUser(req: any): Promise<any> {
  const user = await getDb().user.findUnique({ where: { id: req.user.sub } });
  if (!user) throw ApiError.unauthorized();
  return user;
}

authRouter.post(
  '/2fa/setup',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const user = await loadAuthedUser(req);
    if (user.totpEnabled) throw ApiError.conflict('2FA is already enabled');
    const result = await twofa.setupTwofa(getDb(), user);
    res.json({ ok: true, data: result });
  }),
);

authRouter.post(
  '/2fa/verify',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'), secret: z.string().optional() }),
      req.body,
    );
    const user = await loadAuthedUser(req);
    const result = await twofa.verifyTwofaSetup(getDb(), user, body.code, body.secret);
    res.json({ ok: true, data: result });
  }),
);

authRouter.post(
  '/2fa/disable',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ password: z.string().min(1, 'Password is required') }), req.body);
    const user = await loadAuthedUser(req);
    const result = await twofa.disableTwofa(getDb(), user, body.password);
    res.json({ ok: true, data: result });
  }),
);

authRouter.post(
  '/2fa/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        temp_token: z.string().min(10, 'temp_token is required'),
        code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
      }),
      req.body,
    );
    const result = await twofa.completeTwofaLogin(getDb(), body.temp_token, body.code, req.ip);
    res.json({ ok: true, data: { ...result, user: service.toPublicUser(result.user) } });
  }),
);

authRouter.post(
  '/refresh',
  authLimiter, // 6D: refresh is an auth endpoint — it was the only one without the auth limiter.
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
