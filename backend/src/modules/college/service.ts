// College Mode service (2026-11-20) — programs / semesters / courses /
// enrollments / course marks + GPA/CGPA for schools whose orgType is
// 'College'. Every query is scoped by schoolId (cross-tenant = 404, same
// as the rest of the backend). Creates/updates/deletes write audit_logs
// + change_logs like classes/results; clerk mutations go through the
// approval queue at the route layer (requireQueueable + queueIfClerk),
// exactly as classes do — the service itself always applies directly.
// Programs/semesters/courses soft-delete into the recycle bin (30-day
// restore); enrollments hard-delete on unenroll (audited).
import { ApiError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { writeChangeLogs, logCreate, logDelete, softDeleteEntity, isUniqueViolation } from '../hardening/helpers';
import { gradeForPercentage, percentageOf, computeGpa, computeCgpa, latestMarksOnly, type CourseMarksInput } from './gpa';
import type { Db } from '../../lib/db';

export const COLLEGE_ONLY_MESSAGE = 'College mode is only available for College organizations';

/** Route/service gate: the school must exist and be a College org. */
export async function assertCollege(db: Db, schoolId: string): Promise<any> {
  const school = await db.school.findFirst({ where: { id: schoolId } });
  if (!school) throw ApiError.notFound('School not found');
  if ((school as any).orgType !== 'College') throw ApiError.forbidden(COLLEGE_ONLY_MESSAGE);
  return school;
}

/* ------------------------------------------------------------------ */
/* Public (snake_case) views                                           */
/* ------------------------------------------------------------------ */

export function toPublicProgram(p: any, semesterCount?: number, studentCount?: number): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    code: p.code,
    department: p.department,
    duration_years: p.durationYears,
    semester_count: semesterCount ?? undefined,
    student_count: studentCount ?? undefined,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

export function toPublicSemester(s: any, courseCount?: number, studentCount?: number): Record<string, unknown> {
  return {
    id: s.id,
    program_id: s.programId,
    number: s.number,
    name: s.name,
    course_count: courseCount ?? undefined,
    student_count: studentCount ?? undefined,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

export function toPublicCourse(c: any, teacherName?: string | null): Record<string, unknown> {
  return {
    id: c.id,
    semester_id: c.semesterId,
    code: c.code,
    title: c.title,
    credit_hours: c.creditHours,
    teacher_id: c.teacherId ?? null,
    teacher_name: teacherName ?? null,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

export function toPublicEnrollment(e: any, programName?: string, semesterNumber?: number, semesterName?: string): Record<string, unknown> {
  return {
    id: e.id,
    student_id: e.studentId,
    program_id: e.programId,
    program_name: programName ?? undefined,
    semester_id: e.semesterId,
    semester_number: semesterNumber ?? undefined,
    semester_name: semesterName ?? undefined,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
  };
}

export function toPublicCourseMark(m: any): Record<string, unknown> {
  return {
    id: m.id,
    course_id: m.courseId,
    student_id: m.studentId,
    exam_id: m.examId,
    obtained_marks: m.obtainedMarks,
    total_marks: m.totalMarks,
    percentage: percentageOf(m.obtainedMarks, m.totalMarks),
    created_at: m.createdAt,
    updated_at: m.updatedAt,
  };
}

/** One GPA course row — the same shape used by /gpa, /toppers internals and the report-card college block. */
export function toGpaCourseRow(course: any, mark: any): Record<string, unknown> {
  const percentage = percentageOf(mark.obtainedMarks, mark.totalMarks);
  const { grade, grade_points } = gradeForPercentage(percentage);
  return {
    course_id: course.id,
    course_code: course.code,
    course_title: course.title,
    credit_hours: course.creditHours,
    obtained_marks: mark.obtainedMarks,
    total_marks: mark.totalMarks,
    percentage,
    grade,
    grade_points,
  };
}

/* ------------------------------------------------------------------ */
/* Internal lookups (all school-scoped; cross-tenant = 404)            */
/* ------------------------------------------------------------------ */

async function getProgram(db: Db, schoolId: string, id: string): Promise<any> {
  const p = await db.program.findFirst({ where: { id, schoolId, deletedAt: null } });
  if (!p) throw ApiError.notFound('Program not found');
  return p;
}

async function getSemester(db: Db, schoolId: string, id: string): Promise<any> {
  const s = await db.semester.findFirst({ where: { id, schoolId, deletedAt: null } });
  if (!s) throw ApiError.notFound('Semester not found');
  return s;
}

async function getCourse(db: Db, schoolId: string, id: string): Promise<any> {
  const c = await db.course.findFirst({ where: { id, schoolId, deletedAt: null } });
  if (!c) throw ApiError.notFound('Course not found');
  return c;
}

async function assertTeacherInSchool(db: Db, schoolId: string, teacherId: string): Promise<any> {
  const t = await db.staff.findFirst({ where: { id: teacherId, schoolId } });
  if (!t) throw ApiError.notFound('Teacher not found in this school');
  return t;
}

async function assertUniqueProgramCode(db: Db, schoolId: string, code: string, excludeId?: string): Promise<void> {
  const existing = await db.program.findFirst({ where: { schoolId, code, deletedAt: null } });
  if (existing && existing.id !== excludeId) throw ApiError.conflict(`Program code ${code} already exists`);
}

async function throwProgramCodeDeletedConflict(db: Db, schoolId: string, code: string): Promise<never> {
  const deleted = await db.program.findFirst({ where: { schoolId, code, deletedAt: { not: null } } });
  if (deleted) {
    throw ApiError.conflict(`Program code ${code} was deleted. Restore it from the Recycle Bin, or permanently delete it there first, then create it again.`);
  }
  throw ApiError.conflict(`Program code ${code} already exists`);
}

/* ------------------------------------------------------------------ */
/* Programs                                                            */
/* ------------------------------------------------------------------ */

export interface ProgramInput {
  name: string;
  code: string;
  department: string;
  duration_years: number;
}

export async function createProgram(db: Db, schoolId: string, input: ProgramInput, actorId?: string): Promise<any> {
  await assertCollege(db, schoolId);
  const code = input.code.trim();
  await assertUniqueProgramCode(db, schoolId, code);
  let created: any;
  try {
    created = await db.program.create({
      data: { schoolId, name: input.name.trim(), code, department: input.department.trim(), durationYears: input.duration_years },
    });
  } catch (err) {
    if (isUniqueViolation(err)) await throwProgramCodeDeletedConflict(db, schoolId, code);
    throw err;
  }
  await logCreate(db, { schoolId, actorId: actorId ?? null, entity: 'program', entityId: created.id, after: { name: created.name, code: created.code, department: created.department, duration_years: created.durationYears } });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'program.create', entity: 'program', entityId: created.id, details: { name: created.name, code: created.code } });
  return created;
}

export async function listPrograms(db: Db, schoolId: string): Promise<Record<string, unknown>[]> {
  await assertCollege(db, schoolId);
  const programs = await db.program.findMany({ where: { schoolId, deletedAt: null }, orderBy: [{ name: 'asc' }] });
  const out: Record<string, unknown>[] = [];
  for (const p of programs as any[]) {
    const semesterCount = await db.semester.count({ where: { programId: p.id, schoolId, deletedAt: null } });
    const studentCount = await db.studentEnrollment.count({ where: { programId: p.id, schoolId } });
    out.push(toPublicProgram(p, semesterCount, studentCount));
  }
  return out;
}

export async function getProgramDetail(db: Db, schoolId: string, id: string): Promise<{ program: Record<string, unknown>; semesters: Record<string, unknown>[] }> {
  await assertCollege(db, schoolId);
  const program = await getProgram(db, schoolId, id);
  const semesters = await db.semester.findMany({ where: { programId: id, schoolId, deletedAt: null }, orderBy: [{ number: 'asc' }] });
  const rows: Record<string, unknown>[] = [];
  for (const s of semesters as any[]) {
    const courseCount = await db.course.count({ where: { semesterId: s.id, schoolId, deletedAt: null } });
    const studentCount = await db.studentEnrollment.count({ where: { semesterId: s.id, schoolId } });
    rows.push(toPublicSemester(s, courseCount, studentCount));
  }
  const semesterCount = semesters.length;
  const studentCount = await db.studentEnrollment.count({ where: { programId: id, schoolId } });
  return { program: toPublicProgram(program, semesterCount, studentCount), semesters: rows };
}

export async function updateProgram(db: Db, schoolId: string, id: string, patch: Partial<ProgramInput>, actorId?: string): Promise<any> {
  await assertCollege(db, schoolId);
  const existing = await getProgram(db, schoolId, id);
  const code = patch.code !== undefined ? patch.code.trim() : existing.code;
  await assertUniqueProgramCode(db, schoolId, code, id);
  const data: Record<string, unknown> = {
    name: patch.name !== undefined ? patch.name.trim() : existing.name,
    code,
    department: patch.department !== undefined ? patch.department.trim() : existing.department,
    durationYears: patch.duration_years !== undefined ? patch.duration_years : existing.durationYears,
  };
  const before = { name: existing.name, code: existing.code, department: existing.department, duration_years: existing.durationYears };
  let updated: any;
  try {
    updated = await db.program.update({ where: { id }, data });
  } catch (err) {
    if (isUniqueViolation(err)) await throwProgramCodeDeletedConflict(db, schoolId, code);
    throw err;
  }
  await writeChangeLogs(db, { schoolId, actorId: actorId ?? null, entity: 'program', entityId: id, before, after: { name: updated.name, code: updated.code, department: updated.department, duration_years: updated.durationYears } });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'program.update', entity: 'program', entityId: id, details: { name: updated.name, code: updated.code } });
  return updated;
}

export async function deleteProgram(db: Db, schoolId: string, id: string, actorId?: string): Promise<void> {
  await assertCollege(db, schoolId);
  const existing = await getProgram(db, schoolId, id);
  const semesters = await db.semester.count({ where: { programId: id, schoolId, deletedAt: null } });
  if (semesters > 0) throw ApiError.conflict('Cannot delete a program that has semesters. Delete the semesters first.');
  const enrollments = await db.studentEnrollment.count({ where: { programId: id, schoolId } });
  if (enrollments > 0) throw ApiError.conflict('Cannot delete a program that has student enrollments. Unenroll the students first.');
  await softDeleteEntity(db, { schoolId, entity: 'program', entityId: id, deletedBy: actorId ?? null });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'program.delete', entity: 'program', entityId: id, details: { name: existing.name, code: existing.code, soft_deleted: true } });
}

