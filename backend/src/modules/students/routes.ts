import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { getDb } from '../../lib/db';
import { parseBody, uuidSchema } from '../../lib/validate';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdmin } from '../../middleware/rbac';
import * as service from './service';

export const studentsRouter = Router();
export const parentsRouter = Router();
studentsRouter.use(authenticate, requireSchool);
parentsRouter.use(authenticate, requireSchool);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(csv|xlsx|xls)$/i.test(file.originalname) || file.mimetype.includes('csv') || file.mimetype.includes('sheet');
    if (ok) cb(null, true);
    else cb(new Error('Only CSV or Excel files are accepted'));
  },
});

const studentSchema = z.object({
  name: z.string().min(1, 'Student name is required').max(120),
  name_ur: z.string().max(120).optional().nullable(),
  roll_no: z.number().int().positive().optional().nullable(),
  parent_name: z.string().max(120).optional().nullable(),
  parent_phone: z.string().optional().nullable(),
});
const studentPatchSchema = studentSchema.partial().extend({
  status: z.enum(['active', 'left', 'graduated']).optional(),
  class_id: uuidSchema.optional(),
});
const parentSchema = z.object({
  parent_name: z.string().max(120).optional().nullable(),
  parent_phone: z.string().optional().nullable(),
  opt_out: z.boolean().optional(),
});
const idParams = z.object({ id: uuidSchema });
const classIdParams = z.object({ id: uuidSchema });

// --- Students in a class -------------------------------------------------
studentsRouter.post(
  '/classes/:id/students',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(classIdParams, req.params);
    const body = parseBody(studentSchema, req.body);
    const created = await service.createStudent(getDb(), schoolIdOf(req), id, body, req.user!.sub);
    res.status(201).json({ ok: true, data: service.toPublicStudent(created) });
  }),
);

studentsRouter.get(
  '/classes/:id/students',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(classIdParams, req.params);
    const result = await service.listStudents(getDb(), schoolIdOf(req), id, req.query as Record<string, any>);
    res.json({ ok: true, data: result });
  }),
);

studentsRouter.post(
  '/classes/:id/students/import-csv',
  requireAdmin,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(classIdParams, req.params);
    if (!req.file) {
      res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'Upload a CSV or Excel file as field "file"' } });
      return;
    }
    const isXlsx = /\.(xlsx|xls)$/i.test(req.file.originalname);
    const rows = isXlsx
      ? await service.parseXlsxBuffer(req.file.buffer)
      : service.rowsToImportRows(service.parseCsvText(req.file.buffer.toString('utf8')));
    const result = await service.importStudents(getDb(), schoolIdOf(req), id, rows, req.user!.sub);
    res.json({ ok: true, data: result });
  }),
);

// --- Single student ------------------------------------------------------
studentsRouter.patch(
  '/students/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const patch = parseBody(studentPatchSchema, req.body);
    const updated = await service.updateStudent(getDb(), schoolIdOf(req), id, patch, req.user!.sub);
    res.json({ ok: true, data: service.toPublicStudent(updated) });
  }),
);

studentsRouter.delete(
  '/students/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    await service.deleteStudent(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Student deleted' } });
  }),
);

studentsRouter.patch(
  '/students/:id/parent',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const body = parseBody(parentSchema, req.body);
    const updated = await service.updateParent(getDb(), schoolIdOf(req), id, body, req.user!.sub);
    res.json({ ok: true, data: service.toPublicStudent(updated) });
  }),
);

// --- Parents section ------------------------------------------------------
parentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const result = await service.listParents(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data: result });
  }),
);
