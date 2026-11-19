// College Mode GPA engine (2026-11-20) — pure functions, no DB access.
//
// GRADE TABLE — VERIFIED against the authoritative source, HEC "Policy
// Guidelines for the Implementation of Uniform Semester Examination
// System", section 13.1 ("Fractionalized Grading System"). This DIFFERS
// from the table assumed in the original task brief, which was:
//   A 85-100 (4.0), A- 80-84 (3.7), B+ 75-79 (3.3), B 70-74 (3.0),
//   B- 65-69 (2.7), C+ 61-64 (2.3), C 57-60 (2.0), C- 53-56 (1.7),
//   D+ 50-52 (1.3), D 40-49 (1.0), F <40 (0).
// The HEC §13.1 table actually printed is:
//   A 85+ (4.00), A- 80-84 (3.66), B+ 75-79 (3.33), B 71-74 (3.00),
//   B- 68-70 (2.66), C+ 64-67 (2.33), C 61-63 (2.00), C- 58-60 (1.66),
//   D+ 54-57 (1.3), D 50-53 (1.00), F below 50 (0.00).
// Differences: the B/C/D band boundaries are shifted (B starts at 71 not
// 70, B- at 68 not 65, C+ at 64 not 61, C at 61 not 57, C- at 58 not 53,
// D+ at 54 not 50, D at 50-53 not 40-49), the pass mark is 50% not 40%,
// and the grade points are single values (3.66/3.33/2.66/2.33/1.66, not
// 3.7/2.7/2.3/1.7). The HEC table is used here, per the task's
// "use the verified table" instruction. Individual universities publish
// their own variations (e.g. IBA, FAST-NUCES); a per-school grading scale
// override is a future extension, not part of this module.
//
// JUDGEMENT CALL — D as passing: under HEC §13.1 the pass mark is 50%,
// so D (50-53, 1.00 grade points) IS a passing grade — the course counts
// toward the degree and its 1.0 points enter the GPA. Some universities
// treat D as a fail for specific programmes (or require a repeat for
// major courses); this engine follows the HEC default. Only F (<50%,
// 0 points) is a fail, and a failed course still counts its credit hours
// in the GPA denominator (it drags the GPA down, exactly as HEC intends).
//
// REPEATED COURSES: when a student has marks for the same course under
// more than one exam, only the LATEST exam's marks count (latest by the
// mark row's updatedAt, then createdAt). Earlier attempts are ignored
// entirely — they contribute neither points nor credits.
//
// ROUNDING: GPA/CGPA are rounded to 2 decimals (standard half-up via
// Math.round(x * 100) / 100).

export interface GradeBand {
  grade: string;
  min: number; // inclusive percentage floor of the band
  points: number;
}

/** HEC §13.1 fractionalized grading table, highest band first. */
export const HEC_GRADE_BANDS: GradeBand[] = [
  { grade: 'A', min: 85, points: 4.0 },
  { grade: 'A-', min: 80, points: 3.66 },
  { grade: 'B+', min: 75, points: 3.33 },
  { grade: 'B', min: 71, points: 3.0 },
  { grade: 'B-', min: 68, points: 2.66 },
  { grade: 'C+', min: 64, points: 2.33 },
  { grade: 'C', min: 61, points: 2.0 },
  { grade: 'C-', min: 58, points: 1.66 },
  { grade: 'D+', min: 54, points: 1.3 },
  { grade: 'D', min: 50, points: 1.0 },
  { grade: 'F', min: 0, points: 0 },
];

/** Percentage (0-100) -> { grade, grade_points }. Null percentage -> F/0 is NOT assumed; callers pass only real marks. */
export function gradeForPercentage(percentage: number): { grade: string; grade_points: number } {
  const pct = Math.max(0, Math.min(100, percentage));
  const band = HEC_GRADE_BANDS.find((b) => pct >= b.min) ?? HEC_GRADE_BANDS[HEC_GRADE_BANDS.length - 1]!;
  return { grade: band.grade, grade_points: band.points };
}

/** Percentage from obtained/total marks, rounded to 2 decimals. */
export function percentageOf(obtainedMarks: number, totalMarks: number): number {
  if (!totalMarks || totalMarks <= 0) return 0;
  return Math.round((obtainedMarks / totalMarks) * 10000) / 100;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** One course's marks, as the GPA functions consume them. */
export interface CourseMarksInput {
  course_id: string;
  credit_hours: number;
  obtained_marks: number;
  total_marks: number;
  /** When the same course has marks under several exams, the row with the latest stamp wins. */
  updated_at?: Date | string | null;
  created_at?: Date | string | null;
}

function stampOf(m: CourseMarksInput): number {
  const u = m.updated_at ? new Date(m.updated_at).getTime() : 0;
  const c = m.created_at ? new Date(m.created_at).getTime() : 0;
  return Math.max(u, c);
}

/**
 * Latest-marks-only filter: for each course keep only the single mark row
 * with the latest updatedAt/createdAt stamp (repeated-course rule).
 */
export function latestMarksOnly(marks: CourseMarksInput[]): CourseMarksInput[] {
  const byCourse = new Map<string, CourseMarksInput>();
  for (const m of marks) {
    const prev = byCourse.get(m.course_id);
    if (!prev || stampOf(m) >= stampOf(prev)) byCourse.set(m.course_id, m);
  }
  return [...byCourse.values()];
}

/** Credit-weighted GPA over a set of course marks. Null when there are no marks (empty semester). */
export function computeGpa(marks: CourseMarksInput[]): number | null {
  const latest = latestMarksOnly(marks);
  if (latest.length === 0) return null;
  let points = 0;
  let credits = 0;
  for (const m of latest) {
    const { grade_points } = gradeForPercentage(percentageOf(m.obtained_marks, m.total_marks));
    points += grade_points * m.credit_hours;
    credits += m.credit_hours;
  }
  if (credits <= 0) return null;
  return round2(points / credits);
}

/** CGPA = the same credit-weighted average over ALL semesters' marks (latest attempt per course). */
export function computeCgpa(allMarks: CourseMarksInput[]): number | null {
  return computeGpa(allMarks);
}
