// Shared types — mirror contracts/API.md + contracts/SCHEMA.md (CONTRACT v1.0)

export type Role = 'admin' | 'clerk' | 'principal';
export type AttendanceStatus = 'present' | 'absent' | 'late' | 'leave';
export type TeacherStatus = 'present' | 'absent' | 'leave';
export type FeeStatus = 'unpaid' | 'partial' | 'paid';
export type MessageStatus = 'queued' | 'sent' | 'failed' | 'cancelled';
export type MessageType = 'absent' | 'fee_reminder' | 'teacher_reminder' | 'result' | 'announcement' | 'custom';
export type PhoneFlag = 'missing' | 'invalid' | 'duplicate' | null;

export interface User {
  id: string;
  email: string;
  role: Role;
  school_id: string;
  school_name?: string;
  /** R2-C: whether the admin's email is verified (from GET /auth/me and
   * the signup/login responses). Undefined for older/mock payloads that
   * do not carry it — treated as "unknown", never as unverified. */
  email_verified?: boolean;
  /** 6D: whether TOTP 2FA is enabled (from GET /auth/me). */
  totp_enabled?: boolean;
}

export interface SchoolSettings {
  teacher_reminder_time: string; // "HH:MM"
  fee_auto_send: boolean;
  fee_require_approval: boolean;
  fee_followup_day: number | null;
  sms_provider: 'sim' | 'gateway';
  teacher_attendance_mode: 'admin' | 'link';
  /** 6D: idle/session timeout in minutes (default 120, min 15, max 1440). */
  session_timeout_minutes: number;
  // 6C-2: school identity + display language (see admin service).
  school_name?: string;
  timezone?: string;
  school_address?: string;
  school_phone?: string;
  logo_url?: string;
  language?: 'en' | 'ur';
}

export interface DashboardData {
  classes_submitted: number;
  classes_pending: number;
  present: number;
  absent: number;
  teachers_present: number;
  teachers_absent: number;
  fee_collected_this_month: number;
  fee_pending_this_month: number;
  recent_notifications: NotificationItem[];
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  related_type?: string | null;
  related_id?: string | null;
  is_read: boolean;
  created_at: string;
}

export interface ClassItem {
  id: string;
  name: string;
  section: string;
  teacher_name: string;
  teacher_phone?: string | null;
  /** Masked teacher phone (+92 3XX XXXX123) — what the edit form pre-fills from. */
  teacher_phone_masked?: string | null;
  student_count?: number;
  submitted_today?: boolean;
  absent_today?: number;
  present_today?: number;
  attendance_link?: string | null;
  /** True when a valid (unrevoked, unexpired) link exists — even for links
   * created before the encrypted-token column, whose URL is unrecoverable. */
  attendance_link_active?: boolean;
  token_expires_at?: string | null;
  /** School-local date the submitted_* counts refer to (for the unlock call). */
  attendance_date?: string | null;
  /** True when today's submission was unlocked by an admin (re-submit open). */
  attendance_unlocked?: boolean;
  display_name?: string;
}

export interface Student {
  id: string;
  class_id: string;
  class_name?: string;
  roll_no: number | null;
  name: string;
  name_ur?: string | null;
  parent_name?: string | null;
  parent_phone?: string | null; // masked in responses
  parent_phone_masked?: string | null;
  parent_has_phone?: boolean;
  parent_opt_out?: boolean;
  status: 'active' | 'left' | 'struck_off' | 'graduated';
  phone_flag?: PhoneFlag;
  // 6B extended profile (contracts/SCHEMA.md §1)
  father_name?: string | null;
  admission_no?: string | null;
  date_of_birth?: string | null;
  gender?: 'male' | 'female' | 'other' | null;
  address?: string | null;
  admission_date?: string | null;
  parent2_name?: string | null;
  parent2_phone_masked?: string | null;
  parent2_opt_out?: boolean;
  id_card_issued_at?: string | null;
}

export interface ResultRow {
  id: string;
  exam_id: string;
  class_id: string;
  student_id?: string | null;
  roll_no: number;
  student_name: string;
  father_name?: string | null;
  subject_marks: Record<string, number>;
  obtained_marks?: number | null;
  total_marks?: number | null;
  percentage?: number | null;
  grade?: string | null;
  position?: number | null;
  remarks?: string | null;
  linked: boolean;
  linked_at?: string | null;
}

