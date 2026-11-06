// Result-sheet OCR parser (6B) — turns raw Tesseract text from a
// photographed/scanned result sheet into structured per-student rows.
//
// Unlike the student-list parser (parser.ts), a result sheet is a TABLE:
// the sheet's OWN headings decide what each column means. Headings are
// read in English AND Urdu; any heading that is not a known field is
// treated as a SUBJECT name, so its marks land in `subject_marks`.
//
// Known headings (case-insensitive, EN + UR):
//   roll     — roll no / sr / sr. no / رول نمبر / نمبر شمار
//   name     — student name / name / طالب علم / نام
//   father   — father name / father / s/o / والد / ولدیت
//   obtained — obtained marks / obt / حاصل کردہ / حاصل
//   total    — total marks / max marks / کل / کُل
//   percent  — percentage / % / فیصد
//   grade    — grade / گریڈ
//   position — position / pos / rank / پوزیشن
//   remarks  — remarks / remark / ریمارکس
// Everything else (English, Urdu, Maths, Science, …) is a subject.
//
// Confidence is per-cell: a clean number/name scores high; a cell with
// OCR garbage (mixed symbols, unreadable digits) scores low and is
// flagged so the review table can highlight it (< 0.7).
// Flags: obtained_gt_total, duplicate_roll, missing_roll, missing_name,
// link_mismatch (set later by the results service, not here).

export interface ParsedResultRow {
  roll_no: number | null;
  student_name: string;
  father_name: string | null;
  subject_marks: Record<string, number>;
  obtained_marks: number | null;
  total_marks: number | null;
  percentage: number | null;
  grade: string | null;
  position: number | null;
  remarks: string | null;
  /** Any other column the sheet had, as raw text (heading -> value). */
  extra: Record<string, string>;
  /** Per-field OCR confidence 0..1. */
  confidence: Record<string, number>;
  /** Row-level flags (see header). */
  flags: string[];
}

export interface ParsedResultSheet {
  /** Headings as read from the sheet (empty when no header line found). */
  headings: string[];
  rows: ParsedResultRow[];
  warnings: string[];
}

const URDU_RUN = /[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]+(?:\s+[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]+)*/g;

type FieldKey =
  | 'roll_no'
  | 'student_name'
  | 'father_name'
  | 'obtained_marks'
  | 'total_marks'
  | 'percentage'
  | 'grade'
  | 'position'
  | 'remarks';

