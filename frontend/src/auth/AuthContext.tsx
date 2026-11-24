import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiClientError, api, cachedApiGet, clearTokens, getAccessToken, setTokens, SESSION_EXPIRED_EVENT, SESSION_EXPIRED_KEY } from '../lib/api';
import type { User } from '../lib/types';

/** Registration details collected on signup (one request) — the
 * backend stores them as the school's registration profile. */
export interface SignupDetails {
  school_name: string;
  admin_name: string;
  admin_phone: string;
  address: string;
  tehsil: string;
  district: string;
  province: string;
  category: string;
  org_type: string;
  email: string;
  password: string;
}

/** Phase 1: what POST /auth/signup returns — no tokens. The caller
 * (SignupPage) routes to /verify-email from this payload. */
export interface SignupResult {
  user: User;
  school: { id?: string; name?: string; [key: string]: unknown };
  email_verification: { status: string };
}

interface AuthState {
  user: User | null;
  loading: boolean;
  /** Password step. Returns needs2fa when the account has TOTP enabled:
   * the backend answers {needs_2fa, temp_token} (HTTP 200) instead of
   * JWTs, and the caller must show the code step. The old code treated
   * that payload as a login, stored undefined tokens, navigated to
   * /dashboard, and got bounced back to a cleared login form — the
   * exact symptom of the 2026-11-23 owner lockout (2FA enabled, no code
   * step in the UI). */
  login: (email: string, password: string) => Promise<{ needs2fa: boolean }>;
  /** 2FA code step: exchanges the temp token + 6-digit code for JWTs
   * via POST /auth/2fa/login, then signs the user in like login(). */
  completeTwofaLogin: (code: string) => Promise<void>;
  /** Phase 1: signup NO LONGER logs the user in — the backend issues
   * no tokens and the account must verify its email first. signup()
   * returns the signup payload ({ user, school, email_verification })
   * so the caller can route to /verify-email; it stores no tokens and
   * sets no user. */
  signup: (details: SignupDetails, opts?: { timeoutMs?: number }) => Promise<SignupResult>;
  logout: () => void;
  /** 6D: true when the last logout was an idle/session expiry (server
   * rejected the refresh, or the idle timer fired). The login page shows a
   * friendly "signed out for inactivity" message while this is set. */
  sessionExpired: boolean;
  clearSessionExpired: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

const USER_CACHE_KEY = 'smp_user';

/** 2FA temp token (2026-11-23): issued by the password step when TOTP
 * is enabled, valid 5 minutes. sessionStorage so a reload during the
 * code step does not strand the user; cleared once the code step
 * succeeds. Never a JWT for API access — only POST /auth/2fa/login
 * accepts it. */
const TOTP_TEMP_KEY = 'smp_2fa_temp';

/** Phase 9 fix (empty sidebar): GET /auth/me returns `{ user: {...} }`
 * but this context used to store the whole wrapper as the user, so
 * `user.role` was undefined and the nav filter
 * `n.roles.includes(user.role)` matched nothing — the sidebar rendered
 * empty after every reload, and only a fresh login (which sets the real
 * user) brought it back. The verification below unwraps `.user`.
 * The last-known user is also cached in localStorage so the nav renders
 * immediately on reload instead of waiting on a (possibly cold-start)
 * /auth/me round-trip; a 401/403 still signs out, but a transient
 * network/server failure no longer wipes the session. */
function cachedUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    // R2-E: tolerate a legacy cache entry stored as the `{ user: {...} }`
    // wrapper (pre-round-1 shape) — unwrapping it here means a stale
    // cache can never again leave `user.role` undefined and the sidebar
    // empty while /auth/me is still in flight.
    const candidate = ((parsed as { user?: User } | null)?.user ?? parsed) as User;
    return candidate && typeof candidate.email === 'string' && typeof candidate.role === 'string'
      ? candidate
      : null;
  } catch {
    return null;
  }
}

