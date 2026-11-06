import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config';
import { apiLimiter } from './middleware/rateLimit';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { authenticate } from './middleware/auth';
import { requireSchool } from './middleware/tenant';
import { requireAdmin } from './middleware/rbac';
import { getDb } from './lib/db';
import { authRouter } from './modules/auth/routes';
import { classesRouter } from './modules/classes/routes';
import { studentsRouter, parentsRouter } from './modules/students/routes';
import { attendanceRouter } from './modules/attendance/routes';
import { reportsRouter } from './modules/reports/routes';
import { adminRouter } from './modules/admin/routes';
import { createOcrRouter, prismaOcrDb } from './modules/ocr/index';
import { createMessagingRouter, createPrismaMessagingStore } from './modules/messaging';
import { feesRouter } from './modules/fees/routes';
import { jobsStatusRouter } from './jobs/status-router';

export const app = express();

app.use(helmet());
app.use(
  cors({
    origin: config.frontendUrl,
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api', apiLimiter);

app.get('/health', (_req, res) => {
  res.json({ ok: true, data: { status: 'up', version: '1.0.0' } });
});

// --- Backend Agent modules (Phase 2) ---------------------------------------
// NOTE: attendanceRouter is mounted FIRST: it owns the public /t/:token
// routes, and routers mounted at /api/v1 with a global authenticate()
// middleware would otherwise reject public link requests with 401.
app.use('/api/v1/auth', authRouter);
app.use('/api/v1', attendanceRouter); // /t/:token (public) + /classes/:id/attendance + /teacher-attendance

// Messaging is mounted HERE (before studentsRouter/adminRouter): its
// /sms/devices/* endpoints authenticate with the device key ONLY (no staff
// JWT — the Android companion app has no user account). studentsRouter and
// adminRouter both apply a global authenticate() to every /api/v1 request
// that reaches them, so mounting messaging after them made device-only
// polls 401 with "Missing or invalid Authorization header" (QA 2026-11-06:
// the companion app could never poll or report delivery). Mounting first
// lets deviceAuth handle /sms/*; every other messaging route still
// requires the staff JWT via deps.requireAuth.
const authWithTenant: express.RequestHandler = (req, res, next) => {
  authenticate(req, res, (err?: unknown) => {
    if (err) return next(err as Error);
    requireSchool(req, res, next);
  });
};

const prisma = getDb();
const messagingStore = createPrismaMessagingStore(prisma);

// Messaging: /messages/* (approval flow, templates), /sms/* (device API)
app.use(
  '/api/v1',
  createMessagingRouter({
    store: messagingStore,
    requireAuth: authWithTenant,
    requireAdmin,
  }),
);
app.use('/api/v1/classes', classesRouter);
app.use('/api/v1', studentsRouter); // /classes/:id/students, /students/:id
app.use('/api/v1/parents', parentsRouter);
app.use('/api/v1/reports', reportsRouter);
app.use('/api/v1', adminRouter); // /dashboard, /settings, /users, /holidays, /sessions, /promotions, /leaves, /audit-logs, /notifications

// --- Phase 3 (integration) -------------------------------------------------
// authenticate alone only sets req.user; the OCR router also needs
// req.schoolId, so it gets the composed authenticate+requireSchool handler
// (same pair the other routers apply via router.use()).

// OCR: POST /classes/:id/ocr-upload, GET /ocr-uploads/:id,
// POST /classes/:id/ocr-upload/:upload_id/confirm (see modules/ocr/MOUNT.md)
app.use(
  '/api/v1',
  createOcrRouter({
    db: prismaOcrDb(prisma),
    auth: authWithTenant,
    uploadDir: `${config.uploadDir}/ocr`,
  }),
);
// Fees: /fees/*, /fees/receipts/* (see modules/fees/MOUNT.md)
app.use('/api/v1/fees', feesRouter);
// Jobs: GET /jobs/status (see jobs/MOUNT.md)
app.use('/api/v1/jobs', jobsStatusRouter);

app.use(notFoundHandler);
app.use(errorHandler);
