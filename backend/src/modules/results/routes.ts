// Results routes (6B, contracts/API.md v2 "Results, exams, grading,
// datesheets" + task endpoints). Base /api/v1. Envelope {ok, data}.
// Every route is tenant-scoped by the JWT school_id (never client input).
// Clerk mutations go through the approval queue (202) via requireQueueable
// + queueIfClerk; admin applies directly. Principal is view-only (403 on
// mutations via requireAdminOrClerk / requireQueueable).
import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../../lib/db';
import { config } from '../../config';
import { parseBody, uuidSchema } from '../../lib/validate';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdminOrClerk } from '../../middleware/rbac';
import { requireQueueable } from '../../middleware/permissions';
import { queueIfClerk } from '../hardening/queueGate';
import { OcrUnavailableError } from '../ocr/ocr-engine';
import * as service from './service';

export const resultsRouter = Router();
resultsRouter.use(authenticate, requireSchool);

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const uploadDir = path.resolve(`${config.uploadDir}/result-sheets`);
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase() || '.png'}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_MIMES.has(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type "${file.mimetype}". Upload a JPG, PNG or WebP photo of the result sheet.`));
  },
});

const rowSchema = z.object({
  roll_no: z.number().int().positive(),
  student_name: z.string().min(1).max(120),
  father_name: z.string().max(120).optional().nullable(),
  subject_marks: z.record(z.string(), z.number()).optional(),
  obtained_marks: z.number().optional().nullable(),
  total_marks: z.number().optional().nullable(),
  percentage: z.number().optional().nullable(),
  grade: z.string().max(5).optional().nullable(),
  remarks: z.string().max(500).optional().nullable(),
  confidence: z.record(z.string(), z.number()).optional().nullable(),
  student_id: uuidSchema.optional().nullable(),
});
const idParams = z.object({ id: uuidSchema });
const classIdParams = z.object({ id: uuidSchema });
const sheetIdParams = z.object({ sheetId: uuidSchema });

// --- Upload a result sheet photo (OCR) ------------------------------------
// Contract route (class-scoped) + task route (POST /results/upload).
async function handleUpload(req: any, res: any, classId: string): Promise<void> {
  const examName = String(req.body.exam_name ?? '').trim();
  if (!examName) {
    res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'exam_name is required (e.g. Midterm, Final, Monthly Test)' } });
    return;
  }
  // FINAL REBUILD (Module C): the admin picks the exam type when
  // uploading — monthly | midterm | annual (default monthly).
  const examType = typeof req.body.exam_type === 'string' && req.body.exam_type ? req.body.exam_type : 'monthly';
  if (!['monthly', 'midterm', 'annual'].includes(examType)) {
    res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: "exam_type must be one of 'monthly', 'midterm', 'annual'" } });
    return;
  }
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) {
    res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'No image uploaded. Send a multipart field named "image".' } });
    return;
  }
  try {
    const result = await service.uploadResultSheet(
      getDb(),
      schoolIdOf(req),
      classId,
      { exam_name: examName, exam_type: examType, session_id: typeof req.body.session_id === 'string' ? req.body.session_id : null, file_path: file.path },
      req.user!.sub,
    );
    res.status(201).json({ ok: true, data: result });
  } catch (err) {
    // Same contract as the v1 OCR router: missing Tesseract is a 503 with setup help, not a 500.
    if (err instanceof OcrUnavailableError) {
      res.status(503).json({ ok: false, error: { code: 'OCR_UNAVAILABLE', message: err.message, setup: err.setup } });
      return;
    }
    throw err;
  }
}

resultsRouter.post(
  '/classes/:id/results/upload',
  requireAdminOrClerk,
  requireQueueable('results', 'create'),
  upload.single('image'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(classIdParams, req.params);
    // Clerk upload: the file is already on disk (multer ran first); the
    // queue payload carries its path so OCR runs at approve time (see
    // approvals.ts result_sheet.create applier). exam_type rides along so
    // the approved upload creates the exam with the picked type.
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'result_sheet', payload: { class_id: id, exam_name: String(req.body.exam_name ?? ''), exam_type: typeof req.body.exam_type === 'string' && req.body.exam_type ? req.body.exam_type : 'monthly', file_path: (req as any).file?.path ?? null } })) return;
    await handleUpload(req, res, id);
  }),
);

resultsRouter.post(
  '/results/upload',
  requireAdminOrClerk,
  requireQueueable('results', 'create'),
  upload.single('image'),
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ class_id: uuidSchema }), req.body);
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'result_sheet', payload: { class_id: body.class_id, exam_name: String(req.body.exam_name ?? ''), exam_type: typeof req.body.exam_type === 'string' && req.body.exam_type ? req.body.exam_type : 'monthly', file_path: (req as any).file?.path ?? null } })) return;
    await handleUpload(req, res, body.class_id);
  }),
);

// --- Review a sheet --------------------------------------------------------
// Task name (GET /results/review/:sheetId) + contract name (GET /result-sheets/:id).
async function handleReview(req: any, res: any, sheetId: string): Promise<void> {
  const data = await service.getSheetForReview(getDb(), schoolIdOf(req), sheetId);
  res.json({ ok: true, data });
}

resultsRouter.get(
  '/results/review/:sheetId',
  asyncHandler(async (req, res) => {
    const { sheetId } = parseBody(sheetIdParams, req.params);
    await handleReview(req, res, sheetId);
  }),
);

resultsRouter.get(
  '/result-sheets/:id',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    await handleReview(req, res, id);
  }),
);

// --- Confirm (save) reviewed rows ------------------------------------------
// Task name (POST /results/:sheetId/save) + contract name
// (POST /result-sheets/:id/confirm) — same handler.
async function handleConfirm(req: any, res: any, sheetId: string): Promise<void> {
  const body = parseBody(z.object({ rows: z.array(rowSchema).min(1) }), req.body);
  if (await queueIfClerk(req, res, { actionType: 'create', entity: 'result', payload: { result_sheet_id: sheetId, rows: body.rows } })) return;
  const sheet = await service.getSheetForReview(getDb(), schoolIdOf(req), sheetId);
  const examId = (sheet.exam as Record<string, unknown>).id as string;
  const classId = (sheet.class as Record<string, unknown>).id as string;
  const out = await service.saveResultRows(getDb(), schoolIdOf(req), { exam_id: examId, class_id: classId, result_sheet_id: sheetId, rows: body.rows }, req.user!.sub);
  res.json({ ok: true, data: out });
}

resultsRouter.post(
  '/result-sheets/:id/confirm',
  requireAdminOrClerk,
  requireQueueable('results', 'create'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    await handleConfirm(req, res, id);
  }),
);

resultsRouter.post(
  '/results/:sheetId/save',
  requireAdminOrClerk,
  requireQueueable('results', 'create'),
  asyncHandler(async (req, res) => {
    const { sheetId } = parseBody(sheetIdParams, req.params);
    await handleConfirm(req, res, sheetId);
  }),
);

// --- Publish (admin-approved SMS drafts to parents) -------------------------
resultsRouter.post(
  '/result-sheets/:id/publish',
  requireAdminOrClerk,
  requireQueueable('results', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const out = await service.publishSheetSms(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: out });
  }),
);

// --- Manual entry ------------------------------------------------------------
resultsRouter.post(
  '/results/manual',
  requireAdminOrClerk,
  requireQueueable('results', 'create'),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        exam_id: uuidSchema.optional(),
        exam_name: z.string().min(1).max(120).optional(),
        exam_type: z.enum(['monthly', 'midterm', 'annual']).optional(),
        class_id: uuidSchema,
        session_id: uuidSchema.optional().nullable(),
        rows: z.array(rowSchema).min(1),
      }),
      req.body,
    );
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'result', payload: body })) return;
    const out = await service.saveManualResults(getDb(), schoolIdOf(req), body, req.user!.sub);
    res.json({ ok: true, data: out });
  }),
);

// --- Results: list / toppers / summary / export / report card ---------------
// NOTE: /results/toppers, /results/summary, /results/export and
// /results/report-card/* must precede /results/:id or Express would treat
// "toppers" as an id.
resultsRouter.get(
  '/results/toppers',
  asyncHandler(async (req, res) => {
    const items = await service.getToppers(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data: { items, total: items.length, page: 1, pages: 1 } });
  }),
);

resultsRouter.get(
  '/results/summary',
  asyncHandler(async (req, res) => {
    const data = await service.getSummary(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data });
  }),
);

resultsRouter.get(
  '/results/export',
  asyncHandler(async (req, res) => {
    const out = await service.exportResults(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
  }),
);

resultsRouter.get(
  '/results/report-card/:student_id/:exam_id',
  asyncHandler(async (req, res) => {
    const params = parseBody(z.object({ student_id: uuidSchema, exam_id: uuidSchema }), req.params);
    const card = await service.getReportCard(getDb(), schoolIdOf(req), params.student_id, params.exam_id);
    if (String(req.query.format ?? '') === 'pdf') {
      const pdf = await service.renderReportCardPdf(card);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="report-card-${params.student_id.slice(0, 8)}.pdf"`);
      res.send(pdf);
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(service.renderReportCardHtml(card));
  }),
);

