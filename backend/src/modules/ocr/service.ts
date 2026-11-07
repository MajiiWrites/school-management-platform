// OCR service: upload -> OCR -> parse -> review -> confirm-as-students.
// Depends on the narrow OcrDb interface (see below) so it can be unit-tested
// with a fake; prisma-adapter.ts maps the real Prisma client onto it.
// Multi-tenancy: every call is scoped by schoolId (never trust client input).
import { parseStudentList, type ParsedRow, type ExistingStudent } from './parser.js';
import { normalizePkPhone, hashPhone, normalizeName } from './phone.js';
import { runOcr, inspectImage, runTesseract, OcrUnavailableError } from './ocr-engine.js';
import { encryptPhone } from './crypto.js';

/**
 * "No number" markers: a list with no parent phone shows "-" in the Parent
 * Number field. "-" is NOT a phone — it is never validated, never
 * encrypted, never hashed, and never treated as a valid SMS number. A
 * student saved with "-" (or blank) has parentPhoneEnc = null, so the
 * Students/Parents views flag them 'missing' ("Missing number" list) and
 * the SMS sender skips them with reason 'missing_phone'. Never invent or
 * guess a number.
 */
export const MISSING_PHONE_TOKENS = new Set(['', '-', '—', '--', 'n/a', 'na', 'nil', 'none', 'no number']);

/** True when the value means "no parent number" (not a phone at all). */
export function isMissingPhoneValue(raw: string | null | undefined): boolean {
  if (raw == null) return true;
  return MISSING_PHONE_TOKENS.has(raw.trim().toLowerCase());
}

/**
 * Second verification pass: re-run OCR with a DIFFERENT psm (4 = single
 * column of text of variable sizes) and compare the names it reads with
 * the primary pass. Rows whose Latin name the verification pass also read
 * are 'match'; rows it did not read are 'mismatch' and get their
 * confidence capped at 0.55 so the review screen highlights them.
 * Urdu-only rows cannot be verified by the Latin pass and stay
 * 'unverified'. A failed verification run never fails the upload — every
 * row is then 'unverified' and the upload carries a warning.
 */
export function applyVerification(primary: ParsedRow[], verificationText: string | null): ParsedRow[] {
  if (verificationText === null) {
    return primary.map((r) => ({ ...r, verification: 'unverified' as const }));
  }
  const verifiedNames = new Set(parseStudentList(verificationText).map((r) => normalizeName(r.name)));
  return primary.map((r) => {
    const hasLatinName = /[A-Za-z]/.test(r.name);
    if (!hasLatinName) return { ...r, verification: 'unverified' as const };
    if (verifiedNames.has(normalizeName(r.name))) return { ...r, verification: 'match' as const };
    return { ...r, verification: 'mismatch' as const, confidence: Math.min(r.confidence, 0.55) };
  });
}

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
  parent_phone?: string | null; // raw; normalized + hashed by the service. "-" (or blank) = no number, never validated.
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
    rows: { name: string; name_ur: string | null; roll_no: number | null; parent_name: string | null; parent_phone_enc: string | null; parent_phone_hash: string | null }[],
  ): Promise<{ created: number }>;
  /** Scoped read of the upload's stored file path (for the image endpoint). */
  getUploadFile(schoolId: string, uploadId: string): Promise<{ file_path: string } | null>;  createAuditLog(entry: { school_id: string; actor_id: string | null; actor_type: string; action: string; entity: string; entity_id: string | null; details: Record<string, unknown> }): Promise<void>;
}

