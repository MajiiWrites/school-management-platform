import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../lib/db';
import { parseBody, uuidSchema } from '../../lib/validate';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdmin } from '../../middleware/rbac';
import * as service from './service';

export const classesRouter = Router();
classesRouter.use(authenticate, requireSchool);

const classSchema = z.object({
  name: z.string().min(1, 'Class name is required').max(20),
  section: z.string().min(1, 'Section is required').max(10),
  teacher_name: z.string().min(2, 'Teacher name is required').max(120),
  teacher_phone: z.string().optional().nullable(),
});
const classPatchSchema = classSchema.partial();

classesRouter.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(classSchema, req.body);
    const created = await service.createClass(getDb(), schoolIdOf(req), body);
    res.status(201).json({ ok: true, data: service.toPublicClass(created, 0) });
  }),
);

classesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const items = await service.listClasses(getDb(), schoolIdOf(req));
    res.json({ ok: true, data: { items, total: items.length, page: 1, pages: 1 } });
  }),
);

classesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseBody(z.object({ id: uuidSchema }), req.params).id;
    const item = await service.getClass(getDb(), schoolIdOf(req), id);
    res.json({ ok: true, data: item });
  }),
);

classesRouter.patch(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = parseBody(z.object({ id: uuidSchema }), req.params).id;
    const patch = parseBody(classPatchSchema, req.body);
    const updated = await service.updateClass(getDb(), schoolIdOf(req), id, patch);
    res.json({ ok: true, data: service.toPublicClass(updated) });
  }),
);

classesRouter.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = parseBody(z.object({ id: uuidSchema }), req.params).id;
    await service.deleteClass(getDb(), schoolIdOf(req), id);
    res.json({ ok: true, data: { message: 'Class deleted' } });
  }),
);

classesRouter.post(
  '/:id/attendance-link/regenerate',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = parseBody(z.object({ id: uuidSchema }), req.params).id;
    const result = await service.regenerateLink(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: result });
  }),
);

classesRouter.post(
  '/:id/attendance-link/revoke',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = parseBody(z.object({ id: uuidSchema }), req.params).id;
    await service.revokeLink(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Attendance link revoked' } });
  }),
);
