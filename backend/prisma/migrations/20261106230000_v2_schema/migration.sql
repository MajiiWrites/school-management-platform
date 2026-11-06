-- AlterTable
ALTER TABLE "classes" ADD COLUMN     "deletedAt" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "fee_records" ADD COLUMN     "arrears" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deletedAt" TIMESTAMPTZ(6),
ADD COLUMN     "scholarshipDiscount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "fee_structures" ADD COLUMN     "admissionFee" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "siblingDiscountPct" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "students" ADD COLUMN     "address" TEXT,
ADD COLUMN     "admissionDate" DATE,
ADD COLUMN     "admissionNo" TEXT,
ADD COLUMN     "dateOfBirth" DATE,
ADD COLUMN     "deletedAt" TIMESTAMPTZ(6),
ADD COLUMN     "fatherName" TEXT,
ADD COLUMN     "gender" TEXT,
ADD COLUMN     "idCardIssuedAt" TIMESTAMPTZ(6),
ADD COLUMN     "parent2Name" TEXT,
ADD COLUMN     "parent2OptOut" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "parent2PhoneEnc" TEXT,
ADD COLUMN     "parent2PhoneHash" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "lastLoginIp" TEXT,
ADD COLUMN     "loginAlerts" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totpSecretEnc" TEXT;

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "requestedBy" UUID NOT NULL,
    "actionType" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" UUID,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decidedBy" UUID,
    "decidedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deleted_records" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "deletedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoreBy" TIMESTAMPTZ(6),
    "permanentlyDeletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "deleted_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_logs" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "actorId" UUID,
    "actorType" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" UUID,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "changedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exams" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sessionId" UUID,
    "startDate" DATE,
    "endDate" DATE,
    "deletedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grading_scales" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "classId" UUID,
    "minMarks" INTEGER NOT NULL,
    "maxMarks" INTEGER NOT NULL,
    "grade" TEXT NOT NULL,
    "gpaPoints" DOUBLE PRECISION NOT NULL,
    "isPassing" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grading_scales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result_sheets" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "examId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "sessionId" UUID,
    "filePath" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "rawText" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "results" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "resultSheetId" UUID,
    "examId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "studentId" UUID,
    "rollNo" INTEGER NOT NULL,
    "studentName" TEXT NOT NULL,
    "fatherName" TEXT,
    "subjectMarks" JSONB NOT NULL DEFAULT '{}',
    "obtainedMarks" INTEGER,
    "totalMarks" INTEGER,
    "percentage" DOUBLE PRECISION,
    "grade" TEXT,
    "position" INTEGER,
    "remarks" TEXT,
    "confidence" JSONB,
    "linkedAt" TIMESTAMPTZ(6),
    "deletedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_entries" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "teacherId" UUID,
    "dayOfWeek" INTEGER NOT NULL,
    "periodNo" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "room" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timetable_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "phoneEnc" TEXT,
    "phoneHash" TEXT,
    "email" TEXT,
    "joiningDate" DATE,
    "subjects" JSONB NOT NULL DEFAULT '[]',
    "salaryMonthly" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_class_assignments" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_class_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_records" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "baseSalary" INTEGER NOT NULL,
    "deductions" INTEGER NOT NULL DEFAULT 0,
    "netPay" INTEGER NOT NULL,
    "paidAt" TIMESTAMPTZ(6),
    "payslipNo" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "amount" INTEGER NOT NULL,
    "createdBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "targetType" TEXT NOT NULL DEFAULT 'all',
    "targetClassId" UUID,
    "smsSend" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificates" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedBy" UUID,

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_datesheets" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "examId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_datesheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_vouchers" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "feeRecordId" UUID NOT NULL,
    "voucherNo" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "amountDue" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unpaid',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_deletion_requests" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "requestedBy" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(6),

    CONSTRAINT "account_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "school_backups" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "fileRef" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sizeBytes" INTEGER,

    CONSTRAINT "school_backups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "role_permissions_schoolId_role_idx" ON "role_permissions"("schoolId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_schoolId_role_resource_action_key" ON "role_permissions"("schoolId", "role", "resource", "action");

