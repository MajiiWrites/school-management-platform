import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, cachedApiGet, clearTokens, getAccessToken, setTokens, SESSION_EXPIRED_EVENT, SESSION_EXPIRED_KEY } from '../lib/api';
import type { User } from '../lib/types';

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (schoolName: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  /** 6D: true when the last logout was an idle/session expiry (server
   * rejected the refresh, or the idle timer fired). The login page shows a
   * friendly "signed out for inactivity" message while this is set. */
  sessionExpired: boolean;
  clearSessionExpired: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

const USER_CACHE_KEY = 'smp_user';

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

  const login = useCallback(async (email: string, password: string) => {
    const data = await api<{ access: string; refresh: string; user: User }>('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    clearSessionExpired();
    setTokens(data.access, data.refresh);
    setUser(data.user);
    cacheUser(data.user);
  }, [clearSessionExpired]);

  const signup = useCallback(async (schoolName: string, email: string, password: string) => {
    const data = await api<{ access: string; refresh: string; user: User }>('/auth/signup', {
      method: 'POST',
      body: { school_name: schoolName, email, password },
    });
    clearSessionExpired();
    setTokens(data.access, data.refresh);
    setUser(data.user);
    cacheUser(data.user);
  }, [clearSessionExpired]);

  const value = useMemo(
    () => ({ user, loading, login, signup, logout, sessionExpired, clearSessionExpired }),
    [user, loading, login, signup, logout, sessionExpired, clearSessionExpired],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
