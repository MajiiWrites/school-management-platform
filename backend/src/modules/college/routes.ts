// College Mode routes (2026-11-20). Base /api/v1/college, envelope
// {ok, data} exactly like classes/routes.ts. Every route: auth +
// tenant (requireSchool) + College-org gate (403 otherwise). Mutations
// are queue-gated for clerks (requireQueueable + queueIfClerk, same as
// classes); admins apply directly.
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../lib/db';
import { parseBody, uuidSchema } from '../../lib/validate';
import { asyncHandler, ApiError } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdminOrClerk } from '../../middleware/rbac';
import { requireQueueable } from '../../middleware/permissions';
import { queueIfClerk } from '../hardening/queueGate';
import * as service from './service';

export const collegeRouter = Router();
collegeRouter.use(authenticate, requireSchool);

/** College-org gate: every college route reads orgType from the DB. */
async function requireCollege(req: any, _res: any, next: any): Promise<void> {
  try {
    await service.assertCollege(getDb(), schoolIdOf(req));
    next();
  } catch (err) {
    next(err);
  }
}
collegeRouter.use(requireCollege);

const idParams = z.object({ id: uuidSchema });
const programIdParams = z.object({ id: uuidSchema });

const programSchema = z.object({
  name: z.string().min(1, 'Program name is required').max(120),
  code: z.string().min(1, 'Program code is required').max(20),
  department: z.string().min(1, 'Department is required').max(120),
  duration_years: z.number().int().min(1).max(6),
});
const programPatchSchema = programSchema.partial();

const semesterSchema = z.object({
  number: z.number().int().min(1).max(16),
  name: z.string().max(120).optional().nullable(),
});

const courseSchema = z.object({
  code: z.string().min(1, 'Course code is required').max(20),
  title: z.string().min(1, 'Course title is required').max(200),
  credit_hours: z.number().int().min(1).max(6),
  teacher_id: uuidSchema.optional().nullable(),
});
const coursePatchSchema = courseSchema.partial();

const enrollmentSchema = z.object({
  student_id: uuidSchema,
  program_id: uuidSchema,
  semester_id: uuidSchema,
});

const markSchema = z.object({
  course_id: uuidSchema,
  student_id: uuidSchema,
  exam_id: uuidSchema,
  obtained_marks: z.number().int().min(0),
  total_marks: z.number().int().min(1),
});

/* ------------------------------------------------------------------ */
/* Programs                                                            */
/* ------------------------------------------------------------------ */

collegeRouter.get(
  '/programs',
  asyncHandler(async (req, res) => {
    const programs = await service.listPrograms(getDb(), schoolIdOf(req));
    res.json({ ok: true, data: { programs } });
  }),
);

collegeRouter.post(
  '/programs',
  requireAdminOrClerk,
  requireQueueable('college', 'create'),
  asyncHandler(async (req, res) => {
    const body = parseBody(programSchema, req.body);
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'program', payload: body })) return;
    const created = await service.createProgram(getDb(), schoolIdOf(req), body, req.user!.sub);
    res.status(201).json({ ok: true, data: { program: service.toPublicProgram(created, 0, 0) } });
  }),
);

collegeRouter.get(
  '/programs/:id',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(programIdParams, req.params);
    const detail = await service.getProgramDetail(getDb(), schoolIdOf(req), id);
    res.json({ ok: true, data: detail });
  }),
);

collegeRouter.patch(
  '/programs/:id',
  requireAdminOrClerk,
  requireQueueable('college', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const patch = parseBody(programPatchSchema, req.body);
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'program', entityId: id, payload: { id, patch } })) return;
    const updated = await service.updateProgram(getDb(), schoolIdOf(req), id, patch, req.user!.sub);
    res.json({ ok: true, data: { program: service.toPublicProgram(updated) } });
  }),
);

collegeRouter.delete(
  '/programs/:id',
  requireAdminOrClerk,
  requireQueueable('college', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'program', entityId: id, payload: { id } })) return;
    await service.deleteProgram(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Program deleted (moved to recycle bin — restorable for 30 days)' } });
  }),
);

/* ------------------------------------------------------------------ */
/* Semesters                                                           */
/* ------------------------------------------------------------------ */

collegeRouter.post(
  '/programs/:id/semesters',
  requireAdminOrClerk,
  requireQueueable('college', 'create'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(programIdParams, req.params);
    const body = parseBody(semesterSchema, req.body);
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'semester', payload: { program_id: id, ...body } })) return;
    const created = await service.createSemester(getDb(), schoolIdOf(req), id, body, req.user!.sub);
    res.status(201).json({ ok: true, data: { semester: service.toPublicSemester(created, 0, 0) } });
  }),
);

