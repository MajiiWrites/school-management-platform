// Accuracy table for the rule-based Roman-Urdu → Urdu transliterator,
// asserted against every name on the real 20-row table photo
// (fixtures/student-table-3col.jpg — the image the user uploaded).
// Expected Urdu is the standard spelling for each name; ambiguous cases
// are marked and the review screen is the safety net for them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { transliterateName, transliterateToken } from '../transliterate.js';

// [English name, expected Urdu] — student names, rows 1-20 of the photo.
const STUDENT_NAMES: Array<[string, string]> = [
  ['Ahmed Khan', 'احمد خان'],
  ['Ayesha Malik', 'عائشہ ملک'],
  ['Bilal Hussain', 'بلال حسین'],
  ['Fatima Noor', 'فاطمہ نور'],
  ['Hamza Ali', 'حمزہ علی'],
  ['Hina Shah', 'حنا شاہ'],
  ['Usman Tariq', 'عثمان طارق'],
  ['Sana Iqbal', 'ثناء اقبال'], // AMBIGUOUS: ثناء (common given-name spelling) vs سنا — review covers it
  ['Zain Abbas', 'زین عباس'],
  ['Maryam Saeed', 'مریم سعید'],
  ['Hassan Raza', 'حسن رضا'],
  ['Iqra Javed', 'اقراء جاوید'],
  ['Omar Farooq', 'عمر فاروق'],
  ['Laiba Siddiqui', 'لائبہ صدیقی'],
  ['Talha Mahmood', 'طلحہ محمود'],
  ['Noor Fatima', 'نور فاطمہ'],
  ['Daniyal Butt', 'دانیال بٹ'],
  ['Areeba Khan', 'اریبہ خان'],
  ['Saad Qureshi', 'سعد قریشی'],
  ['Mahnoor Aslam', 'ماہ نور اسلم'],
];

// [English name, expected Urdu] — parent names, rows 1-20 of the photo.
const PARENT_NAMES: Array<[string, string]> = [
  ['Imran Khan', 'عمران خان'],
  ['Tariq Malik', 'طارق ملک'],
  ['Zahid Hussain', 'زاہد حسین'],
  ['Noor Muhammad', 'نور محمد'],
  ['Ali Raza', 'علی رضا'],
  ['Sajid Shah', 'ساجد شاہ'],
  ['Tariq Mehmood', 'طارق محمود'],
  ['Iqbal Ahmed', 'اقبال احمد'],
  ['Abbas Raza', 'عباس رضا'],
  ['Saeed Anwar', 'سعید انور'],
  ['Raza Hussain', 'رضا حسین'],
  ['Javed Akhtar', 'جاوید اختر'],
  ['Farooq Ahmed', 'فاروق احمد'],
  ['Siddique Khan', 'صدیق خان'],
  ['Mahmood Ali', 'محمود علی'],
  ['Khalid Mehmood', 'خالد محمود'],
  ['Rashid Butt', 'راشد بٹ'],
  ['Naveed Khan', 'نوید خان'],
  ['Aslam Qureshi', 'اسلم قریشی'],
  ['Aslam Pervaiz', 'اسلم پرویز'],
];

for (const [en, ur] of STUDENT_NAMES) {
  test(`student name: ${en} → ${ur}`, () => {
    assert.equal(transliterateName(en), ur);
  });
}

for (const [en, ur] of PARENT_NAMES) {
  test(`parent name: ${en} → ${ur}`, () => {
    assert.equal(transliterateName(en), ur);
  });
}

test('already-Urdu input is returned as null (nothing to transliterate)', () => {
  assert.equal(transliterateName('احمد خان'), null);
  assert.equal(transliterateName(''), null);
  assert.equal(transliterateName(null), null);
  assert.equal(transliterateName('0301-2345678'), null);
});

test('dictionary covers common variants', () => {
  assert.equal(transliterateToken('Mohammad'), 'محمد');
  assert.equal(transliterateToken('Ahmad'), 'احمد');
  assert.equal(transliterateToken('Mehmood'), 'محمود');
  assert.equal(transliterateToken('Mahmood'), 'محمود');
});

test('letter fallback handles unknown names approximately', () => {
  // Zoya → زویا (o is a long vowel, final a after ی becomes ا)
  assert.equal(transliterateName('Zoya'), 'زویا');
  // Rizwan is in the dictionary; an unknown name still yields Urdu letters, never Latin.
  const out = transliterateName('Qasim Raza');
  assert.ok(out !== null && !/[A-Za-z]/.test(out!), `fallback output must be Urdu script, got ${out}`);
});
