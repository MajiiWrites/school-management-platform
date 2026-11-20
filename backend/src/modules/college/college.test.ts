// College Mode tests (2026-11-20): GPA engine (HEC §13.1 bands) +
// service behaviour on an in-memory fake Db (same conventions as
// classes/classes.test.ts). Covers: college gate 403, isolation (404,
// never leak), GPA/CGPA math incl. failed course / repeated course
// (latest wins) / empty semester (null) / credit weighting, enrollment
// uniqueness, marks upsert, delete guards, report-card college block
// present for College / absent for School.
import { describe, it, expect } from 'vitest';
import { gradeForPercentage, computeGpa, latestMarksOnly } from './gpa';
import * as svc from './service';
import { getReportCard, renderReportCardHtml, renderReportCardPdf } from '../results/service';

function fakeDb() {
  const schools: any[] = [
    { id: 'college-1', name: 'Test College', timezone: 'Asia/Karachi', orgType: 'College', settings: {} },
    { id: 'school-2', name: 'Test School', timezone: 'Asia/Karachi', orgType: 'School', settings: {} },
    { id: 'college-3', name: 'Other College', timezone: 'Asia/Karachi', orgType: 'College', settings: {} },
  ];
  const programs: any[] = [];
  const semesters: any[] = [];
  const courses: any[] = [];
  const enrollments: any[] = [];
  const marks: any[] = [];
  const students: any[] = [
    { id: 'stu-1', schoolId: 'college-1', classId: 'class-1', rollNo: 1, name: 'Ayesha Khan', fatherName: 'Ahmed Khan', status: 'active', deletedAt: null },
    { id: 'stu-2', schoolId: 'college-1', classId: 'class-1', rollNo: 2, name: 'Bilal Ahmed', fatherName: 'Raza Ahmed', status: 'active', deletedAt: null },
    { id: 'stu-3', schoolId: 'college-1', classId: 'class-1', rollNo: 3, name: 'No Marks', fatherName: null, status: 'active', deletedAt: null },
    { id: 'stu-inactive', schoolId: 'college-1', classId: 'class-1', rollNo: 4, name: 'Inactive One', fatherName: null, status: 'inactive', deletedAt: null },
    { id: 'stu-other', schoolId: 'college-3', classId: 'class-3', rollNo: 1, name: 'Other College Student', fatherName: null, status: 'active', deletedAt: null },
    { id: 'stu-s', schoolId: 'school-2', classId: 'class-s', rollNo: 1, name: 'School Kid', fatherName: 'Father S', status: 'active', deletedAt: null },
    { id: 'stu-s2', schoolId: 'school-2', classId: 'class-s', rollNo: 2, name: 'School No Results', fatherName: 'Father S2', status: 'active', deletedAt: null },
  ];
  const staff: any[] = [
    { id: 'teacher-1', schoolId: 'college-1', name: 'Prof. Sana', role: 'teacher' },
    { id: 'teacher-other', schoolId: 'college-3', name: 'Prof. Other', role: 'teacher' },
  ];
  const exams: any[] = [
    { id: 'exam-1', schoolId: 'college-1', name: 'Midterm', type: 'midterm', deletedAt: null },
    { id: 'exam-2', schoolId: 'college-1', name: 'Annual', type: 'annual', deletedAt: null },
    { id: 'exam-other', schoolId: 'college-3', name: 'Midterm', type: 'midterm', deletedAt: null },
    { id: 'exam-s', schoolId: 'school-2', name: 'Midterm', type: 'midterm', deletedAt: null },
  ];
  const classes: any[] = [
    { id: 'class-1', schoolId: 'college-1', name: 'BS', section: 'CS', deletedAt: null },
    { id: 'class-s', schoolId: 'school-2', name: '5', section: 'A', deletedAt: null },
  ];
  const results: any[] = [
    { id: 'result-1', schoolId: 'college-1', examId: 'exam-1', classId: 'class-1', studentId: 'stu-1', rollNo: 1, studentName: 'Ayesha Khan', fatherName: 'Ahmed Khan', subjectMarks: {}, obtainedMarks: 80, totalMarks: 100, percentage: 80, grade: 'A', position: 1, remarks: '', deletedAt: null },
    { id: 'result-s', schoolId: 'school-2', examId: 'exam-s', classId: 'class-s', studentId: 'stu-s', rollNo: 1, studentName: 'School Kid', fatherName: 'Father S', subjectMarks: {}, obtainedMarks: 70, totalMarks: 100, percentage: 70, grade: 'B', position: 1, remarks: '', deletedAt: null },
  ];
  const gradingScales: any[] = [];
  const auditLogs: any[] = [];
  const changeLogs: any[] = [];
  const deletedRecords: any[] = [];
  let seq = 1;
  const id = () => `id-${seq++}`;

  const same = (a: any, b: any): boolean => {
    const norm = (v: any) => (v instanceof Date ? v.getTime() : v);
    return norm(a) === norm(b);
  };
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]) => {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        if ('in' in (v as any)) return (v as any).in.includes(row[k]);
        if ('not' in (v as any)) return (v as any).not === null ? row[k] != null : row[k] !== (v as any).not;
      }
      if (v === null) return row[k] == null;
      return same(row[k], v);
    });
  const sortBy = (rows: any[], orderBy: any): any[] => {
    let out = [...rows];
    for (const o of (Array.isArray(orderBy) ? orderBy : [orderBy])) {
      const [k, dir] = Object.entries(o)[0] as [string, string];
      out = out.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    return out;
  };
  const collection = (rows: any[]) => ({
    findFirst: async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
    findMany: async ({ where, orderBy }: any) => {
      const out = rows.filter((r) => matches(r, where));
      return orderBy ? sortBy(out, orderBy) : out;
    },
    create: async ({ data }: any) => {
      const row = { id: id(), deletedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const r = rows.find((x) => x.id === where.id);
      Object.assign(r, data, { updatedAt: new Date() });
      return r;
    },
    delete: async ({ where }: any) => {
      const i = rows.findIndex((x) => x.id === where.id);
      const [r] = rows.splice(i, 1);
      return r;
    },
    count: async ({ where }: any) => rows.filter((r) => matches(r, where)).length,
  });

  const db: any = {
    school: collection(schools),
    program: collection(programs),
    semester: collection(semesters),
    course: collection(courses),
    studentEnrollment: collection(enrollments),
    courseMark: collection(marks),
    student: collection(students),
    staff: collection(staff),
    exam: collection(exams),
    class: collection(classes),
    result: collection(results),
    gradingScale: collection(gradingScales),
    auditLog: { create: async ({ data }: any) => { const r = { id: id(), ...data }; auditLogs.push(r); return r; } },
    changeLog: { create: async ({ data }: any) => { const r = { id: id(), ...data }; changeLogs.push(r); return r; } },
    deletedRecord: { create: async ({ data }: any) => { const r = { id: id(), ...data }; deletedRecords.push(r); return r; } },
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(db),
    __programs: programs,
    __semesters: semesters,
    __courses: courses,
    __enrollments: enrollments,
    __marks: marks,
    __auditLogs: auditLogs,
    __changeLogs: changeLogs,
    __deletedRecords: deletedRecords,
  };
  return db;
}

/** Seed a BS-CS program with 2 semesters, 4 courses, stu-1 enrolled in both. */
async function seedCollege(db: any) {
  const program = await svc.createProgram(db as any, 'college-1', { name: 'BS Computer Science', code: 'BSCS', department: 'Computer Science', duration_years: 4 }, 'admin-1');
  const sem1 = await svc.createSemester(db as any, 'college-1', program.id, { number: 1 }, 'admin-1');
  const sem2 = await svc.createSemester(db as any, 'college-1', program.id, { number: 2 }, 'admin-1');
  const cs101 = await svc.createCourse(db as any, 'college-1', sem1.id, { code: 'CS101', title: 'Programming Fundamentals', credit_hours: 3, teacher_id: 'teacher-1' }, 'admin-1');
  const mth101 = await svc.createCourse(db as any, 'college-1', sem1.id, { code: 'MTH101', title: 'Calculus', credit_hours: 3 }, 'admin-1');
  const eng101 = await svc.createCourse(db as any, 'college-1', sem1.id, { code: 'ENG101', title: 'English', credit_hours: 2 }, 'admin-1');
  const cs201 = await svc.createCourse(db as any, 'college-1', sem2.id, { code: 'CS201', title: 'Data Structures', credit_hours: 3 }, 'admin-1');
  const enr1 = await svc.createEnrollment(db as any, 'college-1', { student_id: 'stu-1', program_id: program.id, semester_id: sem1.id }, 'admin-1');
  const enr2 = await svc.createEnrollment(db as any, 'college-1', { student_id: 'stu-1', program_id: program.id, semester_id: sem2.id }, 'admin-1');
  return { program, sem1, sem2, cs101, mth101, eng101, cs201, enr1, enr2 };
}

async function seedSem1Marks(db: any, seed: any) {
  // CS101 85% = A (4.0, 3cr); MTH101 70% = B- (2.66, 3cr); ENG101 40% = F (0, 2cr).
  // Semester GPA = (12 + 7.98 + 0) / 8 = 2.4975 -> 2.5
  await svc.upsertCourseMark(db as any, 'college-1', { course_id: seed.cs101.id, student_id: 'stu-1', exam_id: 'exam-1', obtained_marks: 85, total_marks: 100 }, 'admin-1');
  await svc.upsertCourseMark(db as any, 'college-1', { course_id: seed.mth101.id, student_id: 'stu-1', exam_id: 'exam-1', obtained_marks: 70, total_marks: 100 }, 'admin-1');
  await svc.upsertCourseMark(db as any, 'college-1', { course_id: seed.eng101.id, student_id: 'stu-1', exam_id: 'exam-1', obtained_marks: 40, total_marks: 100 }, 'admin-1');
}

/* ------------------------------------------------------------------ */
/* GPA engine (HEC §13.1)                                              */
/* ------------------------------------------------------------------ */

describe('GPA engine — HEC §13.1 grade bands', () => {
  it('maps percentages to the verified HEC bands and points', () => {
    expect(gradeForPercentage(87)).toEqual({ grade: 'A', grade_points: 4.0 });
    expect(gradeForPercentage(82)).toEqual({ grade: 'A-', grade_points: 3.66 });
    expect(gradeForPercentage(77)).toEqual({ grade: 'B+', grade_points: 3.33 });
    expect(gradeForPercentage(72)).toEqual({ grade: 'B', grade_points: 3.0 });
    expect(gradeForPercentage(69)).toEqual({ grade: 'B-', grade_points: 2.66 });
    expect(gradeForPercentage(65)).toEqual({ grade: 'C+', grade_points: 2.33 });
    expect(gradeForPercentage(62)).toEqual({ grade: 'C', grade_points: 2.0 });
    expect(gradeForPercentage(59)).toEqual({ grade: 'C-', grade_points: 1.66 });
    expect(gradeForPercentage(55)).toEqual({ grade: 'D+', grade_points: 1.3 });
    expect(gradeForPercentage(51)).toEqual({ grade: 'D', grade_points: 1.0 });
    expect(gradeForPercentage(49)).toEqual({ grade: 'F', grade_points: 0 });
    // Boundary checks: 70 is B- (not B), 50 is D (passing), 85 is A.
    expect(gradeForPercentage(70).grade).toBe('B-');
    expect(gradeForPercentage(71).grade).toBe('B');
    expect(gradeForPercentage(50).grade).toBe('D');
    expect(gradeForPercentage(85).grade).toBe('A');
  });

  it('weights by credit hours', () => {
    const gpa = computeGpa([
      { course_id: 'a', credit_hours: 3, obtained_marks: 90, total_marks: 100 },
      { course_id: 'b', credit_hours: 3, obtained_marks: 62, total_marks: 100 },
    ]);
    expect(gpa).toBe(3.0); // (4.0*3 + 2.0*3) / 6
  });

  it('a failed course counts 0 points but its credits stay in the denominator', () => {
    const gpa = computeGpa([
      { course_id: 'a', credit_hours: 3, obtained_marks: 90, total_marks: 100 },
      { course_id: 'b', credit_hours: 3, obtained_marks: 30, total_marks: 100 },
    ]);
    expect(gpa).toBe(2.0); // (12 + 0) / 6
  });

  it('empty marks -> null GPA', () => {
    expect(computeGpa([])).toBeNull();
  });

  it('repeated course: only the latest exam marks count', () => {
    const marks = [
      { course_id: 'a', credit_hours: 3, obtained_marks: 90, total_marks: 100, updated_at: new Date('2026-01-01'), created_at: new Date('2026-01-01') },
      { course_id: 'a', credit_hours: 3, obtained_marks: 60, total_marks: 100, updated_at: new Date('2026-06-01'), created_at: new Date('2026-06-01') },
    ];
    expect(latestMarksOnly(marks)).toHaveLength(1);
    expect(latestMarksOnly(marks)[0]!.obtained_marks).toBe(60);
    expect(computeGpa(marks)).toBe(1.66); // C- only
  });

  it('rounds to 2 decimals', () => {
    const gpa = computeGpa([
      { course_id: 'a', credit_hours: 3, obtained_marks: 82, total_marks: 100 },
      { course_id: 'b', credit_hours: 2, obtained_marks: 77, total_marks: 100 },
    ]);
    expect(gpa).toBe(3.53); // (3.66*3 + 3.33*2) / 5 = 3.528
  });
});

/* ------------------------------------------------------------------ */
/* College gate + isolation                                            */
/* ------------------------------------------------------------------ */

describe('college gate + isolation', () => {
  it('School orgs get 403 with the exact message', async () => {
    const db = fakeDb();
    await expect(
      svc.createProgram(db as any, 'school-2', { name: 'BS CS', code: 'BSCS', department: 'CS', duration_years: 4 }, 'admin-1'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: svc.COLLEGE_ONLY_MESSAGE });
    await expect(svc.listPrograms(db as any, 'school-2')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it("another school's program is 404, never leaked", async () => {
    const db = fakeDb();
    const seed = await seedCollege(db);
    await expect(svc.getProgramDetail(db as any, 'college-3', seed.program.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.createSemester(db as any, 'college-3', seed.program.id, { number: 1 }, 'admin-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const list = await svc.listPrograms(db as any, 'college-3');
    expect(list).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Programs / semesters / courses                                      */
/* ------------------------------------------------------------------ */

describe('programs / semesters / courses', () => {
  it('creates a program; duplicate code 409s; detail lists semesters with counts', async () => {
    const db = fakeDb();
    const seed = await seedCollege(db);
    await expect(
      svc.createProgram(db as any, 'college-1', { name: 'Other', code: 'BSCS', department: 'CS', duration_years: 4 }, 'admin-1'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const detail = await svc.getProgramDetail(db as any, 'college-1', seed.program.id);
    expect((detail.program as any).semester_count).toBe(2);
    expect((detail.program as any).student_count).toBe(2);
    expect(detail.semesters).toHaveLength(2);
    expect((detail.semesters[0] as any).name).toBe('Semester 1');
    expect((detail.semesters[0] as any).course_count).toBe(3);
    expect((detail.semesters[0] as any).student_count).toBe(1);
  });

  it('semester name defaults to "Semester N"; duplicate number 409s', async () => {
    const db = fakeDb();
    const seed = await seedCollege(db);
    expect(seed.sem1.name).toBe('Semester 1');
    await expect(
      svc.createSemester(db as any, 'college-1', seed.program.id, { number: 1 }, 'admin-1'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const named = await svc.createSemester(db as any, 'college-1', seed.program.id, { number: 3, name: 'Third Semester' }, 'admin-1');
    expect(named.name).toBe('Third Semester');
  });

  it('course teacher must belong to the same school (404 otherwise); list shows teacher_name', async () => {
    const db = fakeDb();
    const seed = await seedCollege(db);
    await expect(
      svc.createCourse(db as any, 'college-1', seed.sem1.id, { code: 'PHY101', title: 'Physics', credit_hours: 3, teacher_id: 'teacher-other' }, 'admin-1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const courses = await svc.listCourses(db as any, 'college-1', seed.sem1.id);
    const cs101 = courses.find((c: any) => c.code === 'CS101') as any;
    expect(cs101.teacher_name).toBe('Prof. Sana');
    expect(cs101.credit_hours).toBe(3);
  });

  it('delete guards: program with semesters 409, semester with courses 409, course with marks 409', async () => {
    const db = fakeDb();
    const seed = await seedCollege(db);
    await seedSem1Marks(db, seed);
    await expect(svc.deleteProgram(db as any, 'college-1', seed.program.id, 'admin-1')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(svc.deleteSemester(db as any, 'college-1', seed.sem1.id, 'admin-1')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(svc.deleteCourse(db as any, 'college-1', seed.cs101.id, 'admin-1')).rejects.toMatchObject({ code: 'CONFLICT' });
    // A course without marks soft-deletes into the recycle bin.
    await svc.deleteCourse(db as any, 'college-1', seed.cs201.id, 'admin-1');
    expect(db.__deletedRecords).toHaveLength(1);
    expect(db.__deletedRecords[0].entity).toBe('course');
    const remaining = await svc.listCourses(db as any, 'college-1', seed.sem2.id);
    expect(remaining).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Enrollments                                                         */
/* ------------------------------------------------------------------ */

describe('enrollments', () => {
  it('duplicate student+semester 409s; semester of another program 400s; inactive student 409s; cross-school student 404s', async () => {
    const db = fakeDb();
    const seed = await seedCollege(db);
    await expect(
      svc.createEnrollment(db as any, 'college-1', { student_id: 'stu-1', program_id: seed.program.id, semester_id: seed.sem1.id }, 'admin-1'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const otherProgram = await svc.createProgram(db as any, 'college-1', { name: 'BBA', code: 'BBA', department: 'Business', duration_years: 4 }, 'admin-1');
    await expect(
      svc.createEnrollment(db as any, 'college-1', { student_id: 'stu-2', program_id: otherProgram.id, semester_id: seed.sem1.id }, 'admin-1'),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      svc.createEnrollment(db as any, 'college-1', { student_id: 'stu-inactive', program_id: seed.program.id, semester_id: seed.sem1.id }, 'admin-1'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      svc.createEnrollment(db as any, 'college-1', { student_id: 'stu-other', program_id: seed.program.id, semester_id: seed.sem1.id }, 'admin-1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('unenroll hard-deletes the row (audited) and frees the slot', async () => {
    const db = fakeDb();
    const seed = await seedCollege(db);
    await svc.deleteEnrollment(db as any, 'college-1', seed.enr1.id, 'admin-1');
    expect(db.__enrollments).toHaveLength(1);
    expect(db.__auditLogs.some((a: any) => a.action === 'enrollment.delete')).toBe(true);
    const again = await svc.createEnrollment(db as any, 'college-1', { student_id: 'stu-1', program_id: seed.program.id, semester_id: seed.sem1.id }, 'admin-1');
    expect(again.studentId).toBe('stu-1');
    const list = await svc.listStudentEnrollments(db as any, 'college-1', 'stu-1');
    expect(list).toHaveLength(2);
    const sem1Row = list.find((e: any) => e.semester_number === 1) as any;
    expect(sem1Row.program_name).toBe('BS Computer Science');
    expect(sem1Row.semester_name).toBe('Semester 1');
  });
});

/* ------------------------------------------------------------------ */
/* Marks + GPA / CGPA / toppers                                        */
/* ------------------------------------------------------------------ */

describe('marks + GPA / CGPA / toppers', () => {
  it('upsert: 201-style create then 200-style update; obtained>total 400s; not-enrolled 409s; foreign exam 404s', async () => {
    const db = fakeDb();
    const seed = await seedCollege(db);
    const first = await svc.upsertCourseMark(db as any, 'college-1', { course_id: seed.cs101.id, student_id: 'stu-1', exam_id: 'exam-1', obtained_marks: 85, total_marks: 100 }, 'admin-1');
    expect(first.created).toBe(true);
    const second = await svc.upsertCourseMark(db as any, 'college-1', { course_id: seed.cs101.id, student_id: 'stu-1', exam_id: 'exam-1', obtained_marks: 90, total_marks: 100 }, 'admin-1');
    expect(second.created).toBe(false);
    expect((second.mark as any).obtainedMarks).toBe(90);
    expect(db.__marks).toHaveLength(1);
    await expect(
      svc.upsertCourseMark(db as any, 'college-1', { course_id: seed.cs101.id, student_id: 'stu-1', exam_id: 'exam-1', obtained_marks: 101, total_marks: 100 }, 'admin-1'),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      svc.upsertCourseMark(db as any, 'college-1', { course_id: seed.cs101.id, student_id: 'stu-2', exam_id: 'exam-1', obtained_marks: 50, total_marks: 100 }, 'admin-1'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      svc.upsertCourseMark(db as any, 'college-1', { course_id: seed.cs101.id, student_id: 'stu-1', exam_id: 'exam-other', obtained_marks: 50, total_marks: 100 }, 'admin-1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('semester marks list returns student/course rows with percentages', async () => {
    const db = fakeDb();
    const seed = await seedCollege(db);
    await seedSem1Marks(db, seed);
    const rows = await svc.listSemesterMarks(db as any, 'college-1', seed.sem1.id, 'exam-1');
    expect(rows).toHaveLength(3);
    const cs = rows.find((r: any) => r.course_code === 'CS101') as any;
    expect(cs.student_name).toBe('Ayesha Khan');
    expect(cs.roll_no).toBe(1);
    expect(cs.percentage).toBe(85);
  });

  it('semester GPA 2.5 (failed course drags it down); CGPA spans semesters; empty semester -> null', async () => {
    const db = fakeDb();
    const seed = await seedCollege(db);
    await seedSem1Marks(db, seed);
    const gpa1 = await svc.getStudentGpa(db as any, 'college-1', 'stu-1', seed.sem1.id);
    expect((gpa1.semester as any).gpa).toBe(2.5);
    expect((gpa1.semester as any).total_credit_hours).toBe(8);
    expect(gpa1.cgpa).toBe(2.5);
    expect(gpa1.total_credit_hours_all).toBe(8);
    expect((gpa1.courses as any[]).find((c: any) => c.course_code === 'ENG101').grade).toBe('F');
    // Empty semester (sem2, no marks yet) -> null GPA, courses [].
    const gpa2 = await svc.getStudentGpa(db as any, 'college-1', 'stu-1', seed.sem2.id);
    expect((gpa2.semester as any).gpa).toBeNull();
    expect(gpa2.courses).toEqual([]);
    // Add sem2 marks: CS201 90% A 3cr -> CGPA (19.98 + 12) / 11 = 2.91.
    await svc.upsertCourseMark(db as any, 'college-1', { course_id: seed.cs201.id, student_id: 'stu-1', exam_id: 'exam-2', obtained_marks: 90, total_marks: 100 }, 'admin-1');
    const gpa3 = await svc.getStudentGpa(db as any, 'college-1', 'stu-1');
    expect((gpa3.semester as any).number).toBe(2); // latest enrolled semester by default
    expect((gpa3.semester as any).gpa).toBe(4.0);
    expect(gpa3.cgpa).toBe(2.91);
    expect(gpa3.total_credit_hours_all).toBe(11);
  });

  it('repeated course: later exam marks replace the earlier attempt in GPA and CGPA', async () => {
    const db = fakeDb();
    const seed = await seedCollege(db);
    await seedSem1Marks(db, seed);
    await svc.upsertCourseMark(db as any, 'college-1', { course_id: seed.cs201.id, student_id: 'stu-1', exam_id: 'exam-2', obtained_marks: 90, total_marks: 100 }, 'admin-1');
    // Repeat CS101 in the Annual exam with 60% (C-, 1.66) — replaces the 85% A.
    const repeat = await svc.upsertCourseMark(db as any, 'college-1', { course_id: seed.cs101.id, student_id: 'stu-1', exam_id: 'exam-2', obtained_marks: 60, total_marks: 100 }, 'admin-1');
    expect(repeat.created).toBe(true);
    // Force a strictly later stamp so the "latest wins" rule is unambiguous.
    db.__marks.find((m: any) => m.id === repeat.mark.id).updatedAt = new Date('2026-07-01');
    const gpa = await svc.getStudentGpa(db as any, 'college-1', 'stu-1', seed.sem1.id);
    expect((gpa.semester as any).gpa).toBe(1.62); // (1.66*3 + 2.66*3 + 0) / 8
    expect(gpa.cgpa).toBe(2.27); // (4.98 + 7.98 + 0 + 12) / 11
  });

  it('toppers: ranked by semester GPA, top 10, students without marks excluded', async () => {
    const db = fakeDb();
    const seed = await seedCollege(db);
    await seedSem1Marks(db, seed);
    await svc.createEnrollment(db as any, 'college-1', { student_id: 'stu-2', program_id: seed.program.id, semester_id: seed.sem1.id }, 'admin-1');
    await svc.createEnrollment(db as any, 'college-1', { student_id: 'stu-3', program_id: seed.program.id, semester_id: seed.sem1.id }, 'admin-1');
    await svc.upsertCourseMark(db as any, 'college-1', { course_id: seed.cs101.id, student_id: 'stu-2', exam_id: 'exam-1', obtained_marks: 95, total_marks: 100 }, 'admin-1');
    await svc.upsertCourseMark(db as any, 'college-1', { course_id: seed.mth101.id, student_id: 'stu-2', exam_id: 'exam-1', obtained_marks: 95, total_marks: 100 }, 'admin-1');
    await svc.upsertCourseMark(db as any, 'college-1', { course_id: seed.eng101.id, student_id: 'stu-2', exam_id: 'exam-1', obtained_marks: 95, total_marks: 100 }, 'admin-1');
    const toppers = await svc.getProgramToppers(db as any, 'college-1', seed.program.id, seed.sem1.id, 'exam-1');
    expect(toppers).toHaveLength(2); // stu-3 has no marks -> excluded
    expect((toppers[0] as any).student_name).toBe('Bilal Ahmed');
    expect((toppers[0] as any).semester_gpa).toBe(4.0);
    expect((toppers[1] as any).student_name).toBe('Ayesha Khan');
    expect((toppers[1] as any).semester_gpa).toBe(2.5);
    expect((toppers[0] as any).cgpa).toBe(4.0);
  });
});

/* ------------------------------------------------------------------ */
/* Report-card integration                                             */
/* ------------------------------------------------------------------ */

describe('report-card college block', () => {
  it('College org + enrollment: college block present with GPA rows', async () => {
    const db = fakeDb();
    const seed = await seedCollege(db);
    await seedSem1Marks(db, seed);
    const card = await getReportCard(db as any, 'college-1', 'stu-1', 'exam-1');
    expect(card.college).toBeDefined();
    expect(card.college!.program_name).toBe('BS Computer Science');
    expect(card.college!.semester_number).toBe(1);
    expect(card.college!.semester_name).toBe('Semester 1');
    expect(card.college!.courses).toHaveLength(3);
    expect(card.college!.semester_gpa).toBe(2.5);
    expect(card.college!.cgpa).toBe(2.5);
    const html = renderReportCardHtml(card);
    expect(html).toContain('Semester GPA: 2.5');
    expect(html).toContain('CS101');
  });

  it('School org: no college key at all, HTML has no college section', async () => {
    const db = fakeDb();
    const card = await getReportCard(db as any, 'school-2', 'stu-s', 'exam-s');
    expect('college' in card).toBe(false);
    expect(card.student.name).toBe('School Kid');
    expect(renderReportCardHtml(card)).not.toContain('Semester GPA');
  });

  it('College org but no enrollment: no college block', async () => {
    const db = fakeDb();
    const card = await getReportCard(db as any, 'college-1', 'stu-1', 'exam-1');
    expect('college' in card).toBe(false);
  });

  // Pure-College report card (2026-11-20 fix): a College student whose
  // ONLY marks are college course marks (no school-style result rows)
  // used to 404 before the college block was ever built.
  it('pure-College student with only college marks: 200 with college block + GPA, empty school sections', async () => {
    const db = fakeDb();
    const seed = await seedCollege(db);
    // stu-2 (Bilal) has NO school-style result row; enroll + give him the
    // same Sem 1 marks as stu-1: CS101 85% A (4.0, 3cr), MTH101 70% B-
    // (2.66, 3cr), ENG101 40% F (0, 2cr) -> GPA (12 + 7.98 + 0) / 8 = 2.5.
    await svc.createEnrollment(db as any, 'college-1', { student_id: 'stu-2', program_id: seed.program.id, semester_id: seed.sem1.id }, 'admin-1');
    await svc.upsertCourseMark(db as any, 'college-1', { course_id: seed.cs101.id, student_id: 'stu-2', exam_id: 'exam-1', obtained_marks: 85, total_marks: 100 }, 'admin-1');
    await svc.upsertCourseMark(db as any, 'college-1', { course_id: seed.mth101.id, student_id: 'stu-2', exam_id: 'exam-1', obtained_marks: 70, total_marks: 100 }, 'admin-1');
    await svc.upsertCourseMark(db as any, 'college-1', { course_id: seed.eng101.id, student_id: 'stu-2', exam_id: 'exam-1', obtained_marks: 40, total_marks: 100 }, 'admin-1');
    const card = await getReportCard(db as any, 'college-1', 'stu-2', 'exam-1');
    expect(card.student.name).toBe('Bilal Ahmed');
    expect(card.results).toEqual([]);
    expect(card.obtained).toBeNull();
    expect(card.total).toBeNull();
    expect(card.percentage).toBeNull();
    expect(card.grade).toBeNull();
    expect(card.position).toBeNull();
    expect(card.remarks).toEqual([]);
    expect(card.college).toBeDefined();
    expect(card.college!.program_name).toBe('BS Computer Science');
    expect(card.college!.semester_number).toBe(1);
    expect(card.college!.courses).toHaveLength(3);
    expect(card.college!.semester_gpa).toBe(2.5);
    expect(card.college!.cgpa).toBe(2.5);
    const html = renderReportCardHtml(card);
    expect(html).toContain('BS Computer Science');
    expect(html).toContain('Semester GPA: 2.5');
    expect(html).toContain('CS101');
    const pdf = await renderReportCardPdf(card);
    expect(pdf.length).toBeGreaterThan(0);
  });

  it('College student with enrollment but NO marks at all: still 404', async () => {
    const db = fakeDb();
    const seed = await seedCollege(db);
    // stu-3 is enrolled in Sem 1 but has no course marks for exam-1 (and
    // no school-style results): the college block would be course-less,
    // so the 404 must stand.
    await svc.createEnrollment(db as any, 'college-1', { student_id: 'stu-3', program_id: seed.program.id, semester_id: seed.sem1.id }, 'admin-1');
    await expect(getReportCard(db as any, 'college-1', 'stu-3', 'exam-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'No results for this student in this exam',
    });
  });

  it('School-org student with no results: still 404', async () => {
    const db = fakeDb();
    await expect(getReportCard(db as any, 'school-2', 'stu-s2', 'exam-s')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'No results for this student in this exam',
    });
  });

  it('College student with BOTH school + college results: 200, school sections unchanged', async () => {
    const db = fakeDb();
    const seed = await seedCollege(db);
    await seedSem1Marks(db, seed);
    const card = await getReportCard(db as any, 'college-1', 'stu-1', 'exam-1');
    expect(card.results).toHaveLength(1);
    expect(card.obtained).toBe(80);
    expect(card.total).toBe(100);
    expect(card.percentage).toBe(80);
    expect(card.grade).toBe('A');
    expect(card.college).toBeDefined();
    expect(card.college!.semester_gpa).toBe(2.5);
    const html = renderReportCardHtml(card);
    expect(html).toContain('Total: 80 / 100');
    expect(html).toContain('CS101');
  });
});