collegeRouter.get(
  '/programs/:id/semesters',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(programIdParams, req.params);
    const semesters = await service.listSemesters(getDb(), schoolIdOf(req), id);
    res.json({ ok: true, data: { semesters } });
  }),
);

collegeRouter.delete(
  '/semesters/:id',
  requireAdminOrClerk,
  requireQueueable('college', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'semester', entityId: id, payload: { id } })) return;
    await service.deleteSemester(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Semester deleted (moved to recycle bin — restorable for 30 days)' } });
  }),
);

/* ------------------------------------------------------------------ */
/* Courses                                                             */
/* ------------------------------------------------------------------ */

collegeRouter.post(
  '/semesters/:id/courses',
  requireAdminOrClerk,
  requireQueueable('college', 'create'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const body = parseBody(courseSchema, req.body);
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'course', payload: { semester_id: id, ...body } })) return;
    const created = await service.createCourse(getDb(), schoolIdOf(req), id, body, req.user!.sub);
    res.status(201).json({ ok: true, data: { course: service.toPublicCourse(created) } });
  }),
);

collegeRouter.get(
  '/semesters/:id/courses',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const courses = await service.listCourses(getDb(), schoolIdOf(req), id);
    res.json({ ok: true, data: { courses } });
  }),
);

collegeRouter.patch(
  '/courses/:id',
  requireAdminOrClerk,
  requireQueueable('college', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const patch = parseBody(coursePatchSchema, req.body);
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'course', entityId: id, payload: { id, patch } })) return;
    const updated = await service.updateCourse(getDb(), schoolIdOf(req), id, patch, req.user!.sub);
    res.json({ ok: true, data: { course: service.toPublicCourse(updated) } });
  }),
);

collegeRouter.delete(
  '/courses/:id',
  requireAdminOrClerk,
  requireQueueable('college', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'course', entityId: id, payload: { id } })) return;
    await service.deleteCourse(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Course deleted (moved to recycle bin — restorable for 30 days)' } });
  }),
);

/* ------------------------------------------------------------------ */
/* Enrollments                                                         */
/* ------------------------------------------------------------------ */

collegeRouter.post(
  '/enrollments',
  requireAdminOrClerk,
  requireQueueable('college', 'create'),
  asyncHandler(async (req, res) => {
    const body = parseBody(enrollmentSchema, req.body);
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'enrollment', payload: body })) return;
    const created = await service.createEnrollment(getDb(), schoolIdOf(req), body, req.user!.sub);
    res.status(201).json({ ok: true, data: { enrollment: service.toPublicEnrollment(created) } });
  }),
);

collegeRouter.delete(
  '/enrollments/:id',
  requireAdminOrClerk,
  requireQueueable('college', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'enrollment', entityId: id, payload: { id } })) return;
    await service.deleteEnrollment(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Student unenrolled' } });
  }),
);

collegeRouter.get(
  '/students/:id/enrollments',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const enrollments = await service.listStudentEnrollments(getDb(), schoolIdOf(req), id);
    res.json({ ok: true, data: { enrollments } });
  }),
);

/* ------------------------------------------------------------------ */
/* Marks                                                               */
/* ------------------------------------------------------------------ */

collegeRouter.post(
  '/marks',
  requireAdminOrClerk,
  requireQueueable('college', 'create'),
  asyncHandler(async (req, res) => {
    const body = parseBody(markSchema, req.body);
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'course_mark', payload: body })) return;
    const { mark, created } = await service.upsertCourseMark(getDb(), schoolIdOf(req), body, req.user!.sub);
    res.status(created ? 201 : 200).json({ ok: true, data: { mark: service.toPublicCourseMark(mark) } });
  }),
);

collegeRouter.get(
  '/semesters/:id/marks',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const examId = String(req.query.exam_id ?? '');
    if (!examId) throw ApiError.validation('exam_id query param is required');
    const marks = await service.listSemesterMarks(getDb(), schoolIdOf(req), id, examId);
    res.json({ ok: true, data: { marks } });
  }),
);

/* ------------------------------------------------------------------ */
/* GPA / toppers                                                       */
/* ------------------------------------------------------------------ */

collegeRouter.get(
  '/students/:id/gpa',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const semesterId = typeof req.query.semester_id === 'string' && req.query.semester_id ? req.query.semester_id : null;
    const data = await service.getStudentGpa(getDb(), schoolIdOf(req), id, semesterId);
    res.json({ ok: true, data });
  }),
);

collegeRouter.get(
  '/programs/:id/toppers',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(programIdParams, req.params);
    const semesterId = String(req.query.semester_id ?? '');
    const examId = String(req.query.exam_id ?? '');
    if (!semesterId || !examId) throw ApiError.validation('semester_id and exam_id query params are required');
    const toppers = await service.getProgramToppers(getDb(), schoolIdOf(req), id, semesterId, examId);
    res.json({ ok: true, data: { toppers } });
  }),
);