/* ------------------------------------------------------------------ */
/* Semesters                                                           */
/* ------------------------------------------------------------------ */

export async function createSemester(db: Db, schoolId: string, programId: string, input: { number: number; name?: string | null }, actorId?: string): Promise<any> {
  await assertCollege(db, schoolId);
  const program = await getProgram(db, schoolId, programId);
  const existing = await db.semester.findFirst({ where: { programId, number: input.number, deletedAt: null } });
  if (existing) throw ApiError.conflict(`Semester ${input.number} already exists in program ${program.name}`);
  let created: any;
  try {
    created = await db.semester.create({
      data: { schoolId, programId, number: input.number, name: (input.name ?? '').trim() || `Semester ${input.number}` },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw ApiError.conflict(`Semester ${input.number} already exists in program ${program.name}`);
    throw err;
  }
  await logCreate(db, { schoolId, actorId: actorId ?? null, entity: 'semester', entityId: created.id, after: { program_id: programId, number: created.number, name: created.name } });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'semester.create', entity: 'semester', entityId: created.id, details: { program_id: programId, number: created.number } });
  return created;
}

export async function listSemesters(db: Db, schoolId: string, programId: string): Promise<Record<string, unknown>[]> {
  await assertCollege(db, schoolId);
  await getProgram(db, schoolId, programId);
  const semesters = await db.semester.findMany({ where: { programId, schoolId, deletedAt: null }, orderBy: [{ number: 'asc' }] });
  const out: Record<string, unknown>[] = [];
  for (const s of semesters as any[]) {
    const courseCount = await db.course.count({ where: { semesterId: s.id, schoolId, deletedAt: null } });
    const studentCount = await db.studentEnrollment.count({ where: { semesterId: s.id, schoolId } });
    out.push(toPublicSemester(s, courseCount, studentCount));
  }
  return out;
}

