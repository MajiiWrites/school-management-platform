// Platform Admin API client — /api/v1/platform (contract 2026-11-20).
// Every call wraps api() so the envelope {ok, data} is unwrapped the
// same way as the rest of the app, and errors surface as ApiClientError
// with the backend's own message. Field names follow the contract
// exactly; shapes the backend may extend are kept loose (optional
// fields + index signatures) so a new field never breaks the panel.

import { api, apiDownload } from './api';
import type { PageResult } from './types';

export interface PlatformOverview {
  totals: {
    schools: number;
    students: number;
    users: number;
    verified_users: number;
    unverified_users: number;
  };
  signups: { this_week: number; this_month: number };
  health: {
    api: string;
    mail: { sent: number; failed: number; pending: number };
    queue: { held: number; approved: number; queued: number; failed: number };
    last_backup_at: string | null;
  };
}

export interface PlatformStatus {
  registration_open: boolean;
  maintenance_mode: boolean;
  notice: { text: string; created_at: string } | null;
}

export interface PlatformSchool {
  id: string;
  name: string;
  slug?: string | null;
  org_type?: string | null;
  province?: string | null;
  district?: string | null;
  tehsil?: string | null;
  category?: string | null;
  verified?: boolean;
  suspended?: boolean;
  student_count?: number;
  user_count?: number;
  admin_name?: string | null;
  admin_email?: string | null;
  admin_phone_masked?: string | null;
  address?: string | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface PlatformUser {
  id: string;
  email: string;
  role: string;
  school_id?: string | null;
  school_name?: string | null;
  email_verified?: boolean;
  disabled?: boolean;
  totp_enabled?: boolean;
  created_at?: string;
  last_login_at?: string | null;
  [key: string]: unknown;
}

export interface PlatformRecycleRow {
  id: string;
  school_id?: string | null;
  school_name?: string | null;
  entity: string;
  entity_id: string;
  snapshot?: Record<string, unknown>;
  deleted_by?: string | null;
  deleted_at: string;
  restore_by?: string | null;
  [key: string]: unknown;
}

export interface PlatformAuditRow {
  id: string;
  school_id?: string | null;
  school_name?: string | null;
  user_id?: string | null;
  actor_email?: string | null;
  action: string;
  entity?: string | null;
  entity_id?: string | null;
  source?: 'platform' | 'school' | string;
  details?: Record<string, unknown>;
  created_at: string;
  [key: string]: unknown;
}

export interface PlatformQueueRow {
  id: string;
  school_id?: string | null;
  school_name?: string | null;
  student_name?: string | null;
  parent_phone_masked?: string | null;
  body?: string;
  status: string;
  error?: string | null;
  created_at: string;
  [key: string]: unknown;
}

export interface PlatformMailHealth {
  transport: string;
  recent_verification_mail: { sent: number; failed: number; pending: number };
  recent_failures: { email: string; error: string; at: string }[];
  note?: string | null;
}

export interface PlatformSettings {
  registration_open: boolean;
  maintenance_mode: boolean;
  notice: { text: string; created_at: string } | null;
}

export interface PlatformLoginRow {
  id?: string;
  user_id?: string | null;
  email?: string | null;
  school_id?: string | null;
  school_name?: string | null;
  ip?: string | null;
  success?: boolean;
  created_at: string;
  [key: string]: unknown;
}

export interface PlatformAdminRow {
  id: string;
  email: string;
  totp_enabled?: boolean;
  school_name?: string | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface PlatformSessionRow {
  id?: string;
  user_id: string;
  email?: string | null;
  school_name?: string | null;
  created_at?: string;
  expires_at?: string | null;
  last_seen_at?: string | null;
  [key: string]: unknown;
}

export interface PlatformBackups {
  latest: { school_id?: string | null; school_name?: string | null; file?: string | null; size_bytes?: number | null; created_at: string } | null;
  per_school: { school_id: string; school_name?: string | null; last_backup_at: string | null; size_bytes?: number | null }[];
  total: number;
}

export type PlatformDataEntity =
  | 'students'
  | 'classes'
  | 'fees'
  | 'messages'
  | 'admissions'
  | 'homework'
  | 'programs';

export const PLATFORM_DATA_ENTITIES: PlatformDataEntity[] = [
  'students',
  'classes',
  'fees',
  'messages',
  'admissions',
  'homework',
  'programs',
];

function qs(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const platformApi = {
  getOverview: () => api<PlatformOverview>('/platform/overview'),
  /** Public, no auth — used by the maintenance gate. */
  getStatus: () => api<PlatformStatus>('/platform/status', { public: true }),
  getNotice: () => api<{ notice: { text: string; created_at: string } | null }>('/platform/notice'),

  listSchools: (f: { search?: string; org_type?: string; province?: string; category?: string; verified?: string; suspended?: string; page?: number; limit?: number } = {}) =>
    api<PageResult<PlatformSchool>>(`/platform/schools${qs({ ...f })}`),
  getSchool: (id: string) => api<PlatformSchool>(`/platform/schools/${id}`),
  suspendSchool: (id: string, reason?: string) =>
    api<{ school: PlatformSchool }>(`/platform/schools/${id}/suspend`, { method: 'POST', body: { reason } }),
  activateSchool: (id: string) =>
    api<{ school: PlatformSchool }>(`/platform/schools/${id}/activate`, { method: 'POST' }),
  deleteSchool: (id: string, confirm: string) =>
    api<{ deleted?: boolean; message?: string }>(`/platform/schools/${id}`, { method: 'DELETE', body: { confirm } }),

  listUsers: (f: { search?: string; role?: string; verified?: string; disabled?: string; page?: number; limit?: number } = {}) =>
    api<PageResult<PlatformUser>>(`/platform/users${qs({ ...f })}`),
  getUser: (id: string) => api<PlatformUser>(`/platform/users/${id}`),
  disableUser: (id: string) => api(`/platform/users/${id}/disable`, { method: 'POST' }),
  enableUser: (id: string) => api(`/platform/users/${id}/enable`, { method: 'POST' }),
  reverifyUser: (id: string) => api(`/platform/users/${id}/reverify`, { method: 'POST' }),
  resetPasswordUser: (id: string) => api(`/platform/users/${id}/reset-password`, { method: 'POST' }),
  promoteUser: (id: string) =>
    api(`/platform/users/${id}/promote`, { method: 'POST', body: { role: 'platform_admin' } }),
  demoteUser: (id: string) =>
    api(`/platform/users/${id}/demote`, { method: 'POST', body: { role: 'admin' } }),

  listSchoolData: (schoolId: string, entity: PlatformDataEntity, f: { search?: string; page?: number; limit?: number } = {}) =>
    api<PageResult<Record<string, unknown>>>(`/platform/schools/${schoolId}/data/${entity}${qs({ ...f })}`),
  exportSchoolDataCsv: (schoolId: string, entity: PlatformDataEntity, filename: string) =>
    apiDownload(`/platform/schools/${schoolId}/data/${entity}/export?format=csv`, filename),
  exportSchoolJson: (schoolId: string, filename: string) =>
    apiDownload(`/platform/schools/${schoolId}/export`, filename),

  listRecycleBin: (f: { school_id?: string; entity?: string; page?: number; limit?: number } = {}) =>
    api<PageResult<PlatformRecycleRow>>(`/platform/recycle-bin${qs({ ...f })}`),
  restoreRecycle: (id: string) => api(`/platform/recycle-bin/${id}/restore`, { method: 'POST' }),
  permanentDeleteRecycle: (id: string, confirm: string) =>
    api(`/platform/recycle-bin/${id}/permanent-delete`, { method: 'POST', body: { confirm } }),

  listAuditLogs: (f: { school_id?: string; user_id?: string; action?: string; from?: string; to?: string; page?: number; limit?: number } = {}) =>
    api<PageResult<PlatformAuditRow>>(`/platform/audit-logs${qs({ ...f })}`),

  listMessageQueue: (f: { status?: string; school_id?: string; page?: number; limit?: number } = {}) =>
    api<PageResult<PlatformQueueRow>>(`/platform/messaging/queue${qs({ ...f })}`),
  listFailedMessages: () => api<PageResult<PlatformQueueRow> | PlatformQueueRow[]>('/platform/messaging/failed'),
  retryQueuedMessage: (id: string) => api(`/platform/messaging/queue/${id}/retry`, { method: 'POST' }),

  getMailHealth: () => api<PlatformMailHealth>('/platform/mail-health'),

  getSettings: () => api<PlatformSettings>('/platform/settings'),
  /** PATCH body per the contract: notice is {text} to publish or null
   * to clear — the response carries the full notice with created_at. */
  updateSettings: (body: { registration_open?: boolean; maintenance_mode?: boolean; notice?: { text: string } | null }) =>
    api<PlatformSettings>('/platform/settings', { method: 'PATCH', body }),

  listLogins: (days = 7) => api<PageResult<PlatformLoginRow> | PlatformLoginRow[]>(`/platform/security/logins${qs({ days })}`),
  listPlatformAdmins: () => api<{ admins: PlatformAdminRow[] } | PlatformAdminRow[]>('/platform/security/platform-admins'),
  listSessions: () => api<PageResult<PlatformSessionRow> | PlatformSessionRow[]>('/platform/security/sessions'),
  revokeSessions: (userId: string) =>
    api(`/platform/security/users/${userId}/revoke-sessions`, { method: 'POST' }),

  listBackups: () => api<PlatformBackups>('/platform/backups'),
};

/** True when an ApiClientError is the backend's "enable 2FA first"
 * rejection for the Platform Admin panel. */
export function isTwoFactorRequiredError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return /2fa|two[- ]factor/i.test(msg);
}
