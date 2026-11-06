// OCR service: upload -> OCR -> parse -> review -> confirm-as-students.
// Depends on the narrow OcrDb interface (see below) so it can be unit-tested
// with a fake; prisma-adapter.ts maps the real Prisma client onto it.
// Multi-tenancy: every call is scoped by schoolId (never trust client input).
import { parseStudentList, type ParsedRow, type ExistingStudent } from './parser.js';
import { normalizePkPhone, hashPhone, normalizeName } from './phone.js';
import { runOcr, OcrUnavailableError } from './ocr-engine.js';
import { encryptPhone } from './crypto.js';

export { OcrUnavailableError };

export interface UploadRecord {
  id: string;
  school_id: string;
  class_id: string;
  file_path: string;
  status: 'processing' | 'review' | 'saved' | 'failed';
  raw_text: string | null;
}

export interface NewStudentInput {
  name: string;
  name_ur?: string | null;
  roll_no?: number | null;
  parent_name?: string | null;
  parent_phone?: string | null; // raw; normalized + hashed by the service
}

export interface OcrDb {
  getClass(schoolId: string, classId: string): Promise<{ id: string } | null>;
  listStudents(schoolId: string, classId: string): Promise<ExistingStudent[]>;
  createUpload(data: { school_id: string; class_id: string; file_path: string }): Promise<{ id: string }>;
  getUpload(schoolId: string, uploadId: string): Promise<UploadRecord | null>;
  /** Scoped update: only touches the upload when it belongs to `schoolId` (else throws 404). */
  updateUpload(schoolId: string, uploadId: string, data: { status?: UploadRecord['status']; raw_text?: string }): Promise<void>;
  createStudents(
    schoolId: string,
    classId: string,
    rows: { name: string; name_ur: string | null; roll_no: number | null; parent_phone_enc: string | null; parent_phone_hash: string | null }[],
  ): Promise<{ created: number }>;
  createAuditLog(entry: { school_id: string; actor_id: string | null; actor_type: string; action: string; entity: string; entity_id: string | null; details: Record<string, unknown> }): Promise<void>;
}

export interface UploadResult {
  upload_id: string;
  raw_text: string;
  rows: ParsedRow[];
  engine: string;
  warnings: string[];
}

export interface ConfirmResult {
  saved: number;
  skipped_duplicates: number;
  skipped: { row: NewStudentInput; reason: string }[];
}

/**
 * Phone encryption uses AES-256-GCM (crypto.ts, key from PHONE_ENC_KEY) per
 * contracts/SCHEMA.md. An encryptPhone override may be injected (e.g. the
 * shared backend lib/crypto.ts) — it must use the identical format.
 */
export class OcrService {
  constructor(
    private db: OcrDb,
    private opts: {
      encryptPhone?: (normalized: string) => string;
      /** Override the OCR runner (tests inject a stub; production uses runOcr). */
      runOcr?: (filePath: string) => Promise<{ raw_text: string; engine: string; warnings: string[] }>;
    } = {},
  ) {}

  private encrypt(normalized: string): string {
    return this.opts.encryptPhone ? this.opts.encryptPhone(normalized) : encryptPhone(normalized);
  }

  private async ocr(filePath: string) {
    return this.opts.runOcr ? this.opts.runOcr(filePath) : runOcr(filePath);
  }

  async uploadAndParse(
    schoolId: string,
    classId: string,
    actorId: string | null,
    filePath: string,
  ): Promise<UploadResult> {
    const klass = await this.db.getClass(schoolId, classId);
    if (!klass) {
      const err = new Error('Class not found') as Error & { status?: number; code?: string };
      err.status = 404; err.code = 'NOT_FOUND';
      throw err;
    }
    const upload = await this.db.createUpload({ school_id: schoolId, class_id: classId, file_path: filePath });
    try {
      const ocr = await this.ocr(filePath);
      const existing = await this.db.listStudents(schoolId, classId);
      const rows = parseStudentList(ocr.raw_text, existing);
      await this.db.updateUpload(schoolId, upload.id, { status: 'review', raw_text: ocr.raw_text });
      await this.db.createAuditLog({
        school_id: schoolId,
        actor_id: actorId,
        actor_type: 'user',
        action: 'ocr.upload',
        entity: 'ocr_upload',
        entity_id: upload.id,
        details: { class_id: classId, engine: ocr.engine, rows_found: rows.length },
      });
      return { upload_id: upload.id, raw_text: ocr.raw_text, rows, engine: ocr.engine, warnings: ocr.warnings };
    } catch (err) {
      await this.db.updateUpload(schoolId, upload.id, { status: 'failed' }).catch(() => undefined);
      throw err;
    }
  }