export async function deleteSemester(db: Db, schoolId: string, id: string, actorId?: string): Promise<void> {
  await assertCollege(db, schoolId);
  const existing = await getSemester(db, schoolId, id);
  const courses = await db.course.count({ where: { semesterId: id, schoolId, deletedAt: null } });
  if (courses > 0) throw ApiError.conflict('Cannot delete a semester that has courses. Delete the courses first.');
  const enrollments = await db.studentEnrollment.count({ where: { semesterId: id, schoolId } });
  if (enrollments > 0) throw ApiError.conflict('Cannot delete a semester that has student enrollments. Unenroll the students first.');
  await softDeleteEntity(db, { schoolId, entity: 'semester', entityId: id, deletedBy: actorId ?? null });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'semester.delete', entity: 'semester', entityId: id, details: { program_id: existing.programId, number: existing.number, soft_deleted: true } });
}

/* ------------------------------------------------------------------ */
/* Courses                                                             */
/* ------------------------------------------------------------------ */

export interface CourseInput {
  code: string;
  title: string;
  credit_hours: number;
  teacher_id?: string | null;
}

async function assertUniqueCourseCode(db: Db, schoolId: string, semesterId: string, code: string, excludeId?: string): Promise<void> {
  const existing = await db.course.findFirst({ where: { semesterId, code, deletedAt: null } });
  if (existing && existing.id !== excludeId) throw ApiError.conflict(`Course code ${code} already exists in this semester`);
}

