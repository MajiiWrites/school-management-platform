// API client — contracts/API.md (CONTRACT v1.0).
// Base URL from VITE_API_URL (default http://localhost:3000/api/v1).
// JWT access token (15 min) in Authorization header; refresh token stored
// locally and exchanged at POST /auth/refresh on 401 (single retry).
// Set VITE_MOCK_API=true for local dev without a backend (default OFF).

import { mockRequest } from './mock';
import type { ApiError } from './types';

export const API_BASE =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000/api/v1';
export const MOCK_MODE = import.meta.env.VITE_MOCK_API === 'true';

const ACCESS_KEY = 'smp_access';
const REFRESH_KEY = 'smp_refresh';

/** 6D: set in sessionStorage when the server rejects a refresh with
 * SESSION_EXPIRED (idle timeout) so the login page can explain the logout.
 * Also dispatched as a window event (SESSION_EXPIRED_EVENT) so AuthProvider
 * can sign the user out wherever they are. */
export const SESSION_EXPIRED_KEY = 'smp_session_expired';
export const SESSION_EXPIRED_EVENT = 'smp:session-expired';

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_KEY);
}

export function setTokens(access: string, refresh: string | null): void {
  localStorage.setItem(ACCESS_KEY, access);
  if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
}

export function clearTokens(): void {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  clearApiCache();
}

/**
 * Round 5 (F2): short per-session GET cache. /auth/me and /settings were
 * re-fetched on every full app mount (and the Phase 10 harness counted
 * them in the ~8-12 calls per navigation that made the old 300/15-min
 * limiter bite). Both values change rarely within a session, so cache
 * them in sessionStorage for 5 minutes: a re-verification still happens
 * at least every 5 minutes, a 401 anywhere still signs the user out
 * (api() handles that), and logout/login clear the cache via
 * clearTokens(). Only for reads that are safe to serve briefly stale —
 * never for writes or for data the user just changed (Settings clears
 * the cache after a successful save).
 */
const API_CACHE_TTL_MS = 5 * 60 * 1000;
const API_CACHE_PREFIX = 'smp_api_cache:';

export function clearApiCache(): void {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(API_CACHE_PREFIX)) sessionStorage.removeItem(k);
    }
  } catch {
    /* storage unavailable — caching is best-effort */
  }
}

export async function cachedApiGet<T>(path: string, ttlMs: number = API_CACHE_TTL_MS): Promise<T> {
  const key = API_CACHE_PREFIX + path;
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) {
      const { at, data } = JSON.parse(raw) as { at: number; data: T };
      if (Date.now() - at < ttlMs) return data;
    }
  } catch {
    /* fall through to a live fetch */
  }
  const data = await api<T>(path);
  try {
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* storage full/unavailable — the live result is still returned */
  }
  return data;
}

export class ApiClientError extends Error {
  code: string;
  status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** FINAL REBUILD Point 3: true for a fetch aborted via AbortController
 * (live search cancelling an outdated request) — callers swallow these
 * silently instead of showing an error banner. */
export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException ? e.name === 'AbortError' : (e as { name?: string } | null)?.name === 'AbortError';
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Public token-auth endpoints (teacher link) — no JWT attached. */
  public?: boolean;
  /** Skip the single 401 refresh retry (used by the refresh call itself). */
  noRetry?: boolean;
  /** FINAL REBUILD Point 3: abort signal for live search — lets the
   * caller cancel an outdated request so a slow reply can never
   * overwrite fresher results. */
  signal?: AbortSignal;
  /** Phase 1 (email verification): abort the request after this many
   * ms. A timeout throws ApiClientError(0, 'TIMEOUT', 'Request timed
   * out') — callers distinguish it via the TIMEOUT code (or
   * isAbortError on the raw abort). Merged with opts.signal: an
   * external abort still wins immediately. */
  timeoutMs?: number;
}

