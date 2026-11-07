// Table-aware OCR parsing: turns Tesseract TSV word boxes into structured
// student rows for bordered/column tables (Student Name | Parents Name |
// Parents Number, etc.).
//
// WHY THIS EXISTS: the plain-text OCR path (psm 6) returns EMPTY text for
// bordered table photos — Tesseract's uniform-block segmentation finds no
// text lines in a grid — so the line parser saw 0 rows and the review
// screen showed nothing, even though the photo was perfectly readable.
// Worse, psm 3/4 plain text reads such tables COLUMN-major (all student
// names, then all parent names, then all numbers), so the line parser
// would have invented 20 extra "students" out of the parent names.
// Word boxes (TSV) keep the geometry: rows are grouped by vertical
// overlap and columns by x position, so each row maps to exactly one
// student with the right parent name and number.
//
// A name is kept EXACTLY as OCR read it — never corrected, translated,
// shortened, reordered, merged or "improved" (same rule as parser.ts).
import type { OcrWord } from './ocr-engine.js';
import { extractPhone, type ExistingStudent, type ParsedRow } from './parser.js';
import { normalizeName, normalizePkPhone } from './phone.js';
import { transliterateName } from './transliterate.js';

export interface TableParseResult {
  /** True when a real table (≥2 columns, ≥2 data rows) was found. */
  detected: boolean;
  /** Column roles in left-to-right order, e.g. ['student','parent','phone']. */
  columns: string[];
  rows: ParsedRow[];
}

interface Cell {
  left: number;
  text: string;
  words: OcrWord[];
  meanConf: number;
}

const HEADER_STUDENT_RE = /student/i;
const HEADER_PARENT_RE = /parent|guardian|father/i;
const HEADER_PHONE_RE = /number|phone|mobile|contact/i;
const HEADER_ROLL_RE = /roll|sr\.?|s\.?\s?no|serial/i;
const HEADER_NAME_RE = /name/i;

/** Median of numbers (0 when empty). */
function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

/**
 * Group words into visual rows: words whose vertical centres overlap
 * (within ~0.6x the median word height) belong to the same table row.
 * Rows come back sorted top-to-bottom, words inside a row left-to-right.
 */
export function groupWordsIntoRows(words: OcrWord[]): OcrWord[][] {
  const usable = words.filter((w) => w.text.trim() !== '');
  if (usable.length === 0) return [];
  const heights = usable.map((w) => w.height).filter((h) => h > 0);
  const tol = Math.max(10, 0.6 * median(heights));
  const sorted = [...usable].sort((a, b) => a.top - b.top || a.left - b.left);
  const rows: OcrWord[][] = [];
  let current: OcrWord[] = [];
  let centerSum = 0;
  for (const w of sorted) {
    const cy = w.top + w.height / 2;
    if (current.length === 0) {
      current = [w];
      centerSum = cy;
      continue;
    }
    const center = centerSum / current.length;
    if (Math.abs(cy - center) <= tol) {
      current.push(w);
      centerSum += cy;
    } else {
      rows.push([...current].sort((a, b) => a.left - b.left));
      current = [w];
      centerSum = cy;
    }
  }
  if (current.length > 0) rows.push([...current].sort((a, b) => a.left - b.left));
  return rows;
}

/**
 * Split one row's words into cells at the wide x-gaps (column gutters are
 * far wider than the gaps inside a multi-word name). A gap counts as a
 * gutter when it exceeds max(60px, 3x the row's SMALLEST word gap, capped
 * at 150px) — the smallest gap anchors the in-cell spacing; the median
 * would be inflated by the gutters themselves and swallow the split.
 */
export function splitRowIntoCells(rowWords: OcrWord[]): Cell[] {
  if (rowWords.length === 0) return [];
  const sorted = [...rowWords].sort((a, b) => a.left - b.left);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    gaps.push(sorted[i]!.left - (prev.left + prev.width));
  }
  const threshold = Math.max(60, Math.min(3 * Math.min(...gaps), 150));
  const cells: Cell[] = [];
  let current: OcrWord[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const gap = sorted[i]!.left - (prev.left + prev.width);
    if (gap > threshold) {
      cells.push(toCell(current));
      current = [sorted[i]!];
    } else {
      current.push(sorted[i]!);
    }
  }
  cells.push(toCell(current));
  return cells;
}