export async function createCourse(db: Db, schoolId: string, semesterId: string, input: CourseInput, actorId?: string): Promise<any> {
  await assertCollege(db, schoolId);
  const semester = await getSemester(db, schoolId, semesterId);
  const code = input.code.trim();
  await assertUniqueCourseCode(db, schoolId, semesterId, code);
  if (input.teacher_id) await assertTeacherInSchool(db, schoolId, input.teacher_id);
  let created: any;
  try {
    created = await db.course.create({
      data: { schoolId, semesterId, code, title: input.title.trim(), creditHours: input.credit_hours, teacherId: input.teacher_id ?? null },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw ApiError.conflict(`Course code ${code} already exists in this semester`);
    throw err;
  }
  await logCreate(db, { schoolId, actorId: actorId ?? null, entity: 'course', entityId: created.id, after: { semester_id: semesterId, code: created.code, title: created.title, credit_hours: created.creditHours, teacher_id: created.teacherId } });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'course.create', entity: 'course', entityId: created.id, details: { semester_id: semesterId, code: created.code } });
  return created;
}

async function teacherNameMap(db: Db, schoolId: string, teacherIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(teacherIds.filter((t): t is string => Boolean(t)))];
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const staff = await db.staff.findMany({ where: { schoolId, id: { in: ids } } });
  for (const s of staff as any[]) map.set(s.id, s.name);
  return map;
}

export async function listCourses(db: Db, schoolId: string, semesterId: string): Promise<Record<string, unknown>[]> {
  await assertCollege(db, schoolId);
  await getSemester(db, schoolId, semesterId);
  const courses = await db.course.findMany({ where: { semesterId, schoolId, deletedAt: null }, orderBy: [{ code: 'asc' }] });
  const names = await teacherNameMap(db, schoolId, (courses as any[]).map((c) => c.teacherId));
  return (courses as any[]).map((c) => toPublicCourse(c, c.teacherId ? names.get(c.teacherId) ?? null : null));
}

export async function updateCourse(db: Db, schoolId: string, id: string, patch: Partial<CourseInput>, actorId?: string): Promise<any> {
  await assertCollege(db, schoolId);
  const existing = await getCourse(db, schoolId, id);
  const code = patch.code !== undefined ? patch.code.trim() : existing.code;
  await assertUniqueCourseCode(db, schoolId, existing.semesterId, code, id);
  if (patch.teacher_id) await assertTeacherInSchool(db, schoolId, patch.teacher_id);
  const data: Record<string, unknown> = {
    code,
    title: patch.title !== undefined ? patch.title.trim() : existing.title,
    creditHours: patch.credit_hours !== undefined ? patch.credit_hours : existing.creditHours,
  };
  if (patch.teacher_id !== undefined) data.teacherId = patch.teacher_id;
  const before = { code: existing.code, title: existing.title, credit_hours: existing.creditHours, teacher_id: existing.teacherId };
  let updated: any;
  try {
    updated = await db.course.update({ where: { id }, data });
  } catch (err) {
    if (isUniqueViolation(err)) throw ApiError.conflict(`Course code ${code} already exists in this semester`);
    throw err;
  }
  await writeChangeLogs(db, { schoolId, actorId: actorId ?? null, entity: 'course', entityId: id, before, after: { code: updated.code, title: updated.title, credit_hours: updated.creditHours, teacher_id: updated.teacherId } });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'course.update', entity: 'course', entityId: id, details: { code: updated.code } });
  return updated;
}

export async function deleteCourse(db: Db, schoolId: string, id: string, actorId?: string): Promise<void> {
  await assertCollege(db, schoolId);
  const existing = await getCourse(db, schoolId, id);
  const marks = await db.courseMark.count({ where: { courseId: id, schoolId } });
  if (marks > 0) throw ApiError.conflict('Cannot delete a course that has marks. Remove the marks first.');
  await softDeleteEntity(db, { schoolId, entity: 'course', entityId: id, deletedBy: actorId ?? null });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'course.delete', entity: 'course', entityId: id, details: { code: existing.code, soft_deleted: true } });
}

/* ------------------------------------------------------------------ */
/* Enrollments                                                         */
/* ------------------------------------------------------------------ */

