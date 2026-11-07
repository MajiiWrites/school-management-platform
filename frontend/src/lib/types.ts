// Shared types — mirror contracts/API.md + contracts/SCHEMA.md (CONTRACT v1.0)

export type Role = 'admin' | 'clerk' | 'principal';
export type AttendanceStatus = 'present' | 'absent';
export type TeacherStatus = 'present' | 'absent';
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
  // Registration profile (collected at signup; read-only in Settings).
  tehsil?: string;
  district?: string;
  province?: string;
  category?: string;
  org_type?: string;
  admin_name?: string;
  admin_phone_masked?: string;
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
  parent_name_ur?: string | null;
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
  /** Parent name: from an "s/o ..." tail, or the Parents Name column of a table photo. */
  parent_name?: string | null;
  /** Parent name in Urdu script (transliterated, editable on review). */
  parent_name_ur?: string | null;
  parent_phone?: string;
  confidence: number;
  /** Second verification pass (different psm): 'match' | 'mismatch' | 'unverified'. */
  verification?: 'match' | 'mismatch' | 'unverified';
  duplicate?: boolean;
  /** Why the row was flagged: 'duplicate_name' | 'duplicate_roll_no' (R2-D: 'duplicate_phone' no longer occurs). */
  duplicate_reason?: string | null;
}

export interface OcrUpload {
  upload_id: string;
  raw_text: string;
  rows: OcrRow[];
  warnings?: string[];
  /** Authenticated image endpoint for the zoomable review view. */
  image_url?: string;
  /** Live stage while an upload runs ('processing' | 'reading' | 'verifying' | 'review' | 'failed'). */
  status?: string;
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
  /** D3: true when the student's class has no fee structure and no fee
   * record exists — backend synthesises such rows with amount 0 and a
   * GENERATED status of 'paid'. The frontend must NOT present them as
   * paid; they are "No fee structure". */
  no_structure?: boolean;
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
  /** FINAL REBUILD (Module C): the saved sender number, masked. */
  sender_number_masked?: string | null;
  /** Name of the most-recently-seen linked companion device, if any. */
  device_name?: string | null;
  /** True when the linked device was seen in the last 90 s. */
  device_online?: boolean;
}

/** FINAL REBUILD (Module C): per-school SMS sender number (admin-only endpoints). */
export interface SenderNumberSettings {
  /** Full E.164 number, for the admin's edit field. */
  sender_number: string | null;
  sender_number_masked: string | null;
  device_name: string | null;
  device_online: boolean;
  device_last_seen_at?: string | null;
}

export interface AuditLog {
  id: string;
  actor_id?: string | null;
  actor_type: string;
  // D6: resolved at read time by listAuditLogs — the admin/clerk email for
  // 'user' actors; null for system/device/teacher_link actors (no email
  // exists) and for deleted users. The frontend falls back to actor_type.
  actor_email?: string | null;
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

/** Module D promotion rebuild: one admin decision = one batch. */
export type PromotionOutcome = 'promoted' | 'graduated' | 'held';
export type PromotionStatus = 'applied' | 'reversed' | 'superseded';

export interface PromotionPreviewRow {
  student_id: string;
  student_name: string | null;
  roll_no_from: number | null;
  from_class_id: string;
  to_class_id: string | null;
  outcome: PromotionOutcome;
  roll_no_to: number | null;
  status: 'ready' | 'skipped';
  skip_reason: string | null;
}

export interface PromotionPreview {
  session_id: string;
  rows: PromotionPreviewRow[];
  ready: number;
  skipped: number;
}

export interface PromotionItem {
  id: string;
  student_id: string;
  student_name: string | null;
  from_class_id: string;
  from_class: string | null;
  to_class_id: string;
  to_class: string | null;
  session_id: string;
  batch_id: string | null;
  status: PromotionStatus;
  outcome: PromotionOutcome;
  roll_no_from: number | null;
  roll_no_to: number | null;
  promoted_at: string;
  promoted_by: string | null;
}

export interface PromotionBatch {
  batch_id: string;
  session_id: string;
  promoted_at: string;
  promoted_by: string | null;
  students: number;
  applied: number;
  reversed: number;
  superseded: number;
  status: 'applied' | 'partially_reversed' | 'reversed';
  outcomes: { promoted: number; graduated: number; held: number };
}

/**
 * GET /jobs/status — the real shape (backend/src/jobs/registry.ts
 * getJobsStatus): an array of all six jobs, each with its per-school
 * last-run state. Round 5 (F12): the old flat shape here
 * ({monthly_fee_reminder, daily_pending_attendance, teacher_reminders}
 * as bare date strings) is what the MOCK returned, not the API — so the
 * Jobs tab showed only 3 hardcoded rows, all "Last run: —", and the
 * fee-follow-up / scheduled-messages / backup jobs were invisible.
 */
export interface JobStatusEntry {
  name: string;
  description: string;
  schedule: string;
  schools: Array<{
    school_id: string;
    school_slug: string;
    last_run_at: string | null;
    last_status: 'ok' | 'skipped' | 'error' | 'never';
    last_summary: string;
    last_error: string | null;
    runs: number;
  }>;
}

export interface JobStatus {
  jobs: JobStatusEntry[];
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
/** FINAL REBUILD (Module C): exam types — exactly these three. */
export type ExamType = 'monthly' | 'midterm' | 'annual';
export const EXAM_TYPE_LABELS: Record<ExamType, string> = {
  monthly: 'Monthly Test',
  midterm: 'Midterm',
  annual: 'Annual',
};

export interface ExamItem {
  id: string;
  name: string;
  type: ExamType;
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

/** One row parsed from a photographed timetable sheet (Point 7). */
export type TimetablePhotoFlag =
  | 'missing_teacher'
  | 'missing_time'
  | 'missing_subject'
  | 'period_inferred'
  | 'teacher_double_booked'
  | 'class_double_booked'
  | 'unmatched_teacher'
  | 'unmatched_class'
  | 'low_confidence';

export interface TimetablePhotoCell {
  day_of_week: number | null;
  day_label: string | null;
  period_no: number | null;
  start_time: string | null;
  end_time: string | null;
  subject: string | null;
  teacher_name: string | null;
  class_label: string | null;
  confidence: number;
  flags: TimetablePhotoFlag[];
  source_text: string;
  teacher_id: string | null;
  class_id: string | null;
}

export interface TimetablePhotoUpload {
  raw_text: string;
  cells: TimetablePhotoCell[];
  unmatched_teachers: string[];
  unmatched_classes: string[];
  warnings: string[];
}

export interface TimetablePhotoConfirmResult {
  created: number;
  skipped: { entry: Record<string, unknown>; reason: string }[];
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

export interface StaffPaymentItem {
  id: string;
  staff_id: string;
  staff_name: string | null;
  month: string;
  amount: number;
  paid_at: string | null;
}

export type PayrollStatus = 'unpaid' | 'partial' | 'paid';

export interface PayrollSummaryItem {
  staff_id: string;
  staff_name: string | null;
  month: string;
  monthly_salary: number | null;
  amount_paid: number;
  remaining: number | null;
  status: PayrollStatus;
  payments: StaffPaymentItem[];
}

export interface SalarySlipData {
  staff_id: string;
  school_name: string;
  logo_url: string | null;
  staff_name: string;
  role: string;
  month: string;
  monthly_salary: number | null;
  amount_paid: number;
  remaining: number | null;
  status: PayrollStatus;
  payments: { amount: number; paid_at: string | null }[];
}
