// Pure parser: turns raw OCR text (Tesseract `eng+urd`) into structured
// student rows. No I/O, no DB — unit-testable in isolation.
//
// A list line may contain, in any order: a roll number, a name (Latin
// and/or Urdu script), and a parent phone number, e.g.
//   "1. Ahmed Raza 0301-2345678"
//   "2. Fatima Khan"
//   "3. احمد رضا 0322-7654321"
//   "Roll No 4, Bilal Ahmed, 0333 1112223"
import { normalizePkPhone, hashPhone, normalizeName } from './phone.js';

export interface ExistingStudent {
  id?: string;
  name: string;
  roll_no?: number | null;
  parent_phone_hash?: string | null;
}

export interface ParsedRow {
  name: string;
  name_ur: string | null;
  roll_no: number | null;
  parent_phone: string | null; // E.164 normalized, or null
  parent_phone_masked: string | null;
  confidence: number; // 0..1
  duplicate?: boolean;
  duplicate_reason?: string | null;
}

const URDU_RUN = /[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]+(?:\s+[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]+)*/g;
const PHONE_RE = /(\+?92[\s-]?|0)?3\d{2}[\s-]?\d{7}/g;
const ROLL_PREFIX_RE = /^\s*(\d{1,3})\s*[.)\-–:]\s*/;
const ROLL_LABEL_RE = /\broll\s*(?:no\.?|#)?\s*(\d{1,3})\b/i;
const HEADER_RE =
  /^(class|student|students|name|roll|sr\.?|no\.?|phone|parent|father|list|نام|طالب|علم|کلاس|فہرست)\b/i;
const NOISE_RE = /^[\s\-_=*#|.,:;()]+$/;

function isHeaderOrNoise(line: string): boolean {
  const t = line.trim();
  if (!t || NOISE_RE.test(t)) return true;
  // A line with no letters at all is not a student row.
  if (!/[A-Za-z\u0600-\u06FF]/.test(t)) return true;
  // Header-like lines: few words and starts with a header keyword.
  if (HEADER_RE.test(t) && t.split(/\s+/).length <= 5) return true;
  return false;
}

/** Extract the first valid PK phone from a line; returns normalized E.164 or null. */
export function extractPhone(line: string): string | null {
  PHONE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PHONE_RE.exec(line)) !== null) {
    const norm = normalizePkPhone(m[0]);
    if (norm) return norm;
  }
  return null;
}

/** Extract a roll number (leading "1." / "1)" or "Roll No 4"), or null. */
export function extractRollNo(line: string): number | null {
  const prefix = line.match(ROLL_PREFIX_RE);
  if (prefix) return parseInt(prefix[1], 10);
  const label = line.match(ROLL_LABEL_RE);
  if (label) return parseInt(label[1], 10);
  return null;
}

/** Extract Urdu-script runs from a line, joined with a space. */
export function extractUrduName(line: string): string | null {
  const runs = line.match(URDU_RUN);
  if (!runs) return null;
  const joined = runs.join(' ').replace(/\s+/g, ' ').trim();
  return joined || null;
}

function cleanLatinName(text: string): string {
  return text
    .replace(/\b(s\/o|d\/o|w\/o)\b.*$/i, '') // drop "s/o ..." tails
    .replace(/\b(mr|miss|mrs|ms)\.?\s+/gi, '')
    .replace(/[^A-Za-z .'\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse one OCR line into a ParsedRow, or null if the line is not a student row.
 * `lineNo` is only used for stable ordering/debugging.
 */
export function parseLine(line: string): Omit<ParsedRow, 'duplicate' | 'duplicate_reason'> | null {
  const raw = line.trim();
  if (isHeaderOrNoise(raw)) return null;

  const roll_no = extractRollNo(raw);
  const parent_phone = extractPhone(raw);
  const name_ur = extractUrduName(raw);

  // Remove phone, roll prefix/label, Urdu run and separators; what is left is the Latin name.
  let rest = raw;
  if (parent_phone) {
    // Remove any phone-like token (the raw form, not the normalized one).
    rest = rest.replace(PHONE_RE, ' ');
  }
  rest = rest.replace(ROLL_PREFIX_RE, ' ').replace(ROLL_LABEL_RE, ' ');
  rest = rest.replace(URDU_RUN, ' ');
  rest = rest.replace(/[,;|]/g, ' ');
  const nameLatin = cleanLatinName(rest);

  let name = nameLatin;
  if (!name && name_ur) {
    // Urdu-only row: keep the Urdu name as the display name too.
    name = name_ur;
  }
  if (!name) return null;

  // Confidence heuristic: start at 0.5; roll +0.2, phone +0.15, multi-word name +0.1,
  // Urdu name present +0.05; single short token -0.15. Clamped to [0.3, 0.98].
  let conf = 0.5;
  if (roll_no !== null) conf += 0.2;
  if (parent_phone) conf += 0.15;
  if (name.split(/\s+/).length >= 2) conf += 0.1;
  if (name_ur) conf += 0.05;
  if (name.length < 3) conf -= 0.15;
  conf = Math.min(0.98, Math.max(0.3, conf));

  return {
    name,
    name_ur: name_ur ?? null,
    roll_no,
    parent_phone: parent_phone ?? null,
    parent_phone_masked: parent_phone ? maskOf(parent_phone) : null,
    confidence: Math.round(conf * 100) / 100,
  };
}

function maskOf(normalized: string): string {
  const digits = normalized.replace(/\D/g, '');
  return `+92 3XX XXXX${digits.slice(-3)}`;
}

/**
 * Parse full OCR text into rows, flagging duplicates against the class's
 * existing students AND within the parsed list itself.
 * Duplicate rule (SCHEMA.md): same (class, normalized name) OR same phone hash.
 */
export function parseStudentList(rawText: string, existing: ExistingStudent[] = []): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const seenNames = new Set<string>();
  const seenPhones = new Set<string>();
  const seenRolls = new Set<number>();

  const existingNames = new Set(existing.map((s) => normalizeName(s.name)));
  const existingPhones = new Set(
    existing.map((s) => s.parent_phone_hash).filter((h): h is string => !!h),
  );
  const existingRolls = new Set(
    existing.map((s) => s.roll_no).filter((r): r is number => r !== null && r !== undefined),
  );

  for (const line of rawText.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;

    const nameNorm = normalizeName(parsed.name);
    const phoneHash = parsed.parent_phone ? hashPhone(parsed.parent_phone) : null;

    let duplicate = false;
    let duplicate_reason: string | null = null;
    if (existingNames.has(nameNorm) || seenNames.has(nameNorm)) {
      duplicate = true;
      duplicate_reason = 'duplicate_name';
    } else if (phoneHash && (existingPhones.has(phoneHash) || seenPhones.has(phoneHash))) {
      duplicate = true;
      duplicate_reason = 'duplicate_phone';
    } else if (
      parsed.roll_no !== null &&
      (existingRolls.has(parsed.roll_no) || seenRolls.has(parsed.roll_no))
    ) {
      duplicate = true;
      duplicate_reason = 'duplicate_roll_no';
    }

    seenNames.add(nameNorm);
    if (phoneHash) seenPhones.add(phoneHash);
    if (parsed.roll_no !== null) seenRolls.add(parsed.roll_no);

    rows.push({ ...parsed, duplicate, duplicate_reason });
  }
  return rows;
}