export async function createEnrollment(db: Db, schoolId: string, input: { student_id: string; program_id: string; semester_id: string }, actorId?: string): Promise<any> {
  await assertCollege(db, schoolId);
  const student = await db.student.findFirst({ where: { id: input.student_id, schoolId, deletedAt: null } });
  if (!student) throw ApiError.notFound('Student not found');
  if (student.status !== 'active') throw ApiError.conflict('Student is not active');
  const program = await getProgram(db, schoolId, input.program_id);
  const semester = await db.semester.findFirst({ where: { id: input.semester_id, schoolId, deletedAt: null } });
  if (!semester) throw ApiError.notFound('Semester not found');
  if (semester.programId !== program.id) throw ApiError.validation('Semester does not belong to this program');
  const existing = await db.studentEnrollment.findFirst({ where: { studentId: input.student_id, semesterId: input.semester_id } });
  if (existing) throw ApiError.conflict('Student is already enrolled in this semester');
  let created: any;
  try {
    created = await db.studentEnrollment.create({
      data: { schoolId, studentId: input.student_id, programId: input.program_id, semesterId: input.semester_id },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw ApiError.conflict('Student is already enrolled in this semester');
    throw err;
  }
  await logCreate(db, { schoolId, actorId: actorId ?? null, entity: 'enrollment', entityId: created.id, after: { student_id: created.studentId, program_id: created.programId, semester_id: created.semesterId } });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'enrollment.create', entity: 'enrollment', entityId: created.id, details: { student_id: created.studentId, semester_id: created.semesterId } });
  return created;
}

export async function deleteEnrollment(db: Db, schoolId: string, id: string, actorId?: string): Promise<void> {
  await assertCollege(db, schoolId);
  const existing = await db.studentEnrollment.findFirst({ where: { id, schoolId } });
  if (!existing) throw ApiError.notFound('Enrollment not found');
  await db.studentEnrollment.delete({ where: { id } });
  await logDelete(db, { schoolId, actorId: actorId ?? null, entity: 'enrollment', entityId: id, before: { student_id: existing.studentId, program_id: existing.programId, semester_id: existing.semesterId } });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'enrollment.delete', entity: 'enrollment', entityId: id, details: { student_id: existing.studentId, semester_id: existing.semesterId, unenrolled: true } });
}

export async function listStudentEnrollments(db: Db, schoolId: string, studentId: string): Promise<Record<string, unknown>[]> {
  await assertCollege(db, schoolId);
  const student = await db.student.findFirst({ where: { id: studentId, schoolId, deletedAt: null } });
  if (!student) throw ApiError.notFound('Student not found');
  const enrollments = await db.studentEnrollment.findMany({ where: { studentId, schoolId }, orderBy: [{ createdAt: 'asc' }] });
  const out: Record<string, unknown>[] = [];
  for (const e of enrollments as any[]) {
    const program = await db.program.findFirst({ where: { id: e.programId, schoolId } });
    const semester = await db.semester.findFirst({ where: { id: e.semesterId, schoolId } });
    out.push(toPublicEnrollment(e, program?.name, semester?.number, semester?.name));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Course marks (upsert)                                               */
/* ------------------------------------------------------------------ */

export async function upsertCourseMark(
  db: Db,
  schoolId: string,
  input: { course_id: string; student_id: string; exam_id: string; obtained_marks: number; total_marks: number },
  actorId?: string,
): Promise<{ mark: any; created: boolean }> {
  await assertCollege(db, schoolId);
  if (input.obtained_marks > input.total_marks) throw ApiError.validation('obtained_marks cannot exceed total_marks');
  const course = await getCourse(db, schoolId, input.course_id);
  const exam = await db.exam.findFirst({ where: { id: input.exam_id, schoolId, deletedAt: null } });
  if (!exam) throw ApiError.notFound('Exam not found');
  const enrollment = await db.studentEnrollment.findFirst({ where: { studentId: input.student_id, semesterId: course.semesterId, schoolId } });
  if (!enrollment) throw ApiError.conflict('Student is not enrolled in the semester of this course');
  const existing = await db.courseMark.findFirst({ where: { courseId: input.course_id, studentId: input.student_id, examId: input.exam_id, schoolId } });
  if (existing) {
    const before = { obtained_marks: existing.obtainedMarks, total_marks: existing.totalMarks };
    const updated = await db.courseMark.update({ where: { id: existing.id }, data: { obtainedMarks: input.obtained_marks, totalMarks: input.total_marks } });
    await writeChangeLogs(db, { schoolId, actorId: actorId ?? null, entity: 'course_mark', entityId: existing.id, before, after: { obtained_marks: updated.obtainedMarks, total_marks: updated.totalMarks } });
    await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'course_mark.update', entity: 'course_mark', entityId: existing.id, details: { course_id: input.course_id, student_id: input.student_id, exam_id: input.exam_id } });
    return { mark: updated, created: false };
  }
  let created: any;
  try {
    created = await db.courseMark.create({
      data: { schoolId, courseId: input.course_id, studentId: input.student_id, examId: input.exam_id, obtainedMarks: input.obtained_marks, totalMarks: input.total_marks },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw ApiError.conflict('Marks already exist for this course, student and exam');
    throw err;
  }
  await logCreate(db, { schoolId, actorId: actorId ?? null, entity: 'course_mark', entityId: created.id, after: { course_id: created.courseId, student_id: created.studentId, exam_id: created.examId, obtained_marks: created.obtainedMarks, total_marks: created.totalMarks } });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'course_mark.create', entity: 'course_mark', entityId: created.id, details: { course_id: input.course_id, student_id: input.student_id, exam_id: input.exam_id } });
  return { mark: created, created: true };
}

