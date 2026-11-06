import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, clearTokens, getAccessToken, setTokens, SESSION_EXPIRED_EVENT, SESSION_EXPIRED_KEY } from '../lib/api';
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
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
    setUser(null);
  }, []);

  // 6D: the API client dispatches this when a refresh is rejected with
  // SESSION_EXPIRED — sign out wherever the user is.
  useEffect(() => {
    const onExpired = () => {
      clearTokens();
      setUser(null);
      setSessionExpired(true);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  useEffect(() => {
    let alive = true;
    if (!getAccessToken()) {
      setLoading(false);
      return;
    }
    api<User>('/auth/me')
      .then((me) => {
        if (alive) setUser(me);
      })
      .catch(() => {
        clearTokens();
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
  }, [clearSessionExpired]);

  const signup = useCallback(async (schoolName: string, email: string, password: string) => {
    const data = await api<{ access: string; refresh: string; user: User }>('/auth/signup', {
      method: 'POST',
      body: { school_name: schoolName, email, password },
    });
    clearSessionExpired();
    setTokens(data.access, data.refresh);
    setUser(data.user);
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
