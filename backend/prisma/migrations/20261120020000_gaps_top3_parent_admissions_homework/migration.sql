-- Gaps Top 3 (2026-11-20): parent portal tokens, online admissions,
-- homework diary.
--
-- CHECK constraints live here in migration SQL only (Prisma 6.x has no
-- @@check). Safe on an empty database: CREATE TABLE IF NOT EXISTS + new
-- tables only, no data migration, no changes to existing tables.
-- All FKs cascade from schools (ON DELETE CASCADE), matching the rest of
-- the schema. Parent phones reuse the AES-256-GCM enc + SHA-256 hash
-- pattern of students (see backend/src/lib/crypto.ts).

CREATE TABLE IF NOT EXISTS "parent_tokens" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "studentId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "tokenEnc" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "revoked" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "parent_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "parent_tokens_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "parent_tokens_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "parent_tokens_tokenHash_key" UNIQUE ("tokenHash")
);
CREATE INDEX IF NOT EXISTS "parent_tokens_schoolId_studentId_idx" ON "parent_tokens"("schoolId", "studentId");

CREATE TABLE IF NOT EXISTS "admission_inquiries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "studentName" TEXT NOT NULL,
  "classId" UUID,
  "className" TEXT NOT NULL,
  "parentName" TEXT NOT NULL,
  "parentPhoneEnc" TEXT NOT NULL,
  "parentPhoneHash" TEXT NOT NULL,
  "parentEmail" TEXT,
  "notes" TEXT,
  "status" TEXT NOT NULL DEFAULT 'new',
  "admittedStudentId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "admission_inquiries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admission_inquiries_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "admission_inquiries_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "admission_inquiries_admittedStudentId_fkey" FOREIGN KEY ("admittedStudentId") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "admission_inquiries_status_check" CHECK ("status" IN ('new', 'contacted', 'test', 'interview', 'admitted', 'rejected'))
);
CREATE INDEX IF NOT EXISTS "admission_inquiries_schoolId_status_createdAt_idx" ON "admission_inquiries"("schoolId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "admission_inquiries_schoolId_parentPhoneHash_idx" ON "admission_inquiries"("schoolId", "parentPhoneHash");

CREATE TABLE IF NOT EXISTS "homework" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "classId" UUID NOT NULL,
  "subject" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "dueDate" DATE NOT NULL,
  "teacher" TEXT NOT NULL,
  "createdBy" UUID,
  "deletedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "homework_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "homework_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "homework_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "homework_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "homework_schoolId_classId_dueDate_idx" ON "homework"("schoolId", "classId", "dueDate");
CREATE INDEX IF NOT EXISTS "homework_schoolId_deletedAt_idx" ON "homework"("schoolId", "deletedAt");
