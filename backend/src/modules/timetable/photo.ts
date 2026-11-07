// Timetable-from-photo parser (FINAL REBUILD, Point 7).
// Turns Tesseract TSV word boxes (or plain OCR text as a fallback) from a
// photographed timetable sheet into structured per-period cells.
//
// ZERO-MISINFORMATION RULES:
//  - Never guess, never fill gaps, never change a name or a time.
//  - A cell the parser cannot read confidently is flagged, not invented.
//  - Teachers/classes are MATCHED to existing Staff/Class records; a name
//    with no match is returned as UNMATCHED for the admin to pick — a new
//    teacher/class is NEVER created silently.
//  - Times come only from the sheet. A period with no readable time gets
//    start_time/end_time null + flag 'missing_time' (the admin fills it in
//    on the review screen); period_no falls back to the row order and is
//    flagged 'period_inferred'.
//  - Conflicts are FLAGS on the review screen (teacher in two classes in
//    the same period, a period with a missing teacher); the confirm step
//    re-checks them against the live DB and skips conflicting rows.
//
// Layouts handled:
//  A. Days as COLUMNS (header row of day names; first column = periods).
//  B. Days as ROWS (first column = day names; header row = periods).
//  C. Single-day sheet (one day name found, or none — whole sheet is one day;
//     the admin picks the day on review if it could not be read).
// Fallback: plain-text line parsing ("Monday 1 Math - Ahmed 08:00-08:45").

export interface TimetableWord {
  text: string;
  conf: number; // 0..100 (-1 = unknown)
  left: number;
  top: number;
  width: number;
  height: number;
}

export type TimetableFlag =
  | 'missing_teacher'
  | 'missing_time'
  | 'missing_subject'
  | 'period_inferred'
  | 'teacher_double_booked'
  | 'class_double_booked'
  | 'unmatched_teacher'
  | 'unmatched_class'
  | 'low_confidence';

export interface ParsedTimetableCell {
  day_of_week: number | null;
  day_label: string | null;
  period_no: number | null;
  start_time: string | null;
  end_time: string | null;
  subject: string | null;
  teacher_name: string | null;
  /** Class as read on the sheet (e.g. "5-A"); null when the sheet is for one class. */
  class_label: string | null;
  confidence: number; // 0..1, mean word confidence of the cell
  flags: TimetableFlag[];
  source_text: string;
}

export interface MatchedTimetableCell extends ParsedTimetableCell {
  teacher_id: string | null;
  class_id: string | null;
}

