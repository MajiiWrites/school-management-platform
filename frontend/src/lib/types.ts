// Shared types — mirror contracts/API.md + contracts/SCHEMA.md (CONTRACT v1.0)

export type Role = 'admin' | 'clerk';
export type AttendanceStatus = 'present' | 'absent' | 'late' | 'leave';
export type TeacherStatus = 'present' | 'absent' | 'leave';
export type FeeStatus = 'unpaid' | 'partial' | 'paid';
export type MessageStatus = 'queued' | 'sent' | 'failed' | 'cancelled';
export type MessageType = 'absent' | 'fee_reminder' | 'teacher_reminder';
export type PhoneFlag = 'missing' | 'invalid' | 'duplicate' | null;

export interface User {
  id: string;
  email: string;
  role: Role;
  school_id: string;
  school_name?: string;
}

export interface SchoolSettings {
  teacher_reminder_time: string; // "HH:MM"
  fee_auto_send: boolean;
  fee_require_approval: boolean;
  fee_followup_day: number | null;
  sms_provider: 'sim' | 'gateway';
  teacher_attendance_mode: 'admin' | 'link';
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
  student_count?: number;
  submitted_today?: boolean;
  absent_today?: number;
  present_today?: number;
  attendance_link?: string | null;
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
  parent_opt_out?: boolean;
  status: 'active' | 'left' | 'graduated';
  phone_flag?: PhoneFlag;
}

export interface OcrRow {
  name: string;
  name_ur?: string;
  roll_no?: number | null;
  parent_phone?: string;
  confidence: number;
  duplicate?: boolean;
}

export interface OcrUpload {
  upload_id: string;
  raw_text: string;
  rows: OcrRow[];
}

export interface TeacherLinkData {
  class: { id: string; name: string; section: string };
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
}

export interface FeeStructure {
  id: string;
  class_id: string;
  class_name?: string;
  monthly_amount: number;
  effective_from: string;
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

export interface ApiError {
  code: string;
  message: string;
}
