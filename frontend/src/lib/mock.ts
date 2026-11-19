// DEV-ONLY mock backend (VITE_MOCK_API=true). Default OFF — see lib/api.ts.
// Shapes mirror contracts/API.md. Data mirrors the seed school
// ("Demo Public School", Asia/Karachi): 3 classes, ~25 students.

import type {
  ClassItem,
  CollegeCourse,
  CollegeEnrollment,
  CollegeMark,
  CollegeProgram,
  CollegeSemester,
  DashboardData,
  FeeRow,
  MessageLogItem,
  MessageTemplate,
  PageResult,
  PendingGroup,
  Student,
} from './types';

const MOCK_PROGRAMS: CollegeProgram[] = [
  { id: 'prog-1', name: 'BS Computer Science', code: 'BSCS', department: 'Computer Science', duration_years: 4, semester_count: 2, student_count: 2 },
  { id: 'prog-2', name: 'BBA', code: 'BBA', department: 'Business', duration_years: 4, semester_count: 0, student_count: 0 },
];

const MOCK_SEMESTERS: CollegeSemester[] = [
  { id: 'sem-1', program_id: 'prog-1', number: 1, name: 'Semester 1', course_count: 2, student_count: 2 },
  { id: 'sem-2', program_id: 'prog-1', number: 2, name: 'Semester 2', course_count: 0, student_count: 0 },
];

const MOCK_COURSES: CollegeCourse[] = [
  { id: 'crs-1', semester_id: 'sem-1', code: 'CS101', title: 'Intro to Computing', credit_hours: 3, teacher_id: null, teacher_name: null },
  { id: 'crs-2', semester_id: 'sem-1', code: 'MTH101', title: 'Calculus I', credit_hours: 3, teacher_id: null, teacher_name: null },
];

const MOCK_ENROLLMENTS: CollegeEnrollment[] = [
  { id: 'enr-1', student_id: 'st-1', program_id: 'prog-1', program_name: 'BS Computer Science', semester_id: 'sem-1', semester_number: 1, semester_name: 'Semester 1' },
];

const MOCK_MARKS: CollegeMark[] = [
  { student_id: 'st-1', student_name: 'Ahmed Raza', roll_no: 1, course_id: 'crs-1', course_code: 'CS101', obtained_marks: 85, total_marks: 100, percentage: 85 },
  { student_id: 'st-1', student_name: 'Ahmed Raza', roll_no: 1, course_id: 'crs-2', course_code: 'MTH101', obtained_marks: 72, total_marks: 100, percentage: 72 },
];

const STUDENTS: Student[] = [
  { id: 'st-1', class_id: 'cl-1', class_name: '5-A', roll_no: 1, name: 'Ahmed Raza', name_ur: 'احمد رضا', parent_name: 'Muhammad Raza', parent_phone: '+92 3XX XXXX101', status: 'active', phone_flag: null },
  { id: 'st-2', class_id: 'cl-1', class_name: '5-A', roll_no: 2, name: 'Fatima Noor', name_ur: 'فاطمہ نور', parent_name: 'Abdul Noor', parent_phone: '+92 3XX XXXX102', status: 'active', phone_flag: null },
  { id: 'st-3', class_id: 'cl-1', class_name: '5-A', roll_no: 3, name: 'Bilal Ahmed', parent_name: 'Chaudhry Ahmed', parent_phone: '+92 3XX XXXX103', status: 'active', phone_flag: null },
  { id: 'st-4', class_id: 'cl-1', class_name: '5-A', roll_no: 4, name: 'Ayesha Khan', parent_name: 'Imran Khan', parent_phone: null, status: 'active', phone_flag: 'missing' },
  { id: 'st-5', class_id: 'cl-1', class_name: '5-A', roll_no: 5, name: 'Usman Ali', parent_name: 'Ali Nawaz', parent_phone: '0300-ABC', status: 'active', phone_flag: 'invalid' },
  { id: 'st-6', class_id: 'cl-1', class_name: '5-A', roll_no: 6, name: 'Maryam Siddiqui', parent_name: 'Hassan Siddiqui', parent_phone: '+92 3XX XXXX101', status: 'active', phone_flag: 'duplicate' },
  { id: 'st-7', class_id: 'cl-1', class_name: '5-A', roll_no: 7, name: 'Hassan Javed', parent_name: 'Javed Iqbal', parent_phone: '+92 3XX XXXX107', status: 'active', phone_flag: null },
  { id: 'st-8', class_id: 'cl-1', class_name: '5-A', roll_no: 8, name: 'Zainab Tariq', parent_name: 'Tariq Mehmood', parent_phone: '+92 3XX XXXX108', status: 'active', phone_flag: null },
  { id: 'st-9', class_id: 'cl-2', class_name: '6-B', roll_no: 1, name: 'Omar Farooq', parent_name: 'Farooq Azam', parent_phone: '+92 3XX XXXX201', status: 'active', phone_flag: null },
  { id: 'st-10', class_id: 'cl-2', class_name: '6-B', roll_no: 2, name: 'Hira Shahid', parent_name: 'Shahid Mehmood', parent_phone: '+92 3XX XXXX202', status: 'active', phone_flag: null },
  { id: 'st-11', class_id: 'cl-2', class_name: '6-B', roll_no: 3, name: 'Ali Hamza', parent_name: 'Hamza Yousuf', parent_phone: '+92 3XX XXXX203', status: 'active', phone_flag: null },
  { id: 'st-12', class_id: 'cl-2', class_name: '6-B', roll_no: 4, name: 'Sana Malik', parent_name: 'Malik Asif', parent_phone: '+92 3XX XXXX204', status: 'active', phone_flag: null },
  { id: 'st-13', class_id: 'cl-3', class_name: '1-A', roll_no: 1, name: 'Ibrahim Khalid', parent_name: 'Khalid Mehmood', parent_phone: '+92 3XX XXXX301', status: 'active', phone_flag: null },
  { id: 'st-14', class_id: 'cl-3', class_name: '1-A', roll_no: 2, name: 'Noor Fatima', parent_name: 'Muhammad Aslam', parent_phone: '+92 3XX XXXX302', status: 'active', phone_flag: null },
  { id: 'st-15', class_id: 'cl-3', class_name: '1-A', roll_no: 3, name: 'Danish Ali', parent_name: 'Ali Raza', parent_phone: null, status: 'active', phone_flag: 'missing' },
];