export interface ExistingTeacher {
  id: string;
  name: string;
}
export interface ExistingClass {
  id: string;
  name: string;
  section: string;
}
export interface ExistingEntry {
  class_id: string;
  teacher_id: string | null;
  day_of_week: number;
  period_no: number;
  start_time: string;
  end_time: string;
  subject: string;
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_ALIASES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const TIME_RE = /^([01]?\d|2[0-3])[:.][0-5]\d$/;
const TIME_TOKEN_RE = /([01]?\d|2[0-3])[:.][0-5]\d/g;
const TIME_RANGE_RE = /((?:[01]?\d|2[0-3])[:.][0-5]\d)\s*(?:-|–|to)\s*((?:[01]?\d|2[0-3])[:.][0-5]\d)/;
const PERIOD_RE = /(?:period|p)\s*\.?\s*(\d{1,2})/i;
const BARE_NUMBER_RE = /^(\d{1,2})(?:st|nd|rd|th)?$/;

function dayOf(text: string): number | null {
  const key = text.toLowerCase().replace(/[^a-z]/g, '');
  return DAY_ALIASES[key] ?? null;
}

function normTime(t: string): string {
  const m = t.replace('.', ':').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t;
  return `${m[1]!.padStart(2, '0')}:${m[2]}`;
}

function timesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Parse a period label ("08:00-08:45", "8:00", "Period 1", "P1", "1st").
 * Returns what the label actually says — nothing is invented. A bare time
 * gives a start but no end (end stays null -> 'missing_time' flag).
 */
export function parsePeriodLabel(text: string): { period_no: number | null; start_time: string | null; end_time: string | null } {
  const t = text.trim();
  const range = t.match(TIME_RANGE_RE);
  const period = t.match(PERIOD_RE);
  if (range) {
    return {
      period_no: period ? parseInt(period[1]!, 10) : null,
      start_time: normTime(range[1]!),
      end_time: normTime(range[2]!),
    };
  }
  const wholeTime = t.match(TIME_RE);
  if (wholeTime) {
    return { period_no: period ? parseInt(period[1]!, 10) : null, start_time: normTime(wholeTime[0]), end_time: null };
  }
  const tokenTime = t.split(/\s+/).find((w) => TIME_RE.test(w));
  if (tokenTime) {
    return { period_no: period ? parseInt(period[1]!, 10) : null, start_time: normTime(tokenTime), end_time: null };
  }
  if (period) return { period_no: parseInt(period[1]!, 10), start_time: null, end_time: null };
  const bare = t.match(BARE_NUMBER_RE);
  if (bare) return { period_no: parseInt(bare[1]!, 10), start_time: null, end_time: null };
  return { period_no: null, start_time: null, end_time: null };
}

/** Split one cell's text into subject + teacher. Never guesses: when the
 * split is ambiguous the whole text stays the subject and the teacher is
 * left missing (flagged for the admin). */
export function splitSubjectTeacher(text: string, knownTeachers: ExistingTeacher[] = []): { subject: string | null; teacher_name: string | null } {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return { subject: null, teacher_name: null };
  // "Math (Sir Ahmed)" / "Math (Ahmed)" — parens hold the teacher.
  const paren = t.match(/^(.*?)\s*\(\s*([^()]+?)\s*\)\s*$/);
  if (paren) {
    return { subject: paren[1]!.trim() || null, teacher_name: paren[2]!.trim() || null };
  }
  // "Math - Ahmed" / "Math / Ahmed" / "Math | Ahmed" — last segment is the teacher.
  const dash = t.match(/^(.*?)\s*[-/|]\s*([^-\/|]+?)\s*$/);
  if (dash && dash[1]!.trim() && dash[2]!.trim()) {
    return { subject: dash[1]!.trim(), teacher_name: dash[2]!.trim() };
  }
  // A lone cell that IS a known teacher's name: teacher only, no subject.
  const lower = t.toLowerCase();
  if (knownTeachers.some((s) => s.name.trim().toLowerCase() === lower)) {
    return { subject: null, teacher_name: t };
  }
  return { subject: t, teacher_name: null };
}

// ---------------------------------------------------------------------------
// Grid reconstruction from TSV word boxes
// ---------------------------------------------------------------------------

interface Line {
  words: TimetableWord[];
  top: number;
  height: number;
}

/** Group words into visual lines (same y-band), sorted left-to-right. */
function groupLines(words: TimetableWord[]): Line[] {
  const sorted = [...words].sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: Line[] = [];
  for (const w of sorted) {
    const h = Math.max(w.height, 8);
    const line = lines.find((l) => Math.abs(w.top - l.top) <= Math.max(l.height, h) * 0.6);
    if (line) {
      line.words.push(w);
      line.words.sort((a, b) => a.left - b.left);
    } else {
      lines.push({ words: [w], top: w.top, height: h });
    }
  }
  lines.sort((a, b) => a.top - b.top);
  return lines;
}

function lineText(line: Line): string {
  return line.words.map((w) => w.text).join(' ');
}

function lineConf(line: Line): number {
  const confs = line.words.map((w) => w.conf).filter((c) => c >= 0);
  if (confs.length === 0) return 0.5;
  return confs.reduce((a, b) => a + b, 0) / confs.length / 100;
}

function wordConf(words: TimetableWord[]): number {
  const confs = words.map((w) => w.conf).filter((c) => c >= 0);
  if (confs.length === 0) return 0.5;
  return confs.reduce((a, b) => a + b, 0) / confs.length / 100;
}

interface DayToken {
  day: number;
  label: string;
  left: number; // left edge of the day-name word (start of its column)
  cx: number; // x-center
  cy: number; // y-center
}

function findDayTokens(words: TimetableWord[]): DayToken[] {
  const out: DayToken[] = [];
  for (const w of words) {
    const d = dayOf(w.text);
    if (d !== null) out.push({ day: d, label: DAY_NAMES[d]!, left: w.left, cx: w.left + w.width / 2, cy: w.top + w.height / 2 });
  }
  return out;
}

function makeCell(part: {
  day_of_week: number | null;
  day_label: string | null;
  period_no: number | null;
  start_time: string | null;
  end_time: string | null;
  subject: string | null;
  teacher_name: string | null;
  class_label: string | null;
  confidence: number;
  source_text: string;
}): ParsedTimetableCell {
  const flags: TimetableFlag[] = [];
  if (!part.teacher_name) flags.push('missing_teacher');
  if (!part.start_time || !part.end_time) flags.push('missing_time');
  if (!part.subject) flags.push('missing_subject');
  if (part.confidence < 0.7) flags.push('low_confidence');
  return { ...part, flags };
}

/**
 * Parse TSV words into timetable cells.
 * `sheetClass` — the class the sheet belongs to when the sheet itself is
 * for one class (e.g. the admin picked the class before uploading); cells
 * then carry class_label = sheetClass and no per-cell class is expected.
 */
export function parseTimetableWords(words: TimetableWord[], sheetClass: string | null = null): ParsedTimetableCell[] {
  const cells: ParsedTimetableCell[] = [];
  if (words.length === 0) return cells;
  const lines = groupLines(words);
  const dayTokens = findDayTokens(words);
  if (dayTokens.length === 0) return cells; // caller falls back to plain-text parse

  // Are the day names on ONE line (days = columns) or in ONE column (days = rows)?
  const sameLine = dayTokens.length >= 2 && Math.max(...dayTokens.map((t) => t.cy)) - Math.min(...dayTokens.map((t) => t.cy)) < 30;
  const sameCol = dayTokens.length >= 2 && Math.max(...dayTokens.map((t) => t.cx)) - Math.min(...dayTokens.map((t) => t.cx)) < 60;

  if (sameLine || dayTokens.length === 1) {
    return parseDaysAsColumns(lines, dayTokens, sheetClass);
  }
  if (sameCol) {
    return parseDaysAsRows(lines, dayTokens, sheetClass);
  }
  // Ambiguous layout: treat the first day token's line as the header.
  return parseDaysAsColumns(lines, dayTokens, sheetClass);
}

/** Layout A: header row holds day names; first column holds period labels. */
function parseDaysAsColumns(lines: Line[], dayTokens: DayToken[], sheetClass: string | null): ParsedTimetableCell[] {
  const days = [...dayTokens].sort((a, b) => a.cx - b.cx);
  // Column boundaries: midpoints between neighbouring day centres.
  const bounds: number[] = [];
  for (let i = 0; i < days.length - 1; i++) bounds.push((days[i]!.cx + days[i + 1]!.cx) / 2);
  // Single-day sheet: the only day column starts at its own centre; the
  // period labels live to its left.
  // Period labels live LEFT of the first day column's left edge; the
  // midpoint between day centres only separates day columns from each other.
  const firstBoundary = days[0]!.left;
  const colOf = (cx: number): number => {
    for (let i = 0; i < bounds.length; i++) if (cx < bounds[i]!) return i;
    return days.length - 1;
  };
  const headerTop = Math.min(...days.map((d) => d.cy));
  const cells: ParsedTimetableCell[] = [];
  let rowIndex = 0;
  for (const line of lines) {
    if (line.top < headerTop - 10) continue; // title rows above the header
    // Skip the header line itself (it holds the day names).
    if (Math.abs(line.top - headerTop) < 20 && line.words.some((w) => dayOf(w.text) !== null)) continue;
    const periodWords = line.words.filter((w) => w.left + w.width / 2 < firstBoundary);
    const label = parsePeriodLabel(periodWords.map((w) => w.text).join(' '));
    rowIndex += 1;
    for (let d = 0; d < days.length; d++) {
      const cellWords = line.words.filter((w) => {
        const cx = w.left + w.width / 2;
        return colOf(cx) === d && !periodWords.includes(w);
      });
      if (cellWords.length === 0) continue;
      const text = cellWords.map((w) => w.text).join(' ');
      if (/^(break|lunch|recess|interval)$/i.test(text.trim())) continue;
      const { subject, teacher_name } = splitSubjectTeacher(text);
      const period_no = label.period_no ?? rowIndex;
      cells.push(
        makeCell({
          day_of_week: days[d]!.day,
          day_label: days[d]!.label,
          period_no,
          start_time: label.start_time,
          end_time: label.end_time,
          subject,
          teacher_name,
          class_label: sheetClass,
          confidence: wordConf(cellWords),
          source_text: text,
        }),
      );
      const cell = cells[cells.length - 1]!;
      if (label.period_no === null) cell.flags.push('period_inferred');
    }
  }
  return cells;
}

/** Layout B: first column holds day names; header row holds period labels. */
function parseDaysAsRows(lines: Line[], dayTokens: DayToken[], sheetClass: string | null): ParsedTimetableCell[] {
  const days = [...dayTokens].sort((a, b) => a.cy - b.cy);
  const dayColX = Math.min(...days.map((d) => d.cx));
  // Period header: the line above the first day row that holds times/periods.
  const firstDayTop = Math.min(...days.map((d) => d.cy));
  const headerLine = lines.filter((l) => l.top < firstDayTop - 5).pop();
  const periodLabels: { cx: number; label: ReturnType<typeof parsePeriodLabel> }[] = [];
  if (headerLine) {
    // Split the header line into column clusters by x-gaps.
    const clusters: TimetableWord[][] = [];
    for (const w of headerLine.words) {
      const last = clusters[clusters.length - 1];
      const lastWord = last?.[last.length - 1];
      if (last && lastWord && w.left - (lastWord.left + lastWord.width) < 40) last.push(w);
      else clusters.push([w]);
    }
    for (const c of clusters) {
      const text = c.map((w) => w.text).join(' ');
      if (dayOf(text) !== null) continue; // the "Day" corner label
      const label = parsePeriodLabel(text);
      if (label.period_no !== null || label.start_time) {
        periodLabels.push({ cx: c.reduce((a, w) => a + w.left + w.width / 2, 0) / c.length, label });
      }
    }
  }
  const periodBounds: number[] = [];
  for (let i = 0; i < periodLabels.length - 1; i++) {
    periodBounds.push((periodLabels[i]!.cx + periodLabels[i + 1]!.cx) / 2);
  }
  const colOf = (cx: number): number => {
    for (let i = 0; i < periodBounds.length; i++) if (cx < periodBounds[i]!) return i;
    return periodLabels.length - 1;
  };
  const cells: ParsedTimetableCell[] = [];
  for (const dayTok of days) {
    // The day's row: the line whose y is closest to the day token.
    const row = lines.reduce<Line | null>((best, l) => {
      if (!best) return l;
      return Math.abs(l.top - dayTok.cy) < Math.abs(best.top - dayTok.cy) ? l : best;
    }, null);
    if (!row) continue;
    const cellWords = row.words.filter((w) => w.left + w.width / 2 > dayColX + 40);
    // Group the row's words by period column.
    const byCol = new Map<number, TimetableWord[]>();
    for (const w of cellWords) {
      const c = periodLabels.length > 0 ? colOf(w.left + w.width / 2) : 0;
      const arr = byCol.get(c) ?? [];
      arr.push(w);
      byCol.set(c, arr);
    }
    let colIndex = 0;
    for (const [c, ws] of [...byCol.entries()].sort((a, b) => a[0] - b[0])) {
      colIndex += 1;
      const text = ws.map((w) => w.text).join(' ');
      if (/^(break|lunch|recess|interval)$/i.test(text.trim())) continue;
      const { subject, teacher_name } = splitSubjectTeacher(text);
      const label = periodLabels[c]?.label ?? { period_no: null, start_time: null, end_time: null };
      const period_no = label.period_no ?? colIndex;
      cells.push(
        makeCell({
          day_of_week: dayTok.day,
          day_label: dayTok.label,
          period_no,
          start_time: label.start_time,
          end_time: label.end_time,
          subject,
          teacher_name,
          class_label: sheetClass,
          confidence: wordConf(ws),
          source_text: text,
        }),
      );
      const cell = cells[cells.length - 1]!;
      if (label.period_no === null) cell.flags.push('period_inferred');
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Plain-text fallback (no TSV / no detectable grid)
// ---------------------------------------------------------------------------

/**
 * Fallback for sheets whose grid could not be reconstructed: one line per
 * period, e.g. "Monday 1 Math - Ahmed 08:00-08:45" or
 * "Monday Period 2 English (Sara) 09:00 - 09:45". Lines without a day name
 * are skipped rather than guessed.
 */
export function parseTimetableText(rawText: string, sheetClass: string | null = null): ParsedTimetableCell[] {
  const cells: ParsedTimetableCell[] = [];
  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const dayMatch = line.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/i);
    if (!dayMatch) continue;
    const day = dayOf(dayMatch[1]!);
    if (day === null) continue;
    const rest = line.slice(dayMatch.index! + dayMatch[0].length).trim();
    const label = parsePeriodLabel(rest);
    // Remove the period label + any time range from the text, then split subject/teacher.
    let text = rest
      .replace(TIME_RANGE_RE, ' ')
      .replace(PERIOD_RE, ' ')
      .replace(TIME_TOKEN_RE, ' ')
      .replace(/[,;|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // A leading bare number is the period number.
    const bare = text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+/);
    let period_no = label.period_no;
    if (bare && period_no === null) {
      period_no = parseInt(bare[1]!, 10);
      text = text.slice(bare[0].length).trim();
    }
    if (!text) continue;
    const { subject, teacher_name } = splitSubjectTeacher(text);
    const cell = makeCell({
      day_of_week: day,
      day_label: DAY_NAMES[day]!,
      period_no,
      start_time: label.start_time,
      end_time: label.end_time,
      subject,
      teacher_name,
      class_label: sheetClass,
      confidence: 0.6, // plain-text fallback: no word confidences
      source_text: line,
    });
    if (period_no === null) cell.flags.push('period_inferred');
    cells.push(cell);
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Matching to existing records + conflict flags
// ---------------------------------------------------------------------------

/** "5-A" / "Class 5 A" / "5A" all match class {name:'5', section:'A'}. */
export function matchClassLabel(label: string | null, classes: ExistingClass[]): ExistingClass | null {
  if (!label) return null;
  const norm = label.toLowerCase().replace(/^class\s+/, '').replace(/[^a-z0-9]/g, '');
  if (!norm) return null;
  return classes.find((c) => `${c.name}${c.section}`.toLowerCase().replace(/[^a-z0-9]/g, '') === norm) ?? null;
}

export function matchTeacherName(name: string | null, teachers: ExistingTeacher[]): ExistingTeacher | null {
  if (!name) return null;
  const norm = name.trim().toLowerCase();
  return teachers.find((t) => t.name.trim().toLowerCase() === norm) ?? null;
}

export interface MatchOutcome {
  cells: MatchedTimetableCell[];
  unmatched_teachers: string[];
  unmatched_classes: string[];
}

/**
 * Match every cell's teacher/class to existing records. Unmatched names are
 * collected for the admin to resolve — nothing is created here.
 */
export function matchTimetableCells(
  cells: ParsedTimetableCell[],
  teachers: ExistingTeacher[],
  classes: ExistingClass[],
): MatchOutcome {
  const unmatchedTeachers = new Set<string>();
  const unmatchedClasses = new Set<string>();
  const matched: MatchedTimetableCell[] = cells.map((c) => {
    const teacher = matchTeacherName(c.teacher_name, teachers);
    const klass = matchClassLabel(c.class_label, classes);
    const flags = [...c.flags];
    if (c.teacher_name && !teacher) {
      flags.push('unmatched_teacher');
      unmatchedTeachers.add(c.teacher_name);
    }
    if (c.class_label && !klass) {
      flags.push('unmatched_class');
      unmatchedClasses.add(c.class_label);
    }
    return { ...c, flags, teacher_id: teacher?.id ?? null, class_id: klass?.id ?? null };
  });
  return {
    cells: matched,
    unmatched_teachers: [...unmatchedTeachers],
    unmatched_classes: [...unmatchedClasses],
  };
}

/**
 * Flag problems across the parsed batch AND against existing entries:
 * teacher double-booked (same day + period, or overlapping times),
 * class double-booked (same day + period), missing teacher/time/subject
 * are already set by makeCell. Pure function — no I/O.
 */
export function flagTimetableConflicts(cells: MatchedTimetableCell[], existing: ExistingEntry[]): MatchedTimetableCell[] {
  const out = cells.map((c) => ({ ...c, flags: [...c.flags] }));
  const key = (day: number | null, period: number | null): string => `${day}:${period}`;
  const seenTeacher = new Map<string, MatchedTimetableCell>();
  const seenClass = new Map<string, MatchedTimetableCell>();
  const addFlag = (cell: MatchedTimetableCell, flag: TimetableFlag): void => {
    if (!cell.flags.includes(flag)) cell.flags.push(flag);
  };

  for (const cell of out) {
    // --- against the batch itself ---
    const teacherKey = cell.teacher_id ?? (cell.teacher_name ? `name:${cell.teacher_name.trim().toLowerCase()}` : null);
    if (teacherKey && cell.day_of_week !== null && cell.period_no !== null) {
      const k = `${teacherKey}|${key(cell.day_of_week, cell.period_no)}`;
      const clash = seenTeacher.get(k);
      if (clash) {
        addFlag(cell, 'teacher_double_booked');
        addFlag(clash, 'teacher_double_booked');
      } else {
        seenTeacher.set(k, cell);
      }
      // Overlapping times (different period number, same teacher + day).
      if (cell.start_time && cell.end_time) {
        for (const other of out) {
          if (other === cell || other.day_of_week !== cell.day_of_week || !other.start_time || !other.end_time) continue;
          const otherKey = other.teacher_id ?? (other.teacher_name ? `name:${other.teacher_name.trim().toLowerCase()}` : null);
          if (otherKey === teacherKey && other.period_no !== cell.period_no && timesOverlap(cell.start_time, cell.end_time, other.start_time, other.end_time)) {
            addFlag(cell, 'teacher_double_booked');
            addFlag(other, 'teacher_double_booked');
          }
        }
      }
    }
    if (cell.class_id && cell.day_of_week !== null && cell.period_no !== null) {
      const k = `${cell.class_id}|${key(cell.day_of_week, cell.period_no)}`;
      const clash = seenClass.get(k);
      if (clash) {
        addFlag(cell, 'class_double_booked');
        addFlag(clash, 'class_double_booked');
      } else {
        seenClass.set(k, cell);
      }
    }
    // --- against existing entries in the DB ---
    for (const e of existing) {
      if (e.day_of_week !== cell.day_of_week) continue;
      if (cell.teacher_id && e.teacher_id === cell.teacher_id) {
        if (e.period_no === cell.period_no || (cell.start_time && cell.end_time && timesOverlap(cell.start_time, cell.end_time, e.start_time, e.end_time))) {
          addFlag(cell, 'teacher_double_booked');
        }
      }
      if (cell.class_id && e.class_id === cell.class_id && e.period_no === cell.period_no) {
        addFlag(cell, 'class_double_booked');
      }
    }
  }
  return out;
}
