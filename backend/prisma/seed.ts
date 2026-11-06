// School Management Platform — seed script (CONTRACT v1.0)
// Seeds ONE demo tenant: "Demo Public School" (Asia/Karachi).
// Admin: demo@school.pk / Demo1234! (bcrypt, 12 rounds).
// Run:  DATABASE_URL="postgresql://..." npx tsx prisma/seed.ts
// (Prisma Client does not load .env by itself; export DATABASE_URL first,
// or run from backend/ with a .env file via `npx dotenv -e .env -- tsx ...`.)
// Idempotent: every row is upserted on its natural unique key (or a deterministic
// UUID for rows without one), so re-running the seed is safe.
//
// Phone handling (matches contracts/SCHEMA.md):
// - Numbers are normalized to E.164 (+92 + 10 digits) and stored encrypted
//   (AES-256-GCM, key from PHONE_ENC_KEY, 32 bytes base64) as base64(iv||tag||ct).
// - parent_phone_hash = SHA-256 hex of the normalized number (duplicate detection).
// - If PHONE_ENC_KEY is unset, a DEV-ONLY key is derived (never use in production).
//   The backend lib (src/lib/crypto.ts, Backend Agent) MUST use the same
//   base64(iv[12] || tag[16] || ciphertext) layout or seeded numbers won't decrypt.

import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Phone helpers
// ---------------------------------------------------------------------------

function normalizePkPhone(raw: string): string {
  const d = raw.replace(/[\s\-()]/g, '');
  let e164: string;
  if (d.startsWith('+92')) e164 = d;
  else if (d.startsWith('92')) e164 = '+' + d;
  else if (d.startsWith('0')) e164 = '+92' + d.slice(1);
  else throw new Error(`Invalid PK phone (expected 03XX / +92 / 92): ${raw}`);
  if (!/^\+92\d{10}$/.test(e164)) {
    throw new Error(`Invalid PK phone (must be +92 + 10 digits): ${raw} -> ${e164}`);
  }
  return e164;
}

function getEncKey(): Buffer {
  const b64 = process.env.PHONE_ENC_KEY;
  if (b64) {
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error('PHONE_ENC_KEY must be 32 bytes, base64-encoded');
    return key;
  }
  console.warn('[seed] WARNING: PHONE_ENC_KEY unset — using a DEV-ONLY key. Never in production.');
  return crypto.createHash('sha256').update('dev-only-phone-enc-key').digest();
}

