// Unit tests for OcrService with a fake OcrDb + stub OCR runner.
// No database, no tesseract binary needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { OcrService, type OcrDb, type UploadRecord } from '../service.js';
import { hashPhone } from '../phone.js';

process.env.PHONE_ENC_KEY = randomBytes(32).toString('base64');

function makeFakeDb(existing: { name: string; roll_no?: number | null; parent_phone_hash?: string | null }[] = []) {
  const uploads = new Map<string, UploadRecord>();
  const created: unknown[] = [];
  const audits: unknown[] = [];
  let seq = 0;
  const db: OcrDb = {
    async getClass() {
      return { id: 'class-1' };
    },
    async listStudents() {
      return existing.map((s) => ({ ...s }));
    },
    async createUpload(data) {
      const id = `upload-${++seq}`;
      uploads.set(id, { id, school_id: data.school_id, class_id: data.class_id, file_path: data.file_path, status: 'processing', raw_text: null });
      return { id };
    },
    async getUpload(schoolId, uploadId) {
      const u = uploads.get(uploadId) ?? null;
      return u && u.school_id === schoolId ? u : null;
    },
    async updateUpload(schoolId, uploadId, data) {
      const u = uploads.get(uploadId);
      if (u && u.school_id === schoolId) uploads.set(uploadId, { ...u, ...data });
    },
    async createStudents(_s, _c, rows) {
      created.push(...rows);
      return { created: rows.length };
    },
    async getUploadFile(schoolId, uploadId) {
      const u = uploads.get(uploadId) ?? null;
      return u && u.school_id === schoolId ? { file_path: u.file_path } : null;
    },
    async createAuditLog(entry) {
      audits.push(entry);
    },
  };
  return { db, uploads, created, audits };
}

const SAMPLE_TEXT = `Class 5-A Student List
1. Ahmed Raza 0301-2345678
2. Fatima Khan
3. احمد رضا 0301-1122334`;

test('uploadAndParse runs OCR, parses rows and stores raw_text', async () => {
  const { db, uploads } = makeFakeDb();
  const svc = new OcrService(db, {
    runOcr: async () => ({ raw_text: SAMPLE_TEXT, engine: 'tesseract', warnings: [] }),
  });
  const res = await svc.uploadAndParse('school-1', 'class-1', 'admin-1', '/tmp/x.png');
  assert.equal(res.rows.length, 3);
  assert.equal(res.rows[0].name, 'Ahmed Raza');
  assert.equal(res.rows[0].parent_phone, '+923012345678');
  assert.equal(res.rows[2].name_ur, 'احمد رضا');
  assert.equal(uploads.get(res.upload_id)?.status, 'review');
  assert.equal(uploads.get(res.upload_id)?.raw_text, SAMPLE_TEXT);
});

test('uploadAndParse marks upload failed when OCR throws', async () => {
  const { db, uploads } = makeFakeDb();
  const svc = new OcrService(db, {
    runOcr: async () => {
      throw new Error('boom');
    },
  });
  await assert.rejects(() => svc.uploadAndParse('school-1', 'class-1', 'admin-1', '/tmp/x.png'), /boom/);
  assert.equal(uploads.get('upload-1')?.status, 'failed');
});

test('confirmRows saves new students, skips duplicates + invalid phones, writes audit', async () => {
  const { db, created, audits } = makeFakeDb([
    { name: 'Ahmed Raza', roll_no: 1, parent_phone_hash: hashPhone('+923012345678') },
  ]);
  const svc = new OcrService(db, {});
  // Seed an upload row first
  const up = await db.createUpload({ school_id: 'school-1', class_id: 'class-1', file_path: '/tmp/x.png' });
  const res = await svc.confirmRows('school-1', 'class-1', up.id, 'admin-1', [
    { name: 'Ahmed Raza', roll_no: 1, parent_phone: '0301-2345678' }, // duplicate name
    { name: 'Fatima Khan', roll_no: 2, parent_phone: '0322-7654321' }, // ok
    { name: 'Bad Phone', roll_no: 3, parent_phone: '051-1234567' }, // invalid phone
    { name: '  ', roll_no: 4 }, // empty name
    { name: 'Hassan Ali', roll_no: 2, parent_phone: '0345-5556667' }, // duplicate roll within batch
    { name: 'Maryam Nawaz', roll_no: 6, parent_phone: '0312-3456789' }, // ok
  ]);
  assert.equal(res.saved, 2);
  assert.equal(res.skipped_duplicates, 4);
  assert.equal(created.length, 2);
  assert.equal((created[0] as { name: string }).name, 'Fatima Khan');
  // Phone stored encrypted (not plaintext) + hash present
  const fatima = created[0] as { parent_phone_enc: string; parent_phone_hash: string };
  assert.ok(!fatima.parent_phone_enc.includes('03227654321'));
  assert.equal(fatima.parent_phone_hash, hashPhone('+923227654321'));
  assert.equal(audits.length, 1);
  assert.equal((audits[0] as { action: string }).action, 'ocr.confirm');
});

