/**
 * Idle / session timeout (6D).
 *
 * Mounted inside Layout (authed area only). Reads the school's
 * `session_timeout_minutes` setting (GET /settings — readable by every
 * authed role; falls back to the 120-minute default when unavailable).
 *
 * - Any pointer / key / scroll / touch activity resets the idle clock.
 * - 2 minutes before the timeout, a warning modal offers "Stay signed in"
 *   (resets the clock) or "Sign out now".
 * - On expiry the user is signed out and sent to /login, where the login
 *   page explains the session ended for inactivity.
 *
 * Server-side enforcement is the refresh-token `iat` check in
 * auth/service.ts refreshTokens (SESSION_EXPIRED): even if this component
 * never runs (old tab, JS disabled), an idle refresh is rejected. The two
 * halves agree because the frontend only calls /refresh when the user
 * actually makes a request (see lib/api.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { api, SESSION_EXPIRED_KEY } from '../lib/api';
import type { SchoolSettings } from '../lib/types';
import { Button, Modal } from './ui';

const WARN_BEFORE_MS = 2 * 60 * 1000;
const CHECK_MS = 5_000;
const DEFAULT_TIMEOUT_MINUTES = 120;

function fmtCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

export default function IdleTimeout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [timeoutMinutes, setTimeoutMinutes] = useState<number | null>(null);
  const [warningSeconds, setWarningSeconds] = useState<number | null>(null);
  const lastActivityRef = useRef<number>(Date.now());

  // School's session timeout (any authed role may read /settings).
  useEffect(() => {
    if (!user) return;
    let alive = true;
    api<SchoolSettings>('/settings')
      .then((s) => {
        if (alive) setTimeoutMinutes(s.session_timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES);
      })
      .catch(() => {
        if (alive) setTimeoutMinutes(DEFAULT_TIMEOUT_MINUTES);
      });
    return () => {
      alive = false;
    };
  }, [user]);

  const expire = useCallback(() => {
    sessionStorage.setItem(SESSION_EXPIRED_KEY, '1');
    logout();
    navigate('/login');
  }, [logout, navigate]);

  const staySignedIn = useCallback(() => {
    lastActivityRef.current = Date.now();
    setWarningSeconds(null);
  }, []);

  // Any real activity resets the idle clock (and clears a shown warning).
  useEffect(() => {
    if (!user) return;
    const bump = () => {
      lastActivityRef.current = Date.now();
      setWarningSeconds(null);
    };
    const events = ['pointerdown', 'keydown', 'scroll', 'touchstart', 'wheel'];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, bump));
  }, [user]);

  // Tick: warn 2 min before, expire at the timeout.
  useEffect(() => {
    if (!user || timeoutMinutes === null) return;
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const tick = () => {
      const idleMs = Date.now() - lastActivityRef.current;
      if (idleMs >= timeoutMs) {
        expire();
      } else if (idleMs >= timeoutMs - WARN_BEFORE_MS) {
        setWarningSeconds(Math.max(0, Math.ceil((timeoutMs - idleMs) / 1000)));
      } else {
        setWarningSeconds(null);
      }
    };
    tick();
    const id = window.setInterval(tick, CHECK_MS);
    return () => window.clearInterval(id);
  }, [user, timeoutMinutes, expire]);

  if (!user || warningSeconds === null) return null;

  return (
    <Modal title="Still there?" onClose={staySignedIn}>
      <p className="text-sm text-slate-600">
        You have been inactive for a while. For security, you will be signed out in{' '}
        <strong className="text-slate-900">{fmtCountdown(warningSeconds)}</strong> unless you stay signed in.
      </p>
      <p className="mt-2 text-xs text-slate-500">
        Your school signs inactive sessions out after {timeoutMinutes} minutes. Any unsaved work on this page may be lost when you are signed out.
      </p>
      <div className="mt-5 flex gap-3">
        <Button onClick={staySignedIn}>Stay signed in</Button>
        <Button variant="secondary" onClick={expire}>
          Sign out now
        </Button>
      </div>
    </Modal>
  );
}
