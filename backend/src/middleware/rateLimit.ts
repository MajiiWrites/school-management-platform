import rateLimit from 'express-rate-limit';

/**
 * General API limit: 1000 requests / 15 min per IP (raised from 300 in
 * round 5, Phase 10 D-429). The app itself fires ~8-12 API calls per page
 * navigation (page data + notifications refetch on every route + the
 * settings/language and auth checks on mount), so the old 300 ceiling was
 * ~30 page views in 15 minutes for a single busy admin — reachable in
 * normal use, and every 429 surfaced as a "Could not load…" state. 1000
 * still stops abuse (a sustained ~66 req/min per IP; a scraper doing
 * hundreds per minute trips it in seconds) while giving a busy admin
 * ~100 page views per window. Auth endpoints keep their own, much
 * tighter limiter below (20/15 min) — this change does not touch it.
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
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
