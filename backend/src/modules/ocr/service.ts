// OCR service: upload -> OCR -> parse -> review -> confirm-as-students.
// Depends on the narrow OcrDb interface (see below) so it can be unit-tested
// with a fake; prisma-adapter.ts maps the real Prisma client onto it.
// Multi-tenancy: every call is scoped by schoolId (never trust client input).
import { parseStudentList, type ParsedRow, type ExistingStudent } from './parser.js';
import {
  parseTableWords,
  applyTableVerification,
  tableRowsToText,
  parseTableTextLines,
} from './table.js';
import { normalizePkPhone, hashPhone, normalizeName } from './phone.js';
import {
  inspectImage,
  runTesseract,
  runTesseractTsv,
  preprocessImage,
  mergeDualPass,
  OcrUnavailableError,
  type OcrWord,
  type PreprocessResult,
} from './ocr-engine.js';
import { encryptPhone } from './crypto.js';

/**
 * SPEED (measured 2026-11-07 on the real 20-row table photo, this VM):
 * the old pipeline ran up to 4-5 sequential Tesseract invocations per
 * upload, each preprocessing the image again (sharp + an OSD Tesseract
 * run, ~1.3s) — table path 8.08s, text path 6.06s locally, ~3-3.5 min
 * live on the Render free tier. The fixes:
 * - ONE preprocess per upload (1000px downscale), shared by all passes.
 * - Early-exit: a clean high-confidence table read skips the second
 *   verification pass entirely.
 * - English-first text path: the Urdu pass runs only when the English
 *   pass leaves rows unparsed (mixed/Urdu lists).
 * - NO parallel Tesseract: measured 102.5s for two concurrent passes vs
 *   8.08s sequential — two Tesseract processes thrash the CPU (each
 *   spawns OpenMP threads). Sequential + fewer passes wins.
 * - One student-OCR at a time per server process (serial queue below):
 *   two concurrent uploads would thrash the same way.
 */
export const OCR_TABLE_MIN_CONFIDENCE_EARLY_EXIT = 0.85;
export const OCR_PREP_MAX_WIDTH = 1000;
export const OCR_PREP_FULL_WIDTH = 3000;

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
  /** 'reading'/'verifying' are live progress stages (polled by the review
   * page while an upload runs); 'processing' is the initial state. */
  status: 'processing' | 'reading' | 'verifying' | 'review' | 'saved' | 'failed';
  raw_text: string | null;
  /** Stored JSON of the finished result {rows, warnings, engine} — lets a
   * re-opened review show the same rows + verification flags + warnings
   * instead of re-parsing raw_text (which drops them). Null for uploads
   * finished before this field existed. */
  result_json?: string | null;
}

export interface NewStudentInput {
  name: string;
  name_ur?: string | null;
  roll_no?: number | null;
  parent_name?: string | null;
  parent_name_ur?: string | null;
  parent_phone?: string | null; // raw; normalized + hashed by the service. "-" (or blank) = no number, never validated.
}