test('confirmRows rejects empty rows and unknown class/upload', async () => {
  const { db } = makeFakeDb();
  const svc = new OcrService(db, {});
  const up = await db.createUpload({ school_id: 'school-1', class_id: 'class-1', file_path: '/tmp/x.png' });
  await assert.rejects(() => svc.confirmRows('school-1', 'class-1', up.id, 'admin-1', []), /non-empty array/);
  await assert.rejects(
    () => svc.confirmRows('school-1', 'class-1', 'no-such-upload', 'admin-1', [{ name: 'X' }]),
    /not found/,
  );
});

// --- FINAL REBUILD Point 2: "-" phone handling + verification pass -----
import { isMissingPhoneValue, applyVerification } from '../service.js';

test('isMissingPhoneValue: "-" and friends mean NO number, never a phone', () => {
  for (const v of ['-', '—', '--', '', '  ', 'n/a', 'N/A', 'nil', 'none', 'no number', null, undefined]) {
    assert.equal(isMissingPhoneValue(v), true, JSON.stringify(v));
  }
  for (const v of ['0301-2345678', '0322 7654321', '0', '123']) {
    assert.equal(isMissingPhoneValue(v), false, JSON.stringify(v));
  }
});

test('confirmRows saves "-" rows with NO phone (never validated, never encrypted, never skipped)', async () => {
  const { db, created } = makeFakeDb();
  const svc = new OcrService(db, {
    // Prove "-" is never passed to encryption: throw if it ever is.
    encryptPhone: (v) => {
      assert.notEqual(v, '-');
      assert.ok(!v.includes('-') || v.startsWith('+92'), `encrypt called with ${v}`);
      return `enc(${v})`;
    },
  });
  const up = await db.createUpload({ school_id: 'school-1', class_id: 'class-1', file_path: '/tmp/x.png' });
  const res = await svc.confirmRows('school-1', 'class-1', up.id, 'admin-1', [
    { name: 'No Number One', roll_no: 1, parent_phone: '-' },
    { name: 'No Number Two', roll_no: 2, parent_phone: '' },
    { name: 'No Number Three', roll_no: 3 }, // no phone field at all
    { name: 'Has Number', roll_no: 4, parent_phone: '0301-2345678' },
  ]);
  assert.equal(res.saved, 4);
  assert.equal(res.skipped_duplicates, 0);
  assert.equal(created.length, 4);
  // "-" rows: null enc + null hash — that is what makes them show up in
  // the Students/Parents "Missing number" list (phone_flag 'missing').
  for (const c of created.slice(0, 3) as { parent_phone_enc: string | null; parent_phone_hash: string | null }[]) {
    assert.equal(c.parent_phone_enc, null);
    assert.equal(c.parent_phone_hash, null);
  }
  const withPhone = created[3] as { parent_phone_enc: string; parent_phone_hash: string };
  assert.equal(withPhone.parent_phone_enc, 'enc(+923012345678)');
  assert.equal(withPhone.parent_phone_hash, hashPhone('+923012345678'));
});

test('confirmRows still rejects a REAL invalid phone (only "-" is exempt)', async () => {
  const { db, created } = makeFakeDb();
  const svc = new OcrService(db, {});
  const up = await db.createUpload({ school_id: 'school-1', class_id: 'class-1', file_path: '/tmp/x.png' });
  const res = await svc.confirmRows('school-1', 'class-1', up.id, 'admin-1', [
    { name: 'Bad Phone', roll_no: 1, parent_phone: '051-1234567' },
    { name: 'Dash Phone', roll_no: 2, parent_phone: '-' },
  ]);
  assert.equal(res.saved, 1);
  assert.equal(res.skipped_duplicates, 1);
  assert.equal((created[0] as { name: string }).name, 'Dash Phone');
});

test('confirmRows passes parent_name (s/o tail) through to the student', async () => {
  const { db, created } = makeFakeDb();
  const svc = new OcrService(db, {});
  const up = await db.createUpload({ school_id: 'school-1', class_id: 'class-1', file_path: '/tmp/x.png' });
  await svc.confirmRows('school-1', 'class-1', up.id, 'admin-1', [
    { name: 'Ali', roll_no: 1, parent_name: 'Ahmed', parent_phone: '-' },
  ]);
  assert.equal((created[0] as { parent_name: string }).parent_name, 'Ahmed');
});

