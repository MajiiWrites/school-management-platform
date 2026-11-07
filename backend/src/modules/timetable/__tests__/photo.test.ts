// Timetable-from-photo tests (FINAL REBUILD, Point 7) — parser, matching,
// conflict flags, and the upload -> confirm flow (both views from the
// same entries). Pure parser tests need no DB; service tests use FakeDb.
import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../../../lib/db';
import { FakeDb, seed6C1 } from '../../sessions/__tests__/fake-db';
import * as svc from '../service';
import * as staffSvc from '../../staff/service';
import {
  parsePeriodLabel,
  splitSubjectTeacher,
  parseTimetableWords,
  parseTimetableText,
  matchTimetableCells,
  matchClassLabel,
  flagTimetableConflicts,
  type TimetableWord,
  type MatchedTimetableCell,
} from '../photo';

/** Synthetic TSV word: `text` at (left, top); width ~8px/char, height 18. */
function w(text: string, left: number, top: number, conf = 95): TimetableWord {
  return { text, conf, left, top, width: Math.max(10, text.length * 8), height: 18 };
}

/** Layout A grid: days as columns, first column = period times. */
function gridAWords(): TimetableWord[] {
  return [
    // header row
    w('Period', 10, 10), w('Monday', 150, 10), w('Tuesday', 400, 10),
    // row 1
    w('08:00-08:45', 10, 40), w('Math', 150, 40), w('(Ayesha', 200, 40), w('Khan)', 245, 40),
    w('English', 400, 40), w('-', 455, 40), w('Bilal', 470, 40), w('Ahmed', 510, 40),
    // row 2
    w('09:00-09:45', 10, 70), w('Science', 150, 70), w('-', 215, 70), w('Ayesha', 230, 70), w('Khan', 270, 70),
    w('Urdu', 400, 70), w('(Bilal', 445, 70), w('Ahmed)', 485, 70),
  ];
}

describe('parsePeriodLabel', () => {
  it('reads time ranges, single times, period numbers and bare numbers', () => {
    expect(parsePeriodLabel('08:00-08:45')).toEqual({ period_no: null, start_time: '08:00', end_time: '08:45' });
    expect(parsePeriodLabel('8:00 - 8:45')).toEqual({ period_no: null, start_time: '08:00', end_time: '08:45' });
    expect(parsePeriodLabel('Period 1 08:00-08:45')).toEqual({ period_no: 1, start_time: '08:00', end_time: '08:45' });
    expect(parsePeriodLabel('P3')).toEqual({ period_no: 3, start_time: null, end_time: null });
    expect(parsePeriodLabel('08:00')).toEqual({ period_no: null, start_time: '08:00', end_time: null });
    expect(parsePeriodLabel('2nd')).toEqual({ period_no: 2, start_time: null, end_time: null });
    // Never invents: garbage yields all-null.
    expect(parsePeriodLabel('abc')).toEqual({ period_no: null, start_time: null, end_time: null });
  });
});

describe('splitSubjectTeacher', () => {
  it('splits "Subject (Teacher)", "Subject - Teacher" and keeps the rest as subject', () => {
    expect(splitSubjectTeacher('Math (Ayesha Khan)')).toEqual({ subject: 'Math', teacher_name: 'Ayesha Khan' });
    expect(splitSubjectTeacher('English - Bilal Ahmed')).toEqual({ subject: 'English', teacher_name: 'Bilal Ahmed' });
    expect(splitSubjectTeacher('Urdu / Sara Khan')).toEqual({ subject: 'Urdu', teacher_name: 'Sara Khan' });
    // Ambiguous single text: subject only, teacher missing (flagged, never guessed).
    expect(splitSubjectTeacher('Mathematics')).toEqual({ subject: 'Mathematics', teacher_name: null });
  });

  it('a lone known teacher name is the teacher, not a subject', () => {
    expect(splitSubjectTeacher('Ayesha Khan', [{ id: 't1', name: 'Ayesha Khan' }])).toEqual({
      subject: null,
      teacher_name: 'Ayesha Khan',
    });
  });
});

