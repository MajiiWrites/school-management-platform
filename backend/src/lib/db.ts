/**
 * Prisma access.
 *
 * The Prisma schema is owned by the Database Agent (backend/prisma/schema.prisma).
 * This module NEVER imports '@prisma/client' statically, so `tsc` passes even
 * before `prisma generate` has run. At runtime it loads the generated client
 * and wraps it with a stable, contract-shaped interface. The wrapper tolerates
 * either singular or plural Prisma model names (e.g. `class` vs `classes`,
 * `attendanceDay` vs `attendanceDays`) so the backend keeps working whichever
 * naming the Database Agent chose.
 *
 * If the client has not been generated yet, getDb() throws a clear error.
 */
import { createRequire } from 'module';

const loadModule = createRequire(__filename);

/** Minimal delegate surface used across the backend (methods are untyped on purpose: the generated client is the source of truth at runtime). */
export interface Delegate {
  findUnique: (args: any) => Promise<any>;
  findFirst: (args: any) => Promise<any>;
  findMany: (args: any) => Promise<any>;
  create: (args: any) => Promise<any>;
  createMany: (args: any) => Promise<any>;
  update: (args: any) => Promise<any>;
  updateMany: (args: any) => Promise<any>;
  upsert: (args: any) => Promise<any>;
  delete: (args: any) => Promise<any>;
  deleteMany: (args: any) => Promise<any>;
  count: (args?: any) => Promise<number>;
  aggregate: (args: any) => Promise<any>;
  groupBy: (args: any) => Promise<any>;
}

/** Contract-shaped database interface (SCHEMA.md v1.0). */
export interface Db {
  school: Delegate;
  user: Delegate;
  class: Delegate;
  student: Delegate;
  attendanceDay: Delegate;
  attendanceRecord: Delegate;
  teacherAttendance: Delegate;
  feeStructure: Delegate;
  feeRecord: Delegate;
  messageTemplate: Delegate;
  messageQueue: Delegate;
  messageDelivery: Delegate;
  smsDevice: Delegate;
  holiday: Delegate;
  academicSession: Delegate;
  promotion: Delegate;
  leaveApplication: Delegate;
  ocrUpload: Delegate;
  auditLog: Delegate;
  notification: Delegate;
  // v2 delegates (contracts/SCHEMA.md §§2–11). Added by the 6A hardening
  // phase; the generated Prisma client already carries these models.
  rolePermission: Delegate;
  approvalRequest: Delegate;
  deletedRecord: Delegate;
  changeLog: Delegate;
  exam: Delegate;
  gradingScale: Delegate;
  resultSheet: Delegate;
  result: Delegate;
  timetableEntry: Delegate;
  staff: Delegate;
  staffClassAssignment: Delegate;
  salaryRecord: Delegate;
  expense: Delegate;
  announcement: Delegate;
  event: Delegate;
  certificate: Delegate;
  examDatesheet: Delegate;
  feeVoucher: Delegate;
  accountDeletionRequest: Delegate;
  schoolBackup: Delegate;
  messageDraft: Delegate;
  $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
  $disconnect: () => Promise<void>;
}

const MODEL_KEYS: Array<keyof Omit<Db, '$transaction' | '$disconnect'>> = [
  'school',
  'user',
  'class',
  'student',
  'attendanceDay',
  'attendanceRecord',
  'teacherAttendance',
  'feeStructure',
  'feeRecord',
  'messageTemplate',
  'messageQueue',
  'messageDelivery',
  'smsDevice',
  'holiday',
  'academicSession',
  'promotion',
  'leaveApplication',
  'ocrUpload',
  'auditLog',
  'notification',
  'rolePermission',
  'approvalRequest',
  'deletedRecord',
  'changeLog',
  'exam',
  'gradingScale',
  'resultSheet',
  'result',
  'timetableEntry',
  'staff',
  'staffClassAssignment',
  'salaryRecord',
  'expense',
  'announcement',
  'event',
  'certificate',
  'examDatesheet',
  'feeVoucher',
  'accountDeletionRequest',
  'schoolBackup',
  'messageDraft',
];

const PLURAL_FALLBACK: Record<string, string[]> = {
  class: ['classes'],
  school: ['schools'],
  user: ['users'],
  student: ['students'],
  attendanceDay: ['attendanceDays'],
  attendanceRecord: ['attendanceRecords'],
  teacherAttendance: ['teacherAttendances'],
  feeStructure: ['feeStructures'],
  feeRecord: ['feeRecords'],
  messageTemplate: ['messageTemplates'],
  messageQueue: ['messageQueues'],
  messageDelivery: ['messageDeliveries'],
  smsDevice: ['smsDevices'],
  holiday: ['holidays'],
  academicSession: ['academicSessions'],
  promotion: ['promotions'],
  leaveApplication: ['leaveApplications'],
  ocrUpload: ['ocrUploads'],
  auditLog: ['auditLogs'],
  notification: ['notifications'],
  rolePermission: ['rolePermissions'],
  approvalRequest: ['approvalRequests'],
  deletedRecord: ['deletedRecords'],
  changeLog: ['changeLogs'],
  exam: ['exams'],
  gradingScale: ['gradingScales'],
  resultSheet: ['resultSheets'],
  result: ['results'],
  timetableEntry: ['timetableEntries'],
  staff: ['staff'],
  staffClassAssignment: ['staffClassAssignments'],
  salaryRecord: ['salaryRecords'],
  expense: ['expenses'],
  announcement: ['announcements'],
  event: ['events'],
  certificate: ['certificates'],
  examDatesheet: ['examDatesheets'],
  feeVoucher: ['feeVouchers'],
  accountDeletionRequest: ['accountDeletionRequests'],
  schoolBackup: ['schoolBackups'],
  messageDraft: ['messageDrafts'],
};

function resolveDelegate(client: any, key: string): any {
  if (client[key]) return client[key];
  for (const alt of PLURAL_FALLBACK[key] ?? []) {
    if (client[alt]) return client[alt];
  }
  throw new Error(
    `Prisma model for "${key}" not found on the generated client ` +
      `(tried "${key}" and "${(PLURAL_FALLBACK[key] ?? []).join('", "')}"). ` +
      `Check backend/prisma/schema.prisma model names against contracts/SCHEMA.md.`,
  );
}

function wrapClient(client: any): Db {
  const db: Record<string, unknown> = {};
  for (const key of MODEL_KEYS) {
    db[key] = resolveDelegate(client, key);
  }
  db.$transaction = async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
    // Real Prisma supports the callback form; wrap the tx client the same way.
    return client.$transaction(async (tx: any) => fn(wrapClient(tx)));
  };
  db.$disconnect = async () => client.$disconnect();
  return db as unknown as Db;
}

let cached: Db | null = null;

/** Lazily load + wrap the generated Prisma client. Throws a clear error if not generated. */
export function getDb(): Db {
  if (cached) return cached;
  let PrismaClient: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    PrismaClient = loadModule('@prisma/client').PrismaClient;
  } catch {
    throw new Error(
      'Prisma client is not generated yet. Run `npx prisma generate` in backend/ ' +
        '(the Database Agent owns backend/prisma/schema.prisma).',
    );
  }
  try {
    cached = wrapClient(new PrismaClient());
  } catch (err) {
    throw new Error(
      `Failed to initialise Prisma client: ${(err as Error).message}. ` +
        `Run \`npx prisma generate\` in backend/ after the schema is in place.`,
    );
  }
  return cached;
}
