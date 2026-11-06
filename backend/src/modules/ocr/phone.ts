// Phone helpers for the OCR module.
// INTEGRATION (Phase 3): normalize / hash / mask are the canonical
// implementations from backend src/lib/crypto.ts (re-exported here so the
// OCR module's existing import names keep working). Wire format is
// base64(iv||tag||ciphertext), AES-256-GCM, key from PHONE_ENC_KEY — the
// same format the seed data and every other module use.
//
// ONE deliberate exception: normalizeName stays local. The OCR parser's
// duplicate rule strips punctuation ("Fatima-Khan" -> "fatimakhan", see
// tests/parser.test.ts); lib/crypto.ts's normalizeName only strips
// diacritics and would change duplicate detection. Do not "deduplicate"
// it without updating the parser contract + tests.
export {
  normalizePhone as normalizePkPhone,
  sha256Hex as hashPhone,
  maskPhone,
} from '../../lib/crypto.js';

/** Normalize a student name for duplicate comparison: lowercase, collapse whitespace, strip punctuation. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.'’`-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
