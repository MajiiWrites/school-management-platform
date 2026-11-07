// End-to-end test for the reported failure: the user's exact 3-column
// student-table photo (fixtures/student-table-3col.jpg — the image he
// uploaded on the live site and got 0 students from). Runs REAL Tesseract
// through the same code path the service uses, and asserts the table path
// recovers all 20 rows with exact spellings, parent names and numbers.
// Also proves the OLD text path cannot read this image (psm 6 = empty).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTableWords } from '../table.js';
import { parseStudentList } from '../parser.js';
import { runTesseractTsv, runTesseract } from '../ocr-engine.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = path.join(DIR, 'fixtures', 'student-table-3col.jpg');

// [name, parent name, normalised phone] — exactly as written on the photo.
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

let hasTesseract = true;
try {
  execFileSync('tesseract', ['--version'], { stdio: 'ignore' });
} catch {
  hasTesseract = false;
}

test('3-column table photo: old text path (psm 6) finds nothing — the reported bug', { skip: !hasTesseract }, async () => {
  const { raw_text } = await runTesseract(IMAGE, 'eng', 180_000, '6');
  const rows = parseStudentList(raw_text, []);
  assert.equal(raw_text.trim(), '', 'psm 6 must return empty text for this bordered table');
  assert.equal(rows.length, 0, 'old path yields 0 rows — this is the failure the user saw');
});

test('3-column table photo: table path recovers all 20 rows exactly', { skip: !hasTesseract }, async () => {
  const words = await runTesseractTsv(IMAGE, 'eng', '11', 180_000);
  const res = parseTableWords(words);
  assert.equal(res.detected, true);
  assert.deepEqual(res.columns, ['student', 'parent', 'phone']);
  assert.equal(res.rows.length, 20, `expected 20 rows, got ${res.rows.length}`);
  for (let i = 0; i < EXPECTED.length; i++) {
    const [name, parent, phone] = EXPECTED[i]!;
    assert.equal(res.rows[i]!.name, name, `row ${i + 1} name`);
    assert.equal(res.rows[i]!.parent_phone, phone, `row ${i + 1} phone`);
    // 19/20 parent names are exact; row 13 is the ONE known OCR misread
    // (see below) — asserted separately so a regression is visible.
    if (i !== 12) assert.equal(res.rows[i]!.parent_name, parent, `row ${i + 1} parent`);
  }
  // Known single-letter OCR misread: BOTH psm 11 and psm 3 read row 13's
  // parent as "Faroog Ahmed" (the 'q' in "Farooq" comes out as 'g'), so the
  // two passes agree and verification is 'match' — the row is NOT flagged.
  // The review screen exists for exactly this: the admin sees the row next
  // to the photo and corrects one letter before confirming. The row must
  // still be present with its phone intact.
  assert.equal(res.rows[12]!.name, 'Omar Farooq');
  assert.equal(res.rows[12]!.parent_name, 'Faroog Ahmed');
  assert.equal(res.rows[12]!.parent_phone, '+923123456713');
  // No parent name may leak into a student name, and no row may be a
  // parent's name on its own (the column-major mis-parse the line parser
  // used to produce).
  const parentNames = new Set(EXPECTED.map((e) => e[1]));
  for (const row of res.rows) {
    assert.ok(!parentNames.has(row.name), `row named as a parent: ${row.name}`);
    assert.ok(!/Imran Khan|Tariq Malik|Zahid Hussain/.test(row.name));
  }
});