-- CreateIndex
CREATE INDEX "approval_requests_schoolId_status_createdAt_idx" ON "approval_requests"("schoolId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "deleted_records_schoolId_entity_deletedAt_idx" ON "deleted_records"("schoolId", "entity", "deletedAt");

-- CreateIndex
CREATE INDEX "deleted_records_restoreBy_idx" ON "deleted_records"("restoreBy");

-- CreateIndex
CREATE INDEX "change_logs_schoolId_entity_entityId_changedAt_idx" ON "change_logs"("schoolId", "entity", "entityId", "changedAt");

-- CreateIndex
CREATE INDEX "exams_schoolId_sessionId_idx" ON "exams"("schoolId", "sessionId");

-- CreateIndex
CREATE INDEX "exams_schoolId_deletedAt_idx" ON "exams"("schoolId", "deletedAt");

-- CreateIndex
CREATE INDEX "grading_scales_schoolId_classId_idx" ON "grading_scales"("schoolId", "classId");

-- CreateIndex
CREATE INDEX "result_sheets_schoolId_examId_classId_idx" ON "result_sheets"("schoolId", "examId", "classId");

-- CreateIndex
CREATE INDEX "result_sheets_schoolId_status_idx" ON "result_sheets"("schoolId", "status");

-- CreateIndex
CREATE INDEX "results_schoolId_studentId_idx" ON "results"("schoolId", "studentId");

-- CreateIndex
CREATE INDEX "results_schoolId_examId_classId_idx" ON "results"("schoolId", "examId", "classId");

-- CreateIndex
CREATE UNIQUE INDEX "results_examId_classId_rollNo_key" ON "results"("examId", "classId", "rollNo");

-- CreateIndex
CREATE INDEX "timetable_entries_schoolId_teacherId_idx" ON "timetable_entries"("schoolId", "teacherId");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_entries_schoolId_classId_dayOfWeek_periodNo_key" ON "timetable_entries"("schoolId", "classId", "dayOfWeek", "periodNo");

-- CreateIndex
CREATE INDEX "staff_schoolId_role_idx" ON "staff"("schoolId", "role");

-- CreateIndex
CREATE INDEX "staff_class_assignments_schoolId_classId_idx" ON "staff_class_assignments"("schoolId", "classId");

-- CreateIndex
CREATE UNIQUE INDEX "staff_class_assignments_staffId_classId_subject_key" ON "staff_class_assignments"("staffId", "classId", "subject");

-- CreateIndex
CREATE INDEX "salary_records_schoolId_month_idx" ON "salary_records"("schoolId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "salary_records_staffId_month_key" ON "salary_records"("staffId", "month");

-- CreateIndex
CREATE INDEX "expenses_schoolId_date_idx" ON "expenses"("schoolId", "date");

-- CreateIndex
CREATE INDEX "expenses_schoolId_category_idx" ON "expenses"("schoolId", "category");

-- CreateIndex
CREATE INDEX "announcements_schoolId_status_createdAt_idx" ON "announcements"("schoolId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "events_schoolId_date_idx" ON "events"("schoolId", "date");

-- CreateIndex
CREATE INDEX "certificates_schoolId_studentId_type_idx" ON "certificates"("schoolId", "studentId", "type");

-- CreateIndex
CREATE INDEX "exam_datesheets_schoolId_examId_classId_idx" ON "exam_datesheets"("schoolId", "examId", "classId");

-- CreateIndex
CREATE UNIQUE INDEX "exam_datesheets_examId_classId_subject_date_key" ON "exam_datesheets"("examId", "classId", "subject", "date");

-- CreateIndex
CREATE INDEX "fee_vouchers_schoolId_month_status_idx" ON "fee_vouchers"("schoolId", "month", "status");

-- CreateIndex
CREATE UNIQUE INDEX "fee_vouchers_schoolId_voucherNo_key" ON "fee_vouchers"("schoolId", "voucherNo");

-- CreateIndex
CREATE INDEX "account_deletion_requests_schoolId_status_idx" ON "account_deletion_requests"("schoolId", "status");

-- CreateIndex
CREATE INDEX "school_backups_schoolId_createdAt_idx" ON "school_backups"("schoolId", "createdAt");

-- CreateIndex
CREATE INDEX "classes_schoolId_deletedAt_idx" ON "classes"("schoolId", "deletedAt");

-- CreateIndex
CREATE INDEX "fee_records_schoolId_deletedAt_idx" ON "fee_records"("schoolId", "deletedAt");

-- CreateIndex
CREATE INDEX "students_schoolId_deletedAt_idx" ON "students"("schoolId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "students_schoolId_admissionNo_key" ON "students"("schoolId", "admissionNo");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requestedBy_fkey" FOREIGN KEY ("requestedBy") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decidedBy_fkey" FOREIGN KEY ("decidedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deleted_records" ADD CONSTRAINT "deleted_records_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deleted_records" ADD CONSTRAINT "deleted_records_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_logs" ADD CONSTRAINT "change_logs_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_logs" ADD CONSTRAINT "change_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "academic_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_scales" ADD CONSTRAINT "grading_scales_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_scales" ADD CONSTRAINT "grading_scales_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_examId_fkey" FOREIGN KEY ("examId") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "academic_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "results" ADD CONSTRAINT "results_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "results" ADD CONSTRAINT "results_resultSheetId_fkey" FOREIGN KEY ("resultSheetId") REFERENCES "result_sheets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "results" ADD CONSTRAINT "results_examId_fkey" FOREIGN KEY ("examId") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "results" ADD CONSTRAINT "results_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "results" ADD CONSTRAINT "results_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_class_assignments" ADD CONSTRAINT "staff_class_assignments_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_class_assignments" ADD CONSTRAINT "staff_class_assignments_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_class_assignments" ADD CONSTRAINT "staff_class_assignments_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_records" ADD CONSTRAINT "salary_records_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_records" ADD CONSTRAINT "salary_records_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_targetClassId_fkey" FOREIGN KEY ("targetClassId") REFERENCES "classes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_issuedBy_fkey" FOREIGN KEY ("issuedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_datesheets" ADD CONSTRAINT "exam_datesheets_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_datesheets" ADD CONSTRAINT "exam_datesheets_examId_fkey" FOREIGN KEY ("examId") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_datesheets" ADD CONSTRAINT "exam_datesheets_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_vouchers" ADD CONSTRAINT "fee_vouchers_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_vouchers" ADD CONSTRAINT "fee_vouchers_feeRecordId_fkey" FOREIGN KEY ("feeRecordId") REFERENCES "fee_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_requestedBy_fkey" FOREIGN KEY ("requestedBy") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "school_backups" ADD CONSTRAINT "school_backups_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- HAND-ADDED (v2, same pattern as v1): CHECK constraints + permission seed.
-- Prisma 6.x does not support @@check, so the CHECKs live here. If the schema
-- is regenerated with `prisma migrate diff`, re-apply this block (and keep the
-- fee_records.status GENERATED ALWAYS column above untouched — see the note
-- in schema.prisma; `migrate diff` renders it as a plain DEFAULT, which would
-- destroy the generated column if applied).
-- ============================================================================
-- Extended enums: users.role gains 'principal'; students.status gains 'struck_off'.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_role_check";
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" IN ('admin', 'clerk', 'principal'));
ALTER TABLE "students" DROP CONSTRAINT IF EXISTS "students_status_check";
ALTER TABLE "students" ADD CONSTRAINT "students_status_check" CHECK ("status" IN ('active', 'left', 'struck_off', 'graduated'));

-- New-table CHECKs.
ALTER TABLE "students" ADD CONSTRAINT "students_gender_check" CHECK ("gender" IS NULL OR "gender" IN ('male', 'female', 'other'));
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_check" CHECK ("role" IN ('admin', 'clerk', 'principal'));
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_action_check" CHECK ("action" IN ('view', 'create', 'update', 'delete', 'approve', 'export'));
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_action_type_check" CHECK ("actionType" IN ('create', 'update', 'delete', 'bulk'));
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected'));
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_status_check" CHECK ("status" IN ('processing', 'review', 'saved', 'published'));
ALTER TABLE "grading_scales" ADD CONSTRAINT "grading_scales_range_check" CHECK ("minMarks" >= 0 AND "maxMarks" > "minMarks" AND "gpaPoints" >= 0);
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_day_check" CHECK ("dayOfWeek" BETWEEN 0 AND 6);
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_period_check" CHECK ("periodNo" >= 1);
ALTER TABLE "staff" ADD CONSTRAINT "staff_role_check" CHECK ("role" IN ('teacher', 'staff'));
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_status_check" CHECK ("status" IN ('draft', 'approved', 'sent'));
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_target_type_check" CHECK ("targetType" IN ('all', 'class'));
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_type_check" CHECK ("type" IN ('leaving', 'character', 'bonafide'));
ALTER TABLE "fee_vouchers" ADD CONSTRAINT "fee_vouchers_status_check" CHECK ("status" IN ('unpaid', 'partial', 'paid'));
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'completed', 'rejected'));
ALTER TABLE "change_logs" ADD CONSTRAINT "change_logs_actor_type_check" CHECK ("actorType" IN ('user', 'teacher_link', 'system', 'device'));
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_sibling_discount_check" CHECK ("siblingDiscountPct" BETWEEN 0 AND 100);
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_admission_fee_check" CHECK ("admissionFee" >= 0);
ALTER TABLE "salary_records" ADD CONSTRAINT "salary_records_amounts_check" CHECK ("baseSalary" >= 0 AND "deductions" >= 0 AND "netPay" >= 0);

-- ----------------------------------------------------------------------------
-- Role-permission default seed (per school, idempotent).
-- Runs here so schools that ALREADY exist when v2 is deployed get defaults.
-- Fresh DBs get the same rows from prisma/seed.ts (the school does not exist
-- yet when this migration runs on a fresh deploy). Admin = everything;
-- clerk = view students/fees/results/attendance/reports + add students/fees/
-- results (approval-gated in the app layer) + mark fee paid (v1 behaviour);
-- principal = view-only, no settings/users.
-- ----------------------------------------------------------------------------
-- admin: 84 permission rows per school
INSERT INTO "role_permissions" ("id", "schoolId", "role", "resource", "action", "allowed", "createdAt", "updatedAt")
SELECT gen_random_uuid(), s.id, 'admin', v.resource, v.action, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "schools" s CROSS JOIN (VALUES
  ('students', 'view'),
  ('students', 'create'),
  ('students', 'update'),
  ('students', 'delete'),
  ('students', 'approve'),
  ('students', 'export'),
  ('fees', 'view'),
  ('fees', 'create'),
  ('fees', 'update'),
  ('fees', 'delete'),
  ('fees', 'approve'),
  ('fees', 'export'),
  ('results', 'view'),
  ('results', 'create'),
  ('results', 'update'),
  ('results', 'delete'),
  ('results', 'approve'),
  ('results', 'export'),
  ('attendance', 'view'),
  ('attendance', 'create'),
  ('attendance', 'update'),
  ('attendance', 'delete'),
  ('attendance', 'approve'),
  ('attendance', 'export'),
  ('classes', 'view'),
  ('classes', 'create'),
  ('classes', 'update'),
  ('classes', 'delete'),
  ('classes', 'approve'),
  ('classes', 'export'),
  ('messages', 'view'),
  ('messages', 'create'),
  ('messages', 'update'),
  ('messages', 'delete'),
  ('messages', 'approve'),
  ('messages', 'export'),
  ('reports', 'view'),
  ('reports', 'create'),
  ('reports', 'update'),
  ('reports', 'delete'),
  ('reports', 'approve'),
  ('reports', 'export'),
  ('settings', 'view'),
  ('settings', 'create'),
  ('settings', 'update'),
  ('settings', 'delete'),
  ('settings', 'approve'),
  ('settings', 'export'),
  ('users', 'view'),
  ('users', 'create'),
  ('users', 'update'),
  ('users', 'delete'),
  ('users', 'approve'),
  ('users', 'export'),
  ('staff', 'view'),
  ('staff', 'create'),
  ('staff', 'update'),
  ('staff', 'delete'),
  ('staff', 'approve'),
  ('staff', 'export'),
  ('timetable', 'view'),
  ('timetable', 'create'),
  ('timetable', 'update'),
  ('timetable', 'delete'),
  ('timetable', 'approve'),
  ('timetable', 'export'),
  ('exams', 'view'),
  ('exams', 'create'),
  ('exams', 'update'),
  ('exams', 'delete'),
  ('exams', 'approve'),
  ('exams', 'export'),
  ('announcements', 'view'),
  ('announcements', 'create'),
  ('announcements', 'update'),
  ('announcements', 'delete'),
  ('announcements', 'approve'),
  ('announcements', 'export'),
  ('expenses', 'view'),
  ('expenses', 'create'),
  ('expenses', 'update'),
  ('expenses', 'delete'),
  ('expenses', 'approve'),
  ('expenses', 'export')
) AS v(resource, action)
ON CONFLICT ("schoolId", "role", "resource", "action") DO NOTHING;

-- clerk: 9 permission rows per school
INSERT INTO "role_permissions" ("id", "schoolId", "role", "resource", "action", "allowed", "createdAt", "updatedAt")
SELECT gen_random_uuid(), s.id, 'clerk', v.resource, v.action, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "schools" s CROSS JOIN (VALUES
  ('students', 'view'),
  ('fees', 'view'),
  ('results', 'view'),
  ('attendance', 'view'),
  ('reports', 'view'),
  ('students', 'create'),
  ('fees', 'create'),
  ('results', 'create'),
  ('fees', 'update')
) AS v(resource, action)
ON CONFLICT ("schoolId", "role", "resource", "action") DO NOTHING;

-- principal: 12 permission rows per school
INSERT INTO "role_permissions" ("id", "schoolId", "role", "resource", "action", "allowed", "createdAt", "updatedAt")
SELECT gen_random_uuid(), s.id, 'principal', v.resource, v.action, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "schools" s CROSS JOIN (VALUES
  ('students', 'view'),
  ('fees', 'view'),
  ('results', 'view'),
  ('attendance', 'view'),
  ('classes', 'view'),
  ('messages', 'view'),
  ('reports', 'view'),
  ('staff', 'view'),
  ('timetable', 'view'),
  ('exams', 'view'),
  ('announcements', 'view'),
  ('expenses', 'view')
) AS v(resource, action)
ON CONFLICT ("schoolId", "role", "resource", "action") DO NOTHING;
