// GET /jobs/status router — mounted by the integration phase with the fees
// module (see jobs/MOUNT.md):
//   import { jobsStatusRouter } from './jobs/status-router';
//   app.use('/api/v1/jobs', jobsStatusRouter);
// The Backend Agent may alternatively call getJobsStatus(getDb()) directly
// from its own endpoint — the data shape is identical. Last-run state is
// in-memory (see jobs/registry.ts); it resets on restart.

import { Router } from 'express';
import { getDb } from '../lib/db';
import { asyncHandler } from '../lib/errors';
import { authenticate } from '../middleware/auth';
import { requireAdminOrClerk } from '../middleware/rbac';
import { requireSchool } from '../middleware/tenant';
import { getJobsStatus } from './registry';

export const jobsStatusRouter = Router();
jobsStatusRouter.use(authenticate, requireSchool);

jobsStatusRouter.get(
  '/status',
  requireAdminOrClerk,
  asyncHandler(async (_req, res) => {
    const data = await getJobsStatus(getDb());
    res.json({ ok: true, data });
  }),
);