export interface ResultSheetReviewRow {
  roll_no: number | null;
  student_name: string;
  father_name?: string | null;
  subject_marks: Record<string, number>;
  obtained_marks?: number | null;
  total_marks?: number | null;
  percentage?: number | null;
  grade?: string | null;
  position?: number | null;
  remarks?: string | null;
  extra: Record<string, string>;
  confidence: Record<string, number>;
  flags: string[];
  link_preview?: { studentId: string | null; method: 'roll' | 'name' | null; mismatch: boolean };
}

// NOTE (6B): ExamItem is declared in the 6C-1 block below — reused here, not duplicated.

export interface OcrRow {
  name: string;
  name_ur?: string;
  roll_no?: number | null;
  parent_phone?: string;
  confidence: number;
  duplicate?: boolean;
  /** Why the row was flagged: 'duplicate_name' | 'duplicate_roll_no' (R2-D: 'duplicate_phone' no longer occurs). */
  duplicate_reason?: string | null;
}

export interface OcrUpload {
  upload_id: string;
  raw_text: string;
  rows: OcrRow[];
}

export interface TeacherLinkData {
  class: { id: string; name: string; section: string; display_name?: string; teacher_name?: string };
  date: string;
  students: { id: string; name: string; roll_no: number | null; status?: AttendanceStatus }[];
  already_submitted: boolean;
}

export interface FeeRow {
  student_id: string;
  student_name: string;
  class_name: string;
  month: string;
  amount_due: number;
  amount_paid: number;
  discount: number;
  status: FeeStatus;
  paid_at?: string | null;
  receipt_no?: string | null;
  // 6C-2
  record_id?: string | null;
  record_exists?: boolean;
  arrears?: number;
  scholarship_discount?: number;
}

export interface FeeStructure {
  id: string;
  class_id: string;
  class_name?: string;
  monthly_amount: number;
  effective_from: string;
  /** One-time admission fee (v2; 0 when unset). */
  admission_fee?: number;
  /** Sibling discount percent, 0–100 (v2; 0 when unset). */
  sibling_discount_pct?: number;
}

export interface PendingMessage {
  id: string;
  student: string;
  parent_phone_masked: string;
  body: string;
  dedupe_key: string;
}

export interface PendingGroup {
  group_id?: string;
  class: string;
  class_id?: string;
  date: string;
  absent_count: number;
  messages: PendingMessage[];
}

export interface MessageLogItem {
  id: string;
  type: MessageType;
  student_name?: string | null;
  parent_phone_masked: string;
  body: string;
  status: MessageStatus;
  created_at: string;
  sent_at?: string | null;
  error?: string | null;
  dedupe_key: string;
  /** Section 11: latest delivery attempt (from message_deliveries). */
  delivery?: { status: string; deliveredAt: string | null; error: string | null } | null;
}

export interface MessageTemplate {
  id: string;
  type: MessageType;
  language: 'en' | 'ur';
  body: string;
  is_active: boolean;
}

export interface SmsStatus {
  provider: 'sim' | 'gateway';
  sim_connected: boolean;
  last_seen_at?: string | null;
  queued_count: number;
  pending_approval_count?: number;
}