async function refreshAccess(): Promise<boolean> {
  const refresh = localStorage.getItem(REFRESH_KEY);
  if (!refresh) return false;
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh }),
    });
    if (!res.ok) {
      // 6D: the server rejected the refresh because the session sat idle
      // past settings.session_timeout_minutes — sign out with a friendly
      // message instead of a bare 401.
      try {
        const json = (await res.json()) as { ok: boolean; error?: { code?: string } };
        if (json.error?.code === 'SESSION_EXPIRED') {
          sessionStorage.setItem(SESSION_EXPIRED_KEY, '1');
          window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
        }
      } catch {
        /* ignore parse errors */
      }
      return false;
    }
    const json = (await res.json()) as { ok: boolean; data?: { access: string; refresh?: string } };
    if (!json.ok || !json.data) return false;
    setTokens(json.data.access, json.data.refresh ?? refresh);
    return true;
  } catch {
    return false;
  }
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (MOCK_MODE) return mockRequest<T>(path, opts.method ?? 'GET', opts.body);

  // Phase 1: optional timeout, merged with any caller-provided signal.
  // The timeout abort is tracked separately so a caller-initiated abort
  // still surfaces as a plain AbortError, while a timeout becomes the
  // distinguishable TIMEOUT ApiClientError.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let signal = opts.signal;
  if (opts.timeoutMs !== undefined) {
    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort(opts.signal.reason);
      else opts.signal.addEventListener('abort', () => controller.abort(opts.signal?.reason), { once: true });
    }
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs);
    signal = controller.signal;
  }

  const doFetch = async (): Promise<Response> => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (!opts.public) {
      const token = getAccessToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const isForm = opts.body instanceof FormData;
    if (!isForm && opts.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`${API_BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      signal,
      body: isForm ? (opts.body as FormData) : opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  };

  try {
    let res = await doFetch();
    if (res.status === 401 && !opts.public && !opts.noRetry) {
      if (await refreshAccess()) res = await doFetch();
    }
    if (!res.ok) {
      let err: ApiError = { code: 'UNKNOWN', message: `Request failed (${res.status})` };
      try {
        const json = (await res.json()) as { ok: boolean; error?: ApiError };
        if (json.error) err = json.error;
      } catch {
        /* keep default */
      }
      throw new ApiClientError(res.status, err.code, err.message);
    }
    if (res.status === 204) return undefined as T;
    const json = (await res.json()) as { ok: boolean; data: T };
    return json.data;
  } catch (e) {
    if (timedOut && isAbortError(e)) {
      throw new ApiClientError(0, 'TIMEOUT', 'Request timed out');
    }
    throw e;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/** GET that returns a binary download (report exports). */
export async function apiDownload(path: string, filename: string): Promise<void> {
  if (MOCK_MODE) {
    alert('Export is disabled in mock mode — start the backend to download reports.');
    return;
  }
  const token = getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new ApiClientError(res.status, 'DOWNLOAD', 'Download failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Open an authenticated printable HTML page (receipt / voucher /
 * certificate / ID card) in a new tab. A plain <a href> would 401 because
 * the backend needs the JWT — this fetches the HTML with the token and
 * writes it into the new window, where the page's own Print button works.
 */
export async function apiPrint(path: string): Promise<void> {
  if (MOCK_MODE) {
    alert('Printing is disabled in mock mode — start the backend to print.');
    return;
  }
  const token = getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new ApiClientError(res.status, 'PRINT', 'Could not load the printable page');
  const html = await res.text();
  const win = window.open('', '_blank');
  if (!win) throw new ApiClientError(0, 'PRINT', 'The browser blocked the pop-up — allow pop-ups and try again');
  win.document.write(html);
  win.document.close();
}

/* ------------------------------------------------------------------ */
/* College Mode — /api/v1/college (college-only; 403 for School orgs). */
/* Paths, methods and field names follow the API contract exactly.     */
/* Errors (403/409) surface the API's own message via ApiClientError.  */
/* ------------------------------------------------------------------ */

import type {
  CollegeCourse,
  CollegeEnrollment,
  CollegeGpa,
  CollegeMark,
  CollegeProgram,
  CollegeSemester,
  CollegeTopper,
  ParentPortalData,
  ParentTokenInfo,
  AdmissionsFormData,
  AdmissionInquiry,
  AdmissionStatus,
  HomeworkItem,
} from './types';

export const collegeApi = {
  listPrograms: () => api<{ programs: CollegeProgram[] }>('/college/programs'),
  createProgram: (body: { name: string; code: string; department: string; duration_years: number }) =>
    api<{ program: CollegeProgram }>('/college/programs', { method: 'POST', body }),
  getProgram: (id: string) =>
    api<{ program: CollegeProgram; semesters: CollegeSemester[] }>(`/college/programs/${id}`),
  updateProgram: (id: string, body: Partial<{ name: string; code: string; department: string; duration_years: number }>) =>
    api<{ program: CollegeProgram }>(`/college/programs/${id}`, { method: 'PATCH', body }),
  deleteProgram: (id: string) => api(`/college/programs/${id}`, { method: 'DELETE' }),

  listSemesters: (programId: string) =>
    api<{ semesters: CollegeSemester[] }>(`/college/programs/${programId}/semesters`),
  createSemester: (programId: string, body: { number: number; name?: string }) =>
    api<{ semester: CollegeSemester }>(`/college/programs/${programId}/semesters`, { method: 'POST', body }),
  deleteSemester: (id: string) => api(`/college/semesters/${id}`, { method: 'DELETE' }),

  listCourses: (semesterId: string) =>
    api<{ courses: CollegeCourse[] }>(`/college/semesters/${semesterId}/courses`),
  createCourse: (semesterId: string, body: { code: string; title: string; credit_hours: number; teacher_id?: string }) =>
    api<{ course: CollegeCourse }>(`/college/semesters/${semesterId}/courses`, { method: 'POST', body }),
  updateCourse: (id: string, body: Partial<{ code: string; title: string; credit_hours: number; teacher_id?: string | null }>) =>
    api<{ course: CollegeCourse }>(`/college/courses/${id}`, { method: 'PATCH', body }),
  deleteCourse: (id: string) => api(`/college/courses/${id}`, { method: 'DELETE' }),

  createEnrollment: (body: { student_id: string; program_id: string; semester_id: string }) =>
    api<{ enrollment: CollegeEnrollment }>('/college/enrollments', { method: 'POST', body }),
  deleteEnrollment: (id: string) => api(`/college/enrollments/${id}`, { method: 'DELETE' }),
  listStudentEnrollments: (studentId: string) =>
    api<{ enrollments: CollegeEnrollment[] }>(`/college/students/${studentId}/enrollments`),

  upsertMark: (body: { course_id: string; student_id: string; exam_id: string; obtained_marks: number; total_marks: number }) =>
    api('/college/marks', { method: 'POST', body }),
  listSemesterMarks: (semesterId: string, examId: string) =>
    api<{ marks: CollegeMark[] }>(`/college/semesters/${semesterId}/marks?exam_id=${encodeURIComponent(examId)}`),

  getStudentGpa: (studentId: string, semesterId?: string) =>
    api<CollegeGpa>(
      `/college/students/${studentId}/gpa${semesterId ? `?semester_id=${encodeURIComponent(semesterId)}` : ''}`,
    ),
  listToppers: (programId: string, semesterId?: string, examId?: string) => {
    const q = new URLSearchParams();
    if (semesterId) q.set('semester_id', semesterId);
    if (examId) q.set('exam_id', examId);
    const qs = q.toString();
    return api<{ toppers: CollegeTopper[] }>(`/college/programs/${programId}/toppers${qs ? `?${qs}` : ''}`);
  },
};

/* ------------------------------------------------------------------ */
/* Gaps Top 3 — parent portal, admissions, homework.                   */
/* ------------------------------------------------------------------ */

export const portalApi = {
  /** Public, no login: GET /p/:token. */
  getPortal: (token: string) => api<ParentPortalData>(`/p/${token}`, { public: true }),
  getTokenInfo: (studentId: string) => api<ParentTokenInfo>(`/students/${studentId}/parent-token`),
  createToken: (studentId: string) =>
    api<ParentTokenInfo>(`/students/${studentId}/parent-token`, { method: 'POST' }),
  revokeToken: (studentId: string) => api(`/students/${studentId}/parent-token`, { method: 'DELETE' }),
  /** Queues a held SMS draft with the link (admin approves in Messages). */
  sendLinkSms: (studentId: string) =>
    api<{ queued: boolean; already_queued: boolean; queue_id: string }>(`/students/${studentId}/send-parent-link`, {
      method: 'POST',
    }),
};

export const admissionsApi = {
  /** Public, no login: GET /admissions/:slug. */
  getForm: (slug: string) => api<AdmissionsFormData>(`/admissions/${slug}`, { public: true }),
  /** Public, no login: POST /admissions/:slug. */
  submit: (slug: string, body: Record<string, unknown>) =>
    api<{ received: boolean; inquiry_id?: string }>(`/admissions/${slug}`, { method: 'POST', body, public: true }),
  list: (status?: string, page = 1) => {
    const q = new URLSearchParams({ page: String(page) });
    if (status) q.set('status', status);
    return api<{ items: AdmissionInquiry[]; total: number; page: number; pages: number; public_form_url: string | null }>(
      `/admissions?${q.toString()}`,
    );
  },
  setStatus: (id: string, status: AdmissionStatus) =>
    api<{ inquiry: AdmissionInquiry }>(`/admissions/${id}/status`, { method: 'PATCH', body: { status } }),
  admit: (id: string, body: { class_id: string; roll_no?: number | null; admission_no?: string | null }) =>
    api<{ inquiry: AdmissionInquiry; student_id: string; student_name: string; voucher_no: string | null }>(
      `/admissions/${id}/admit`,
      { method: 'POST', body },
    ),
};

export const homeworkApi = {
  list: (classId?: string) =>
    api<{ items: HomeworkItem[]; total: number }>(`/homework${classId ? `?class_id=${encodeURIComponent(classId)}` : ''}`),
  create: (body: { class_id: string; subject: string; title: string; description?: string | null; due_date: string; teacher: string }) =>
    api<{ homework: HomeworkItem }>('/homework', { method: 'POST', body }),
  update: (id: string, body: Partial<{ class_id: string; subject: string; title: string; description?: string | null; due_date: string; teacher: string }>) =>
    api<{ homework: HomeworkItem }>(`/homework/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => api(`/homework/${id}`, { method: 'DELETE' }),
  notify: (id: string) =>
    api<{ drafted: number; skipped: number; total_students: number }>(`/homework/${id}/notify`, { method: 'POST' }),
};
