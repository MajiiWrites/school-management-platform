import rateLimit from 'express-rate-limit';

/** General API limit: 300 requests / 15 min per IP. */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' } });
  },
});

/** Auth endpoints (login/signup/forgot): 20 attempts / 15 min per IP. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ ok: false, error: { code: 'RATE_LIMITED', message: 'Too many login attempts, try again later' } });
  },
});

/** Public teacher-link endpoints: 120 requests / 10 min per IP. */
export const publicLinkLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, try again later' } });
  },
});
