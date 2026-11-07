// Baseline profiler for the OCR upload pipeline (real user image).
// Run: cd backend && ./node_modules/.bin/tsx ~/workspace/tmp/ocr-profile.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  preprocessImage,
  detectOrientation,
  runTesseractTsv,
  runTesseract,
  inspectImage,
} from '/home/hatch/workspace/school-management-platform/backend/src/modules/ocr/ocr-engine.ts';
import {
  parseTableWords,
  applyTableVerification,
} from '/home/hatch/workspace/school-management-platform/backend/src/modules/ocr/table.ts';
import { parseStudentList } from '/home/hatch/workspace/school-management-platform/backend/src/modules/ocr/parser.ts';
import { normalizeName } from '/home/hatch/workspace/school-management-platform/backend/src/modules/ocr/phone.ts';

const execFileAsync = promisify(execFile);
// The user's real 3-column table photo (fixtures/student-table-3col.jpg —
// the image he uploaded on the live site). Same file as
// ~/workspace/user/files/60240_3_v7he.png.
const IMAGE = '/home/hatch/workspace/school-management-platform/backend/src/modules/ocr/tests/fixtures/student-table-3col.jpg';

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

function scoreTable(words: Awaited<ReturnType<typeof runTesseractTsv>>): string {
  const res = parseTableWords(words);
  if (!res.detected) return 'NOT DETECTED';
  let exact = 0;
  for (let i = 0; i < EXPECTED.length; i++) {
    const r = res.rows[i];
    if (r && r.name === EXPECTED[i]![0] && r.parent_phone === EXPECTED[i]![2]) exact++;
  }
  const meanConf =
    res.rows.reduce((a, r) => a + r.confidence, 0) / Math.max(1, res.rows.length);
  return `${res.rows.length} rows, ${exact}/20 name+phone exact, meanConf=${meanConf.toFixed(2)}, minConf=${Math.min(
    ...res.rows.map((r) => r.confidence),
  ).toFixed(2)}`;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  const ms = performance.now() - t0;
  console.log(`  ${label}: ${(ms / 1000).toFixed(2)}s`);
  return { ms, value };
}

async function tsvDirect(
  filePath: string,
  psm: string,
): Promise<ReturnType<typeof runTesseractTsv> extends Promise<infer T> ? T : never> {
  const { stdout } = await execFileAsync(
    'tesseract',
    [filePath, 'stdout', '--psm', psm, '-l', 'eng', 'tsv'],
    { timeout: 180_000, maxBuffer: 10 * 1024 * 1024 },
  );
  const lines = stdout.split(/\r?\n/);
  const words: Array<{
    text: string;
    conf: number;
    left: number;
    top: number;
    width: number;
    height: number;
    line: number;
  }> = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 12 || cols[0] !== '5') continue;
    const text = (cols[11] ?? '').trim();
    if (!text) continue;
    words.push({
      text,
      conf: Number(cols[10] ?? -1),
      left: Number(cols[6] ?? 0),
      top: Number(cols[7] ?? 0),
      width: Number(cols[8] ?? 0),
      height: Number(cols[9] ?? 0),
      line: Number(cols[4] ?? 0),
    });
  }
  return words;
}

async function main(): Promise<void> {
  console.log('=== BASELINE PROFILE — real image 1600x1596 ===\n');

  console.log('-- inspectImage (EXIF check, no tesseract) --');
  await timed('inspectImage', () => inspectImage(IMAGE));

  console.log('-- preprocessImage (sharp rotate + OSD tesseract + grey/normalise/resize3000) --');
  const prep = await timed('preprocessImage full', () => preprocessImage(IMAGE));
  console.log(`  applied: ${prep.value.applied.join(', ') || '(none)'}, skipped=${prep.value.skipped}`);

  console.log('-- detectOrientation alone (tesseract --psm 0 -l osd) --');
  await timed('OSD only', () => detectOrientation(IMAGE));

  console.log('-- sharp pipeline alone (rotate + resize3000 + greyscale + normalise + png) --');
  await timed('sharp only', async () => {
    const buf = await sharp(IMAGE).rotate().toBuffer();
    const out = join(tmpdir(), 'smp-profile-sharp.png');
    await sharp(buf).resize({ width: 3000, withoutEnlargement: true }).greyscale().normalise().png().toFile(out);
    return out;
  });

  console.log('-- raw tesseract psm 11 TSV on ORIGINAL file (no preprocess) --');
  const raw11 = await timed('tesseract psm11 TSV raw', () => tsvDirect(IMAGE, '11'));
  console.log(`  ${scoreTable(raw11.value)}`);

  console.log('-- TABLE PATH as the service runs it today (sequential, preprocess per pass) --');
  const t0 = performance.now();
  const w11 = await timed('runTesseractTsv psm 11 (incl. preprocess)', () => runTesseractTsv(IMAGE, 'eng', '11', 180_000));
  console.log(`  ${scoreTable(w11.value)}`);
  const table1 = parseTableWords(w11.value);
  const w3 = await timed('runTesseractTsv psm 3 verify (incl. preprocess)', () => runTesseractTsv(IMAGE, 'eng', '3', 180_000));
  const verified = new Set(parseTableWords(w3.value).rows.map((r) => normalizeName(r.name)));
  const rows = applyTableVerification(table1.rows, verified);
  const mismatches = rows.filter((r) => r.verification === 'mismatch').length;
  console.log(`  verify: ${verified.size} names, mismatches=${mismatches}`);
  console.log(`  TABLE PATH TOTAL: ${((performance.now() - t0) / 1000).toFixed(2)}s`);

  console.log('-- TABLE PATH parallel (preprocess once, psm11+psm3 concurrent on shared file) --');
  const t1 = performance.now();
  const prep2 = await preprocessImage(IMAGE);
  const p11 = tsvDirect(prep2.path, '11');
  const p3 = tsvDirect(prep2.path, '3');
  const [pw11, pw3] = await Promise.all([p11, p3]);
  await prep2.cleanup();
  const parTable = parseTableWords(pw11);
  console.log(`  ${scoreTable(pw11)}`);
  console.log(`  TABLE PATH PARALLEL TOTAL: ${((performance.now() - t1) / 1000).toFixed(2)}s (incl. 1 preprocess)`);

  console.log('-- TEXT PATH as the service runs it today (dual eng+urd sequential + psm4 verify) --');
  const t2 = performance.now();
  const ocr = await timed('runTesseract eng+urd psm 6 (dual sequential)', () =>
    runTesseract(IMAGE, 'eng+urd', 180_000, '6'),
  );
  const parsed = parseStudentList(ocr.value.raw_text, []);
  console.log(`  raw_text chars=${ocr.value.raw_text.length}, parsed rows=${parsed.length}`);
  await timed('verify psm 4 eng (incl. preprocess)', () => runTesseract(IMAGE, 'eng', 120_000, '4'));
  console.log(`  TEXT PATH TOTAL: ${((performance.now() - t2) / 1000).toFixed(2)}s`);

  console.log('-- DOWNSCALE SWEEP (greyscale+normalise at width W, tesseract psm 11 TSV direct) --');
  for (const w of [1600, 1400, 1200, 1000, 800]) {
    const out = join(tmpdir(), `smp-profile-w${w}.png`);
    await sharp(IMAGE).rotate().resize({ width: w, withoutEnlargement: true }).greyscale().normalise().png().toFile(out);
    const r = await timed(`width ${w}`, () => tsvDirect(out, '11'));
    console.log(`  ${scoreTable(r.value)}`);
  }

  console.log('\n=== DONE ===');
  await prep.value.cleanup();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
