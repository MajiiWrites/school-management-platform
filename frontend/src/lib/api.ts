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

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Public token-auth endpoints (teacher link) — no JWT attached. */
  public?: boolean;
  /** Skip the single 401 refresh retry (used by the refresh call itself). */
  noRetry?: boolean;
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
      body: isForm ? (opts.body as FormData) : opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  };

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