const CLASSES: ClassItem[] = [
  { id: 'cl-1', name: '5', section: 'A', teacher_name: 'Ms. Shazia Parveen', teacher_phone: '+92 3XX XXXX901', teacher_phone_masked: '+92 3XX XXXX901', student_count: 8, submitted_today: true, absent_today: 2, present_today: 6, attendance_link: 'http://localhost:5173/t/demo-token-5a', attendance_link_active: true, attendance_date: '2026-11-06', attendance_unlocked: false },
  { id: 'cl-2', name: '6', section: 'B', teacher_name: 'Mr. Naveed Akhtar', teacher_phone: '+92 3XX XXXX902', teacher_phone_masked: '+92 3XX XXXX902', student_count: 4, submitted_today: false, absent_today: 0, present_today: 0, attendance_link: 'http://localhost:5173/t/demo-token-6b', attendance_link_active: true, attendance_date: '2026-11-06', attendance_unlocked: false },
  { id: 'cl-3', name: '1', section: 'A', teacher_name: 'Ms. Rabia Anwar', teacher_phone: '+92 3XX XXXX903', teacher_phone_masked: '+92 3XX XXXX903', student_count: 3, submitted_today: true, absent_today: 0, present_today: 3, attendance_link: 'http://localhost:5173/t/demo-token-1a', attendance_link_active: true, attendance_date: '2026-11-06', attendance_unlocked: true },
];

const FEES: FeeRow[] = STUDENTS.map((s, i) => ({
  student_id: s.id,
  student_name: s.name,
  class_name: s.class_name ?? '',
  month: '2026-11',
  amount_due: 2500,
  amount_paid: i % 3 === 0 ? 2500 : i % 3 === 1 ? 1000 : 0,
  discount: 0,
  status: (i % 3 === 0 ? 'paid' : i % 3 === 1 ? 'partial' : 'unpaid') as FeeRow['status'],
  paid_at: i % 3 === 0 ? '2026-11-03T08:00:00Z' : null,
  receipt_no: i % 3 === 0 ? `demo-202611-${String(i + 1).padStart(3, '0')}` : null,
}));

const PENDING: PendingGroup[] = [
  {
    group_id: 'grp-1',
    class: '5-A',
    class_id: 'cl-1',
    date: '2026-11-06',
    absent_count: 2,
    messages: [
      { id: 'mq-1', student: 'Ahmed Raza', parent_phone_masked: '+92 3XX XXXX101', body: 'Dear Parent, your child Ahmed Raza (Class 5-A) was marked ABSENT from school today (06 Nov 2026). Please contact the school if needed. – Demo Public School', dedupe_key: 'absent:st-1:2026-11-06' },
      { id: 'mq-2', student: 'Bilal Ahmed', parent_phone_masked: '+92 3XX XXXX103', body: 'Dear Parent, your child Bilal Ahmed (Class 5-A) was marked ABSENT from school today (06 Nov 2026). Please contact the school if needed. – Demo Public School', dedupe_key: 'absent:st-3:2026-11-06' },
    ],
  },
];

