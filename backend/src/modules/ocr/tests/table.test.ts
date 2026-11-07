// Unit tests for the table-aware OCR parser (table.ts). Pure functions,
// no tesseract binary needed — word boxes are synthetic, modelled on the
// real TSV output of the 3-column student table photo
// (fixtures/student-table-3col.jpg; see table-e2e.test.ts for the real run).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupWordsIntoRows,
  splitRowIntoCells,
  parseTableWords,
  parseTableTextLines,
  tableRowsToText,
  applyTableVerification,
} from '../table.js';
import type { OcrWord } from '../ocr-engine.js';
import { normalizeName } from '../phone.js';

function w(text: string, left: number, top: number, width = 70, height = 24, conf = 96): OcrWord {
  return { text, conf, left, top, width, height, line: 0 };
}

// Header + 2 data rows, coordinates taken from the real TSV of
// student-table-3col.jpg (columns start ~24 / ~587 / ~1106, row pitch ~76).
const HEADER = [
  w('Student', 26, 24, 151, 26),
  w('Name', 192, 25, 105, 25),
  w('Parents', 587, 25, 143, 25),
  w('Name', 746, 25, 106, 25),
  w('Parents', 1107, 25, 143, 25),
  w('Number', 1266, 24, 150, 26),
];
const ROW1 = [
  w('Ahmed', 24, 101, 103, 23),
  w('Khan', 143, 101, 71, 23),
  w('Imran', 587, 102, 83, 23),
  w('Khan', 684, 101, 71, 23),
  w('0300-1234501', 1106, 102, 216, 23),
];
const ROW2 = [
  w('Ayesha', 24, 177, 105, 23),
  w('Malik', 144, 177, 75, 23),
  w('Tariq', 584, 177, 68, 23),
  w('Malik', 668, 177, 75, 23),
  w('0301-2345602', 1106, 178, 216, 23),
];
const ROW_NO_PHONE = [
  w('Bilal', 27, 253, 59, 23),
  w('Hussain', 100, 253, 114, 23),
  w('Zahid', 585, 253, 81, 23),
  w('Hussain', 682, 253, 113, 23),
];

test('groupWordsIntoRows groups by vertical overlap, sorts left-to-right', () => {
  const rows = groupWordsIntoRows([...ROW2, ...ROW1, ...HEADER]);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows[1]!.map((x) => x.text),
    ['Ahmed', 'Khan', 'Imran', 'Khan', '0300-1234501'],
  );
});

test('splitRowIntoCells splits at wide column gutters, not inside names', () => {
  const cells = splitRowIntoCells(ROW1);
  assert.equal(cells.length, 3);
  assert.deepEqual(
    cells.map((c) => c.text),
    ['Ahmed Khan', 'Imran Khan', '0300-1234501'],
  );
});

test('parseTableWords reads a 3-column table exactly (header skipped)', () => {
  const res = parseTableWords([...HEADER, ...ROW1, ...ROW2]);
  assert.equal(res.detected, true);
  assert.deepEqual(res.columns, ['student', 'parent', 'phone']);
  assert.equal(res.rows.length, 2);
  assert.equal(res.rows[0]!.name, 'Ahmed Khan');
  assert.equal(res.rows[0]!.parent_name, 'Imran Khan');
  assert.equal(res.rows[0]!.parent_phone, '+923001234501');
  assert.equal(res.rows[1]!.name, 'Ayesha Malik');
  assert.equal(res.rows[1]!.parent_name, 'Tariq Malik');
  assert.equal(res.rows[1]!.parent_phone, '+923012345602');
});

test('parseTableWords: missing phone becomes null (review shows "-")', () => {
  const res = parseTableWords([...HEADER, ...ROW1, ...ROW_NO_PHONE]);
  assert.equal(res.detected, true);
  assert.equal(res.rows.length, 2);
  assert.equal(res.rows[1]!.name, 'Bilal Hussain');
  assert.equal(res.rows[1]!.parent_name, 'Zahid Hussain');
  assert.equal(res.rows[1]!.parent_phone, null);
});