test('uploadAndParse applies the verification pass and caps mismatched rows', async () => {
  const { db } = makeFakeDb();
  const svc = new OcrService(db, {
    runOcr: async () => ({ raw_text: '1. Ahmed Raza 0301-2345678\n2. Fatima Khan\n3. Bilal Ahmed', engine: 'tesseract', warnings: [] }),
    // Second pass (different psm) reads Ahmed + Bilal but NOT Fatima.
    runVerificationOcr: async () => ({ raw_text: '1. Ahmed Raza 0301-2345678\n3. Bilal Ahmed' }),
    inspectImage: async () => [],
  });
  const res = await svc.uploadAndParse('school-1', 'class-1', 'admin-1', '/tmp/x.png');
  assert.equal(res.rows[0].verification, 'match');
  assert.equal(res.rows[1].verification, 'mismatch');
  assert.ok(res.rows[1].confidence <= 0.55, 'mismatched row confidence capped');
  assert.equal(res.rows[2].verification, 'match');
  assert.ok(res.warnings.some((w) => /not confirmed by the second OCR pass/.test(w)));
  assert.equal(res.image_url, `/ocr-uploads/${res.upload_id}/image`);
});

test('uploadAndParse marks rows unverified (not failed) when the second pass fails', async () => {
  const { db } = makeFakeDb();
  const svc = new OcrService(db, {
    runOcr: async () => ({ raw_text: '1. Ahmed Raza', engine: 'tesseract', warnings: [] }),
    runVerificationOcr: async () => {
      throw new Error('tesseract timed out');
    },
    inspectImage: async () => [],
  });
  const res = await svc.uploadAndParse('school-1', 'class-1', 'admin-1', '/tmp/x.png');
  assert.equal(res.rows[0].verification, 'unverified');
  assert.ok(res.warnings.some((w) => /verification pass did not run/.test(w)));
});

test('uploadAndParse surfaces rotation warnings from image inspection', async () => {
  const { db } = makeFakeDb();
  const svc = new OcrService(db, {
    runOcr: async () => ({ raw_text: '1. Ahmed Raza', engine: 'tesseract', warnings: [] }),
    runVerificationOcr: async () => ({ raw_text: '1. Ahmed Raza' }),
    inspectImage: async () => ['This photo is stored rotated 90° (EXIF orientation 6) — test warning.'],
  });
  const res = await svc.uploadAndParse('school-1', 'class-1', 'admin-1', '/tmp/x.png');
  assert.ok(res.warnings.some((w) => /rotated 90/.test(w)));
});

test('applyVerification leaves Urdu-only rows unverified (Latin pass cannot read them)', () => {
  const rows = applyVerification(
    [
      { name: 'احمد رضا', name_ur: 'احمد رضا', roll_no: 1, parent_phone: null, parent_phone_masked: null, parent_name: null, confidence: 0.9 },
    ],
    '1. Ahmed Raza',
  );
  assert.equal(rows[0].verification, 'unverified');
  assert.equal(rows[0].confidence, 0.9); // not capped
});

// ---- Table path (3-column student table photo) ----
// The user's photo (Student Name | Parents Name | Parents Number) came
// back with 0 rows from the old text path (psm 6 returns empty text for
// bordered tables). The table path reads TSV word boxes instead.
import type { OcrWord } from '../ocr-engine.js';

function tw(text: string, left: number, top: number, width = 60, height = 24, conf = 96): OcrWord {
  return { text, conf, left, top, width, height, line: 0 };
}

const TABLE_WORDS: OcrWord[] = [
  tw('Student', 10, 10), tw('Name', 90, 10),
  tw('Parents', 300, 10), tw('Name', 380, 10),
  tw('Parents', 600, 10), tw('Number', 680, 10),
  tw('Ahmed', 10, 50), tw('Khan', 80, 50),
  // Row 1's phone word reads at conf 50 on purpose: the early-exit rule
  // skips the verification pass when EVERY row is ≥85% confident, so at
  // least one row here must stay low-confidence or the tests below that
  // exercise the verification pass would silently stop running it (the
  // dedicated early-exit test uses its own all-96 fixture instead).
  tw('Imran', 300, 50), tw('Khan', 370, 50), tw('0300-1234501', 600, 50, 150, 24, 50),
  tw('Ayesha', 10, 90), tw('Malik', 80, 90),
  tw('Tariq', 300, 90), tw('Malik', 370, 90), tw('0301-2345602', 600, 90, 150),
];

