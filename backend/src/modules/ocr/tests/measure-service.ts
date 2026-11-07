// End-to-end timing of the NEW uploadAndParse (real Tesseract, fake DB)
// on the real 20-row table photo. Run AFTER the harness, alone:
//   ./node_modules/.bin/tsx measure-service.ts
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OcrService, type OcrDb, type UploadRecord } from '../service.js';

process.env.PHONE_ENC_KEY = randomBytes(32).toString('base64');

const DIR = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = path.join(DIR, 'fixtures', 'student-table-3col.jpg');

function makeFakeDb(): OcrDb {
  const uploads = new Map<string, UploadRecord>();
  let seq = 0;
  return {
    async getClass() {
      return { id: 'class-1' };
    },
    async listStudents() {
      return [];
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
      return { created: rows.length };
    },
    async getUploadFile(schoolId, uploadId) {
      const u = uploads.get(uploadId) ?? null;
      return u && u.school_id === schoolId ? { file_path: u.file_path } : null;
    },
    async createAuditLog() {},
  };
}

const EXPECTED: Array<[string, string, string]> = [
  ['Ahmed Khan', 'Imran Khan', '+923001234501'],
  ['Ayesha Malik', 'Tariq Malik', '+923012345602'],
  ['Bilal Hussain', 'Zahid Hussain', '+923023456703'],
  ['Fatima Noor', 'Noor Muhammad', '+923034567804'],
  ['Hamza Ali', 'Ali Raza', '+923045678905'],
  ['Hina Shah', 'Sajid Shah', '+923056789006'],
  ['Usman Tariq', 'Tariq Mehmood', '+923067890107'],
  ['Sana Iqbal', 'Iqbal Ahmed', '+923078901208'],
  ['Zain Abbas', 'Abbas Raza', '+923089012309'],
  ['Maryam Saeed', 'Saeed Anwar', '+923090123410'],
  ['Hassan Raza', 'Raza Hussain', '+923101234511'],
  ['Iqra Javed', 'Javed Akhtar', '+923112345612'],
  ['Omar Farooq', 'Farooq Ahmed', '+923123456713'],
  ['Laiba Siddiqui', 'Siddique Khan', '+923134567814'],
  ['Talha Mahmood', 'Mahmood Ali', '+923145678915'],
  ['Noor Fatima', 'Khalid Mehmood', '+923156789016'],
  ['Daniyal Butt', 'Rashid Butt', '+923167890117'],
  ['Areeba Khan', 'Naveed Khan', '+923178901218'],
  ['Saad Qureshi', 'Aslam Qureshi', '+923189012319'],
  ['Mahnoor Aslam', 'Aslam Pervaiz', '+923190123420'],
];

async function main(): Promise<void> {
  const svc = new OcrService(makeFakeDb(), {});
  for (let run = 1; run <= 2; run++) {
    const t0 = performance.now();
    const res = await svc.uploadAndParse('school-1', 'class-1', 'admin-1', IMAGE);
    const secs = (performance.now() - t0) / 1000;
    let exact = 0;
    for (let i = 0; i < EXPECTED.length; i++) {
      const r = res.rows[i];
      if (r && r.name === EXPECTED[i]![0] && r.parent_phone === EXPECTED[i]![2]) exact++;
    }
    console.log(`run ${run}: ${secs.toFixed(2)}s, rows=${res.rows.length}, name+phone exact=${exact}/20`);
    console.log(`  warnings: ${JSON.stringify(res.warnings)}`);
    console.log(`  verification: ${JSON.stringify(res.rows.map((r) => r.verification))}`);
    console.log(`  urdu sample: ${res.rows[0]?.name_ur} / ${res.rows[0]?.parent_name_ur}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