function toCell(words: OcrWord[]): Cell {
  const confs = words.map((w) => w.conf).filter((c) => c >= 0);
  return {
    left: Math.min(...words.map((w) => w.left)),
    text: words.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim(),
    words,
    meanConf: confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : 0,
  };
}

/** Map one header cell's text to a column role, or null when it says nothing. */
function roleOfHeaderCell(text: string): string | null {
  const t = text.toLowerCase();
  if (HEADER_ROLL_RE.test(t)) return 'roll';
  if (HEADER_PARENT_RE.test(t) && HEADER_PHONE_RE.test(t)) return 'phone';
  if (HEADER_PARENT_RE.test(t)) return 'parent';
  if (HEADER_PHONE_RE.test(t)) return 'phone';
  if (HEADER_STUDENT_RE.test(t)) return 'student';
  if (HEADER_NAME_RE.test(t)) return 'student';
  return null;
}

/**
 * Find the header row (first row mentioning student/parent/roll) and derive
 * the column starts + roles from it. Falls back to clustering all word
 * left-edges when there is no header row (roles then positional).
 * Also returns the header row's index (-1 when there is none) so callers
 * can skip title rows above it.
 */
function detectColumns(rows: OcrWord[][]): { starts: number[]; roles: string[]; headerRowIndex: number } | null {
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri]!;
    const cells = splitRowIntoCells(row);
    if (cells.length < 2) continue;
    const joined = cells.map((c) => c.text).join(' ');
    if (!/student|parent|roll|guardian|father/i.test(joined)) continue;
    const roles = cells.map((c) => roleOfHeaderCell(c.text));
    // Fill unmapped roles positionally when there are exactly 3 columns.
    if (cells.length === 3) {
      const fallback = ['student', 'parent', 'phone'];
      const used = new Set(roles.filter(Boolean));
      for (let i = 0; i < 3; i++) {
        if (!roles[i]) {
          const want = fallback[i]!;
          roles[i] = used.has(want) ? null : want;
          if (roles[i]) used.add(roles[i]!);
        }
      }
    }
    if (roles.some(Boolean)) {
      return { starts: cells.map((c) => c.left), roles: roles.map((r) => r ?? 'unknown'), headerRowIndex: ri };
    }
  }
  // No header row: use the column starts of the split cells themselves.
  // (Clustering raw word left-edges misfires: the 2nd word of a cell
  // starts ~100px into the column and would form a phantom cluster.)
  // Cell starts within one column vary by only a few px.
  // Positional roles are only trusted when the LAST column looks like a
  // phone column (most cells phone-like or empty) — otherwise this is a
  // plain list the text parser handles better (name + class, name + roll),
  // and a table read would silently drop the phone numbers.
  const rowsCells = rows.map((row) => splitRowIntoCells(row));
  const cellStarts: number[] = [];
  for (const cells of rowsCells) {
    if (cells.length >= 2) cellStarts.push(...cells.map((c) => c.left));
  }
  if (cellStarts.length === 0) return null;
  cellStarts.sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const left of cellStarts) {
    const last = clusters[clusters.length - 1];
    if (last && left - last[last.length - 1]! <= 100) last.push(left);
    else clusters.push([left]);
  }
  if (clusters.length < 2 || clusters.length > 3) return null;
  const starts = clusters.map((c) => Math.min(...c));
  const lastIdx = clusters.length - 1;
  let phoneLike = 0;
  let phoneChecked = 0;
  for (const cells of rowsCells) {
    if (cells.length < 2) continue;
    const last = cells[cells.length - 1]!;
    if (Math.abs(last.left - starts[lastIdx]!) > 100) continue;
    phoneChecked++;
    const text = last.text.trim();
    if (text === '' || extractPhone(text)) phoneLike++;
  }
  if (phoneChecked === 0 || phoneLike / phoneChecked < 0.5) return null;
  const roles = clusters.length === 2 ? ['student', 'phone'] : ['student', 'parent', 'phone'];
  return { starts, roles, headerRowIndex: -1 };
}

/** Header-like row (title/header text, not a student): few words, starts with a header keyword. */
function isHeaderLikeRow(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^(class|student|students|name|roll|sr\.?|no\.?|phone|parent|father|list)\b/i.test(t) && t.split(/\s+/).length <= 5) {
    return true;
  }
  return false;
}

