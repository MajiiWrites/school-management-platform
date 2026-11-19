-- College Mode (2026-11-20): programs / semesters / courses /
-- student_enrollments / course_marks for schools whose orgType is 'College'.
--
-- CHECK constraints live here in migration SQL only (Prisma 6.x has no
-- @@check). Safe on an empty database: CREATE TABLE IF NOT EXISTS + new
-- tables only, no data migration, no changes to existing tables.
-- All FKs cascade from schools (ON DELETE CASCADE), matching the rest of
-- the schema. course_marks.obtained_marks <= total_marks is enforced by
-- course_marks_obtained_lte_total_check.

CREATE TABLE IF NOT EXISTS "programs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "department" TEXT NOT NULL,
  "durationYears" INTEGER NOT NULL,
  "deletedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "programs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "programs_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "programs_schoolId_code_key" UNIQUE ("schoolId", "code"),
  CONSTRAINT "programs_duration_years_check" CHECK ("durationYears" >= 1 AND "durationYears" <= 6)
);
CREATE INDEX IF NOT EXISTS "programs_schoolId_deletedAt_idx" ON "programs"("schoolId", "deletedAt");

CREATE TABLE IF NOT EXISTS "semesters" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "programId" UUID NOT NULL,
  "number" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "deletedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "semesters_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "semesters_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "semesters_programId_fkey" FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "semesters_programId_number_key" UNIQUE ("programId", "number"),
  CONSTRAINT "semesters_number_check" CHECK ("number" >= 1 AND "number" <= 16)
);
CREATE INDEX IF NOT EXISTS "semesters_schoolId_deletedAt_idx" ON "semesters"("schoolId", "deletedAt");

CREATE TABLE IF NOT EXISTS "courses" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "semesterId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "creditHours" INTEGER NOT NULL,
  "teacherId" UUID,
  "deletedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "courses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "courses_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "courses_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "semesters"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "courses_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "courses_semesterId_code_key" UNIQUE ("semesterId", "code"),
  CONSTRAINT "courses_credit_hours_check" CHECK ("creditHours" >= 1 AND "creditHours" <= 6)
);
CREATE INDEX IF NOT EXISTS "courses_schoolId_deletedAt_idx" ON "courses"("schoolId", "deletedAt");

CREATE TABLE IF NOT EXISTS "student_enrollments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "studentId" UUID NOT NULL,
  "programId" UUID NOT NULL,
  "semesterId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "student_enrollments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "student_enrollments_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "student_enrollments_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "student_enrollments_programId_fkey" FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "student_enrollments_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "semesters"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "student_enrollments_studentId_semesterId_key" UNIQUE ("studentId", "semesterId")
);
CREATE INDEX IF NOT EXISTS "student_enrollments_schoolId_studentId_idx" ON "student_enrollments"("schoolId", "studentId");

CREATE TABLE IF NOT EXISTS "course_marks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "courseId" UUID NOT NULL,
  "studentId" UUID NOT NULL,
  "examId" UUID NOT NULL,
  "obtainedMarks" INTEGER NOT NULL,
  "totalMarks" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "course_marks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "course_marks_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "course_marks_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "course_marks_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "course_marks_examId_fkey" FOREIGN KEY ("examId") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "course_marks_courseId_studentId_examId_key" UNIQUE ("courseId", "studentId", "examId"),
  CONSTRAINT "course_marks_obtained_nonneg_check" CHECK ("obtainedMarks" >= 0),
  CONSTRAINT "course_marks_total_positive_check" CHECK ("totalMarks" > 0),
  CONSTRAINT "course_marks_obtained_lte_total_check" CHECK ("obtainedMarks" <= "totalMarks")
);
CREATE INDEX IF NOT EXISTS "course_marks_schoolId_studentId_idx" ON "course_marks"("schoolId", "studentId");
CREATE INDEX IF NOT EXISTS "course_marks_schoolId_courseId_idx" ON "course_marks"("schoolId", "courseId");
