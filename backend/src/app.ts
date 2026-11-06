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
import { hardeningRouter } from './modules/hardening/routes';
import { expensesRouter } from './modules/expenses/routes';
import { announcementsRouter } from './modules/announcements/routes';
import { eventsRouter } from './modules/events/routes';
import { certificatesRouter } from './modules/certificates/routes';
import { notificationsRouter } from './modules/notifications/routes';
import { resultsRouter } from './modules/results/routes';
import { securityRouter } from './modules/security/routes';
// --- 6C-1: sessions / exams / timetable / staff+payroll ----------------------
import { sessionsRouter } from './modules/sessions/routes';
import { examsRouter } from './modules/exams/routes';
import { timetableRouter } from './modules/timetable/routes';
import { staffRouter } from './modules/staff/routes';

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
// --- 6C-1: sessions router mounts BEFORE adminRouter: it supersedes the v1
// admin session routes (same paths, snake_case views + is_archived +
// PATCH/DELETE/archive/promote) while keeping the v1 contract the Settings
// page relies on (GET /sessions, POST /sessions/:id/make-current).
app.use('/api/v1', sessionsRouter);
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
// Hardening (6A): /approvals, /recycle-bin, /change-history, /roles/*,
// /export/all, /account/*, /backups
app.use('/api/v1', hardeningRouter);

// --- 6B (students/classes/results) ----------------------------------------
// Results: /results/*, /result-sheets/*, /exams (list/update/delete only;
// the full exams module belongs to 6C-1). Mounted after studentsRouter so
// /students/:id/report-card does not collide with /students/:id.
app.use('/api/v1', resultsRouter);
// --- 6C-1: exams (/exams, /grading-scales), timetable (/timetable),
// staff + payroll (/staff, /payroll) --------------------------------------
app.use('/api/v1', examsRouter);
app.use('/api/v1', timetableRouter);
app.use('/api/v1', staffRouter);
// --- Phase 6D (roles & security) ------------------------------------------
// Security router: POST /backups/run (manual per-school backup now).
// GET /backups (log) stays in the hardening router; 2FA / roles / export /
// deletion-request endpoints are reused from hardening + auth as-is.
app.use('/api/v1', securityRouter);

// --- 6C-2 (School Features part 2): expenses, announcements, events,
// certificates + ID cards, notification center ---------------------------
// Clerk mutations in these routers go through the approval queue (202);
// see modules/hardening/approvals.ts (6C-2 block) for the appliers.
app.use('/api/v1/expenses', expensesRouter);
app.use('/api/v1/announcements', announcementsRouter);
app.use('/api/v1/events', eventsRouter);
app.use('/api/v1', certificatesRouter); // /students/:id/certificates, /certificates/:id, /students/:id/issue-id-card
app.use('/api/v1', notificationsRouter); // GET /notifications/center

app.use(notFoundHandler);
app.use(errorHandler);