test('parseTableWords: plain name-only list is NOT a table (falls back)', () => {
  const words = [
    w('Ahmed', 24, 101),
    w('Raza', 120, 101),
    w('Fatima', 24, 177),
    w('Khan', 120, 177),
    w('Bilal', 24, 253),
    w('Ahmed', 120, 253),
  ];
  const res = parseTableWords(words);
  assert.equal(res.detected, false);
  assert.equal(res.rows.length, 0);
});

test('parseTableWords: "1. Name phone" lines are NOT read as a table', () => {
  // Roll numbers sit in the first column; they must never become student
  // names. The no-letters guard + single-column structure reject this.
  const words = [
    w('1.', 24, 101, 20),
    w('Ahmed', 60, 101),
    w('Raza', 150, 101),
    w('0301-2345678', 260, 101, 150),
    w('2.', 24, 177, 20),
    w('Fatima', 60, 177),
    w('Khan', 150, 177),
    w('0322-7654321', 260, 177, 150),
    w('3.', 24, 253, 20),
    w('Bilal', 60, 253),
    w('Ahmed', 150, 253),
    w('0333-1112223', 260, 253, 150),
  ];
  const res = parseTableWords(words);
  assert.equal(res.detected, false);
  assert.ok(!res.rows.some((r) => r.name === '1.' || r.name === '2.'));
});

test('parseTableWords: no-header table falls back to positional columns', () => {
  const res = parseTableWords([...ROW1, ...ROW2]);
  assert.equal(res.detected, true);
  assert.deepEqual(res.columns, ['student', 'parent', 'phone']);
  assert.equal(res.rows[0]!.name, 'Ahmed Khan');
  assert.equal(res.rows[0]!.parent_name, 'Imran Khan');
  assert.equal(res.rows[0]!.parent_phone, '+923001234501');
});

test('parseTableWords: title row above the header is skipped', () => {
  const title = [w('Class', 24, 5, 60), w('5-A', 100, 5, 40), w('Student', 160, 5, 80), w('List', 250, 5, 40)];
  const res = parseTableWords([...title, ...HEADER, ...ROW1, ...ROW2]);
  assert.equal(res.detected, true);
  assert.equal(res.rows.length, 2);
  assert.equal(res.rows[0]!.name, 'Ahmed Khan');
});

test('parseTableWords flags duplicates against existing students', () => {
  const res = parseTableWords([...HEADER, ...ROW1, ...ROW2], [{ name: 'Ahmed Khan' }]);
  assert.equal(res.rows[0]!.duplicate, true);
  assert.equal(res.rows[0]!.duplicate_reason, 'duplicate_name');
  assert.equal(res.rows[1]!.duplicate, false);
});

test('pipe format round-trips: tableRowsToText -> parseTableTextLines', () => {
  const res = parseTableWords([...HEADER, ...ROW1, ...ROW2, ...ROW_NO_PHONE]);
  const text = tableRowsToText(res.rows);
  assert.ok(text.includes('Ahmed Khan | Imran Khan | +923001234501'));
  assert.ok(text.includes('Bilal Hussain | Zahid Hussain | '));
  const back = parseTableTextLines(text);
  assert.ok(back);
  assert.equal(back!.length, 3);
  assert.equal(back![0]!.name, 'Ahmed Khan');
  assert.equal(back![0]!.parent_name, 'Imran Khan');
  assert.equal(back![0]!.parent_phone, '+923001234501');
  assert.equal(back![2]!.parent_phone, null);
});

test('parseTableTextLines returns null for plain OCR text (fallback)', () => {
  assert.equal(parseTableTextLines('1. Ahmed Raza 0301-2345678\n2. Fatima Khan'), null);
  assert.equal(parseTableTextLines(''), null);
});

test('applyTableVerification marks match / mismatch / unverified', () => {
  const res = parseTableWords([...HEADER, ...ROW1, ...ROW2]);
  const verified = new Set([normalizeName('Ahmed Khan')]);
  const out = applyTableVerification(res.rows, verified);
  assert.equal(out[0]!.verification, 'match');
  assert.equal(out[1]!.verification, 'mismatch');
  assert.ok(out[1]!.confidence <= 0.55);
  const unv = applyTableVerification(res.rows, null);
  assert.ok(unv.every((r) => r.verification === 'unverified'));
});
