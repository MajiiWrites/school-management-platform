// OCR routes (contracts/API.md). Mounted by the Backend Agent under /api/v1
// — see MOUNT.md. This module never edits app.ts itself.
//
//   POST /classes/:id/ocr-upload
//   GET  /ocr-uploads/:id
//   POST /classes/:id/ocr-upload/:upload_id/confirm
//
// Auth/tenant middleware is injected by the caller (backend middleware/auth.ts
// + tenant.ts): it sets req.schoolId and req.user (AccessPayload; the user id
// is req.user.sub). In tests a stub is passed.
import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { OcrService, OcrUnavailableError, type OcrDb } from './service.js';

export interface AuthedRequest extends Request {
  schoolId?: string;
  // NB: `user` is NOT redeclared here — the global Express.Request type
  // (src/types/express.d.ts) already provides `user?: AccessPayload`.
}

export interface OcrRouterDeps {
  db: OcrDb;
  /** Auth middleware from the backend module (JWT + tenant). Required in production. */
  auth: RequestHandler;
  uploadDir?: string; // default: env UPLOAD_DIR + '/ocr' or './uploads/ocr'
  encryptPhone?: (normalized: string) => string;
}

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ ok: true, data });
}

/** Express 5 types params as string | string[]; routes use single-value params. */
function param(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

function fail(res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void {
  res.status(status).json({ ok: false, error: { code, message, ...(extra ?? {}) } });
}

function isHttpError(err: unknown): err is Error & { status?: number; code?: string } {
  return err instanceof Error;
}

export function createOcrRouter(deps: OcrRouterDeps): Router {
  const uploadDir = path.resolve(deps.uploadDir ?? process.env.UPLOAD_DIR ?? './uploads/ocr');
  fs.mkdirSync(uploadDir, { recursive: true });
  const service = new OcrService(deps.db, { encryptPhone: deps.encryptPhone });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      cb(null, `${randomUUID()}${ext}`);
    },
  });
  const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter: (_req, file, cb) => {
      if (IMAGE_MIMES.has(file.mimetype)) cb(null, true);
      else cb(new Error(`Unsupported file type "${file.mimetype}". Upload a JPG, PNG or WebP photo of the student list.`));
    },
  });

  const router = Router();

  const asyncHandler =
    (fn: (req: AuthedRequest, res: Response) => Promise<void>): RequestHandler =>
    (req, res, next) => {
      fn(req as AuthedRequest, res).catch(next);
    };

  const handleError = (err: unknown, res: Response): void => {
    if (err instanceof OcrUnavailableError) {
      fail(res, 503, 'OCR_UNAVAILABLE', err.message, { setup: err.setup });
      return;
    }
    if (isHttpError(err) && err.status) {
      fail(res, err.status, err.code ?? 'VALIDATION', err.message);
      return;
    }
    if (err instanceof Error && /Unsupported file type/.test(err.message)) {
      fail(res, 400, 'VALIDATION', err.message);
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[ocr] unexpected error', err);
    fail(res, 500, 'INTERNAL', 'Unexpected server error while processing the OCR upload.');
  };

  // POST /classes/:id/ocr-upload — multipart image -> {upload_id, raw_text, rows}
  router.post(
    '/classes/:id/ocr-upload',
    deps.auth,
    upload.single('image'),
    asyncHandler(async (req, res) => {
      try {
        const schoolId = req.schoolId;
        if (!schoolId) return fail(res, 401, 'UNAUTHORIZED', 'Missing tenant context.');
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file) return fail(res, 400, 'VALIDATION', 'No image uploaded. Send a multipart field named "image".');
        const result = await service.uploadAndParse(schoolId, param(req, 'id'), req.user?.sub ?? null, file.path);
        return ok(res, result, 201);
      } catch (err) {
        return handleError(err, res);
      }
    }),
  );

  // GET /ocr-uploads/:id — review data (raw_text + parsed rows, duplicates flagged fresh)
  router.get(
    '/ocr-uploads/:id',
    deps.auth,
    asyncHandler(async (req, res) => {
      try {
        const schoolId = req.schoolId;
        if (!schoolId) return fail(res, 401, 'UNAUTHORIZED', 'Missing tenant context.');
        const result = await service.getUploadForReview(schoolId, param(req, 'id'));
        return ok(res, result);
      } catch (err) {
        return handleError(err, res);
      }
    }),
  );

  // POST /classes/:id/ocr-upload/:upload_id/confirm — save edited rows as students
  router.post(
    '/classes/:id/ocr-upload/:upload_id/confirm',
    deps.auth,
    asyncHandler(async (req, res) => {
      try {
        const schoolId = req.schoolId;
        if (!schoolId) return fail(res, 401, 'UNAUTHORIZED', 'Missing tenant context.');
        const rows = (req.body as { rows?: unknown })?.rows;
        if (!Array.isArray(rows)) {
          return fail(res, 400, 'VALIDATION', 'Body must be {rows: [...edited rows...]}.');
        }
        const result = await service.confirmRows(
          schoolId,
          param(req, 'id'),
          param(req, 'upload_id'),
          req.user?.sub ?? null,
          rows as never,
        );
        return ok(res, result);
      } catch (err) {
        return handleError(err, res);
      }
    }),
  );

  // Multer / unexpected errors on this router
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof Error && err.message.includes('File too large')) {
      return fail(res, 400, 'VALIDATION', 'Image is larger than 10 MB.');
    }
    return handleError(err, res);
  });

  return router;
}

export { OcrService };
export default createOcrRouter;
