// LOCAL REPRO of the live OCR-upload regression (commit 862978a9).
// Uses the REAL Prisma adapter + REAL OcrService + REAL Tesseract on the
// real 20-row table photo — the only difference from live is the DB
// (scratch Postgres) and the host. Prints the FULL error + stack on
// failure, so the root cause is visible instead of a bare 'failed'.
// Run: DATABASE_URL=postgresql://postgres@127.0.0.1:54333/smp_ocr_repro ./node_modules/.bin/tsx src/modules/ocr/tests/repro-ocr-regression.ts
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { OcrService } from '../service.js';
import { prismaOcrDb } from '../prisma-adapter.js';

process.env.PHONE_ENC_KEY = randomBytes(32).toString('base64');

const DIR = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = path.join(DIR, 'fixtures', 'student-table-3col.jpg');

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const school = await prisma.school.create({
    data: { name: 'OCR Regression Repro Local', slug: `ocr-regression-repro-local-${randomBytes(4).toString('hex')}` },
  });
  const klass = await prisma.class.create({
    data: { schoolId: school.id, name: '5', section: '', teacherName: 'Ms. Repro Teacher' },
  });
  console.log('school', school.id, 'class', klass.id);
  const service = new OcrService(prismaOcrDb(prisma));
  const t0 = Date.now();
  try {
    const { upload_id } = await service.beginUpload(school.id, klass.id, null, IMAGE);
    console.log('beginUpload OK', upload_id, `(${(Date.now() - t0) / 1000}s)`);
    const result = await service.processUpload(school.id, klass.id, null, upload_id, IMAGE);
    console.log('processUpload OK in', (Date.now() - t0) / 1000, 's');
    console.log('rows:', result.rows.length);
    console.log('first row:', JSON.stringify(result.rows[0]));
    console.log('warnings:', result.warnings);
    const rec = await prisma.ocrUpload.findFirst({ where: { id: upload_id } });
    console.log('DB upload status now:', rec?.status, '| resultJson stored:', !!rec?.resultJson);
    // Correct the known single-letter misread (row 13 parent "Faroog"),
    // then confirm exactly as the review screen does.
    const fixed = result.rows.map((r) => ({
      ...r,
      parent_name: r.parent_name === 'Faroog Ahmed' ? 'Farooq Ahmed' : r.parent_name,
      parent_name_ur:
        r.parent_name_ur === 'فروگ احمد' ? 'فاروق احمد' : r.parent_name_ur,
    }));
    const confirmed = await service.confirmRows(school.id, klass.id, upload_id, null, fixed as never);
    console.log('confirmRows:', JSON.stringify(confirmed));
    const students = await prisma.student.findMany({
      where: { schoolId: school.id, classId: klass.id },
      select: { name: true, nameUr: true, parentName: true, parentNameUr: true },
      orderBy: { name: 'asc' },
    });
    console.log('students saved:', students.length);
    console.log('sample:', JSON.stringify(students.slice(0, 2)));
    const withUrdu = students.filter((s) => s.nameUr && s.parentNameUr).length;
    console.log('students with BOTH Urdu names:', withUrdu, '/', students.length);
  } catch (err) {
    console.log('processUpload THREW after', (Date.now() - t0) / 1000, 's');
    console.log('ERROR NAME:', (err as Error)?.name);
    console.log('ERROR MESSAGE:', (err as Error)?.message);
    console.log('ERROR STACK:', (err as Error)?.stack);
    const rec = await prisma.ocrUpload.findFirst({ where: { schoolId: school.id } });
    console.log('DB upload status now:', rec?.status);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('TOP-LEVEL THROW:', e);
  process.exit(1);
});
