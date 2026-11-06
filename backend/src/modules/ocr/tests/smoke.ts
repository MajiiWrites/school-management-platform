// Smoke test: boots a real Express app with the OCR router (fake in-memory
// DB + stub auth), uploads the fixture image through the actual HTTP
// endpoint with REAL Tesseract, reviews, and confirms. Run:
//   PHONE_ENC_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
//   npx tsx smoke.ts
// Exits non-zero on any failed assertion.
import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOcrRouter } from '../routes.js';
import type { OcrDb, UploadRecord } from '../service.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18765;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

const uploads = new Map<string, UploadRecord>();
const students: { name: string; roll_no: number | null; parent_phone_hash: string | null }[] = [];
const audits: unknown[] = [];
let seq = 0;

const db: OcrDb = {
  async getClass() {
    return { id: 'class-1' };
  },
  async listStudents() {
    return students.map((s) => ({ ...s }));
  },
  async createUpload(data) {
    const id = `upload-${++seq}`;
    uploads.set(id, { id, school_id: data.school_id, class_id: data.class_id, file_path: data.file_path, status: 'processing', raw_text: null });
    return { id };
  },
  async getUpload(_s, id) {
    return uploads.get(id) ?? null;
  },
  async updateUpload(id, data) {
    const u = uploads.get(id);
    if (u) uploads.set(id, { ...u, ...data });
  },
  async createStudents(_s, _c, rows) {
    students.push(...rows.map((r) => ({ name: r.name, roll_no: r.roll_no, parent_phone_hash: r.parent_phone_hash })));
    return { created: rows.length };
  },
  async createAuditLog(entry) {
    audits.push(entry);
  },
};

const app = express();
app.use(express.json());
const stubAuth = (req: any, _res: any, next: any) => {
  req.schoolId = 'school-1';
  req.user = { id: 'admin-1', role: 'admin' };
  next();
};
app.use('/api/v1', createOcrRouter({ db, auth: stubAuth, uploadDir: '/tmp/ocr-smoke-uploads' }));

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
}

const server = app.listen(PORT, async () => {
  try {
    // 1. Upload fixture
    const img = readFileSync(path.join(dir, 'fixtures', 'sample-list.png'));
    const form = new FormData();
    form.append('image', new Blob([img], { type: 'image/png' }), 'sample-list.png');
    const upRes = await fetch(`${BASE}/classes/class-1/ocr-upload`, { method: 'POST', body: form });
    const up = (await upRes.json()) as any;
    assert(upRes.status === 201, `upload status ${upRes.status}: ${JSON.stringify(up)}`);
    assert(up.ok && up.data.rows.length === 12, `expected 12 rows, got ${JSON.stringify(up.data?.rows?.length)}`);
    const names = up.data.rows.map((r: any) => r.name);
    assert(names.includes('Ahmed Raza'), 'Ahmed Raza missing');
    assert(names.includes('احمد رضا'), 'Urdu name احمد رضا missing');
    assert(up.data.rows.every((r: any) => !r.parent_phone || r.parent_phone.startsWith('+92')), 'phones normalized');
    console.log('upload OK: 12 rows, engine =', up.data.engine);

    // 2. Review GET
    const revRes = await fetch(`${BASE}/ocr-uploads/${up.data.upload_id}`);
    const rev = (await revRes.json()) as any;
    assert(revRes.status === 200 && rev.data.rows.length === 12, 'review GET failed');
    console.log('review GET OK');

    // 3. Confirm (edit one name, drop the phone of another)
    const rows = up.data.rows.map((r: any) => ({
      name: r.name,
      name_ur: r.name_ur,
      roll_no: r.roll_no,
      parent_phone: r.parent_phone,
    }));
    rows[0].name = 'Ahmed Raza Khan'; // admin edit
    const cfRes = await fetch(`${BASE}/classes/class-1/ocr-upload/${up.data.upload_id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    });
    const cf = (await cfRes.json()) as any;
    assert(cfRes.status === 200, `confirm status ${cfRes.status}: ${JSON.stringify(cf)}`);
    assert(cf.data.saved === 12, `saved=${cf.data.saved}, skipped=${cf.data.skipped_duplicates}`);
    assert(students.length === 12 && students[0].name === 'Ahmed Raza Khan', 'students not saved/edited');
    console.log('confirm OK: saved 12, audit rows =', audits.length);

    // 4. Confirm again with same rows -> all duplicates skipped
    const cf2Res = await fetch(`${BASE}/classes/class-1/ocr-upload/${up.data.upload_id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    });
    const cf2 = (await cf2Res.json()) as any;
    assert(cf2.data.saved === 0 && cf2.data.skipped_duplicates === 12, `re-confirm: ${JSON.stringify(cf2.data)}`);
    console.log('duplicate guard OK: re-confirm saved 0, skipped 12');

    // 5. Non-image upload -> 400
    const bad = new FormData();
    bad.append('image', new Blob(['hello'], { type: 'text/plain' }), 'x.txt');
    const badRes = await fetch(`${BASE}/classes/class-1/ocr-upload`, { method: 'POST', body: bad });
    assert(badRes.status === 400, `non-image should be 400, got ${badRes.status}`);
    console.log('validation OK: non-image rejected with 400');

    console.log('SMOKE TEST PASSED');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
