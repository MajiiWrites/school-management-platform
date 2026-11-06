import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, clearTokens, getAccessToken, setTokens } from '../lib/api';
import type { User } from '../lib/types';

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (schoolName: string, email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

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
    setTokens(data.access, data.refresh);
    setUser(data.user);
  }, []);

  const signup = useCallback(async (schoolName: string, email: string, password: string) => {
    const data = await api<{ access: string; refresh: string; user: User }>('/auth/signup', {
      method: 'POST',
      body: { school_name: schoolName, email, password },
    });
    setTokens(data.access, data.refresh);
    setUser(data.user);
  }, []);

  const logout = useCallback(() => {
    api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    clearTokens();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, signup, logout }),
    [user, loading, login, signup, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
