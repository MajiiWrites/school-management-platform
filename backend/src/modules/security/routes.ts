/**
 * Security routes (6D) — mounted at /api/v1 in app.ts.
 *
 * Only one endpoint lives here: POST /backups/run (admin) triggers the
 * nightly backup job for the caller's own school right now. GET /backups
 * (the backup log) already exists in the hardening routes — it is NOT
 * duplicated here. All 2FA / roles / export / deletion-request endpoints
 * already exist in the hardening + auth modules and are reused as-is by the
 * Security page; no new auth endpoints were needed.
 *
 * Every query is scoped by the JWT school_id (authenticate + requireSchool);
 * the backup job itself only ever touches the school it is given.
 */
import { Router } from 'express';
import { getDb } from '../../lib/db';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdmin } from '../../middleware/rbac';
import { writeAudit } from '../../lib/audit';
import { runSchoolBackup } from '../../jobs/backup';
import { toSchoolRow } from '../../jobs/registry';

export const securityRouter = Router();
securityRouter.use(authenticate, requireSchool);

// --- Manual backup -----------------------------------------------------------
// POST /backups/run (admin): run this school's backup now (same job the
// nightly cron runs). Returns the backup result incl. file ref + size.
securityRouter.post(
  '/backups/run',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getDb();
    const school: any = await db.school.findUnique({ where: { id: schoolIdOf(req) } });
    if (!school) {
      res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'School not found' } });
      return;
    }
    const result = await runSchoolBackup(db, toSchoolRow(school));
    await writeAudit(db, {
      schoolId: schoolIdOf(req),
      actorId: req.user!.sub,
      actorType: 'user',
      action: 'backup.run_manual',
      entity: 'school_backup',
      entityId: schoolIdOf(req),
      details: { file: result.file, size_bytes: result.sizeBytes },
    });
    res.json({ ok: true, data: result });
  }),
);