export async function listSemesterMarks(db: Db, schoolId: string, semesterId: string, examId: string): Promise<Record<string, unknown>[]> {
  await assertCollege(db, schoolId);
  const semester = await getSemester(db, schoolId, semesterId);
  const exam = await db.exam.findFirst({ where: { id: examId, schoolId, deletedAt: null } });
  if (!exam) throw ApiError.notFound('Exam not found');
  const courses = await db.course.findMany({ where: { semesterId: semester.id, schoolId, deletedAt: null } });
  const courseById = new Map<string, any>((courses as any[]).map((c) => [c.id, c]));
  const marks = await db.courseMark.findMany({ where: { schoolId, examId, courseId: { in: [...courseById.keys()] } } });
  const studentIds = [...new Set((marks as any[]).map((m) => m.studentId))];
  const students = studentIds.length > 0
    ? await db.student.findMany({ where: { schoolId, id: { in: studentIds } } })
    : [];
  const studentById = new Map<string, any>((students as any[]).map((s) => [s.id, s]));
  const rows: Array<Record<string, unknown> | null> = (marks as any[])
    .map((m) => {
      const student = studentById.get(m.studentId);
      const course = courseById.get(m.courseId);
      if (!student || !course) return null;
      return {
        student_id: m.studentId,
        student_name: student.name,
        roll_no: student.rollNo ?? null,
        course_id: course.id,
        course_code: course.code,
        obtained_marks: m.obtainedMarks,
        total_marks: m.totalMarks,
        percentage: percentageOf(m.obtainedMarks, m.totalMarks),
      };
    });
  return rows
    .filter((r): r is Record<string, unknown> => r !== null)
    .sort((a, b) => String(a.student_name).localeCompare(String(b.student_name)) || String(a.course_code).localeCompare(String(b.course_code)));
}

/* ------------------------------------------------------------------ */
/* GPA / CGPA                                                          */
/* ------------------------------------------------------------------ */

/** All marks for a student, joined to their courses (for GPA math). */
async function studentMarksWithCourses(db: Db, schoolId: string, studentId: string, semesterId?: string): Promise<Array<{ course: any; mark: any }>> {
  const marks = await db.courseMark.findMany({ where: { schoolId, studentId } });
  const courseIds = [...new Set((marks as any[]).map((m) => m.courseId))];
  if (courseIds.length === 0) return [];
  const courses = await db.course.findMany({ where: { schoolId, id: { in: courseIds } } });
  const courseById = new Map<string, any>((courses as any[]).map((c) => [c.id, c]));
  return (marks as any[])
    .map((m) => ({ course: courseById.get(m.courseId), mark: m }))
    .filter((x) => x.course && (!semesterId || x.course.semesterId === semesterId));
}

function toMarksInput(rows: Array<{ course: any; mark: any }>): CourseMarksInput[] {
  return rows.map(({ course, mark }) => ({
    course_id: course.id,
    credit_hours: course.creditHours,
    obtained_marks: mark.obtainedMarks,
    total_marks: mark.totalMarks,
    updated_at: mark.updatedAt,
    created_at: mark.createdAt,
  }));
}