test('uploadAndParse uses the table path for a 3-column table photo', async () => {
  const { db, uploads } = makeFakeDb();
  const svc = new OcrService(db, {
    runTableOcr: async () => TABLE_WORDS,
    runTableVerifyOcr: async () => TABLE_WORDS,
    runOcr: async () => {
      throw new Error('text path must not run when the table path succeeds');
    },
  });
  const res = await svc.uploadAndParse('school-1', 'class-1', 'admin-1', '/tmp/x.png');
  assert.equal(res.rows.length, 2);
  assert.equal(res.rows[0].name, 'Ahmed Khan');
  assert.equal(res.rows[0].parent_name, 'Imran Khan');
  assert.equal(res.rows[0].parent_phone, '+923001234501');
  assert.equal(res.rows[1].name, 'Ayesha Malik');
  assert.equal(res.rows[1].parent_name, 'Tariq Malik');
  assert.equal(res.rows[1].parent_phone, '+923012345602');
  assert.equal(res.rows[0].verification, 'match');
  assert.ok(res.warnings.some((w) => /Table layout detected/.test(w)));
  // Stored raw_text is the pipe format so a re-opened review re-parses
  // the same rows (parent name NOT merged into the student name).
  assert.equal(
    uploads.get(res.upload_id)?.raw_text,
    'Ahmed Khan | Imran Khan | +923001234501\nAyesha Malik | Tariq Malik | +923012345602',
  );
  assert.equal(uploads.get(res.upload_id)?.status, 'review');
});

test('getUploadForReview re-parses stored pipe-format rows (parent kept separate)', async () => {
  const { db } = makeFakeDb();
  const svc = new OcrService(db, {
    runTableOcr: async () => TABLE_WORDS,
    runTableVerifyOcr: async () => TABLE_WORDS,
  });
  const res = await svc.uploadAndParse('school-1', 'class-1', 'admin-1', '/tmp/x.png');
  const reopened = await svc.getUploadForReview('school-1', res.upload_id);
  assert.equal(reopened.rows.length, 2);
  assert.equal(reopened.rows[0].name, 'Ahmed Khan');
  assert.equal(reopened.rows[0].parent_name, 'Imran Khan');
  assert.equal(reopened.rows[0].parent_phone, '+923001234501');
  assert.equal(reopened.rows[1].name, 'Ayesha Malik');
});

test('uploadAndParse falls back to the text path when the table pass throws', async () => {
  const { db } = makeFakeDb();
  const svc = new OcrService(db, {
    runTableOcr: async () => {
      throw new Error('tesseract tsv failed');
    },
    runOcr: async () => ({ raw_text: SAMPLE_TEXT, engine: 'tesseract', warnings: [] }),
    runVerificationOcr: async () => ({ raw_text: SAMPLE_TEXT }),
  });
  const res = await svc.uploadAndParse('school-1', 'class-1', 'admin-1', '/tmp/x.png');
  assert.equal(res.rows.length, 3);
  assert.equal(res.rows[0].name, 'Ahmed Raza');
  assert.ok(!res.warnings.some((w) => /Table layout detected/.test(w)));
});

test('uploadAndParse falls back to the text path when TSV words are not a table', async () => {
  const { db } = makeFakeDb();
  const svc = new OcrService(db, {
    runTableOcr: async () => [
      tw('Ahmed', 10, 50), tw('Raza', 80, 50),
      tw('Fatima', 10, 90), tw('Khan', 80, 90),
    ],
    runOcr: async () => ({ raw_text: SAMPLE_TEXT, engine: 'tesseract', warnings: [] }),
    runVerificationOcr: async () => ({ raw_text: SAMPLE_TEXT }),
  });
  const res = await svc.uploadAndParse('school-1', 'class-1', 'admin-1', '/tmp/x.png');
  assert.equal(res.rows.length, 3);
  assert.equal(res.rows[0].name, 'Ahmed Raza');
});

test('uploadAndParse marks table rows unverified when the table verification pass fails', async () => {
  const { db } = makeFakeDb();
  const svc = new OcrService(db, {
    runTableOcr: async () => TABLE_WORDS,
    runTableVerifyOcr: async () => {
      throw new Error('second pass failed');
    },
  });
  const res = await svc.uploadAndParse('school-1', 'class-1', 'admin-1', '/tmp/x.png');
  assert.equal(res.rows.length, 2);
  assert.ok(res.rows.every((r) => r.verification === 'unverified'));
  assert.ok(res.warnings.some((w) => /Second verification pass did not run/.test(w)));
});

