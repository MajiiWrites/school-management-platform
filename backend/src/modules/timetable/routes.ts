// Timetable routes (6C-1).
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { getDb } from '../../lib/db';
import { parseBody, uuidSchema } from '../../lib/validate';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdminOrClerk } from '../../middleware/rbac';
import { requireQueueable } from '../../middleware/permissions';
import { queueIfClerk } from '../hardening/queueGate';
import { createApprovalRequest } from '../hardening/approvals';
import * as service from './service';

export const timetableRouter = Router();
timetableRouter.use(authenticate, requireSchool);

// Photo upload storage (transient input — the service deletes the file
// after parsing; the frontend shows its own local preview).
const photoUploadDir = path.resolve(process.env.UPLOAD_DIR ? `${process.env.UPLOAD_DIR}/timetable` : './uploads/timetable');
fs.mkdirSync(photoUploadDir, { recursive: true });
const photoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, photoUploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    cb(null, `${randomUUID()}${ext}`);
  },
});
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const uploadPhoto = multer({
  storage: photoStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (IMAGE_MIMES.has(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type "${file.mimetype}". Upload a JPG, PNG or WebP photo of the timetable.`));
  },
});

/** Multer errors become a 400 contract envelope (not the global 500). */
function handlePhotoUpload(req: Request, res: Response, next: NextFunction): void {
  uploadPhoto.single('image')(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : 'Upload failed.';
      const friendly = message.includes('File too large') ? 'Image is larger than 10 MB.' : message;
      res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: friendly } });
      return;
    }
    next();
  });
}

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM (24h)');
const entryBody = z.object({
  class_id: uuidSchema,
  teacher_id: z.string().uuid().optional().nullable(),
  day_of_week: z.number().int().min(0).max(6),
  period_no: z.number().int().min(1),
  subject: z.string().min(1).max(120),
  start_time: timeSchema,
  end_time: timeSchema,
  room: z.string().max(60).optional().nullable(),
});

timetableRouter.get(
  '/timetable',
  asyncHandler(async (req, res) => {
    const data = await service.listTimetable(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data });
  }),
);

timetableRouter.get(
  '/timetable/class/:class_id',
  asyncHandler(async (req, res) => {
    const { class_id } = parseBody(z.object({ class_id: uuidSchema }), req.params);
    const data = await service.getClassTimetable(getDb(), schoolIdOf(req), class_id);
    res.json({ ok: true, data });
  }),
);

timetableRouter.get(
  '/timetable/teacher/:staff_id',
  asyncHandler(async (req, res) => {
    const { staff_id } = parseBody(z.object({ staff_id: uuidSchema }), req.params);
    const data = await service.getTeacherTimetable(getDb(), schoolIdOf(req), staff_id);
    res.json({ ok: true, data });
  }),
);

timetableRouter.post(
  '/timetable',
  requireAdminOrClerk,
  requireQueueable('timetable', 'create'),
  asyncHandler(async (req, res) => {
    const body = parseBody(entryBody, req.body);
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'timetable_entry', payload: body })) return;
    const created = await service.createTimetableEntry(getDb(), schoolIdOf(req), body as any, req.user!.sub);
    res.status(201).json({ ok: true, data: created });
  }),
);

timetableRouter.patch(
  '/timetable/:id',
  requireAdminOrClerk,
  requireQueueable('timetable', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const body = parseBody(
      z.object({
        teacher_id: z.string().uuid().optional().nullable(),
        day_of_week: z.number().int().min(0).max(6).optional(),
        period_no: z.number().int().min(1).optional(),
        subject: z.string().min(1).max(120).optional(),
        start_time: timeSchema.optional(),
        end_time: timeSchema.optional(),
        room: z.string().max(60).optional().nullable(),
      }),
      req.body,
    );
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'timetable_entry', entityId: id, payload: { id, patch: body } })) return;
    const updated = await service.updateTimetableEntry(getDb(), schoolIdOf(req), id, body as any, req.user!.sub);
    res.json({ ok: true, data: updated });
  }),
);

timetableRouter.delete(
  '/timetable/:id',
  requireAdminOrClerk,
  requireQueueable('timetable', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'timetable_entry', entityId: id, payload: { id } })) return;
    await service.deleteTimetableEntry(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Timetable entry deleted' } });
  }),
);

// --- Timetable from photo (FINAL REBUILD, Point 7) ------------------------
// POST /timetable/photo-upload — multipart image -> parsed review cells.
// Read-only parse (nothing saved); the photo is deleted after parsing and
// the frontend shows its own local preview next to the review table.
const photoUploadBody = z.object({
  class_id: uuidSchema.optional(), // the class this sheet is for (optional)
});

timetableRouter.post(
  '/timetable/photo-upload',
  requireAdminOrClerk,
  handlePhotoUpload,
  asyncHandler(async (req, res) => {
    const body = parseBody(photoUploadBody, req.body);
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) throw new Error('No image uploaded. Send a multipart field named "image".');
    const data = await service.uploadTimetablePhoto(getDb(), schoolIdOf(req), file.path, req.user!.sub, {
      class_id: body.class_id ?? null,
    });
    res.status(201).json({ ok: true, data });
  }),
);

// POST /timetable/photo-confirm — save admin-reviewed rows as entries.
// Admins apply directly; clerks submit ONE approval request per row (the
// existing applier only knows single-entry creates), so nothing bypasses
// the queue and nothing is applied before an admin approves it.
const photoConfirmEntry = z.object({
  class_id: uuidSchema,
  teacher_id: z.string().uuid().optional().nullable(),
  day_of_week: z.number().int().min(0).max(6),
  period_no: z.number().int().min(1),
  subject: z.string().min(1).max(120),
  start_time: timeSchema,
  end_time: timeSchema,
  room: z.string().max(60).optional().nullable(),
});

timetableRouter.post(
  '/timetable/photo-confirm',
  requireAdminOrClerk,
  requireQueueable('timetable', 'create'),
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ entries: z.array(photoConfirmEntry).min(1).max(200) }), req.body);
    const entries = body.entries as service.TimetablePhotoConfirmEntry[];
    if (req.user!.role === 'clerk') {
      const approval_request_ids: string[] = [];
      for (const entry of entries) {
        const created = await createApprovalRequest(getDb(), {
          schoolId: schoolIdOf(req),
          requestedBy: req.user!.sub,
          actionType: 'create',
          entity: 'timetable_entry',
          entityId: null,
          payload: entry as unknown as Record<string, unknown>,
        });
        approval_request_ids.push(created.id as string);
      }
      res.status(202).json({
        ok: true,
        data: {
          approval_request_ids,
          status: 'pending',
          message: `Submitted ${entries.length} timetable row(s) for admin approval — nothing was applied yet.`,
        },
      });
      return;
    }
    const data = await service.confirmTimetablePhoto(getDb(), schoolIdOf(req), entries, req.user!.sub);
    res.status(201).json({ ok: true, data });
  }),
);