function cacheUser(u: User | null): void {
  if (u) localStorage.setItem(USER_CACHE_KEY, JSON.stringify(u));
  else localStorage.removeItem(USER_CACHE_KEY);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => cachedUser());
  const [loading, setLoading] = useState(true);
  // 6D: set when the session ends by idle expiry (server SESSION_EXPIRED or
  // the idle timer); read from sessionStorage on load so a redirect to
  // /login keeps the message.
  const [sessionExpired, setSessionExpired] = useState<boolean>(() => sessionStorage.getItem(SESSION_EXPIRED_KEY) === '1');

  const clearSessionExpired = useCallback(() => {
    sessionStorage.removeItem(SESSION_EXPIRED_KEY);
    setSessionExpired(false);
  }, []);

  const logout = useCallback(() => {
    api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    clearTokens();
    cacheUser(null);
    setUser(null);
  }, []);

  // 6D: the API client dispatches this when a refresh is rejected with
  // SESSION_EXPIRED — sign out wherever the user is.
  useEffect(() => {
    const onExpired = () => {
      clearTokens();
      cacheUser(null);
      setUser(null);
      setSessionExpired(true);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  useEffect(() => {
    let alive = true;
    if (!getAccessToken()) {
      cacheUser(null);
      setUser(null);
      setLoading(false);
      return;
    }
    // Round 5 (F2): /auth/me is cached per session for 5 minutes
    // (cachedApiGet) — it was re-fetched on every full app mount and
    // counted toward the per-IP rate limit on every navigation in the
    // harness. A 401 from any other call still signs the user out.
    cachedApiGet<{ user: User }>('/auth/me')
      .then((data) => {
        if (!alive) return;
        // The endpoint wraps the user: { user: {...} }. Accept the bare
        // shape too, so a future backend change cannot empty the nav again.
        const me = (data as { user?: User }).user ?? (data as unknown as User);
        if (me && typeof me.role === 'string') {
          setUser(me);
          cacheUser(me);
        }
      })
      .catch((err: unknown) => {
        if (!alive) return;
        // Only an auth rejection ends the session. A cold-start timeout
        // or 5xx used to clear the tokens here, logging the user out on
        // a slow first load; now the cached user stays and the next
        // navigation re-verifies.
        const status = (err as { status?: number })?.status;
        if (status === 401 || status === 403) {
          clearTokens();
          cacheUser(null);
          setUser(null);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<{ needs2fa: boolean }> => {
    // Cold-start guard (2026-11-23): login had NO timeout, so a
    // sleeping server left the button on "Logging in…" for over a
    // minute with no explanation. 120s covers the worst Render wake
    // (~70s) plus the request itself; the page shows a waking-up note
    // while it waits and a plain retry message on timeout.
    const data = await api<
      | { access: string; refresh: string; user: User }
      | { needs_2fa: true; temp_token: string }
    >('/auth/login', {
      method: 'POST',
      body: { email, password },
      timeoutMs: 120_000,
    });
    // 2FA (2026-11-23): a TOTP-enabled account gets NO tokens here —
    // only a temp token. Storing data.access (undefined) used to fake
    // a login and bounce the user back to a cleared form. The `in`
    // check alone discriminates the union (only this member carries
    // needs_2fa); a compound && would defeat TS narrowing below.
    if ('needs_2fa' in data) {
      sessionStorage.setItem(TOTP_TEMP_KEY, data.temp_token);
      return { needs2fa: true };
    }
    clearSessionExpired();
    setTokens(data.access, data.refresh);
    setUser(data.user);
    cacheUser(data.user);
    return { needs2fa: false };
  }, [clearSessionExpired]);

  const completeTwofaLogin = useCallback(
    async (code: string) => {
      const tempToken = sessionStorage.getItem(TOTP_TEMP_KEY);
      if (!tempToken) {
        throw new ApiClientError(401, 'UNAUTHORIZED', 'Your verification session expired — please log in again.');
      }
      const data = await api<{ access: string; refresh: string; user: User }>('/auth/2fa/login', {
        method: 'POST',
        body: { temp_token: tempToken, code },
        timeoutMs: 120_000,
      });
      sessionStorage.removeItem(TOTP_TEMP_KEY);
      clearSessionExpired();
      setTokens(data.access, data.refresh);
      setUser(data.user);
      cacheUser(data.user);
    },
    [clearSessionExpired],
  );

  const signup = useCallback(async (details: SignupDetails, opts?: { timeoutMs?: number }) => {
    // Phase 1: the backend returns no tokens — the user is NOT logged
    // in after signup and must verify their email first. Return the
    // payload to the caller; store nothing here.
    // Cold-start guard (2026-11-23): the old 30s timeout fired during
    // a normal Render wake (30–70s) and told the user the account "may
    // already exist". Default 120s; callers may still override.
    return api<SignupResult>('/auth/signup', {
      method: 'POST',
      body: details,
      timeoutMs: opts?.timeoutMs ?? 120_000,
    });
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, signup, completeTwofaLogin, logout, sessionExpired, clearSessionExpired }),
    [user, loading, login, signup, completeTwofaLogin, logout, sessionExpired, clearSessionExpired],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