describe('parseTimetableWords (days as columns)', () => {
  it('builds cells with day, period, times, subject and teacher — nothing guessed', () => {
    const cells = parseTimetableWords(gridAWords(), '5-A');
    expect(cells).toHaveLength(4);
    const mon1 = cells.find((c) => c.day_of_week === 1 && c.period_no === 1)!;
    expect(mon1.subject).toBe('Math');
    expect(mon1.teacher_name).toBe('Ayesha Khan');
    expect(mon1.start_time).toBe('08:00');
    expect(mon1.end_time).toBe('08:45');
    expect(mon1.class_label).toBe('5-A');
    expect(mon1.flags).not.toContain('missing_teacher');
    const tue2 = cells.find((c) => c.day_of_week === 2 && c.period_no === 2)!;
    expect(tue2.subject).toBe('Urdu');
    expect(tue2.teacher_name).toBe('Bilal Ahmed');
    // Period numbers come from row order and are flagged as inferred.
    expect(cells.every((c) => c.flags.includes('period_inferred'))).toBe(true);
  });

  it('flags a missing teacher and missing time instead of inventing them', () => {
    const words = [
      w('Monday', 150, 10),
      w('P1', 10, 40), w('Math', 150, 40),
    ];
    const cells = parseTimetableWords(words, '5-A');
    expect(cells).toHaveLength(1);
    expect(cells[0].subject).toBe('Math');
    expect(cells[0].teacher_name).toBeNull();
    expect(cells[0].flags).toContain('missing_teacher');
    expect(cells[0].flags).toContain('missing_time');
    expect(cells[0].start_time).toBeNull();
  });

  it('returns no cells when no day name is present (caller falls back to text)', () => {
    expect(parseTimetableWords([w('Math', 10, 10), w('English', 10, 40)])).toHaveLength(0);
  });
});

describe('parseTimetableWords (days as rows)', () => {
  /** Layout B grid: days down the first column, header row = period times. */
  function gridBWords(): TimetableWord[] {
    return [
      // header row (times only)
      w('08:00-08:45', 150, 10), w('09:00-09:45', 400, 10),
      // Monday row
      w('Monday', 10, 40), w('Math', 150, 40), w('-', 200, 40), w('Ayesha', 215, 40), w('Khan', 260, 40),
      w('English', 400, 40), w('-', 455, 40), w('Bilal', 470, 40), w('Ahmed', 510, 40),
      // Tuesday row
      w('Tuesday', 10, 70), w('Science', 150, 70), w('-', 215, 70), w('Ayesha', 230, 70), w('Khan', 270, 70),
      w('Urdu', 400, 70), w('(Bilal', 445, 70), w('Ahmed)', 485, 70),
    ];
  }

  it('builds one cell per period (not one merged cell per day) with times', () => {
    const cells = parseTimetableWords(gridBWords(), '5-A');
    expect(cells).toHaveLength(4);
    const mon1 = cells.find((c) => c.day_of_week === 1 && c.period_no === 1)!;
    expect(mon1.subject).toBe('Math');
    expect(mon1.teacher_name).toBe('Ayesha Khan');
    expect(mon1.start_time).toBe('08:00');
    expect(mon1.end_time).toBe('08:45');
    expect(mon1.flags).not.toContain('missing_time');
    // Times-only header: period numbers come from column order, so the
    // flag correctly stays (times themselves are read, not inferred).
    expect(mon1.flags).toContain('period_inferred');
    const mon2 = cells.find((c) => c.day_of_week === 1 && c.period_no === 2)!;
    expect(mon2.subject).toBe('English');
    expect(mon2.teacher_name).toBe('Bilal Ahmed');
    expect(mon2.start_time).toBe('09:00');
    const tue1 = cells.find((c) => c.day_of_week === 2 && c.period_no === 1)!;
    expect(tue1.subject).toBe('Science');
    expect(tue1.teacher_name).toBe('Ayesha Khan');
  });

  it('REGRESSION (live re-test 2026-11-07): the header is the times row, never the first day row', () => {
    // A day row's own line top sits ABOVE its day token's centre (cy) by
    // half the word height, so `top < cy - 5` used to match the Monday row
    // itself as the "header" — every day collapsed to one merged cell with
    // no times. With the header fixed to the times row, Monday period 1
    // carries its real time.
    const cells = parseTimetableWords(gridBWords(), '5-A');
    const mon1 = cells.find((c) => c.day_of_week === 1 && c.period_no === 1)!;
    expect(mon1.start_time).toBe('08:00');
    expect(mon1.subject).toBe('Math');
    expect(cells.filter((c) => c.day_of_week === 1)).toHaveLength(2);
  });
});