export interface OcrDb {
  getClass(schoolId: string, classId: string): Promise<{ id: string } | null>;
  listStudents(schoolId: string, classId: string): Promise<ExistingStudent[]>;
  createUpload(data: { school_id: string; class_id: string; file_path: string }): Promise<{ id: string }>;
  getUpload(schoolId: string, uploadId: string): Promise<UploadRecord | null>;
  /** Scoped update: only touches the upload when it belongs to `schoolId` (else throws 404). */
  updateUpload(schoolId: string, uploadId: string, data: { status?: UploadRecord['status']; raw_text?: string; result_json?: string }): Promise<void>;
  createStudents(
    schoolId: string,
    classId: string,
    rows: { name: string; name_ur: string | null; roll_no: number | null; parent_name: string | null; parent_name_ur: string | null; parent_phone_enc: string | null; parent_phone_hash: string | null }[],
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
      /**
       * Override the ENGLISH text OCR pass (tests inject a stub;
       * production runs Tesseract `eng` psm 6 on the prepared file).
       * This used to be the whole dual-pass OCR; since the speed work it
       * is the FIRST pass only — the Urdu pass runs only when the English
       * pass leaves rows unparsed (see runUrdOcr).
       */
      runOcr?: (filePath: string, preparedPath?: string) => Promise<{ raw_text: string; engine: string; warnings: string[] }>;
      /** Override the URDU text pass (tests inject a stub). */
      runUrdOcr?: (filePath: string, preparedPath?: string) => Promise<{ raw_text: string }>;
      /** Override the SECOND verification pass (tests inject a stub). */
      runVerificationOcr?: (filePath: string, preparedPath?: string) => Promise<{ raw_text: string }>;
      /** Override the TABLE pass (TSV word boxes; tests inject a stub). */
      runTableOcr?: (filePath: string, preparedPath?: string) => Promise<OcrWord[]>;
      /** Override the TABLE verification pass (tests inject a stub). */
      runTableVerifyOcr?: (filePath: string, preparedPath?: string) => Promise<OcrWord[]>;
      /** Override the pre-OCR image inspection (rotation warnings). */
      inspectImage?: (filePath: string) => Promise<string[]>;
      /** Override the one-per-upload preprocessing (tests inject a stub). */
      preprocessImage?: (filePath: string, opts?: { maxWidth?: number }) => Promise<PreprocessResult>;
    } = {},
  ) {}

  private encrypt(normalized: string): string {
    return this.opts.encryptPhone ? this.opts.encryptPhone(normalized) : encryptPhone(normalized);
  }

  private async prepare(filePath: string, maxWidth: number): Promise<PreprocessResult> {
    return this.opts.preprocessImage
      ? this.opts.preprocessImage(filePath, { maxWidth })
      : preprocessImage(filePath, { maxWidth });
  }

  /** English text pass on the shared prepared file. */
  private async ocr(filePath: string, preparedPath: string) {
    return this.opts.runOcr
      ? this.opts.runOcr(filePath, preparedPath)
      : runTesseract(filePath, 'eng', 180_000, '6', { preparedPath });
  }

  /** Urdu text pass on the shared prepared file (mixed/Urdu lists only). */
  private async ocrUrd(filePath: string, preparedPath: string): Promise<string> {
    if (this.opts.runUrdOcr) return (await this.opts.runUrdOcr(filePath, preparedPath)).raw_text;
    const res = await runTesseract(filePath, 'urd', 180_000, '6', { preparedPath });
    return res.raw_text;
  }

  private async verify(filePath: string, preparedPath: string): Promise<string | null> {
    try {
      // Different psm (4) from the primary pass (6): a genuinely
      // independent second read, not the same output twice.
      const res = this.opts.runVerificationOcr
        ? await this.opts.runVerificationOcr(filePath, preparedPath)
        : await runTesseract(filePath, 'eng', 120_000, '4', { preparedPath });
      return res.raw_text;
    } catch {
      return null; // verification is best-effort; never fails the upload
    }
  }

  private async tableOcr(filePath: string, preparedPath: string): Promise<OcrWord[]> {
    return this.opts.runTableOcr
      ? this.opts.runTableOcr(filePath, preparedPath)
      : runTesseractTsv(filePath, 'eng', '11', 180_000, { preparedPath });
  }

  private async tableVerifyOcr(filePath: string, preparedPath: string): Promise<OcrWord[]> {
    return this.opts.runTableVerifyOcr
      ? this.opts.runTableVerifyOcr(filePath, preparedPath)
      : runTesseractTsv(filePath, 'eng', '3', 180_000, { preparedPath });
  }

  /**
   * Serial queue: ONE student-OCR at a time per server process. Two
   * concurrent Tesseract runs thrash the CPU (measured 2026-11-07:
   * 102.5s for two parallel passes vs 8.08s sequential — each Tesseract
   * process spawns OpenMP threads) — uploads queue instead of slowing
   * each other down. The queue only gates the OCR work, never the HTTP
   * response: the route returns 202 immediately and the review page polls
   * the upload status (reading → verifying → review).
   */
  private static ocrQueue: Promise<void> = Promise.resolve();

  /** Create the upload record (class check + row) without running OCR. */
  async beginUpload(
    schoolId: string,
    classId: string,
    actorId: string | null,
    filePath: string,
  ): Promise<{ upload_id: string }> {
    const klass = await this.db.getClass(schoolId, classId);
    if (!klass) {
      const err = new Error('Class not found') as Error & { status?: number; code?: string };
      err.status = 404; err.code = 'NOT_FOUND';
      throw err;
    }
    const upload = await this.db.createUpload({ school_id: schoolId, class_id: classId, file_path: filePath });
    return { upload_id: upload.id };
  }

  /**
   * Run OCR on an existing upload record and store the result. Queued
   * behind any OCR already running on this process (see ocrQueue).
   * Marks the upload 'failed' on error (the route's background call
   * swallows the rejection — the status row is the signal).
   */
  async processUpload(
    schoolId: string,
    classId: string,
    actorId: string | null,
    uploadId: string,
    filePath: string,
  ): Promise<UploadResult> {
    const run = OcrService.ocrQueue.then(() =>
      this.doProcessUpload(schoolId, classId, actorId, uploadId, filePath),
    );
    OcrService.ocrQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doProcessUpload(
    schoolId: string,
    classId: string,
    actorId: string | null,
    uploadId: string,
    filePath: string,
  ): Promise<UploadResult> {
    try {
      const imageWarnings = this.opts.inspectImage
        ? await this.opts.inspectImage(filePath)
        : await inspectImage(filePath);
      const existing = await this.db.listStudents(schoolId, classId);
      const warnings = [...imageWarnings];
      let rows: ParsedRow[] = [];
      let raw_text = '';
      let engine = 'tesseract';

      await this.db.updateUpload(schoolId, uploadId, { status: 'reading' });
      // Preprocess ONCE (1000px downscale) and share the prepared file
      // across every pass below — the old code preprocessed per pass
      // (sharp + an OSD Tesseract run each time, ~1.3s a go).
      const prep = await this.prepare(filePath, OCR_PREP_MAX_WIDTH);
      let fullPrep: PreprocessResult | null = null;
      const getFullPrep = async (): Promise<PreprocessResult> => {
        if (!fullPrep) fullPrep = await this.prepare(filePath, OCR_PREP_FULL_WIDTH);
        return fullPrep;
      };
      try {
        // 1. TABLE path first (bordered/column tables): the plain-text pass
        // (psm 6) returns EMPTY text for grid tables, so the line parser saw
        // 0 rows even on perfectly readable photos. TSV word boxes keep the
        // geometry — rows by vertical overlap, columns by x position.
        // Best-effort: any failure here falls through to the text path.
        let tableUsed = false;
        try {
          let activePrep = prep;
          const tableWords = await this.tableOcr(filePath, prep.path);
          let table = parseTableWords(tableWords, existing);
          if (!table.detected) {
            // Fast-path miss: the 1000px read found no table — retry once
            // at full resolution before giving up on tables (small print).
            const fp = await getFullPrep();
            const words2 = await this.tableOcr(filePath, fp.path);
            const table2 = parseTableWords(words2, existing);
            if (table2.detected) {
              table = table2;
              activePrep = fp;
            }
          }
          if (table.detected && table.rows.length > 0) {
            // Early-exit: a clean high-confidence read skips the second
            // verification pass entirely. The pass costs ~3.8s locally
            // (far more on the free tier) and catches nothing on a clean
            // read — both passes even agree on the rare single-letter
            // misread (e.g. "Faroog" for "Farooq"), so the review screen
            // is the safety net either way. Rows are marked 'unverified'
            // (honest: no second pass ran) with a warning saying why.
            const clean =
              table.rows.every((r) => r.confidence >= OCR_TABLE_MIN_CONFIDENCE_EARLY_EXIT) &&
              (!table.columns.includes('phone') || table.rows.every((r) => r.parent_phone));
            if (clean) {
              rows = table.rows.map((r) => ({ ...r, verification: 'unverified' as const }));
              raw_text = tableRowsToText(rows);
              warnings.push(
                `Table layout detected — ${rows.length} rows read from ${table.columns.length} columns (${table.columns.join(' / ')}).`,
                `High-confidence read (all rows ≥${Math.round(OCR_TABLE_MIN_CONFIDENCE_EARLY_EXIT * 100)}%) — second verification pass skipped to save time; check rows against the photo as usual.`,
              );
            } else {
              await this.db.updateUpload(schoolId, uploadId, { status: 'verifying' });
              let verifiedNames: Set<string> | null = null;
              try {
                const verifyWords = await this.tableVerifyOcr(filePath, activePrep.path);
                verifiedNames = new Set(parseTableWords(verifyWords).rows.map((r) => normalizeName(r.name)));
              } catch {
                verifiedNames = null;
              }
              rows = applyTableVerification(table.rows, verifiedNames);
              raw_text = tableRowsToText(rows);
              warnings.push(
                `Table layout detected — ${rows.length} rows read from ${table.columns.length} columns (${table.columns.join(' / ')}).`,
              );
              if (verifiedNames === null) {
                warnings.push('Second verification pass did not run — check low-confidence rows carefully.');
              } else {
                const mismatches = rows.filter((r) => r.verification === 'mismatch').length;
                if (mismatches > 0) {
                  warnings.push(
                    `${mismatches} name(s) were not confirmed by the second OCR pass — they are highlighted for review.`,
                  );
                }
              }
            }
            tableUsed = true;
          }
        } catch {
          tableUsed = false;
        }

        // 2. TEXT path: English first; the Urdu pass runs ONLY when the
        // English pass leaves rows unparsed (mixed/Urdu lists). The old
        // code always ran both passes sequentially. The Urdu pass is also
        // skipped when the English read is empty at 1000px but succeeds
        // at full resolution (tiny print, not Urdu — an Urdu list still
        // yields garbage Latin text from the English pass, never empty).
        if (!tableUsed) {
          const eng = await this.ocr(filePath, prep.path);
          let engText = eng.raw_text;
          let engWarnings = eng.warnings;
          engine = eng.engine;
          if (engText.trim() === '') {
            const fp = await getFullPrep();
            const engFull = await this.ocr(filePath, fp.path);
            if (engFull.raw_text.trim() !== '') {
              engText = engFull.raw_text;
              engWarnings = engFull.warnings;
              engine = engFull.engine;
            }
          }
          let rawText = engText;
          let parsed = parseStudentList(rawText, existing);
          const lines = rawText.split(/\r?\n/).filter((l) => l.trim() !== '');
          // The Urdu pass runs only when the English pass looks incomplete:
          // no rows at all, most lines unparsed, or a parsed row that looks
          // like OCR garbage (no vowel, or weird characters — what the
          // English pass produces on Urdu-script lines). A clean
          // English-only list skips the Urdu pass entirely. Running it when
          // unsure is harmless (mergeDualPass discards Urdu-pass garbage),
          // but skipping it when the list is English-only saves a pass.
          const looksLikeGarbage = (r: ParsedRow): boolean => {
            const letters = r.name.replace(/[^A-Za-z]/g, '');
            if (letters.length === 0) return true;
            if (!/[aeiouAEIOU]/.test(letters)) return true;
            if (/[^A-Za-z\s.'-]/.test(r.name)) return true;
            return false;
          };
          const needsUrd =
            parsed.length === 0 ||
            (lines.length > 0 && parsed.length / lines.length < 0.6) ||
            parsed.some(looksLikeGarbage);
          if (needsUrd) {
            try {
              const urdText = await this.ocrUrd(filePath, prep.path);
              if (urdText.trim() !== '') rawText = mergeDualPass(engText, urdText);
              parsed = parseStudentList(rawText, existing);
            } catch {
              // Urdu pass is best-effort; the English parse stands.
            }
          }
          await this.db.updateUpload(schoolId, uploadId, { status: 'verifying' });
          const verificationText = await this.verify(filePath, prep.path);
          rows = applyVerification(parsed, verificationText);
          raw_text = rawText;
          warnings.push(...engWarnings);
          if (verificationText === null) {
            warnings.push('Second verification pass did not run — check low-confidence rows carefully.');
          } else {
            const mismatches = rows.filter((r) => r.verification === 'mismatch').length;
            if (mismatches > 0) {
              warnings.push(`${mismatches} name(s) were not confirmed by the second OCR pass — they are highlighted for review.`);
            }
          }
        }

        // Persist the finished result so a re-opened review (and the
        // polling review page) shows the same rows + verification flags +
        // warnings instead of re-parsing raw_text (which drops them).
        const resultJson = JSON.stringify({ rows, warnings, engine });
        await this.db.updateUpload(schoolId, uploadId, { status: 'review', raw_text, result_json: resultJson });
        await this.db.createAuditLog({
          school_id: schoolId,
          actor_id: actorId,
          actor_type: 'user',
          action: 'ocr.upload',
          entity: 'ocr_upload',
          entity_id: uploadId,
          details: { class_id: classId, engine, rows_found: rows.length },
        });
        return { upload_id: uploadId, raw_text, rows, engine, warnings, image_url: `/ocr-uploads/${uploadId}/image` };
      } finally {
        await prep.cleanup();
        // (fullPrep is assigned inside the getFullPrep closure, which
        // control-flow analysis cannot see — the assertion restores its
        // declared type here.)
        await (fullPrep as PreprocessResult | null)?.cleanup();
      }
    } catch (err) {
      // Log the real error server-side: the route swallows the rejection
      // and the review page only sees status 'failed', so without this the
      // cause is invisible (2026-11-07: a CHECK violation failed every
      // upload and nothing in the logs said why).
      // eslint-disable-next-line no-console
      console.error('[ocr] upload failed', uploadId, err);
      await this.db.updateUpload(schoolId, uploadId, { status: 'failed' }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Synchronous wrapper (tests + any direct callers): create the upload
   * and await the full OCR run. The HTTP route instead calls beginUpload
   * + processUpload in the background and returns 202 immediately.
   */
  async uploadAndParse(
    schoolId: string,
    classId: string,
    actorId: string | null,
    filePath: string,
  ): Promise<UploadResult> {
    const { upload_id } = await this.beginUpload(schoolId, classId, actorId, filePath);
    return this.processUpload(schoolId, classId, actorId, upload_id, filePath);
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
    // Finished uploads store the full result (rows + verification flags +
    // warnings) as JSON — return it as-is so a re-opened review (and the
    // polling review page) shows exactly what the first review showed.
    // Uploads finished before this field existed fall back to re-parsing
    // raw_text below (verification then reads 'unverified').
    if (upload.result_json) {
      try {
        const stored = JSON.parse(upload.result_json) as {
          rows: ParsedRow[];
          warnings: string[];
          engine: string;
        };
        if (Array.isArray(stored.rows)) {
          return {
            upload_id: upload.id,
            class_id: upload.class_id,
            status: upload.status,
            raw_text: upload.raw_text ?? '',
            rows: stored.rows,
            engine: stored.engine ?? 'tesseract',
            warnings: stored.warnings ?? [],
            image_url: `/ocr-uploads/${upload.id}/image`,
          };
        }
      } catch {
        // Corrupt stored JSON — fall through to the re-parse below.
      }
    }
    const existing = await this.db.listStudents(schoolId, upload.class_id);
    // Table uploads store raw_text as `name | parent | phone` lines: re-parse
    // that format first — the flat line parser would merge the parent name
    // into the student name. Falls back to the line parser for text uploads.
    const tableRows = parseTableTextLines(upload.raw_text ?? '', existing);
    const rows = tableRows ?? parseStudentList(upload.raw_text ?? '', existing);
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
    const toCreate: { name: string; name_ur: string | null; roll_no: number | null; parent_name: string | null; parent_name_ur: string | null; parent_phone_enc: string | null; parent_phone_hash: string | null }[] = [];
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
        parent_name_ur: row.parent_name_ur?.trim() || null,
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