/** GPA course rows for one semester: latest exam's marks per course only. */
async function semesterGpaRows(db: Db, schoolId: string, studentId: string, semesterId: string): Promise<Record<string, unknown>[]> {
  const rows = await studentMarksWithCourses(db, schoolId, studentId, semesterId);
  const courseById = new Map<string, any>(rows.map((r) => [r.course.id, r.course]));
  // Latest attempt per course wins (repeated-course rule): pick per
  // course the mark row with the max updatedAt/createdAt stamp.
  const stamp = (m: any) => Math.max(new Date(m.updatedAt ?? 0).getTime(), new Date(m.createdAt ?? 0).getTime());
  const newest = new Map<string, any>();
  for (const { course, mark } of rows) {
    const prev = newest.get(course.id);
    if (!prev || stamp(mark) >= stamp(prev)) newest.set(course.id, mark);
  }
  return [...newest.entries()]
    .map(([courseId, mark]) => toGpaCourseRow(courseById.get(courseId), mark))
    .sort((a, b) => String(a.course_code).localeCompare(String(b.course_code)));
}

export async function getStudentGpa(
  db: Db,
  schoolId: string,
  studentId: string,
  semesterId?: string | null,
): Promise<Record<string, unknown>> {
  await assertCollege(db, schoolId);
  const student = await db.student.findFirst({ where: { id: studentId, schoolId, deletedAt: null } });
  if (!student) throw ApiError.notFound('Student not found');
  const enrollments = await db.studentEnrollment.findMany({ where: { studentId, schoolId }, orderBy: [{ createdAt: 'asc' }] });
  let semester: any = null;
  if (semesterId) {
    const enrollment = (enrollments as any[]).find((e) => e.semesterId === semesterId);
    if (!enrollment) throw ApiError.notFound('Student is not enrolled in this semester');
    semester = await db.semester.findFirst({ where: { id: semesterId, schoolId } });
  } else if (enrollments.length > 0) {
    // Latest enrolled semester = the one with the highest semester number.
    const semesters = await db.semester.findMany({ where: { schoolId, id: { in: (enrollments as any[]).map((e) => e.semesterId) } } });
    semester = [...(semesters as any[])].sort((a, b) => b.number - a.number)[0] ?? null;
  }
  const courses: Record<string, unknown>[] = [];
  let semesterGpa: number | null = null;
  let semesterCredits = 0;
  if (semester) {
    const rows = await semesterGpaRows(db, schoolId, studentId, semester.id);
    courses.push(...rows);
    const inputs = await studentMarksWithCourses(db, schoolId, studentId, semester.id);
    semesterGpa = computeGpa(toMarksInput(inputs));
    semesterCredits = rows.reduce((a, r) => a + Number(r.credit_hours), 0);
  }
  const allInputs = await studentMarksWithCourses(db, schoolId, studentId);
  const cgpa = computeCgpa(toMarksInput(allInputs));
  const latestPerCourse = latestMarksOnly(toMarksInput(allInputs));
  const totalCreditsAll = latestPerCourse.reduce((a, m) => a + m.credit_hours, 0);
  return {
    student_id: studentId,
    semester: semester
      ? { id: semester.id, number: semester.number, name: semester.name, gpa: semesterGpa, total_credit_hours: semesterCredits }
      : null,
    cgpa,
    total_credit_hours_all: totalCreditsAll,
    courses,
  };
}

/* ------------------------------------------------------------------ */
/* Toppers                                                             */
/* ------------------------------------------------------------------ */

