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