// Contract alias: GET /students/:id/report-card?exam_id=
resultsRouter.get(
  '/students/:id/report-card',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const examId = String(req.query.exam_id ?? '');
    if (!examId) {
      res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'exam_id query param is required' } });
      return;
    }
    const card = await service.getReportCard(getDb(), schoolIdOf(req), id, examId);
    if (String(req.query.format ?? '') === 'pdf') {
      const pdf = await service.renderReportCardPdf(card);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="report-card-${id.slice(0, 8)}.pdf"`);
      res.send(pdf);
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(service.renderReportCardHtml(card));
  }),
);

resultsRouter.get(
  '/results',
  asyncHandler(async (req, res) => {
    const result = await service.listResults(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data: result });
  }),
);

resultsRouter.get(
  '/results/:id',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const row = await service.getResult(getDb(), schoolIdOf(req), id);
    res.json({ ok: true, data: service.toPublicResult(row) });
  }),
);

resultsRouter.patch(
  '/results/:id',
  requireAdminOrClerk,
  requireQueueable('results', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const patch = parseBody(rowSchema.partial(), req.body);
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'result', entityId: id, payload: { id, patch } })) return;
    const updated = await service.updateResult(getDb(), schoolIdOf(req), id, patch, req.user!.sub);
    res.json({ ok: true, data: service.toPublicResult(updated) });
  }),
);

// Explicit link (admin-confirmed in the UI): attach an unlinked row to an
// existing student in the same class. Never creates a student.
resultsRouter.post(
  '/results/:id/link',
  requireAdminOrClerk,
  requireQueueable('results', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const body = parseBody(z.object({ student_id: uuidSchema }), req.body);
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'result', entityId: id, payload: { id, link_student_id: body.student_id } })) return;
    const updated = await service.linkResult(getDb(), schoolIdOf(req), id, body.student_id, req.user!.sub);
    res.json({ ok: true, data: service.toPublicResult(updated) });
  }),
);

resultsRouter.delete(
  '/results/:id',
  requireAdminOrClerk,
  requireQueueable('results', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'result', entityId: id, payload: { id } })) return;
    await service.deleteResult(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Result deleted (moved to recycle bin — restorable for 30 days)' } });
  }),
);

resultsRouter.delete(
  '/result-sheets/:id',
  requireAdminOrClerk,
  requireQueueable('results', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'result_sheet', entityId: id, payload: { id } })) return;
    await service.deleteResultSheet(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Result sheet deleted (moved to recycle bin — restorable for 30 days)' } });
  }),
);

// NOTE (6B): /exams list/create/update/delete + datesheets + grading
// scales live in the 6C-1 exams router (modules/exams/**) — this router
// deliberately defines NO /exams routes. The results flow creates exam
// rows internally via upsertExam (service.ts) when a sheet/manual entry
// names an exam that does not exist yet.