function assignColumn(left: number, starts: number[]): number {
  // The column whose start is the greatest start not more than 40px to the
  // right of the word (words sit a few px left of their column edge).
  let col = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i]! - 40 <= left) col = i;
    else break;
  }
  return col;
}

function confidenceOf(cells: Cell[]): number {
  const confs = cells.flatMap((c) => c.words.map((w) => w.conf)).filter((c) => c >= 0);
  if (confs.length === 0) return 0.5;
  const mean = confs.reduce((a, b) => a + b, 0) / confs.length / 100;
  const min = Math.min(...confs);
  let conf = Math.min(0.98, Math.max(0.3, mean));
  if (min < 60) conf = Math.min(conf, 0.65);
  return Math.round(conf * 100) / 100;
}

/** Same duplicate rules as parser.ts: same normalized name, or same roll no. */
function flagDuplicates(rows: ParsedRow[], existing: ExistingStudent[]): ParsedRow[] {
  const existingNames = new Set(existing.map((s) => normalizeName(s.name)));
  const existingRolls = new Set(
    existing.map((s) => s.roll_no).filter((r): r is number => r !== null && r !== undefined),
  );
  const seenNames = new Set<string>();
  const seenRolls = new Set<number>();
  return rows.map((r) => {
    const nameNorm = normalizeName(r.name);
    let duplicate = false;
    let duplicate_reason: string | null = null;
    if (existingNames.has(nameNorm) || seenNames.has(nameNorm)) {
      duplicate = true;
      duplicate_reason = 'duplicate_name';
    } else if (r.roll_no !== null && (existingRolls.has(r.roll_no) || seenRolls.has(r.roll_no))) {
      duplicate = true;
      duplicate_reason = 'duplicate_roll_no';
    }
    seenNames.add(nameNorm);
    if (r.roll_no !== null) seenRolls.add(r.roll_no);
    return { ...r, duplicate, duplicate_reason };
  });
}

/**
 * Parse Tesseract TSV word boxes into student rows for a column table.
 * Returns detected:false when the words do not form a table (e.g. a
 * plain name-only list) — the caller should then fall back to the
 * plain-text parser.
 */
export function parseTableWords(words: OcrWord[], existing: ExistingStudent[] = []): TableParseResult {
  const rows = groupWordsIntoRows(words);
  if (rows.length < 2) return { detected: false, columns: [], rows: [] };
  const cols = detectColumns(rows);
  if (!cols || cols.starts.length < 2) return { detected: false, columns: [], rows: [] };
  const { starts, roles } = cols;

  const parsed: ParsedRow[] = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri]!;
    // Skip the header row and any title rows above it; without a header,
    // skip header-like rows wherever they appear.
    if (cols.headerRowIndex >= 0) {
      if (ri <= cols.headerRowIndex) continue;
    } else if (isHeaderLikeRow(row.map((w) => w.text).join(' '))) {
      continue;
    }
    const cells = splitRowIntoCells(row);
    // Assign each cell's words to columns; a cell straddling a gutter is
    // split word-by-word instead.
    const byCol: Map<number, OcrWord[]> = new Map();
    for (const w of row) {
      const col = assignColumn(w.left, starts);
      const list = byCol.get(col) ?? [];
      list.push(w);
      byCol.set(col, list);
    }
    const cellText = (col: number): string => {
      const ws = (byCol.get(col) ?? []).sort((a, b) => a.left - b.left);
      return ws.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
    };
    const roleIndex = (role: string): number => roles.indexOf(role);
    const studentIdx = roleIndex('student');
    const name = studentIdx >= 0 ? cellText(studentIdx) : cellText(0);
    // A student name must contain letters — a row of bare numbers/roll
    // numbers is not a student (this also stops a plain "1. Name phone"
    // list being misread as a table: its roll numbers would land in the
    // first column and must never become student names).
    if (!name || !/[A-Za-z\u0600-\u06FF]/.test(name)) continue;
    const parentIdx = roleIndex('parent');
    const phoneIdx = roleIndex('phone');
    const rollIdx = roleIndex('roll');
    const parentName = parentIdx >= 0 ? cellText(parentIdx) : null;
    const phoneCell = phoneIdx >= 0 ? cellText(phoneIdx) : '';
    const parent_phone = phoneCell ? extractPhone(phoneCell) : null;
    let roll_no: number | null = null;
    if (rollIdx >= 0) {
      const digits = cellText(rollIdx).replace(/\D/g, '');
      if (digits) roll_no = parseInt(digits, 10);
    }
    const rowCells = cells;
    parsed.push({
      name,
      // Table passes read English only, so the Urdu name is always the
      // transliteration (dictionary + fallback) — editable on review.
      name_ur: transliterateName(name),
      roll_no,
      parent_phone: parent_phone ?? null,
      parent_phone_masked: parent_phone ? maskOf(parent_phone) : null,
      parent_name: parentName || null,
      parent_name_ur: parentName ? transliterateName(parentName) : null,
      confidence: confidenceOf(rowCells),
    });
  }
  if (parsed.length < 2) return { detected: false, columns: roles, rows: [] };
  return { detected: true, columns: roles, rows: flagDuplicates(parsed, existing) };
}