describe('parseTimetableText fallback', () => {
  it('parses one line per period and skips lines without a day (never guesses)', () => {
    const cells = parseTimetableText(
      'Monday 1 Math - Ahmed 08:00-08:45\nTuesday Period 2 English (Sara) 09:00 - 09:45\nSome random line\nFriday 3 Urdu',
      '5-A',
    );
    expect(cells).toHaveLength(3);
    expect(cells[0]).toMatchObject({ day_of_week: 1, period_no: 1, subject: 'Math', teacher_name: 'Ahmed', start_time: '08:00', end_time: '08:45' });
    expect(cells[1]).toMatchObject({ day_of_week: 2, period_no: 2, subject: 'English', teacher_name: 'Sara', start_time: '09:00', end_time: '09:45' });
    expect(cells[2]).toMatchObject({ day_of_week: 5, period_no: 3, subject: 'Urdu', teacher_name: null });
    expect(cells[2].flags).toContain('missing_teacher');
    expect(cells[2].flags).toContain('missing_time');
  });
});

describe('matching (never create silently)', () => {
  const teachers = [
    { id: 't-ayesha', name: 'Ayesha Khan' },
    { id: 't-bilal', name: 'Bilal Ahmed' },
  ];
  const classes = [
    { id: 'c-5a', name: '5', section: 'A' },
    { id: 'c-6a', name: '6', section: 'A' },
  ];

  it('matchClassLabel accepts "5-A", "Class 5 A" and "5A"', () => {
    expect(matchClassLabel('5-A', classes)?.id).toBe('c-5a');
    expect(matchClassLabel('Class 5 A', classes)?.id).toBe('c-5a');
    expect(matchClassLabel('5A', classes)?.id).toBe('c-5a');
    expect(matchClassLabel('7-B', classes)).toBeNull();
    expect(matchClassLabel(null, classes)).toBeNull();
  });

  it('unmatched teachers/classes are collected for the admin, ids stay null', () => {
    const cells = parseTimetableWords(gridAWords(), '5-A');
    // Rename one teacher to someone who does not exist.
    const renamed = cells.map((c) => (c.teacher_name === 'Bilal Ahmed' ? { ...c, teacher_name: 'Sir Unknown' } : c));
    const out = matchTimetableCells(renamed, teachers, classes);
    expect(out.unmatched_teachers).toEqual(['Sir Unknown']);
    expect(out.unmatched_classes).toEqual([]);
    const unknown = out.cells.filter((c) => c.teacher_name === 'Sir Unknown');
    expect(unknown).toHaveLength(2);
    for (const c of unknown) {
      expect(c.teacher_id).toBeNull();
      expect(c.flags).toContain('unmatched_teacher');
    }
    const known = out.cells.find((c) => c.teacher_name === 'Ayesha Khan')!;
    expect(known.teacher_id).toBe('t-ayesha');
  });
});

describe('flagTimetableConflicts', () => {
  function cell(partial: Partial<MatchedTimetableCell>): MatchedTimetableCell {
    return {
      day_of_week: 1, day_label: 'Monday', period_no: 1, start_time: '08:00', end_time: '08:45',
      subject: 'Math', teacher_name: 'Ayesha Khan', class_label: '5-A', confidence: 0.95,
      flags: [], source_text: 'Math (Ayesha Khan)', teacher_id: 't-ayesha', class_id: 'c-5a',
      ...partial,
    };
  }

  it('flags a teacher in two classes in the same period (same period + overlapping times)', () => {
    const a = cell({});
    const b = cell({ class_id: 'c-6a', subject: 'Science' });
    const out = flagTimetableConflicts([a, b], []);
    expect(out[0].flags).toContain('teacher_double_booked');
    expect(out[1].flags).toContain('teacher_double_booked');
  });

  it('flags overlapping times for the same teacher under different period numbers', () => {
    const a = cell({});
    const b = cell({ class_id: 'c-6a', period_no: 2, start_time: '08:30', end_time: '09:15', subject: 'Science' });
    const out = flagTimetableConflicts([a, b], []);
    expect(out[1].flags).toContain('teacher_double_booked');
  });

  it('flags a class double-booked in the same period', () => {
    const a = cell({});
    const b = cell({ teacher_id: null, teacher_name: null, subject: 'English', flags: ['missing_teacher'] });
    const out = flagTimetableConflicts([a, b], []);
    expect(out[1].flags).toContain('class_double_booked');
  });

  it('flags against existing DB entries', () => {
    const existing = [{ class_id: 'c-6a', teacher_id: 't-ayesha', day_of_week: 1, period_no: 1, start_time: '08:00', end_time: '08:45', subject: 'Math' }];
    const out = flagTimetableConflicts([cell({ class_id: 'c-5a' })], existing);
    expect(out[0].flags).toContain('teacher_double_booked');
  });

  it('adjacent (non-overlapping) times for the same teacher are fine', () => {
    const a = cell({});
    const b = cell({ class_id: 'c-6a', period_no: 2, start_time: '08:45', end_time: '09:30', subject: 'Science' });
    const out = flagTimetableConflicts([a, b], []);
    expect(out[0].flags).not.toContain('teacher_double_booked');
    expect(out[1].flags).not.toContain('teacher_double_booked');
  });
});