const LOG: MessageLogItem[] = [
  { id: 'ml-1', type: 'absent', student_name: 'Zainab Tariq', parent_phone_masked: '+92 3XX XXXX108', body: 'Dear Parent, your child Zainab Tariq (Class 5-A) was marked ABSENT from school today (05 Nov 2026). Please contact the school if needed. – Demo Public School', status: 'sent', created_at: '2026-11-05T09:15:00Z', sent_at: '2026-11-05T09:15:40Z', dedupe_key: 'absent:st-8:2026-11-05' },
  { id: 'ml-2', type: 'fee_reminder', student_name: 'Ayesha Khan', parent_phone_masked: '+92 3XX XXXX104', body: 'Dear Parent, the fee of Ayesha Khan (Class 5-A) for November 2026 is due. Amount: Rs 2,500. Please pay at the earliest. – Demo Public School', status: 'failed', created_at: '2026-11-01T08:00:00Z', error: 'SIM unreachable', dedupe_key: 'fee:st-4:2026-11' },
];

const TEMPLATES: MessageTemplate[] = [
  { id: 'tm-1', type: 'absent', language: 'en', body: 'Dear Parent, your child {student_name} (Class {class}) was marked ABSENT from school today ({date}). Please contact the school if needed. – {school_name}', is_active: true },
  { id: 'tm-2', type: 'absent', language: 'ur', body: 'محترم والدین، آپ کا بچہ {student_name} (کلاس {class}) آج ({date}) اسکول سے غیر حاضر تھا۔ براہ کرم اسکول سے رابطہ کریں۔ – {school_name}', is_active: true },
  { id: 'tm-3', type: 'fee_reminder', language: 'en', body: 'Dear Parent, the fee of {student_name} (Class {class}) for {month} is due. Amount: {amount}. Please pay at the earliest. – {school_name}', is_active: true },
  { id: 'tm-4', type: 'fee_reminder', language: 'ur', body: 'محترم والدین، {student_name} (کلاس {class}) کی {month} کی فیس واجب الادا ہے۔ رقم: {amount}۔ براہ کرم جلد ادا کریں۔ – {school_name}', is_active: true },
  { id: 'tm-5', type: 'teacher_reminder', language: 'en', body: 'Reminder: attendance for Class {class} has not been submitted yet today ({date}). Please submit it at the earliest. – {school_name}', is_active: true },
  { id: 'tm-6', type: 'teacher_reminder', language: 'ur', body: 'یاد دہانی: کلاس {class} کی حاضری آج ({date}) ابھی تک جمع نہیں ہوئی۔ براہ کرم جلد جمع کروائیں۔ – {school_name}', is_active: true },
];

function page<T>(items: T[]): PageResult<T> {
  return { items, total: items.length, page: 1, pages: 1 };
}

const delay = (ms = 250) => new Promise((r) => setTimeout(r, ms));