// ---- SPEED: early-exit + English-first text path ----

test('uploadAndParse SKIPS the table verification pass on a clean high-confidence read', async () => {
  const { db } = makeFakeDb();
  const svc = new OcrService(db, {
    // All words at conf 96 → every row ≥85% with phones → early-exit.
    runTableOcr: async () => TABLE_WORDS.map((w) => ({ ...w, conf: 96 })),
    runTableVerifyOcr: async () => {
      throw new Error('verification pass must not run on a clean high-confidence read');
    },
    runOcr: async () => {
      throw new Error('text path must not run when the table path succeeds');
    },
  });
  const res = await svc.uploadAndParse('school-1', 'class-1', 'admin-1', '/tmp/x.png');
  assert.equal(res.rows.length, 2);
  assert.ok(res.rows.every((r) => r.verification === 'unverified'));
  assert.ok(res.warnings.some((w) => /High-confidence read/.test(w)));
  assert.ok(res.warnings.some((w) => /Table layout detected/.test(w)));
});

test('uploadAndParse SKIPS the Urdu pass for an English-only list', async () => {
  const { db } = makeFakeDb();
  let urdCalled = false;
  const svc = new OcrService(db, {
    runOcr: async () => ({
      raw_text: '1. Ahmed Raza 0301-2345678\n2. Fatima Khan\n3. Bilal Ahmed',
      engine: 'tesseract',
      warnings: [],
    }),
    runUrdOcr: async () => {
      urdCalled = true;
      return { raw_text: '' };
    },
    runVerificationOcr: async () => ({ raw_text: '1. Ahmed Raza 0301-2345678\n2. Fatima Khan\n3. Bilal Ahmed' }),
  });
  const res = await svc.uploadAndParse('school-1', 'class-1', 'admin-1', '/tmp/x.png');
  assert.equal(res.rows.length, 3);
  assert.equal(urdCalled, false);
});

test('uploadAndParse RUNS the Urdu pass when the English pass leaves rows unparsed (mixed list)', async () => {
  const { db } = makeFakeDb();
  let urdCalled = false;
  const svc = new OcrService(db, {
    // English pass reads the Latin row; the Urdu rows come back as garbage.
    runOcr: async () => ({
      raw_text: '1. Ahmed Raza 0301-2345678\n2. xxx\n3. yyy',
      engine: 'tesseract',
      warnings: [],
    }),
    runUrdOcr: async () => {
      urdCalled = true;
      return { raw_text: '1. Ahmed Raza 0301-2345678\n2. احمد رضا 0301-1122334\n3. فاطمہ خان' };
    },
    runVerificationOcr: async () => ({ raw_text: '1. Ahmed Raza 0301-2345678' }),
  });
  const res = await svc.uploadAndParse('school-1', 'class-1', 'admin-1', '/tmp/x.png');
  assert.equal(urdCalled, true);
  assert.equal(res.rows.length, 3);
  assert.equal(res.rows[1].name_ur, 'احمد رضا');
  assert.equal(res.rows[2].name, 'فاطمہ خان');
});

test('uploadAndParse transliterates Latin names to Urdu (table path)', async () => {
  const { db } = makeFakeDb();
  const svc = new OcrService(db, {
    runTableOcr: async () => TABLE_WORDS,
    runTableVerifyOcr: async () => TABLE_WORDS,
  });
  const res = await svc.uploadAndParse('school-1', 'class-1', 'admin-1', '/tmp/x.png');
  assert.equal(res.rows[0].name_ur, 'احمد خان');
  assert.equal(res.rows[0].parent_name_ur, 'عمران خان');
  assert.equal(res.rows[1].name_ur, 'عائشہ ملک');
  assert.equal(res.rows[1].parent_name_ur, 'طارق ملک');
});

test('confirmRows passes parent_name_ur through to the student', async () => {
  const { db, created } = makeFakeDb();
  const svc = new OcrService(db, {});
  const up = await db.createUpload({ school_id: 'school-1', class_id: 'class-1', file_path: '/tmp/x.png' });
  await svc.confirmRows('school-1', 'class-1', up.id, 'admin-1', [
    { name: 'Ali', roll_no: 1, parent_name: 'Ahmed', parent_name_ur: 'احمد', parent_phone: '-' },
  ]);
  assert.equal((created[0] as { parent_name_ur: string }).parent_name_ur, 'احمد');
});
