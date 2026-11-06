// Unit tests for the dual-pass OCR merge (ocr-engine.ts mergeDualPass).
// Fixture texts are real Tesseract 5.3.4 outputs captured from the E2E
// fixture image (eng-only and urd-only passes, --psm 6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDualPass } from '../ocr-engine.js';

const ENG_PASS = `Class 5-A — Student List

Roll No. Name Parent Phone

1. Ahmed Raza 0301-2345678

2. Fatima Khan 0322-7654321

9. 0301-1122334 Ld) soo!

10. 0321-4455667 ub rabls

11. 0302-9988776 sa! JM

12. 0344-5566778 (situs addle`;

const URD_PASS = `٢ا‏ ٢ہ٥۸81)ن]ک5‏ - ق۔5 55وا(

۲۱٠۱ ٥٢٠٠٢ 66 ۲۲٠ ٥

1.۰ ۵۲۰۹۵ ٣۵2٥ 0301--8

2ٰ ۲٢٢ )۷۱٥ 0322 071

احمد رضا 2-4- 0301-11 9

فاطمہ خان 0321-667 .10

بلال احمد 0302-4776 .11

عائشہ صدیقی 98۔0344 .12`;

test('mergeDualPass keeps English lines verbatim', () => {
  const merged = mergeDualPass(ENG_PASS, URD_PASS);
  assert.ok(merged.includes('1. Ahmed Raza 0301-2345678'));
  assert.ok(merged.includes('2. Fatima Khan 0322-7654321'));
});

test('mergeDualPass rebuilds Urdu rows from urd name + eng roll/phone', () => {
  const merged = mergeDualPass(ENG_PASS, URD_PASS);
  assert.ok(merged.includes('9. احمد رضا 0301-1122334'), merged);
  assert.ok(merged.includes('10. فاطمہ خان 0321-4455667'), merged);
  assert.ok(merged.includes('11. بلال احمد 0302-9988776'), merged);
  assert.ok(merged.includes('12. عائشہ صدیقی 0344-5566778'), merged);
});

test('mergeDualPass does not mistake Arabic-Indic digits for an Urdu name', () => {
  // The urd pass emits digit-garbage on English lines (e.g. "1.۰ ۵۲۰۹۵").
  // Those lines must stay exactly as the eng pass read them.
  const merged = mergeDualPass(ENG_PASS, URD_PASS);
  assert.ok(!merged.includes('۵۲۰۹۵'));
  assert.ok(merged.includes('1. Ahmed Raza 0301-2345678'));
});

test('mergeDualPass tolerates different line counts', () => {
  const merged = mergeDualPass('1. Ahmed Raza 0301-2345678', '');
  assert.equal(merged, '1. Ahmed Raza 0301-2345678');
});

test('mergeDualPass ignores hallucinated isolated letters on English rows', () => {
  // The `urd` pass emits fragments like "۷ا۹ ا" or "۲٦٥٦کنا" on Latin
  // lines — isolated letters / digit-letter mixes. These must NOT trigger
  // an Urdu rebuild; the English line stays verbatim.
  const eng = '4. Ayesha Siddiqui 0300-9876543\n7. Usman Ghani 0308-2223344';
  const urd = '۷ا۹ ا 0300-9876543\nا ا ۲٦٥٦کنا 0308-2223344';
  const merged = mergeDualPass(eng, urd);
  assert.ok(merged.includes('4. Ayesha Siddiqui 0300-9876543'), merged);
  assert.ok(merged.includes('7. Usman Ghani 0308-2223344'), merged);
});