export async function getProgramToppers(
  db: Db,
  schoolId: string,
  programId: string,
  semesterId: string,
  examId: string,
): Promise<Record<string, unknown>[]> {
  await assertCollege(db, schoolId);
  await getProgram(db, schoolId, programId);
  const semester = await getSemester(db, schoolId, semesterId);
  if (semester.programId !== programId) throw ApiError.validation('Semester does not belong to this program');
  const exam = await db.exam.findFirst({ where: { id: examId, schoolId, deletedAt: null } });
  if (!exam) throw ApiError.notFound('Exam not found');
  const enrollments = await db.studentEnrollment.findMany({ where: { schoolId, semesterId, programId } });
  const courses = await db.course.findMany({ where: { schoolId, semesterId, deletedAt: null } });
  const courseIds = (courses as any[]).map((c) => c.id);
  const out: Array<{ student_id: string; student_name: string; roll_no: number | null; semester_gpa: number; cgpa: number | null }> = [];
  for (const e of enrollments as any[]) {
    const student = await db.student.findFirst({ where: { id: e.studentId, schoolId, deletedAt: null } });
    if (!student) continue;
    const examMarks = courseIds.length > 0
      ? await db.courseMark.findMany({ where: { schoolId, studentId: student.id, examId, courseId: { in: courseIds } } })
      : [];
    if ((examMarks as any[]).length === 0) continue; // no marks in this exam -> not rankable
    const courseById = new Map<string, any>((courses as any[]).map((c) => [c.id, c]));
    const semesterInputs: CourseMarksInput[] = (examMarks as any[]).map((m) => ({
      course_id: m.courseId,
      credit_hours: courseById.get(m.courseId)?.creditHours ?? 0,
      obtained_marks: m.obtainedMarks,
      total_marks: m.totalMarks,
      updated_at: m.updatedAt,
      created_at: m.createdAt,
    }));
    const semesterGpa = computeGpa(semesterInputs);
    if (semesterGpa === null) continue;
    const allInputs = await studentMarksWithCourses(db, schoolId, student.id);
    const cgpa = computeCgpa(toMarksInput(allInputs));
    out.push({ student_id: student.id, student_name: student.name, roll_no: student.rollNo ?? null, semester_gpa: semesterGpa, cgpa });
  }
  out.sort((a, b) => b.semester_gpa - a.semester_gpa || (b.cgpa ?? -1) - (a.cgpa ?? -1) || a.student_name.localeCompare(b.student_name));
  return out.slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Report-card college block (called from results/service.ts)          */
/* ------------------------------------------------------------------ */

export interface CollegeReportCardBlock {
  program_name: string;
  semester_number: number;
  semester_name: string;
  courses: Record<string, unknown>[];
  semester_gpa: number | null;
  cgpa: number | null;
}

/**
 * College block for the existing report card. Returns null for School
 * orgs or students with no enrollment — the results service then leaves
 * the response byte-identical to before.
 */
export async function buildCollegeReportCardBlock(
  db: Db,
  schoolId: string,
  studentId: string,
  examId: string,
): Promise<CollegeReportCardBlock | null> {
  const school = await db.school.findFirst({ where: { id: schoolId } });
  if (!school || (school as any).orgType !== 'College') return null;
  const enrollments = await db.studentEnrollment.findMany({ where: { studentId, schoolId }, orderBy: [{ createdAt: 'asc' }] });
  if ((enrollments as any[]).length === 0) return null;
  // Semester for this report card: the semester where the student has
  // course marks under THIS exam (highest number if several); otherwise
  // the latest enrolled semester.
  const allMarks = await db.courseMark.findMany({ where: { schoolId, studentId, examId } });
  const courseIds = [...new Set((allMarks as any[]).map((m) => m.courseId))];
  let semester: any = null;
  if (courseIds.length > 0) {
    const courses = await db.course.findMany({ where: { schoolId, id: { in: courseIds } } });
    const semesterIds = [...new Set((courses as any[]).map((c) => c.semesterId))];
    const semesters = await db.semester.findMany({ where: { schoolId, id: { in: semesterIds } } });
    semester = [...(semesters as any[])].sort((a, b) => b.number - a.number)[0] ?? null;
  }
  if (!semester) {
    const semesters = await db.semester.findMany({ where: { schoolId, id: { in: (enrollments as any[]).map((e) => e.semesterId) } } });
    semester = [...(semesters as any[])].sort((a, b) => b.number - a.number)[0] ?? null;
  }
  if (!semester) return null;
  const program = await db.program.findFirst({ where: { id: semester.programId, schoolId } });
  // This exam's marks only (it is an exam report card), same row shape as /gpa.
  const semesterCourses = await db.course.findMany({ where: { schoolId, semesterId: semester.id, deletedAt: null } });
  const courseById = new Map<string, any>((semesterCourses as any[]).map((c) => [c.id, c]));
  const examMarks = await db.courseMark.findMany({
    where: { schoolId, studentId, examId, courseId: { in: [...courseById.keys()] } },
  });
  const courses = (examMarks as any[])
    .map((m) => toGpaCourseRow(courseById.get(m.courseId), m))
    .sort((a, b) => String(a.course_code).localeCompare(String(b.course_code)));
  const semesterInputs: CourseMarksInput[] = (examMarks as any[]).map((m) => ({
    course_id: m.courseId,
    credit_hours: courseById.get(m.courseId)?.creditHours ?? 0,
    obtained_marks: m.obtainedMarks,
    total_marks: m.totalMarks,
    updated_at: m.updatedAt,
    created_at: m.createdAt,
  }));
  const semesterGpa = computeGpa(semesterInputs);
  const allInputs = await studentMarksWithCourses(db, schoolId, studentId);
  const cgpa = computeCgpa(toMarksInput(allInputs));
  return {
    program_name: program?.name ?? '',
    semester_number: semester.number,
    semester_name: semester.name,
    courses,
    semester_gpa: semesterGpa,
    cgpa,
  };
}