function encryptPhone(e164: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncKey(), iv);
  const ct = Buffer.concat([cipher.update(e164, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function phoneHash(e164: string): string {
  return crypto.createHash('sha256').update(e164).digest('hex');
}

function phoneFields(raw: string | null): { enc: string | null; hash: string | null } {
  if (!raw) return { enc: null, hash: null };
  const e164 = normalizePkPhone(raw);
  return { enc: encryptPhone(e164), hash: phoneHash(e164) };
}

// Deterministic UUID (v4-shaped) so rows without a natural unique key can be upserted.
function deterministicUuid(seed: string): string {
  const hex = crypto.createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const SCHOOL_SLUG = 'demo-public-school';

type SeedStudent = {
  rollNo: number;
  name: string;
  nameUr: string;
  parentName: string;
  parentPhone: string | null;
  optOut?: boolean;
};

const CLASSES: { name: string; section: string; teacher: string; teacherPhone: string }[] = [
  { name: '1', section: 'A', teacher: 'Ayesha Khan', teacherPhone: '0300 1234567' },
  { name: '5', section: 'A', teacher: 'Bilal Ahmed', teacherPhone: '0321 7654321' },
  { name: '6', section: 'B', teacher: 'Sana Malik', teacherPhone: '0333 9876543' },
];

const STUDENTS: Record<string, SeedStudent[]> = {
  '1-A': [
    { rollNo: 1, name: 'Ahmed Raza', nameUr: 'احمد رضا', parentName: 'Muhammad Raza', parentPhone: '0300 1112233' },
    { rollNo: 2, name: 'Fatima Zahra', nameUr: 'فاطمہ زہرا', parentName: 'Ali Asghar', parentPhone: '0301 2223344' },
    { rollNo: 3, name: 'Hassan Ali', nameUr: 'حسن علی', parentName: 'Imran Ali', parentPhone: '0302 3334455' },
    { rollNo: 4, name: 'Ayesha Siddiqui', nameUr: 'عائشہ صدیقی', parentName: 'Ahmed Siddiqui', parentPhone: '0303 4445566' },
    { rollNo: 5, name: 'Bilal Hussain', nameUr: 'بلال حسین', parentName: 'Hussain Ahmed', parentPhone: '0304 5556677' },
    { rollNo: 6, name: 'Zainab Batool', nameUr: 'زینب بتول', parentName: 'Abbas Batool', parentPhone: '0305 6667788' },
    { rollNo: 7, name: 'Usman Ghani', nameUr: 'عثمان غنی', parentName: 'Abdul Ghani', parentPhone: '0306 7778899' },
    // No parent phone on purpose — exercises the "missing number" flag (Parents section).
    { rollNo: 8, name: 'Maryam Khan', nameUr: 'مریم خان', parentName: 'Sher Khan', parentPhone: null },
  ],
  '5-A': [
    { rollNo: 1, name: 'Ali Hamza', nameUr: 'علی حمزہ', parentName: 'Hamza Yousuf', parentPhone: '0321 1112233' },
    { rollNo: 2, name: 'Hira Fatima', nameUr: 'حرا فاطمہ', parentName: 'Abdul Qadir', parentPhone: '0322 2223344' },
    { rollNo: 3, name: 'Omar Farooq', nameUr: 'عمر فاروق', parentName: 'Farooq Ahmed', parentPhone: '0323 3334455' },
    { rollNo: 4, name: 'Noor Fatima', nameUr: 'نور فاطمہ', parentName: 'Muhammad Noor', parentPhone: '0324 4445566' },
    { rollNo: 5, name: 'Daniyal Ahmed', nameUr: 'دانیال احمد', parentName: 'Ahmed Raza', parentPhone: '0325 5556677' },
    // Opted out on purpose — absent + opt-out must NEVER be messaged (edge case).
    { rollNo: 6, name: 'Mahnoor Akhtar', nameUr: 'ماہ نور اختر', parentName: 'Akhtar Hussain', parentPhone: '0326 6667788', optOut: true },
    { rollNo: 7, name: 'Saad Iqbal', nameUr: 'سعد اقبال', parentName: 'Iqbal Hussain', parentPhone: '0327 7778899' },
    { rollNo: 8, name: 'Amna Tariq', nameUr: 'آمنہ طارق', parentName: 'Tariq Aziz', parentPhone: '0328 8889900' },
    { rollNo: 9, name: 'Rayyan Sheikh', nameUr: 'ریان شیخ', parentName: 'Sheikh Abdullah', parentPhone: '0329 9990011' },
  ],
  '6-B': [
    { rollNo: 1, name: 'Zoya Malik', nameUr: 'زویا ملک', parentName: 'Malik Aslam', parentPhone: '0333 1112233' },
    { rollNo: 2, name: 'Arham Khan', nameUr: 'ارحم خان', parentName: 'Khan Bahadur', parentPhone: '0334 2223344' },
    { rollNo: 3, name: 'Eman Shah', nameUr: 'ایمان شاہ', parentName: 'Shahid Mehmood', parentPhone: '0335 3334455' },
    { rollNo: 4, name: 'Ibrahim Khalid', nameUr: 'ابراہیم خالد', parentName: 'Khalid Mehmood', parentPhone: '0336 4445566' },
    { rollNo: 5, name: 'Alina Raza', nameUr: 'علینا رضا', parentName: 'Raza Hussain', parentPhone: '0337 5556677' },
    { rollNo: 6, name: 'Fahad Nadeem', nameUr: 'فہد ندیم', parentName: 'Nadeem Akhtar', parentPhone: '0338 6667788' },
    { rollNo: 7, name: 'Laiba Anwar', nameUr: 'لائبہ انور', parentName: 'Anwar Ali', parentPhone: '0339 7778899' },
    { rollNo: 8, name: 'Huzaifa Tariq', nameUr: 'حذیفہ طارق', parentName: 'Tariq Mehmood', parentPhone: '0340 8889900' },
  ],
};

const FEE_AMOUNT: Record<string, number> = { '1-A': 1500, '5-A': 2000, '6-B': 2500 };
const FEE_MONTH = '2026-11'; // seeded fee month
const ATTENDANCE_DATE = '2026-11-05'; // Thursday — one submitted day (class 5-A)

const TEMPLATES: { type: string; language: string; name: string; body: string }[] = [
  {
    type: 'absent',
    language: 'en',
    name: 'Absent Alert (EN)',
    body: 'Dear Parent, your child {student_name} (Class {class}) was marked ABSENT from school today ({date}). Please contact the school if needed. – {school_name}',
  },
  {
    type: 'absent',
    language: 'ur',
    name: 'Absent Alert (UR)',
    body: 'پیارے والدین، آپ کا بچہ {student_name} (کلاس {class}) آج ({date}) اسکول سے غیر حاضر تھا۔ ضرورت ہو تو اسکول سے رابطہ کریں۔ – {school_name}',
  },
  {
    type: 'fee_reminder',
    language: 'en',
    name: 'Fee Reminder (EN)',
    body: 'Dear Parent, the fee of {student_name} (Class {class}) for {month} is due. Amount: {amount}. Please pay at the earliest. – {school_name}',
  },
  {
    type: 'fee_reminder',
    language: 'ur',
    name: 'Fee Reminder (UR)',
    body: 'پیارے والدین، {student_name} (کلاس {class}) کی {month} کی فیس واجب الادا ہے۔ رقم: {amount}۔ براہ کرم جلد از جلد ادا کریں۔ – {school_name}',
  },
  {
    type: 'teacher_reminder',
    language: 'en',
    name: 'Teacher Reminder (EN)',
    body: 'Reminder: attendance for Class {class} has not been submitted today ({date}). Please submit it as soon as possible. – {school_name}',
  },
  {
    type: 'teacher_reminder',
    language: 'ur',
    name: 'Teacher Reminder (UR)',
    body: 'یاد دہانی: کلاس {class} کی حاضری آج ({date}) ابھی تک جمع نہیں ہوئی۔ براہ کرم جلد از جلد جمع کروائیں۔ – {school_name}',
  },
];

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const school = await prisma.school.upsert({
    where: { slug: SCHOOL_SLUG },
    update: {
      name: 'Demo Public School',
      timezone: 'Asia/Karachi',
      country: 'PK',
      settings: {
        teacher_reminder_time: '07:30',
        fee_auto_send: false,
        fee_require_approval: true,
        fee_followup_day: 10,
        sms_provider: 'sim',
        teacher_attendance_mode: 'admin',
      },
    },
    create: {
      name: 'Demo Public School',
      slug: SCHOOL_SLUG,
      timezone: 'Asia/Karachi',
      country: 'PK',
      settings: {
        teacher_reminder_time: '07:30',
        fee_auto_send: false,
        fee_require_approval: true,
        fee_followup_day: 10,
        sms_provider: 'sim',
        teacher_attendance_mode: 'admin',
      },
    },
  });
  console.log(`school: ${school.name} (${school.id})`);

  const passwordHash = await bcrypt.hash('Demo1234!', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'demo@school.pk' },
    update: { passwordHash, role: 'admin', emailVerified: true, schoolId: school.id },
    create: {
      schoolId: school.id,
      email: 'demo@school.pk',
      passwordHash,
      role: 'admin',
      emailVerified: true,
    },
  });
  console.log(`admin: ${admin.email} (${admin.id})`);

  // Classes + students
  const classIds: Record<string, string> = {};
  const studentIds: Record<string, string> = {};
  for (const c of CLASSES) {
    const cls = await prisma.class.upsert({
      where: { schoolId_name_section: { schoolId: school.id, name: c.name, section: c.section } },
      update: { teacherName: c.teacher },
      create: {
        schoolId: school.id,
        name: c.name,
        section: c.section,
        teacherName: c.teacher,
        ...(() => {
          const p = phoneFields(c.teacherPhone);
          return { teacherPhoneEnc: p.enc, teacherPhoneHash: p.hash };
        })(),
      },
    });
    // Keep teacher phone current on re-seed (phoneFields re-encrypts each run — fine).
    const tp = phoneFields(c.teacherPhone);
    await prisma.class.update({
      where: { id: cls.id },
      data: { teacherPhoneEnc: tp.enc, teacherPhoneHash: tp.hash },
    });
    const key = `${c.name}-${c.section}`;
    classIds[key] = cls.id;
    for (const s of STUDENTS[key]) {
      const p = phoneFields(s.parentPhone);
      const student = await prisma.student.upsert({
        where: { classId_rollNo: { classId: cls.id, rollNo: s.rollNo } },
        update: {
          name: s.name,
          nameUr: s.nameUr,
          parentName: s.parentName,
          parentPhoneEnc: p.enc,
          parentPhoneHash: p.hash,
          parentOptOut: s.optOut ?? false,
          status: 'active',
        },
        create: {
          schoolId: school.id,
          classId: cls.id,
          rollNo: s.rollNo,
          name: s.name,
          nameUr: s.nameUr,
          parentName: s.parentName,
          parentPhoneEnc: p.enc,
          parentPhoneHash: p.hash,
          parentOptOut: s.optOut ?? false,
          status: 'active',
        },
      });
      studentIds[`${key}:${s.rollNo}`] = student.id;
    }
    console.log(`class ${key}: ${STUDENTS[key].length} students`);
  }

  // Fee structures (one active row per class)
  for (const key of Object.keys(FEE_AMOUNT)) {
    await prisma.feeStructure.upsert({
      where: { id: deterministicUuid(`fee-structure:${key}`) },
      update: { monthlyAmount: FEE_AMOUNT[key], effectiveFrom: new Date('2026-01-01') },
      create: {
        id: deterministicUuid(`fee-structure:${key}`),
        schoolId: school.id,
        classId: classIds[key],
        monthlyAmount: FEE_AMOUNT[key],
        effectiveFrom: new Date('2026-01-01'),
      },
    });
  }
  console.log('fee structures: 1-A=1500, 5-A=2000, 6-B=2500 PKR/month');

  // Fee records for FEE_MONTH. NOTE: `status` is a DB-generated column — it is
  // deliberately NOT passed here; Postgres computes it from the amounts.
  const paidStudents: Record<string, { receiptNo: string; method: string }> = {
    '5-A:1': { receiptNo: `${SCHOOL_SLUG}-202611-001`, method: 'cash' },
    '6-B:1': { receiptNo: `${SCHOOL_SLUG}-202611-002`, method: 'cash' },
  };
  for (const key of Object.keys(STUDENTS)) {
    for (const s of STUDENTS[key]) {
      const paid = paidStudents[`${key}:${s.rollNo}`];
      const amountDue = FEE_AMOUNT[key];
      await prisma.feeRecord.upsert({
        where: { studentId_month: { studentId: studentIds[`${key}:${s.rollNo}`], month: FEE_MONTH } },
        update: {
          amountDue,
          amountPaid: paid ? amountDue : 0,
          discount: 0,
          paidAt: paid ? new Date('2026-11-03T10:00:00+05:00') : null,
          receiptNo: paid ? paid.receiptNo : null,
          paymentMethod: paid ? paid.method : null,
          markedBy: admin.id,
        },
        create: {
          schoolId: school.id,
          studentId: studentIds[`${key}:${s.rollNo}`],
          month: FEE_MONTH,
          amountDue,
          amountPaid: paid ? amountDue : 0,
          discount: 0,
          paidAt: paid ? new Date('2026-11-03T10:00:00+05:00') : null,
          receiptNo: paid ? paid.receiptNo : null,
          paymentMethod: paid ? paid.method : null,
          markedBy: admin.id,
        },
      });
    }
  }
  console.log(`fee records: month ${FEE_MONTH}, 25 students (2 paid, 23 unpaid)`);

  // One submitted attendance day: class 5-A on 2026-11-05 (teacher link).
  // Absent: Daniyal Ahmed (roll 5) and Mahnoor Akhtar (roll 6, opted out).
  const day5A = await prisma.attendanceDay.upsert({
    where: { classId_date: { classId: classIds['5-A'], date: new Date(ATTENDANCE_DATE) } },
    update: { submittedBy: 'teacher_link', submittedAt: new Date('2026-11-05T08:15:00+05:00') },
    create: {
      schoolId: school.id,
      classId: classIds['5-A'],
      date: new Date(ATTENDANCE_DATE),
      submittedBy: 'teacher_link',
      submittedAt: new Date('2026-11-05T08:15:00+05:00'),
    },
  });
  for (const s of STUDENTS['5-A']) {
    const status = s.rollNo === 5 || s.rollNo === 6 ? 'absent' : 'present';
    await prisma.attendanceRecord.upsert({
      where: { attendanceDayId_studentId: { attendanceDayId: day5A.id, studentId: studentIds[`5-A:${s.rollNo}`] } },
      update: { status, markedAt: new Date('2026-11-05T08:15:00+05:00'), updatedBy: 'teacher_link' },
      create: {
        attendanceDayId: day5A.id,
        studentId: studentIds[`5-A:${s.rollNo}`],
        status,
        markedAt: new Date('2026-11-05T08:15:00+05:00'),
        updatedBy: 'teacher_link',
      },
    });
  }
  console.log(`attendance: class 5-A on ${ATTENDANCE_DATE} — 7 present, 2 absent`);

  // Teacher attendance for the same day (1-A present, 5-A present, 6-B leave).
  const teacherStatus: Record<string, { status: string; note: string | null }> = {
    '1-A': { status: 'present', note: null },
    '5-A': { status: 'present', note: null },
    '6-B': { status: 'leave', note: 'Sana Malik on leave' },
  };
  for (const key of Object.keys(teacherStatus)) {
    await prisma.teacherAttendance.upsert({
      where: { classId_date: { classId: classIds[key], date: new Date(ATTENDANCE_DATE) } },
      update: { status: teacherStatus[key].status, note: teacherStatus[key].note, markedBy: admin.id },
      create: {
        schoolId: school.id,
        classId: classIds[key],
        date: new Date(ATTENDANCE_DATE),
        status: teacherStatus[key].status,
        note: teacherStatus[key].note,
        markedBy: admin.id,
      },
    });
  }

  // Message templates (EN + UR for all three types)
  for (const t of TEMPLATES) {
    await prisma.messageTemplate.upsert({
      where: { schoolId_type_language: { schoolId: school.id, type: t.type, language: t.language } },
      update: { body: t.body, name: t.name, isCustom: false, isActive: true },
      create: { schoolId: school.id, type: t.type, language: t.language, name: t.name, body: t.body, isCustom: false, isActive: true },
    });
  }
  console.log('templates: absent / fee_reminder / teacher_reminder x en+ur');

  // v2: default role permissions for the demo school (same matrix as the v2
  // migration SQL, which covers schools that already exist at deploy time;
  // the school does not exist yet when the migration runs on a fresh DB, so
  // the seed covers it here). Admin = everything; clerk = view
  // students/fees/results/attendance/reports + add students/fees/results
  // (approval-gated in the app layer) + mark fee paid (v1 behaviour);
  // principal = view-only, no settings/users.
  const ROLE_RESOURCES = ['students', 'fees', 'results', 'attendance', 'classes', 'messages', 'reports',
    'settings', 'users', 'staff', 'timetable', 'exams', 'announcements', 'expenses'];
  const ROLE_ACTIONS = ['view', 'create', 'update', 'delete', 'approve', 'export'];
  const ROLE_DEFAULTS: Record<string, [string, string][]> = {
    admin: ROLE_RESOURCES.flatMap((r) => ROLE_ACTIONS.map((a): [string, string] => [r, a])),
    clerk: [
      ...['students', 'fees', 'results', 'attendance', 'reports'].map((r): [string, string] => [r, 'view']),
      ['students', 'create'], ['fees', 'create'], ['results', 'create'], ['fees', 'update'],
    ],
    principal: ['students', 'fees', 'results', 'attendance', 'classes', 'messages', 'reports',
      'staff', 'timetable', 'exams', 'announcements', 'expenses'].map((r): [string, string] => [r, 'view']),
  };
  let permCount = 0;
  for (const [role, pairs] of Object.entries(ROLE_DEFAULTS)) {
    for (const [resource, action] of pairs) {
      await prisma.rolePermission.upsert({
        where: { schoolId_role_resource_action: { schoolId: school.id, role, resource, action } },
        update: { allowed: true },
        create: { schoolId: school.id, role, resource, action, allowed: true },
      });
      permCount++;
    }
  }
  console.log(`role permissions: ${permCount} rows (admin ${ROLE_DEFAULTS.admin.length}, clerk ${ROLE_DEFAULTS.clerk.length}, principal ${ROLE_DEFAULTS.principal.length})`);

  // Holiday + current academic session
  await prisma.holiday.upsert({
    where: { schoolId_date: { schoolId: school.id, date: new Date('2026-11-09') } },
    update: { name: 'Iqbal Day' },
    create: { schoolId: school.id, date: new Date('2026-11-09'), name: 'Iqbal Day' },
  });
  await prisma.academicSession.upsert({
    where: { id: deterministicUuid('session:2026-27') },
    update: { name: '2026-27', startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), isCurrent: true },
    create: {
      id: deterministicUuid('session:2026-27'),
      schoolId: school.id,
      name: '2026-27',
      startDate: new Date('2026-04-01'),
      endDate: new Date('2027-03-31'),
      isCurrent: true,
    },
  });

  console.log('seed complete.');
}

main()
  .catch((e) => {
    console.error('[seed] FAILED:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