  async getUploadForReview(schoolId: string, uploadId: string): Promise<UploadResult & { class_id: string; status: string }> {
    const upload = await this.db.getUpload(schoolId, uploadId);
    if (!upload) {
      const err = new Error('OCR upload not found') as Error & { status?: number; code?: string };
      err.status = 404; err.code = 'NOT_FOUND';
      throw err;
    }
    const existing = await this.db.listStudents(schoolId, upload.class_id);
    const rows = parseStudentList(upload.raw_text ?? '', existing);
    return {
      upload_id: upload.id,
      class_id: upload.class_id,
      status: upload.status,
      raw_text: upload.raw_text ?? '',
      rows,
      engine: 'tesseract',
      warnings: [],
    };
  }

  /** Save admin-edited rows as students. Merge semantics: skip duplicates, never overwrite. */
  async confirmRows(
    schoolId: string,
    classId: string,
    uploadId: string,
    actorId: string | null,
    rows: NewStudentInput[],
  ): Promise<ConfirmResult> {
    const klass = await this.db.getClass(schoolId, classId);
    if (!klass) {
      const err = new Error('Class not found') as Error & { status?: number; code?: string };
      err.status = 404; err.code = 'NOT_FOUND';
      throw err;
    }
    const upload = await this.db.getUpload(schoolId, uploadId);
    if (!upload || upload.class_id !== classId) {
      const err = new Error('OCR upload not found') as Error & { status?: number; code?: string };
      err.status = 404; err.code = 'NOT_FOUND';
      throw err;
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      const err = new Error('rows must be a non-empty array') as Error & { status?: number; code?: string };
      err.status = 400; err.code = 'VALIDATION';
      throw err;
    }

    const existing = await this.db.listStudents(schoolId, classId);
    const existingNames = new Set(existing.map((s) => normalizeName(s.name)));
    const existingPhones = new Set(existing.map((s) => s.parent_phone_hash).filter((h): h is string => !!h));
    const existingRolls = new Set(existing.map((s) => s.roll_no).filter((r): r is number => r != null));

    const seenNames = new Set<string>();
    const seenPhones = new Set<string>();
    const seenRolls = new Set<number>();
    const toCreate: { name: string; name_ur: string | null; roll_no: number | null; parent_phone_enc: string | null; parent_phone_hash: string | null }[] = [];
    const skipped: { row: NewStudentInput; reason: string }[] = [];

    for (const [i, row] of rows.entries()) {
      const name = (row.name ?? '').trim();
      if (!name) {
        skipped.push({ row, reason: `row ${i}: name is required` });
        continue;
      }
      let phoneNorm: string | null = null;
      if (row.parent_phone) {
        phoneNorm = normalizePkPhone(row.parent_phone);
        if (!phoneNorm) {
          skipped.push({ row, reason: `row ${i}: invalid parent phone "${row.parent_phone}"` });
          continue;
        }
      }
      const phoneHash = phoneNorm ? hashPhone(phoneNorm) : null;
      const nameNorm = normalizeName(name);
      const roll = row.roll_no ?? null;

      let reason: string | null = null;
      if (existingNames.has(nameNorm) || seenNames.has(nameNorm)) reason = 'duplicate_name';
      else if (phoneHash && (existingPhones.has(phoneHash) || seenPhones.has(phoneHash))) reason = 'duplicate_phone';
      else if (roll !== null && (existingRolls.has(roll) || seenRolls.has(roll))) reason = 'duplicate_roll_no';
      if (reason) {
        skipped.push({ row, reason });
        continue;
      }

      seenNames.add(nameNorm);
      if (phoneHash) seenPhones.add(phoneHash);
      if (roll !== null) seenRolls.add(roll);
      toCreate.push({
        name,
        name_ur: row.name_ur?.trim() || null,
        roll_no: roll,
        parent_phone_enc: phoneNorm ? this.encrypt(phoneNorm) : null,
        parent_phone_hash: phoneHash,
      });
    }

    let saved = 0;
    if (toCreate.length > 0) {
      const res = await this.db.createStudents(schoolId, classId, toCreate);
      saved = res.created;
    }
    await this.db.updateUpload(schoolId, uploadId, { status: 'saved' });
    await this.db.createAuditLog({
      school_id: schoolId,
      actor_id: actorId,
      actor_type: 'user',
      action: 'ocr.confirm',
      entity: 'ocr_upload',
      entity_id: uploadId,
      details: { class_id: classId, saved, skipped_duplicates: skipped.length },
    });

    return { saved, skipped_duplicates: skipped.length, skipped };
  }
}