describe('upload -> confirm flow (FakeDb)', () => {
  let db: Db;
  let schoolId: string;
  let classAId: string;
  let teacherId: string;

  beforeEach(async () => {
    const fake = new FakeDb();
    const seed = seed6C1(fake);
    db = fake as unknown as Db;
    schoolId = seed.schoolId;
    classAId = seed.classAId;
    const t = await staffSvc.createStaff(db, schoolId, { name: 'Ayesha Khan', role: 'teacher', subjects: ['Math'] }, 'admin-1');
    teacherId = t.id as string;
    await staffSvc.createStaff(db, schoolId, { name: 'Bilal Ahmed', role: 'teacher', subjects: ['English'] }, 'admin-1');
  });

  it('uploads a photo, matches teachers/classes, and confirms into BOTH views', async () => {
    const res = await svc.uploadTimetablePhoto(db, schoolId, '/tmp/tt.png', 'admin-1', {
      class_id: classAId,
      runTsv: async () => gridAWords(),
    });
    expect(res.cells).toHaveLength(4);
    expect(res.unmatched_teachers).toEqual([]);
    expect(res.unmatched_classes).toEqual([]);
    expect(res.cells.every((c) => c.class_id === classAId)).toBe(true);
    const mon1 = res.cells.find((c) => c.day_of_week === 1 && c.period_no === 1)!;
    expect(mon1.teacher_id).toBe(teacherId);

    const confirmed = await svc.confirmTimetablePhoto(
      db,
      schoolId,
      res.cells.map((c) => ({
        class_id: c.class_id!,
        teacher_id: c.teacher_id,
        day_of_week: c.day_of_week!,
        period_no: c.period_no!,
        subject: c.subject!,
        start_time: c.start_time!,
        end_time: c.end_time!,
      })),
      'admin-1',
    );
    expect(confirmed.created).toBe(4);
    expect(confirmed.skipped).toHaveLength(0);

    // BOTH views are queries over the same entries.
    const classView = await svc.getClassTimetable(db, schoolId, classAId);
    expect((classView.entries as unknown[]).length).toBe(4);
    const teacherView = await svc.getTeacherTimetable(db, schoolId, teacherId);
    expect((teacherView.entries as unknown[]).length).toBe(2); // Ayesha teaches Mon P1 + P2
    expect((teacherView.entries as { subject: string }[]).map((e) => e.subject).sort()).toEqual(['Math', 'Science']);
  });

  it('confirm skips conflicting rows with a reason and still saves the rest', async () => {
    await svc.createTimetableEntry(db, schoolId, { class_id: classAId, teacher_id: teacherId, day_of_week: 1, period_no: 1, subject: 'Math', start_time: '08:00', end_time: '08:45' }, 'admin-1');
    const res = await svc.confirmTimetablePhoto(
      db,
      schoolId,
      [
        { class_id: classAId, teacher_id: teacherId, day_of_week: 1, period_no: 1, subject: 'English', start_time: '09:00', end_time: '09:45' },
        { class_id: classAId, teacher_id: null, day_of_week: 1, period_no: 2, subject: 'English', start_time: '09:00', end_time: '09:45' },
      ],
      'admin-1',
    );
    expect(res.created).toBe(1);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].reason).toMatch(/already has a lesson in period 1/);
  });

  it('manual add still works after the photo flow (unchanged path)', async () => {
    const e = await svc.createTimetableEntry(db, schoolId, { class_id: classAId, teacher_id: teacherId, day_of_week: 3, period_no: 1, subject: 'Math', start_time: '08:00', end_time: '08:45' }, 'admin-1');
    expect(e.subject).toBe('Math');
    expect(e.day_name).toBe('Wednesday');
  });
});