export interface UploadResult {
  upload_id: string;
  raw_text: string;
  rows: ParsedRow[];
  engine: string;
  warnings: string[];
  /** Authenticated image endpoint for the zoomable review view. */
  image_url: string;
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
      /** Override the SECOND verification pass (tests inject a stub). */
      runVerificationOcr?: (filePath: string) => Promise<{ raw_text: string }>;
      /** Override the pre-OCR image inspection (rotation warnings). */
      inspectImage?: (filePath: string) => Promise<string[]>;
    } = {},
  ) {}

  private encrypt(normalized: string): string {
    return this.opts.encryptPhone ? this.opts.encryptPhone(normalized) : encryptPhone(normalized);
  }

  private async ocr(filePath: string) {
    return this.opts.runOcr ? this.opts.runOcr(filePath) : runOcr(filePath);
  }

  private async verify(filePath: string): Promise<string | null> {
    try {
      // Different psm (4) from the primary pass (6): a genuinely
      // independent second read, not the same output twice.
      const res = this.opts.runVerificationOcr
        ? await this.opts.runVerificationOcr(filePath)
        : await runTesseract(filePath, 'eng', 120_000, '4');
      return res.raw_text;
    } catch {
      return null; // verification is best-effort; never fails the upload
    }
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
      const imageWarnings = this.opts.inspectImage
        ? await this.opts.inspectImage(filePath)
        : await inspectImage(filePath);
      const ocr = await this.ocr(filePath);
      const existing = await this.db.listStudents(schoolId, classId);
      const parsed = parseStudentList(ocr.raw_text, existing);
      const verificationText = await this.verify(filePath);
      const rows = applyVerification(parsed, verificationText);
      const warnings = [...imageWarnings, ...ocr.warnings];
      if (verificationText === null) {
        warnings.push('Second verification pass did not run — check low-confidence rows carefully.');
      } else {
        const mismatches = rows.filter((r) => r.verification === 'mismatch').length;
        if (mismatches > 0) {
          warnings.push(`${mismatches} name(s) were not confirmed by the second OCR pass — they are highlighted for review.`);
        }
      }
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
      return { upload_id: upload.id, raw_text: ocr.raw_text, rows, engine: ocr.engine, warnings, image_url: `/ocr-uploads/${upload.id}/image` };
    } catch (err) {
      await this.db.updateUpload(schoolId, upload.id, { status: 'failed' }).catch(() => undefined);
      throw err;
    }
  }

  /** Scoped file path for the image endpoint (404 when not this school's upload). */
  async getUploadImage(schoolId: string, uploadId: string): Promise<{ file_path: string }> {
    const upload = await this.db.getUploadFile(schoolId, uploadId);
    if (!upload) {
      const err = new Error('OCR upload not found') as Error & { status?: number; code?: string };
      err.status = 404; err.code = 'NOT_FOUND';
      throw err;
    }
    return { file_path: upload.file_path };
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
      // Re-parsed from stored raw text: verification is not persisted (no
      // schema change), so a re-opened review shows 'unverified'.
      rows: rows.map((r) => ({ ...r, verification: 'unverified' as const })),
      engine: 'tesseract',
      warnings: [],
      image_url: `/ocr-uploads/${upload.id}/image`,
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
    const existingRolls = new Set(existing.map((s) => s.roll_no).filter((r): r is number => r != null));

    const seenNames = new Set<string>();
    const seenRolls = new Set<number>();
    const toCreate: { name: string; name_ur: string | null; roll_no: number | null; parent_name: string | null; parent_phone_enc: string | null; parent_phone_hash: string | null }[] = [];
    const skipped: { row: NewStudentInput; reason: string }[] = [];

    for (const [i, row] of rows.entries()) {
      const name = (row.name ?? '').trim();
      if (!name) {
        skipped.push({ row, reason: `row ${i}: name is required` });
        continue;
      }
      // "-" (or blank / "n/a" / ...) means NO parent number: save the
      // student with no phone (parentPhoneEnc null) — never validate "-"
      // as a phone, never encrypt it, never skip the row for it.
      let phoneNorm: string | null = null;
      if (!isMissingPhoneValue(row.parent_phone)) {
        phoneNorm = normalizePkPhone(row.parent_phone!);
        if (!phoneNorm) {
          skipped.push({ row, reason: `row ${i}: invalid parent phone "${row.parent_phone}"` });
          continue;
        }
      }
      const phoneHash = phoneNorm ? hashPhone(phoneNorm) : null;
      const nameNorm = normalizeName(name);
      const roll = row.roll_no ?? null;

      // R2-D (b): same rule as parseStudentList — a shared parent phone
      // alone is NOT a duplicate (siblings share a number); only the same
      // normalized name or the same roll number in the class counts. The
      // old phone-alone branch silently skipped every sibling after the
      // first at save time even when review showed no flag.
      let reason: string | null = null;
      if (existingNames.has(nameNorm) || seenNames.has(nameNorm)) reason = 'duplicate_name';
      else if (roll !== null && (existingRolls.has(roll) || seenRolls.has(roll))) reason = 'duplicate_roll_no';
      if (reason) {
        skipped.push({ row, reason });
        continue;
      }

      seenNames.add(nameNorm);
      if (roll !== null) seenRolls.add(roll);
      toCreate.push({
        name,
        name_ur: row.name_ur?.trim() || null,
        roll_no: roll,
        parent_name: row.parent_name?.trim() || null,
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
