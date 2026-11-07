// Unit tests for the OCR parser (parser.ts) and phone helpers (phone.ts).
// Run: npx tsx --test tests/parser.test.ts  (from the tests/ harness dir)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLine,
  parseStudentList,
  extractPhone,
  extractRollNo,
  extractUrduName,
} from '../parser.js';
import { normalizePkPhone, maskPhone, normalizeName } from '../phone.js';

// --- phone normalization ---
test('normalizePkPhone accepts 03XX, +92, 92 and bare 3XX forms', () => {
  assert.equal(normalizePkPhone('0301-2345678'), '+923012345678');
  assert.equal(normalizePkPhone('0301 2345678'), '+923012345678');
  assert.equal(normalizePkPhone('+92 301 2345678'), '+923012345678');
  assert.equal(normalizePkPhone('923012345678'), '+923012345678');
  assert.equal(normalizePkPhone('3012345678'), '+923012345678');
});

test('normalizePkPhone rejects landlines, short numbers and non-PK numbers', () => {
  assert.equal(normalizePkPhone('051-1234567'), null);
  assert.equal(normalizePkPhone('03012345'), null);
  assert.equal(normalizePkPhone('+1 555 123 4567'), null);
  assert.equal(normalizePkPhone(''), null);
  assert.equal(normalizePkPhone(null), null);
});

test('maskPhone hides the middle digits', () => {
  assert.equal(maskPhone('+923012345678'), '+92 3XX XXXX678');
  assert.equal(maskPhone(null), null);
});

test('normalizeName is case/space/punctuation-insensitive', () => {
  assert.equal(normalizeName("  Ahmed   Raza "), 'ahmed raza');
  assert.equal(normalizeName("Fatima-Khan"), 'fatimakhan');
});

// --- phone / roll / urdu extraction ---
test('extractPhone finds the first valid PK mobile in a line', () => {
  assert.equal(extractPhone('Ahmed Raza 0301-2345678'), '+923012345678');
  assert.equal(extractPhone('Call 0322 7654321 after 5pm'), '+923227654321');
  assert.equal(extractPhone('No phone here'), null);
});

test('extractRollNo handles "1.", "1)" and "Roll No 4"', () => {
  assert.equal(extractRollNo('1. Ahmed Raza'), 1);
  assert.equal(extractRollNo('12) Fatima Khan'), 12);
  assert.equal(extractRollNo('Roll No 4, Bilal Ahmed'), 4);
  assert.equal(extractRollNo('Ahmed Raza'), null);
});

test('extractUrduName pulls the Arabic-script run', () => {
  assert.equal(extractUrduName('احمد رضا 0301-1122334'), 'احمد رضا');
  assert.equal(extractUrduName('Ahmed Raza'), null);
});

// --- line parsing ---
test('parseLine: English row with roll + phone', () => {
  const row = parseLine('1. Ahmed Raza 0301-2345678');
  assert.ok(row);
  assert.equal(row.name, 'Ahmed Raza');
  assert.equal(row.roll_no, 1);
  assert.equal(row.parent_phone, '+923012345678');
  assert.equal(row.parent_phone_masked, '+92 3XX XXXX678');
  assert.ok(row.confidence >= 0.8);
});

test('parseLine: name-only row still parses with lower confidence', () => {
  const row = parseLine('Fatima Khan');
  assert.ok(row);
  assert.equal(row.name, 'Fatima Khan');
  assert.equal(row.roll_no, null);
  assert.equal(row.parent_phone, null);
  assert.ok(row.confidence < 0.8);
});

test('parseLine: Urdu-only row keeps Urdu as name and name_ur', () => {
  const row = parseLine('احمد رضا 0301-1122334');
  assert.ok(row);
  assert.equal(row.name, 'احمد رضا');
  assert.equal(row.name_ur, 'احمد رضا');
  assert.equal(row.parent_phone, '+923011122334');
});

test('parseLine: mixed Urdu + Latin keeps both', () => {
  const row = parseLine('3. Ahmed Raza احمد رضا 0333-1112223');
  assert.ok(row);
  assert.equal(row.name, 'Ahmed Raza');
  assert.equal(row.name_ur, 'احمد رضا');
  assert.equal(row.roll_no, 3);
});

test('parseLine: header and blank lines return null', () => {
  assert.equal(parseLine('Class 5-A Student List'), null);
  assert.equal(parseLine('Roll No.   Name   Parent Phone'), null);
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('---'), null);
});

// --- duplicate flagging ---
test('parseStudentList flags duplicates vs existing students (name + phone + roll)', () => {
  const existing = [
    { name: 'Ahmed Raza', roll_no: 1, parent_phone_hash: 'deadbeef' },
    { name: 'Bilal Ahmed', roll_no: 3, parent_phone_hash: null },
  ];
  const rows = parseStudentList(
    '1. Ahmed Raza 0301-2345678\n2. Fatima Khan\n3. Bilal Ahmed\n4. Bilal Ahmed\n5. Hassan Ali 0301-2345678',
    existing,
  );
  assert.equal(rows.length, 5);
  assert.equal(rows[0].duplicate, true); // same name as existing
  assert.equal(rows[0].duplicate_reason, 'duplicate_name');
  assert.equal(rows[1].duplicate, false);
  assert.equal(rows[2].duplicate, true); // same name as existing
  assert.equal(rows[3].duplicate, true); // same name within the list
  // R2-D (b): same parent phone with a DIFFERENT name is a sibling, not a
  // duplicate — phone alone never flags (matches findDuplicate + CSV import).
  assert.equal(rows[4].duplicate, false);
  assert.equal(rows[4].duplicate_reason, null);
});

test('parseStudentList flags duplicate roll numbers', () => {
  const rows = parseStudentList('1. Ahmed Raza\n1. Fatima Khan', []);
  assert.equal(rows[1].duplicate, true);
  assert.equal(rows[1].duplicate_reason, 'duplicate_roll_no');
});

// R2-D (b): siblings sharing one parent number — in the same upload and
// against already-enrolled students — are NOT duplicates. True duplicates
// (same name, same roll) still flag.
test('parseStudentList does not flag siblings sharing a parent phone', () => {
  const existing = [{ name: 'Ahmed Raza', roll_no: 1, parent_phone_hash: 'deadbeef' }];
  const rows = parseStudentList(
    '1. Ahmed Raza 0301-2345678\n2. Sara Raza 0301-2345678\n3. Omar Raza 0301-2345678',
    existing,
  );
  assert.equal(rows[0].duplicate, true); // same name as existing
  assert.equal(rows[1].duplicate, false); // sibling: same phone, different name/roll
  assert.equal(rows[2].duplicate, false);
});

test('parseStudentList still flags a true duplicate: same name + same phone', () => {
  const rows = parseStudentList('1. Ahmed Raza 0301-2345678\n2. Ahmed Raza 0301-2345678', []);
  assert.equal(rows[1].duplicate, true);
  assert.equal(rows[1].duplicate_reason, 'duplicate_name');
});