export interface AuditLog {
  id: string;
  actor_type: string;
  action: string;
  entity: string;
  entity_id?: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface Holiday {
  id: string;
  date: string;
  name: string;
}

export interface AcademicSession {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  is_current: boolean;
  // 6C-1: archived sessions are read-only (flag stored in school settings).
  is_archived?: boolean;
}

export interface JobStatus {
  monthly_fee_reminder?: string | null;
  daily_pending_attendance?: string | null;
  teacher_reminders?: string | null;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pages: number;
}

/* ------------------------------------------------------------------ */
/* Section 12 — Recycle Bin + Change History (D1, contracts/SCHEMA.md  */
/* §4/§5). Mirrors GET /recycle-bin and GET /change-logs.             */
/* ------------------------------------------------------------------ */

/** One row of GET /recycle-bin — the deleted_records snapshot is kept as-is. */
export interface DeletedRecord {
  id: string;
  school_id: string;
  entity: string;
  entity_id: string;
  snapshot: Record<string, unknown>;
  deleted_by: string | null;
  deleted_at: string;
  restore_by: string | null;
  permanently_deleted_at: string | null;
}

/** One row of GET /change-logs — one row per changed field, old → new. */
export interface ChangeLogEntry {
  id: string;
  school_id: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_type: string;
  entity: string;
  entity_id: string | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_at: string;
}

export interface ApiError {
  code: string;
  message: string;
}

/* ------------------------------------------------------------------ */
/* Section 11 — Custom Messages (contracts/SCHEMA.md §11).             */
/* These types mirror the REAL backend wire shapes (camelCase Prisma    */
/* rows / service results), not the v1 snake_case contract types above. */
/* ------------------------------------------------------------------ */

export type CustomMessageType =
  | 'absent'
  | 'fee_reminder'
  | 'teacher_reminder'
  | 'result'
  | 'announcement'
  | 'custom';

export const MESSAGE_VARIABLES = [
  'student_name',
  'father_name',
  'class',
  'section',
  'date',
  'amount',
  'month',
  'school_name',
] as const;

export interface MessageTemplateRow {
  id: string;
  schoolId: string;
  type: CustomMessageType;
  language: 'en' | 'ur';
  body: string;
  isActive: boolean;
  /** Admin-editable label (null on old rows). */
  name: string | null;
  /** false = seeded default, true = admin-created. NOT a lock. */
  isCustom: boolean;
}

export type RecipientType = 'all_parents' | 'class' | 'selected_students' | 'single_parent';
export type DraftStatus = 'draft' | 'scheduled' | 'sent' | 'cancelled';

export interface MessageDraftRow {
  id: string;
  schoolId: string;
  createdBy: string | null;
  recipientType: RecipientType;
  targetClassId: string | null;
  targetStudentIds: string[];
  body: string;
  status: DraftStatus;
  scheduledFor: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DraftApprovalInfo {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface PreviewSample {
  studentId: string;
  studentName: string;
  parentPhoneMasked: string;
  /** Exactly what this parent will receive. */
  body: string;
  charCount: number;
  smsParts: number;
  isUnicode: boolean;
}

export interface PreviewSkipped {
  studentId: string;
  studentName: string;
  reason: 'opted_out' | 'missing_phone' | 'invalid_phone' | 'already_queued';
}

export interface PreviewResult {
  samples: PreviewSample[];
  recipientCount: number;
  skippedCount: number;
  skipped: PreviewSkipped[];
  charCount: number;
  smsParts: number;
  isUnicode: boolean;
  variablesUsed: string[];
}

export interface RecipientItem {
  studentId: string;
  studentName: string;
  fatherName: string | null;
  className: string;
  section: string;
  parentPhoneMasked: string | null;
  parentOptOut: boolean;
  amountDue: number | null;
}

// --- 6C-1: sessions / exams / timetable / staff / payroll -------------------
export interface ExamItem {
  id: string;
  name: string;
  session_id: string | null;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
}

export interface DatesheetItem {
  id: string;
  exam_id: string;
  class_id: string;
  subject: string;
  date: string;
  start_time: string;
  end_time: string;
}

export interface GradingScaleItem {
  id: string;
  class_id: string | null;
  min_marks: number;
  max_marks: number;
  grade: string;
  gpa_points: number;
  is_passing: boolean;
}

export interface TimetableEntryItem {
  id: string;
  class_id: string;
  class_name: string | null;
  teacher_id: string | null;
  teacher_name: string | null;
  day_of_week: number;
  day_name: string | null;
  period_no: number;
  subject: string;
  start_time: string;
  end_time: string;
  room: string | null;
}

export interface StaffItem {
  id: string;
  name: string;
  role: 'teacher' | 'staff';
  phone_masked: string | null;
  email: string | null;
  joining_date: string | null;
  subjects: string[];
  salary_monthly: number | null;
}

export interface StaffAssignmentItem {
  id: string;
  staff_id: string;
  staff_name: string | null;
  class_id: string;
  class_name: string | null;
  subject: string;
}

export interface SalaryRecordItem {
  id: string;
  staff_id: string;
  staff_name: string | null;
  month: string;
  base_salary: number;
  deductions: number;
  net_pay: number;
  paid: boolean;
  paid_at: string | null;
  payslip_no: string | null;
}