export async function mockRequest<T>(path: string, method: string, body?: unknown): Promise<T> {
  await delay();
  const [rawPath] = path.split('?');
  const seg = rawPath.split('/').filter(Boolean);

  // Auth — LOCAL MOCK ONLY (VITE_MOCK_API=true, no backend). These are
  // fake mock credentials, not a live account. Never use real/demo creds here.
  if (rawPath === '/auth/login' && method === 'POST') {
    const b = body as { email: string; password: string };
    if (b.email === 'admin@mock.local' && b.password === 'Mock1234!') {
      return { access: 'mock-access', refresh: 'mock-refresh', user: { id: 'u-1', email: b.email, role: 'admin', school_id: 'sch-1', school_name: 'Demo Public School' } } as T;
    }
    throw Object.assign(new Error('Invalid email or password'), { status: 401, code: 'UNAUTHORIZED' });
  }
  if (rawPath === '/auth/signup' && method === 'POST') {
    // Phase 1: signup issues NO tokens — the user is not logged in
    // until their email is verified.
    return {
      user: { id: 'u-1', email: (body as { email: string }).email, role: 'admin', school_id: 'sch-1', school_name: (body as { school_name: string }).school_name, email_verified: false },
      school: { id: 'sch-1', name: (body as { school_name: string }).school_name },
      email_verification: { status: 'sent' },
    } as T;
  }
  if (rawPath === '/auth/resend-verification' && method === 'POST') {
    return { sent: true, message: 'Verification link sent.' } as T;
  }
  if (rawPath === '/auth/me') {
    return { user: { id: 'u-1', email: 'admin@mock.local', role: 'admin', school_id: 'sch-1', school_name: 'Demo Public School', email_verified: true, email_verification_status: 'sent' } } as T;
  }
  if (rawPath === '/auth/refresh' && method === 'POST') {
    return { access: 'mock-access', refresh: 'mock-refresh' } as T;
  }
  if (['/auth/logout', '/auth/verify-email', '/auth/forgot-password', '/auth/reset-password'].includes(rawPath)) {
    return { ok: true } as T;
  }

  // Dashboard
  if (rawPath === '/dashboard') {
    const d: DashboardData = {
      classes_submitted: 2,
      classes_pending: 1,
      present: 9,
      absent: 2,
      teachers_present: 2,
      teachers_absent: 1,
      fee_collected_this_month: 17500,
      fee_pending_this_month: 20000,
      recent_notifications: [
        { id: 'n-1', type: 'absent', title: '2 students absent in Class 5-A', body: 'Approve & send messages to their parents.', is_read: false, created_at: '2026-11-06T09:05:00Z' },
        { id: 'n-2', type: 'attendance_pending', title: 'Class 6-B has not submitted attendance', body: 'Reminder will be sent at the set time.', is_read: false, created_at: '2026-11-06T08:00:00Z' },
        { id: 'n-3', type: 'sim_offline', title: 'SIM device offline', body: 'No Android device seen in the last 10 minutes.', is_read: true, created_at: '2026-11-05T18:40:00Z' },
      ],
    };
    return d as T;
  }

  // Classes
  if (rawPath === '/classes' && method === 'GET') return page(CLASSES) as T;
  if (rawPath === '/classes' && method === 'POST') {
    const b = body as { name: string; section: string; teacher_name: string; teacher_phone?: string };
    return { id: `cl-${Date.now()}`, name: b.name, section: b.section, teacher_name: b.teacher_name, teacher_phone: b.teacher_phone ?? null, student_count: 0, submitted_today: false, absent_today: 0, present_today: 0 } as T;
  }
  if (seg[0] === 'classes' && seg.length === 2 && method === 'GET') {
    return (CLASSES.find((c) => c.id === seg[1]) ?? CLASSES[0]) as T;
  }
  if (seg[0] === 'classes' && seg[2] === 'attendance-link' && method === 'POST') {
    return { link: `http://localhost:5173/t/mock-${seg[1]}` } as T;
  }
  if (seg[0] === 'classes' && seg[2] === 'attendance' && seg[3] === 'unlock' && method === 'PATCH') {
    return { id: `day-mock-${seg[1]}`, unlocked: true } as T;
  }

  // Students
  if (seg[0] === 'classes' && seg[2] === 'students' && method === 'GET') {
    return page(STUDENTS.filter((s) => s.class_id === seg[1])) as T;
  }
  if (seg[0] === 'classes' && seg[2] === 'students' && method === 'POST') {
    const b = body as Partial<Student>;
    return { id: `st-${Date.now()}`, class_id: seg[1], roll_no: b.roll_no ?? null, name: b.name ?? 'New Student', parent_name: b.parent_name ?? null, parent_phone: b.parent_phone ?? null, status: 'active', phone_flag: null } as T;
  }
  if (seg[0] === 'classes' && seg[2] === 'ocr-upload' && method === 'POST') {
    // Async flow: 202 immediately, the review page polls GET /ocr-uploads/:id.
    return { upload_id: 'ocr-1', status: 'processing' } as T;
  }
  if (seg[0] === 'ocr-uploads' && method === 'GET') {
    return {
      upload_id: 'ocr-1',
      status: 'review',
      raw_text: '1 Ahmed Raza 03001234567\n2 Fatima Noor 03007654321',
      rows: STUDENTS.slice(0, 3).map((s) => ({
        name: s.name,
        name_ur: s.name_ur,
        roll_no: s.roll_no,
        parent_name: s.parent_name,
        parent_name_ur: s.parent_name === 'Muhammad Raza' ? 'محمد رضا' : s.parent_name === 'Abdul Noor' ? 'عبد النور' : null,
        parent_phone: s.parent_phone ?? undefined,
        confidence: 0.93,
        duplicate: false,
      })),
      warnings: [],
    } as T;
  }
  if (seg[0] === 'classes' && seg[3] === 'confirm' && method === 'POST') {
    return { saved: (body as { rows: unknown[] }).rows.length, skipped_duplicates: 0 } as T;
  }
  if (seg[0] === 'classes' && seg[2] === 'students' && seg[3] === 'import-csv') {
    return { imported: 5, duplicates_flagged: 1, invalid_rows: 0 } as T;
  }
  if (seg[0] === 'students' && method === 'PATCH') return { id: seg[1], ...(body as object) } as T;
  if (seg[0] === 'students' && method === 'DELETE') return { ok: true } as T;

  // Parents
  if (rawPath === '/parents' && method === 'GET') {
    return page(STUDENTS.filter((s) => s.phone_flag)) as T;
  }

  // Teacher link (public)
  if (seg[0] === 't' && method === 'GET') {
    const token = seg[1] ?? '';
    const cls = token.includes('6b') ? CLASSES[1] : token.includes('1a') ? CLASSES[2] : CLASSES[0];
    return {
      class: { id: cls.id, name: cls.name, section: cls.section },
      date: '2026-11-06',
      students: STUDENTS.filter((s) => s.class_id === cls.id).map((s) => ({ id: s.id, name: s.name, roll_no: s.roll_no })),
      already_submitted: token.includes('done'),
    } as T;
  }
  if (seg[0] === 't' && seg[2] === 'submit' && method === 'POST') {
    return { ok: true, submitted: (body as { records: unknown[] }).records.length } as T;
  }

  // Teacher attendance
  if (rawPath === '/teacher-attendance' && method === 'GET') {
    return page([
      { id: 'ta-1', class_id: 'cl-1', class_name: '5-A', teacher_name: 'Ms. Shazia Parveen', date: '2026-11-06', status: 'present' },
      { id: 'ta-2', class_id: 'cl-2', class_name: '6-B', teacher_name: 'Mr. Naveed Akhtar', date: '2026-11-06', status: 'absent' },
      { id: 'ta-3', class_id: 'cl-3', class_name: '1-A', teacher_name: 'Ms. Rabia Anwar', date: '2026-11-06', status: 'present' },
    ]) as T;
  }
  if (rawPath === '/teacher-attendance' && method === 'POST') return { ok: true } as T;

  // Fees
  if (rawPath.startsWith('/fees') && method === 'GET' && !rawPath.includes('structures') && !rawPath.includes('receipts')) {
    return page(FEES) as T;
  }
  if (rawPath === '/fees/structures' && method === 'GET') {
    return page(CLASSES.map((c) => ({ id: `fs-${c.id}`, class_id: c.id, class_name: `${c.name}-${c.section}`, monthly_amount: 2500, effective_from: '2026-09-01' }))) as T;
  }
  if (rawPath === '/fees/structures' && method === 'POST') return { ok: true } as T;
  if (seg[0] === 'fees' && seg[2] === 'pay' && method === 'POST') {
    return { receipt_no: `demo-202611-${String(Math.floor(Math.random() * 900) + 100)}`, receipt_url: '/fees/receipts/demo' } as T;
  }
  if (seg[0] === 'fees' && seg[1] === 'receipts') {
    return { receipt_no: seg[2], school_name: 'Demo Public School', student_name: 'Ahmed Raza', class_name: '5-A', month: '2026-11', amount_due: 2500, amount_paid: 2500, discount: 0, payment_method: 'Cash', paid_at: '2026-11-03T08:00:00Z' } as T;
  }

  // Messages
  if (rawPath === '/messages/pending-approval') return { groups: PENDING } as T;
  if (rawPath === '/messages/log' && method === 'GET') return page(LOG) as T;
  if (rawPath === '/messages/templates' && method === 'GET') return { templates: TEMPLATES } as T;
  if (rawPath === '/messages/approve' && method === 'POST') return { approved: 2, queued: 2 } as T;
  if (seg[0] === 'messages' && seg[1] === 'queue' && seg[3] === 'retry') return { ok: true } as T;
  if (seg[0] === 'messages' && seg[1] === 'queue' && method === 'PATCH') return { ok: true } as T;
  if (seg[0] === 'messages' && seg[1] === 'templates' && method === 'PATCH') return { ok: true } as T;
  // Section 11 (Custom Messages) — minimal mock so the page renders in mock mode.
  if (rawPath === '/messages/templates' && method === 'POST') return { template: { id: 'tm-new', type: 'custom', language: 'en', body: '', isActive: true, name: 'New', isCustom: true } } as T;
  if (seg[0] === 'messages' && seg[1] === 'templates' && seg[3] === 'duplicate') return { template: { id: 'tm-copy', type: 'custom', language: 'en', body: '', isActive: true, name: 'Copy', isCustom: true } } as T;
  if (seg[0] === 'messages' && seg[1] === 'templates' && method === 'DELETE') return { deleted: seg[2] } as T;
  if (rawPath === '/messages/drafts' && method === 'GET') return page([]) as T;
  if (rawPath === '/messages/drafts' && method === 'POST') return { draft: { id: 'd-1', recipientType: 'all_parents', targetClassId: null, targetStudentIds: [], body: '', status: 'draft', scheduledFor: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } as T;
  if (seg[0] === 'messages' && seg[1] === 'drafts' && method === 'PATCH') return { draft: { id: seg[2], status: 'draft' } } as T;
  if (seg[0] === 'messages' && seg[1] === 'drafts' && method === 'DELETE') return { deleted: seg[2] } as T;
  if (seg[0] === 'messages' && seg[1] === 'drafts' && seg[3] === 'cancel') return { draft: { id: seg[2], status: 'cancelled' } } as T;
  if (seg[0] === 'messages' && seg[1] === 'drafts' && seg[3] === 'submit-for-approval') return { approval_request_id: 'ap-1', status: 'pending' } as T;
  if (seg[0] === 'messages' && seg[1] === 'drafts' && seg[3] === 'approve-send') return { queued: 2, skipped: [], skippedOptedOut: 0 } as T;
  if (seg[0] === 'messages' && seg[1] === 'drafts' && seg[3] === 'reject') return { draft: { id: seg[2], status: 'cancelled' } } as T;
  if (rawPath === '/messages/preview' && method === 'POST') {
    return {
      samples: [{ studentId: 'st-1', studentName: 'Ahmed Raza', parentPhoneMasked: '+92 3XX XXXX101', body: 'Mock preview message.', charCount: 22, smsParts: 1, isUnicode: false }],
      recipientCount: 1, skippedCount: 0, skipped: [], charCount: 22, smsParts: 1, isUnicode: false, variablesUsed: [],
    } as T;
  }
  if (rawPath === '/messages/recipients' && method === 'GET') {
    return {
      recipients: STUDENTS.map((s) => ({ studentId: s.id, studentName: s.name, fatherName: s.parent_name, className: s.class_name?.split('-')[0] ?? '', section: s.class_name?.split('-')[1] ?? '', parentPhoneMasked: s.parent_phone, parentOptOut: false, amountDue: null })),
      total: STUDENTS.length, optedOutCount: 0,
    } as T;
  }

  // SMS status / devices / jobs
  if (rawPath === '/sms/status') {
    return { provider: 'sim', sim_connected: false, last_seen_at: '2026-11-05T18:40:00Z', queued_count: 2 } as T;
  }
  if (rawPath === '/jobs/status') {
    // Round 5 (F12): the real API shape is {jobs: [...]} with all six
    // jobs (see lib/types.ts JobStatus) — the old flat mock hid the
    // mismatch that left the Jobs tab showing "Last run: —" for 3 rows.
    const job = (name: string, description: string, schedule: string, last_run_at: string | null) => ({
      name,
      description,
      schedule,
      schools: [{ school_id: 'mock', school_slug: 'mock', last_run_at, last_status: last_run_at ? 'ok' : 'never', last_summary: '', last_error: null, runs: last_run_at ? 1 : 0 }],
    });
    return {
      jobs: [
        job('monthly_fee_reminder', '1st school day of the month: roll over fee records, queue fee reminders for unpaid students.', '*/30 * * * *', '2026-11-01T00:05:00Z'),
        job('fee_followup', 'On the fee follow-up day: remind parents whose fees are still unpaid.', '*/30 * * * *', null),
        job('daily_pending_attendance', 'After school hours: notify admin about classes with no attendance submission today.', '*/30 * * * *', '2026-11-06T08:00:00Z'),
        job('teacher_reminders', 'At the set reminder time: queue a teacher-reminder SMS for each class that has not submitted attendance.', '*/5 * * * *', '2026-11-06T08:00:00Z'),
        job('scheduled_messages', 'Every 5 minutes: send due scheduled custom-message drafts that were approved first.', '*/5 * * * *', null),
        job('school_backup', 'Nightly (02:00 UTC): per-school full data backup.', '0 2 * * *', null),
      ],
    } as T;
  }

  // Settings
  if (rawPath === '/settings' && method === 'GET') {
    // Mock school is a College so College Mode can be exercised in mock
    // mode (VITE_MOCK_API=true) without a backend.
    return { teacher_reminder_time: '08:30', fee_auto_send: false, fee_require_approval: true, fee_followup_day: 10, sms_provider: 'sim', teacher_attendance_mode: 'link', org_type: 'College', school_name: 'Demo College' } as T;
  }
  if (rawPath === '/settings' && method === 'PATCH') return { ok: true } as T;

  // College Mode (mock — mirrors the /college contract exactly).
  if (rawPath === '/college/programs' && method === 'GET') {
    return { programs: MOCK_PROGRAMS } as T;
  }
  if (rawPath === '/college/programs' && method === 'POST') {
    const b = body as { name: string; code: string; department: string; duration_years: number };
    const p = { id: `prog-${Date.now()}`, name: b.name, code: b.code, department: b.department, duration_years: b.duration_years, semester_count: 0, student_count: 0 };
    MOCK_PROGRAMS.push(p);
    return { program: p } as T;
  }
  if (seg[0] === 'college' && seg[1] === 'programs' && seg.length === 3 && method === 'GET') {
    const p = MOCK_PROGRAMS.find((x) => x.id === seg[2]) ?? MOCK_PROGRAMS[0];
    return { program: p, semesters: MOCK_SEMESTERS.filter((s) => s.program_id === p.id) } as T;
  }
  if (seg[0] === 'college' && seg[1] === 'programs' && seg.length === 3 && method === 'PATCH') {
    const p = MOCK_PROGRAMS.find((x) => x.id === seg[2]);
    if (p) Object.assign(p, body as object);
    return { program: p } as T;
  }
  if (seg[0] === 'college' && seg[1] === 'programs' && seg.length === 3 && method === 'DELETE') {
    const p = MOCK_PROGRAMS.find((x) => x.id === seg[2]);
    if (p && (p.semester_count > 0 || p.student_count > 0)) {
      throw Object.assign(new Error('Cannot delete a program that has semesters or enrollments'), { status: 409, code: 'CONFLICT' });
    }
    return { ok: true } as T;
  }
  if (seg[0] === 'college' && seg[1] === 'programs' && seg[3] === 'semesters' && method === 'GET') {
    return { semesters: MOCK_SEMESTERS.filter((s) => s.program_id === seg[2]) } as T;
  }
  if (seg[0] === 'college' && seg[1] === 'programs' && seg[3] === 'semesters' && method === 'POST') {
    const b = body as { number: number; name?: string };
    const s = { id: `sem-${Date.now()}`, program_id: seg[2], number: b.number, name: b.name ?? `Semester ${b.number}`, course_count: 0, student_count: 0 };
    MOCK_SEMESTERS.push(s);
    return { semester: s } as T;
  }
  if (seg[0] === 'college' && seg[1] === 'semesters' && seg.length === 3 && method === 'DELETE') {
    const s = MOCK_SEMESTERS.find((x) => x.id === seg[2]);
    if (s && s.course_count > 0) {
      throw Object.assign(new Error('Cannot delete a semester that has courses or enrollments'), { status: 409, code: 'CONFLICT' });
    }
    return { ok: true } as T;
  }
  if (seg[0] === 'college' && seg[1] === 'semesters' && seg[3] === 'courses' && method === 'GET') {
    return { courses: MOCK_COURSES.filter((c) => c.semester_id === seg[2]) } as T;
  }
  if (seg[0] === 'college' && seg[1] === 'semesters' && seg[3] === 'courses' && method === 'POST') {
    const b = body as { code: string; title: string; credit_hours: number; teacher_id?: string };
    const c = { id: `crs-${Date.now()}`, semester_id: seg[2], code: b.code, title: b.title, credit_hours: b.credit_hours, teacher_id: b.teacher_id ?? null, teacher_name: b.teacher_id ? 'Ms. Shazia Parveen' : null };
    MOCK_COURSES.push(c);
    return { course: c } as T;
  }
  if (seg[0] === 'college' && seg[1] === 'courses' && seg.length === 3 && method === 'PATCH') {
    const c = MOCK_COURSES.find((x) => x.id === seg[2]);
    if (c) Object.assign(c, body as object);
    return { course: c } as T;
  }
  if (seg[0] === 'college' && seg[1] === 'courses' && seg.length === 3 && method === 'DELETE') {
    return { ok: true } as T;
  }
  if (rawPath === '/college/enrollments' && method === 'POST') {
    const b = body as { student_id: string; program_id: string; semester_id: string };
    const sem = MOCK_SEMESTERS.find((s) => s.id === b.semester_id);
    const prog = MOCK_PROGRAMS.find((p) => p.id === b.program_id);
    return { enrollment: { id: `enr-${Date.now()}`, student_id: b.student_id, program_id: b.program_id, program_name: prog?.name ?? '', semester_id: b.semester_id, semester_number: sem?.number ?? 0, semester_name: sem?.name ?? '' } } as T;
  }
  if (seg[0] === 'college' && seg[1] === 'enrollments' && seg.length === 3 && method === 'DELETE') {
    return { ok: true } as T;
  }
  if (seg[0] === 'college' && seg[1] === 'students' && seg[3] === 'enrollments' && method === 'GET') {
    return { enrollments: MOCK_ENROLLMENTS.filter((e) => e.student_id === seg[2]) } as T;
  }
  if (rawPath === '/college/marks' && method === 'POST') return { ok: true } as T;
  if (seg[0] === 'college' && seg[1] === 'semesters' && seg[3] === 'marks' && method === 'GET') {
    return { marks: MOCK_MARKS.filter((m) => MOCK_COURSES.some((c) => c.id === m.course_id && c.semester_id === seg[2])) } as T;
  }
  if (seg[0] === 'college' && seg[1] === 'students' && seg[3] === 'gpa' && method === 'GET') {
    return {
      student_id: seg[2],
      semester: { id: 'sem-1', number: 1, name: 'Semester 1', gpa: 3.5, total_credit_hours: 15 },
      cgpa: 3.5,
      total_credit_hours_all: 15,
      courses: [
        { course_id: 'crs-1', course_code: 'CS101', course_title: 'Intro to Computing', credit_hours: 3, obtained_marks: 85, total_marks: 100, percentage: 85, grade: 'A', grade_points: 4.0 },
        { course_id: 'crs-2', course_code: 'MTH101', course_title: 'Calculus I', credit_hours: 3, obtained_marks: 72, total_marks: 100, percentage: 72, grade: 'B', grade_points: 3.0 },
      ],
    } as T;
  }
  if (seg[0] === 'college' && seg[1] === 'programs' && seg[3] === 'toppers' && method === 'GET') {
    return { toppers: [{ student_id: 'st-1', student_name: 'Ahmed Raza', roll_no: 1, semester_gpa: 3.8, cgpa: 3.7 }] } as T;
  }

  // Reports
  if (rawPath.startsWith('/reports/attendance/daily')) {
    return page(CLASSES.map((c) => ({ class: `${c.name}-${c.section}`, present: c.present_today ?? 0, absent: c.absent_today ?? 0, total: c.student_count ?? 0 }))) as T;
  }
  if (rawPath.startsWith('/reports/attendance/weekly') || rawPath.startsWith('/reports/attendance/monthly')) {
    return page(STUDENTS.slice(0, 8).map((s) => ({ student: s.name, class: s.class_name ?? '', present: 18, absent: 2, total: 20 }))) as T;
  }
  if (rawPath.startsWith('/reports/fees/monthly')) {
    return { collected: 17500, pending: 20000, by_class: CLASSES.map((c) => ({ class: `${c.name}-${c.section}`, collected: 5000, pending: 7500 })) } as T;
  }

  // Sessions / holidays / audit / notifications / users / promotions
  if (rawPath === '/sessions' && method === 'GET') {
    return page([{ id: 'ss-1', name: '2026-27', start_date: '2026-04-01', end_date: '2027-03-31', is_current: true }]) as T;
  }
  if (rawPath === '/sessions' && method === 'POST') return { ok: true } as T;
  if (rawPath === '/holidays' && method === 'GET') {
    return page([{ id: 'h-1', date: '2026-11-09', name: 'Iqbal Day' }]) as T;
  }
  if (rawPath === '/holidays' && method === 'POST') return { ok: true } as T;
  if (rawPath === '/audit-logs' && method === 'GET') {
    return page([
      { id: 'a-1', actor_type: 'teacher_link', action: 'attendance.submit', entity: 'attendance_day', entity_id: 'ad-1', details: { class: '5-A', present: 6, absent: 2 }, created_at: '2026-11-06T09:00:00Z' },
      { id: 'a-2', actor_type: 'user', action: 'fee.pay', entity: 'fee_record', entity_id: 'fr-1', details: { student: 'Ahmed Raza', amount: 2500 }, created_at: '2026-11-03T08:00:00Z' },
    ]) as T;
  }
  if (rawPath === '/notifications' && method === 'GET') {
    return page([
      { id: 'n-1', type: 'absent', title: '2 students absent in Class 5-A', body: 'Approve & send messages to their parents.', is_read: false, created_at: '2026-11-06T09:05:00Z' },
    ]) as T;
  }
  if (rawPath === '/users' && method === 'GET') {
    return page([{ id: 'u-1', email: 'admin@mock.local', role: 'admin' }, { id: 'u-2', email: 'clerk@school.pk', role: 'clerk' }]) as T;
  }
  if (rawPath === '/users/clerks' && method === 'POST') return { ok: true } as T;
  if (rawPath === '/users/principals' && method === 'POST') return { ok: true } as T;
  // D2: approval queue (mock: one pending student-create example).
  if (rawPath === '/approvals' && method === 'GET') {
    return page([
      { id: 'ap-1', school_id: 's-1', requested_by: 'u-2', action_type: 'create', entity: 'student', entity_id: null, payload: { name: 'Mock Student', class_id: 'c-1' }, status: 'pending', decided_by: null, decided_at: null, created_at: '2026-11-07T02:00:00Z' },
    ]) as T;
  }
  if (rawPath === '/approvals/ap-1/approve' && method === 'POST') {
    return { id: 'ap-1', status: 'approved', applied: { student_id: 'st-mock-1' } } as T;
  }
  if (rawPath === '/approvals/ap-1/reject' && method === 'POST') {
    return { id: 'ap-1', status: 'rejected' } as T;
  }
  if (rawPath === '/promotions' && method === 'POST') return { ok: true } as T;

  // Fallback: unknown mock route
  throw Object.assign(new Error(`Mock route not implemented: ${method} ${rawPath}`), { status: 501, code: 'MOCK_MISSING' });
}