/** Heading token (lowercased, trimmed) -> field. Subjects fall through. */
function headingToField(token: string): FieldKey | 'subject' {
  const t = token.toLowerCase().replace(/[.#:()]/g, '').trim();
  // Order matters: father ("والد کا نام") contains "نام", so check it first.
  if (/father|f\/name|s\/o|d\/o|guardian|والد|ولدیت/.test(t)) return 'father_name';
  if (/roll|رول|نمبر شمار/.test(t) || t === 'sr' || t === 'no' || t === 'sr no') return 'roll_no';
  if (/student|طالب|نام/.test(t)) return 'student_name';
  if (/obtained|obt|حاصل/.test(t)) return 'obtained_marks';
  if (/total|max|کل|کُل/.test(t)) return 'total_marks';
  if (/percent|%|فیصد|فی صد/.test(t)) return 'percentage';
  if (/grade|گریڈ|درجہ/.test(t)) return 'grade';
  if (/position|pos|rank|پوزیشن|مقام|رینک/.test(t)) return 'position';
  if (/remark|comment|ریمارکس|تبصرہ/.test(t)) return 'remarks';
  return 'subject';
}

const HEADER_HINT =
  /(roll|sr\.?|name|student|father|obtained|total|marks|percent|grade|position|remark|subject|رول|نام|والد|حاصل|کل|فیصد|گریڈ|پوزیشن|ریمارکس|مضمون)/i;

/** Split a table line into cells on 2+ spaces, tabs, or | separators. */
function splitCells(line: string): string[] {
  return line
    .split(/\s{2,}|\t+|\s*\|\s*/)
    .map((c) => c.trim())
    .filter((c) => c !== '');
}

function cleanNumber(raw: string): { value: number | null; confidence: number } {
  const t = raw.replace(/[,\s]/g, '').trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return { value: Number(t), confidence: 0.95 };
  // Digits mixed with OCR garbage (e.g. "8S" or "4?") — salvage digits, low confidence.
  const digits = t.replace(/[^\d.]/g, '');
  if (digits && /^\d+(\.\d+)?$/.test(digits)) return { value: Number(digits), confidence: 0.5 };
  return { value: null, confidence: 0.3 };
}

function cleanName(raw: string): { value: string; confidence: number } {
  const t = raw.replace(/[^A-Za-z\u0600-\u06FF .'\-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return { value: '', confidence: 0.3 };
  const garbage = raw.length > 0 ? (raw.length - t.length) / raw.length : 0;
  const conf = garbage > 0.4 ? 0.5 : t.split(/\s+/).length >= 2 ? 0.95 : 0.8;
  return { value: t, confidence: conf };
}

/**
 * Parse one data line against a known column map (heading index -> field
 * or subject name). Returns null when the line holds no usable row.
 */
function parseTableLine(cells: string[], columns: Array<{ field: FieldKey | 'subject'; label: string }>): ParsedResultRow | null {
  const row: ParsedResultRow = {
    roll_no: null,
    student_name: '',
    father_name: null,
    subject_marks: {},
    obtained_marks: null,
    total_marks: null,
    percentage: null,
    grade: null,
    position: null,
    remarks: null,
    extra: {},
    confidence: {},
    flags: [],
  };
  let sawAnything = false;
  for (let i = 0; i < cells.length && i < columns.length; i++) {
    const cell = cells[i]!;
    const col = columns[i]!;
    if (!cell) continue;
    sawAnything = true;
    if (col.field === 'subject') {
      const { value, confidence } = cleanNumber(cell);
      if (value !== null) {
        row.subject_marks[col.label] = value;
        row.confidence[`subject:${col.label}`] = confidence;
      } else {
        row.extra[col.label] = cell;
        row.confidence[`subject:${col.label}`] = 0.3;
      }
      continue;
    }
    switch (col.field) {
      case 'roll_no': {
        const { value, confidence } = cleanNumber(cell);
        if (value !== null) row.roll_no = Math.trunc(value);
        row.confidence.roll_no = confidence;
        break;
      }
      case 'student_name': {
        const { value, confidence } = cleanName(cell);
        row.student_name = value;
        row.confidence.student_name = confidence;
        break;
      }
      case 'father_name': {
        const { value, confidence } = cleanName(cell);
        row.father_name = value || null;
        row.confidence.father_name = confidence;
        break;
      }
      case 'obtained_marks': {
        const { value, confidence } = cleanNumber(cell);
        row.obtained_marks = value;
        row.confidence.obtained_marks = confidence;
        break;
      }
      case 'total_marks': {
        const { value, confidence } = cleanNumber(cell);
        row.total_marks = value;
        row.confidence.total_marks = confidence;
        break;
      }
      case 'percentage': {
        const { value, confidence } = cleanNumber(cell);
        row.percentage = value;
        row.confidence.percentage = confidence;
        break;
      }
      case 'grade': {
        const g = cell.replace(/[^A-Za-z+\-]/g, '').toUpperCase();
        row.grade = g || null;
        row.confidence.grade = g ? 0.9 : 0.3;
        break;
      }
      case 'position': {
        const { value, confidence } = cleanNumber(cell);
        row.position = value !== null ? Math.trunc(value) : null;
        row.confidence.position = confidence;
        break;
      }
      case 'remarks': {
        row.remarks = cell;
        row.confidence.remarks = 0.9;
        break;
      }
    }
  }
  if (!sawAnything || !row.student_name) return null;
  return row;
}

/**
 * Fallback for sheets with NO detectable header line: leading roll number
 * ("1. Ahmed Raza 450 500 90%" or "1 Ahmed Raza 450 500"), then a name,
 * then trailing numbers. A bare leading number followed by a name counts
 * as a roll number (result lists rarely start a row with a bare mark).
 * The LAST TWO numbers are obtained / total (percentage is derived);
 * earlier numbers are subject marks whose subject names the header
 * would have given — without a header they cannot be named, so they are
 * left out rather than invented.
 */
function parseFreeLine(line: string): ParsedResultRow | null {
  const raw = line.trim();
  if (!raw || !/[A-Za-z\u0600-\u06FF]/.test(raw)) return null;
  const rollMatch = raw.match(/^\s*(\d{1,3})[.)\-–:]?\s+(?=[A-Za-z\u0600-\u06FF])/);
  let rest = raw;
  let rollNo: number | null = null;
  if (rollMatch) {
    rollNo = parseInt(rollMatch[1]!, 10);
    rest = raw.slice(rollMatch[0].length);
  }
  const nums = [...rest.matchAll(/(\d+(?:\.\d+)?)\s*%?/g)].map((m) => Number(m[1]));
  const namePart = rest.replace(/\d+(?:\.\d+)?\s*%?/g, ' ').replace(/[,;|]/g, ' ');
  const { value: name, confidence } = cleanName(namePart);
  if (!name) return null;
  const row: ParsedResultRow = {
    roll_no: rollNo,
    student_name: name,
    father_name: null,
    subject_marks: {},
    obtained_marks: null,
    total_marks: null,
    percentage: null,
    grade: null,
    position: null,
    remarks: null,
    extra: {},
    confidence: { student_name: confidence },
    flags: [],
  };
  if (rollNo !== null) row.confidence.roll_no = 0.9;
  if (nums.length >= 2) {
    row.obtained_marks = nums[nums.length - 2] ?? null;
    row.total_marks = nums[nums.length - 1] ?? null;
    row.confidence.obtained_marks = 0.7;
    row.confidence.total_marks = 0.7;
  } else if (nums.length === 1) {
    row.obtained_marks = nums[0] ?? null;
    row.confidence.obtained_marks = 0.7;
  }
  return row;
}

function finalize(rows: ParsedResultRow[], warnings: string[]): ParsedResultSheet {
  const seenRolls = new Set<number>();
  for (const row of rows) {
    if (row.roll_no === null) row.flags.push('missing_roll');
    if (!row.student_name) row.flags.push('missing_name');
    if (row.obtained_marks !== null && row.total_marks !== null && row.obtained_marks > row.total_marks) {
      row.flags.push('obtained_gt_total');
    }
    if (row.roll_no !== null) {
      if (seenRolls.has(row.roll_no)) row.flags.push('duplicate_roll');
      seenRolls.add(row.roll_no);
    }
    // Derive percentage when both marks are present and no % was read.
    if (row.percentage === null && row.obtained_marks !== null && row.total_marks !== null && row.total_marks > 0) {
      row.percentage = Math.round((row.obtained_marks / row.total_marks) * 10000) / 100;
      row.confidence.percentage = 0.9;
    }
    // Derive obtained from subject marks when the sheet has no obtained column.
    if (row.obtained_marks === null && Object.keys(row.subject_marks).length > 0) {
      row.obtained_marks = Object.values(row.subject_marks).reduce((a, b) => a + b, 0);
      row.confidence.obtained_marks = 0.8;
      if (row.total_marks !== null && row.total_marks > 0) {
        row.percentage = Math.round((row.obtained_marks / row.total_marks) * 10000) / 100;
        row.confidence.percentage = 0.8;
      }
    }
  }
  return { headings: [], rows, warnings };
}

/**
 * Parse full OCR text of a result sheet. Header-driven when a header line
 * is found (the sheet's own headings win); free-form line parsing otherwise.
 */
export function parseResultSheet(rawText: string): ParsedResultSheet {
  const warnings: string[] = [];
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) return { headings: [], rows: [], warnings: ['No text was read from the sheet.'] };

  // Find the header line: the first line with >= 2 heading hints.
  let headerIdx = -1;
  let columns: Array<{ field: FieldKey | 'subject'; label: string }> = [];
  let headings: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cells = splitCells(lines[i]!);
    if (cells.length < 2) continue;
    const hinted = cells.filter((c) => HEADER_HINT.test(c)).length;
    if (hinted >= 2) {
      headerIdx = i;
      headings = cells;
      columns = cells.map((c) => {
        const field = headingToField(c);
        return { field, label: field === 'subject' ? c.replace(/[^A-Za-z\u0600-\u06FF ]/g, '').trim() || c : c };
      });
      break;
    }
  }

  if (headerIdx === -1) {
    warnings.push('No heading row was found — rows were parsed from the free-form layout (roll, name, marks). Check every row before saving.');
    const rows: ParsedResultRow[] = [];
    for (const line of lines) {
      const parsed = parseFreeLine(line);
      if (parsed) rows.push(parsed);
    }
    const out = finalize(rows, warnings);
    out.headings = [];
    return out;
  }

  const rows: ParsedResultRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCells(lines[i]!);
    if (cells.length === 0) continue;
    // Skip repeated header/footer lines (school name, totals row, page footer).
    if (cells.filter((c) => HEADER_HINT.test(c)).length >= 2) continue;
    const parsed = parseTableLine(cells, columns);
    if (parsed) rows.push(parsed);
  }
  if (rows.length === 0) warnings.push('A heading row was found but no student rows could be parsed from it.');
  const out = finalize(rows, warnings);
  out.headings = headings;
  return out;
}

/** Row-level confidence: the lowest per-field confidence (0..1). */
export function rowConfidence(row: ParsedResultRow): number {
  const values = Object.values(row.confidence);
  if (values.length === 0) return 0.3;
  return Math.min(...values);
}

/** True when any cell of the row is below the review threshold (default 0.7). */
export function isLowConfidence(row: ParsedResultRow, threshold = 0.7): boolean {
  return rowConfidence(row) < threshold;
}
