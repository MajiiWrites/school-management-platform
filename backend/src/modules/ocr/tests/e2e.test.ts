// End-to-end test: generate the fixture image (PIL), run REAL Tesseract
// (eng+urd) on it, parse the output, and assert names/phones extract.
// Skips cleanly (t.skip) if the tesseract binary is unavailable — the
// service must then return 503 in production (see ocr-engine.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTesseract, OcrUnavailableError } from '../ocr-engine.js';
import { parseStudentList } from '../parser.js';

const execFileAsync = promisify(execFile);
const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(dir, 'fixtures', 'sample-list.png');
const generator = path.join(dir, 'fixtures', 'generate-fixture.py');

const EXPECTED: [string, string | null][] = [
  ['Ahmed Raza', '+923012345678'],
  ['Fatima Khan', '+923227654321'],
  ['Bilal Akhtar', '+923331112223'],
  ['Ayesha Siddiqui', '+923009876543'],
  ['Hassan Ali', '+923455556667'],
  ['Maryam Nawaz', '+923123456789'],
  ['Usman Ghani', '+923082223344'],
  ['Zainab Tariq', '+923327778889'],
  ['احمد رضا', '+923011122334'],
  ['فاطمہ خان', '+923214455667'],
  ['بلال احمد', '+923029988776'],
  ['عائشہ صدیقی', '+923445566778'],
];

test('e2e: fixture image -> tesseract eng+urd -> parsed rows', async (t) => {
  await execFileAsync('python3', [generator], { timeout: 30_000 });
  let ocr;
  try {
    ocr = await runTesseract(fixture, 'eng+urd', 180_000);
  } catch (err) {
    if (err instanceof OcrUnavailableError) {
      t.skip(`tesseract unavailable: ${err.message}`);
      return;
    }
    throw err;
  }
  t.diagnostic(`raw OCR text:\n${ocr.raw_text}`);
  const rows = parseStudentList(ocr.raw_text, []);
  t.diagnostic(`parsed ${rows.length} rows`);

  const found = new Map(rows.map((r) => [r.name, r.parent_phone ?? null]));
  const missing: string[] = [];
  for (const [name, phone] of EXPECTED) {
    if (found.get(name) !== phone) missing.push(`${name} (expected phone ${phone}, got ${found.get(name) ?? 'NOT FOUND'})`);
  }
  assert.deepEqual(missing, [], `Missing/mismatched rows:\n${missing.join('\n')}\nRaw text was:\n${ocr.raw_text}`);
  assert.ok(rows.every((r) => r.confidence >= 0.5), 'every row should have confidence >= 0.5');
});