function maskOf(normalized: string): string {
  const digits = normalized.replace(/\D/g, '');
  return `+92 3XX XXXX${digits.slice(-3)}`;
}

/**
 * Second verification pass for table rows: names read by BOTH table passes
 * are 'match'; Latin names the verification pass did not read are
 * 'mismatch' (confidence capped at 0.55, highlighted on review);
 * 'unverified' when no verification read was possible.
 */
export function applyTableVerification(
  primary: ParsedRow[],
  verifiedNames: Set<string> | null,
): ParsedRow[] {
  if (verifiedNames === null) {
    return primary.map((r) => ({ ...r, verification: 'unverified' as const }));
  }
  return primary.map((r) => {
    const hasLatinName = /[A-Za-z]/.test(r.name);
    if (!hasLatinName) return { ...r, verification: 'unverified' as const };
    if (verifiedNames.has(normalizeName(r.name))) return { ...r, verification: 'match' as const };
    return { ...r, verification: 'mismatch' as const, confidence: Math.min(r.confidence, 0.55) };
  });
}

/**
 * Serialize table rows to the stored raw-text format: one line per row,
 * `name | parent_name | phone`. getUploadForReview re-parses this format
 * (see parseTableTextLines) so a re-opened review shows the same rows —
 * the flat line parser would merge the parent name into the student name.
 */
export function tableRowsToText(rows: ParsedRow[]): string {
  return rows
    .map((r) => [r.name, r.parent_name ?? '', r.parent_phone ?? ''].join(' | '))
    .join('\n');
}

/**
 * Parse stored `name | parent | phone` lines back into rows. Returns null
 * when the text is not in that format (caller falls back to the flat
 * line parser). Duplicate flags are applied against `existing`.
 */
export function parseTableTextLines(rawText: string, existing: ExistingStudent[] = []): ParsedRow[] | null {
  const lines = rawText.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return null;
  // Strict: EVERY non-empty line must be a `name | parent | phone` line,
  // otherwise this is plain OCR text (which can contain a stray "|" as
  // noise) and the caller must fall back to the flat line parser.
  for (const line of lines) {
    const parts = line.split(' | ');
    if (parts.length < 2 || parts.length > 3) return null;
    if (!(parts[0] ?? '').trim()) return null;
  }
  const rows: ParsedRow[] = [];
  for (const line of lines) {
    const parts = line.split(' | ');
    const name = (parts[0] ?? '').trim();
    const parentName = (parts[1] ?? '').trim() || null;
    const phoneRaw = (parts[2] ?? '').trim();
    const parent_phone = phoneRaw ? normalizePkPhone(phoneRaw) : null;
    rows.push({
      name,
      // Re-derived deterministically from the Latin name — the stored pipe
      // format carries no Urdu, and transliteration is deterministic, so a
      // re-opened review shows the same Urdu names as the first one.
      name_ur: transliterateName(name),
      roll_no: null,
      parent_phone: parent_phone ?? null,
      parent_phone_masked: parent_phone ? maskOf(parent_phone) : null,
      parent_name: parentName,
      parent_name_ur: parentName ? transliterateName(parentName) : null,
      confidence: 0.9,
    });
  }
  if (rows.length === 0) return null;
  return flagDuplicates(rows, existing);
}
