import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { getDb } from '../../lib/db';
import { parseBody, uuidSchema } from '../../lib/validate';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdmin, requireAdminOrClerk } from '../../middleware/rbac';
import { requireQueueable } from '../../middleware/permissions';
import { queueIfClerk } from '../hardening/queueGate';
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
  parent_name_ur: z.string().max(120).optional().nullable(),
  parent_phone: z.string().optional().nullable(),
  parent_opt_out: z.boolean().optional(),
  // v2 extended profile (contracts/SCHEMA.md §1)
  father_name: z.string().max(120).optional().nullable(),
  admission_no: z.string().max(60).optional().nullable(),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional().nullable(),
  gender: z.enum(['male', 'female', 'other']).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  admission_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional().nullable(),
  parent2_name: z.string().max(120).optional().nullable(),
  parent2_phone: z.string().optional().nullable(),
  parent2_opt_out: z.boolean().optional(),
});
const studentPatchSchema = studentSchema.partial().extend({
  status: z.enum(['active', 'left', 'struck_off', 'graduated']).optional(),
  class_id: uuidSchema.optional(),
});
const parentSchema = z.object({
  parent_name: z.string().max(120).optional().nullable(),
  parent_name_ur: z.string().max(120).optional().nullable(),
  parent_phone: z.string().optional().nullable(),
  opt_out: z.boolean().optional(),
});
const idParams = z.object({ id: uuidSchema });
const classIdParams = z.object({ id: uuidSchema });

// --- Students in a class -------------------------------------------------
studentsRouter.post(
  '/classes/:id/students',
  requireAdminOrClerk,
  requireQueueable('students', 'create'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(classIdParams, req.params);
    const body = parseBody(studentSchema, req.body);
    // 6A: clerk creates go to the approval queue (202); admin applies directly.
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'student', payload: { ...body, class_id: id } })) return;
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
  requireAdminOrClerk,
  requireQueueable('students', 'create'),
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
    // 6A: clerk bulk imports go to the approval queue (202) as one bulk request.
    if (await queueIfClerk(req, res, { actionType: 'bulk', entity: 'student', payload: { class_id: id, rows } })) return;
    const result = await service.importStudents(getDb(), schoolIdOf(req), id, rows, req.user!.sub);
    res.json({ ok: true, data: result });
  }),
);

// 6B: preview-before-import — same parsing + per-row validation as the real
// import, but writes NOTHING. The UI shows this table first; the admin
// confirms, and only then POST .../import-csv runs.
studentsRouter.post(
  '/classes/:id/students/import-preview',
  requireAdminOrClerk,
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
    const preview = await service.previewImport(getDb(), schoolIdOf(req), id, rows);
    res.json({ ok: true, data: preview });
  }),
);

// --- Single student ------------------------------------------------------
// 6B: school-wide list (contracts/API.md GET /students?admission_no=&status=).
// Must precede /students/:id so "students" is not parsed as an id.
studentsRouter.get(
  '/students',
  asyncHandler(async (req, res) => {
    const result = await service.listStudentsSchoolWide(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data: result });
  }),
);

studentsRouter.get(
  '/students/:id',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const student = await service.getStudent(getDb(), schoolIdOf(req), id);
    res.json({ ok: true, data: service.toPublicStudent(student) });
  }),
);

studentsRouter.patch(
  '/students/:id',
  requireAdminOrClerk,
  requireQueueable('students', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const patch = parseBody(studentPatchSchema, req.body);
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'student', entityId: id, payload: { id, patch } })) return;
    const updated = await service.updateStudent(getDb(), schoolIdOf(req), id, patch, req.user!.sub);
    res.json({ ok: true, data: service.toPublicStudent(updated) });
  }),
);

studentsRouter.delete(
  '/students/:id',
  requireAdminOrClerk,
  requireQueueable('students', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'student', entityId: id, payload: { id } })) return;
    await service.deleteStudent(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Student deleted (moved to recycle bin — restorable for 30 days)' } });
  }),
);

studentsRouter.patch(
  '/students/:id/parent',
  requireAdminOrClerk,
  requireQueueable('students', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const body = parseBody(parentSchema, req.body);
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'student', entityId: id, payload: { id, parent: body } })) return;
    const updated = await service.updateParent(getDb(), schoolIdOf(req), id, body, req.user!.sub);
    res.json({ ok: true, data: service.toPublicStudent(updated) });
  }),
);

// 6B: move a student to another section/class (ConfirmDialog in the UI;
// clerk moves go through the approval queue as a student update).
studentsRouter.post(
  '/students/:id/move',
  requireAdminOrClerk,
  requireQueueable('students', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const body = parseBody(z.object({ class_id: uuidSchema }), req.body);
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'student', entityId: id, payload: { id, patch: { class_id: body.class_id } } })) return;
    const updated = await service.moveStudent(getDb(), schoolIdOf(req), id, body.class_id, req.user!.sub);
    res.json({ ok: true, data: service.toPublicStudent(updated) });
  }),
);

// NOTE (6B): POST /students/:id/issue-id-card lives in the 6C-2
// certificates router (same path, same queueing) — not duplicated here.

// --- Parents section ------------------------------------------------------
parentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const result = await service.listParents(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data: result });
  }),
);

// Phase 9 fix: bulk import of parent numbers (CSV/Excel) — the Parents page
// had no import control. Same preview-first pattern as the student import:
// POST .../import-preview validates and shows the table, POST .../import-csv
// writes only the 'ok' rows. Columns: admission_no, student, parent_name,
// parent_phone. Clerk imports go through the approval queue like the
// student import.
parentsRouter.post(
  '/import-preview',
  requireAdminOrClerk,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'Upload a CSV or Excel file as field "file"' } });
      return;
    }
    const isXlsx = /\.(xlsx|xls)$/i.test(req.file.originalname);
    const rows = isXlsx
      ? service.parentRowsFromGrid(await service.parseXlsxGrid(req.file.buffer))
      : service.parentRowsFromGrid(service.parseCsvText(req.file.buffer.toString('utf8')));
    const preview = await service.previewParentsImport(getDb(), schoolIdOf(req), rows);
    res.json({ ok: true, data: preview });
  }),
);

parentsRouter.post(
  '/import-csv',
  requireAdminOrClerk,
  requireQueueable('students', 'update'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'Upload a CSV or Excel file as field "file"' } });
      return;
    }
    const isXlsx = /\.(xlsx|xls)$/i.test(req.file.originalname);
    const rows = isXlsx
      ? service.parentRowsFromGrid(await service.parseXlsxGrid(req.file.buffer))
      : service.parentRowsFromGrid(service.parseCsvText(req.file.buffer.toString('utf8')));
    if (await queueIfClerk(req, res, { actionType: 'bulk', entity: 'student', payload: { parent_import_rows: rows } })) return;
    const result = await service.importParents(getDb(), schoolIdOf(req), rows, req.user!.sub);
    res.json({ ok: true, data: result });
  }),
);
