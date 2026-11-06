// Notification center routes (6C-2) — mounted in app.ts at /api/v1.
// GET /notifications/center is the only new endpoint here; the v1
// GET /notifications list + POST /notifications/:id/read stay in the admin
// router, untouched.

import { Router } from 'express';
import { getDb } from '../../lib/db';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { getNotificationCenter } from './service';

export const notificationsRouter = Router();
notificationsRouter.use(authenticate, requireSchool);

notificationsRouter.get(
  '/notifications/center',
  asyncHandler(async (req, res) => {
    const data = await getNotificationCenter(getDb(), schoolIdOf(req));
    res.json({ ok: true, data });
  }),
);
