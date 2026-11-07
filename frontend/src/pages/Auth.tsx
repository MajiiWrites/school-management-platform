import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { api, ApiClientError } from '../lib/api';
import { Button, Card, ErrorBanner, Field, inputCls } from '../components/ui';
import DeveloperFooter from '../components/DeveloperFooter';

function AuthShell({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <p className="text-2xl font-bold text-brand-900">🏫 Student Manager</p>
          <p className="mt-1 text-sm text-slate-500">Attendance · Parent SMS · Fees</p>
        </div>
        <Card className="p-6">
          <h1 className="text-xl font-bold text-slate-900">{title}</h1>
          <p className="mt-1 text-sm text-slate-500">{sub}</p>
          <div className="mt-5">{children}</div>
        </Card>
        <DeveloperFooter />
      </div>
    </div>
  );
}

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong. Please try again.';
}

export function LoginPage() {
  const { login, sessionExpired, clearSessionExpired } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email.trim(), password);
      navigate('/dashboard');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Welcome back" sub="Log in to your school portal.">
      {/* 6D: shown when the previous session ended for inactivity. */}
      {sessionExpired && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span>Your session ended because you were inactive for a while. Please sign in again — your data is safe.</span>
          <button onClick={clearSessionExpired} className="shrink-0 font-medium underline" aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      )}
      {error && <ErrorBanner message={error} />}
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <input className={inputCls} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@school.pk" autoComplete="email" />
        </Field>
        <Field label="Password">
          <input className={inputCls} type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
        </Field>
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Logging in…' : 'Log in'}
        </Button>
      </form>
      <div className="mt-4 flex justify-between text-sm">
        <Link to="/forgot-password" className="text-brand-700 hover:underline">
          Forgot password?
        </Link>
        <Link to="/signup" className="text-brand-700 hover:underline">
          Create a school account
        </Link>
      </div>
    </AuthShell>
  );
}

const PROVINCES = [
  'Punjab',
  'Sindh',
  'Khyber Pakhtunkhwa',
  'Balochistan',
  'Gilgit-Baltistan',
  'Azad Jammu & Kashmir',
  'Islamabad Capital Territory',
] as const;

const CATEGORIES = ['Private', 'Public', 'Semi-Government'] as const;

const ORG_TYPES = ['School', 'College'] as const;

export function SignupPage() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [schoolName, setSchoolName] = useState('');
  const [orgType, setOrgType] = useState('');
  const [category, setCategory] = useState('');
  const [address, setAddress] = useState('');
  const [tehsil, setTehsil] = useState('');
  const [district, setDistrict] = useState('');
  const [province, setProvince] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminPhone, setAdminPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      await signup({
        school_name: schoolName.trim(),
        admin_name: adminName.trim(),
        admin_phone: adminPhone.trim(),
        address: address.trim(),
        tehsil: tehsil.trim(),
        district: district.trim(),
        province,
        category,
        org_type: orgType,
        email: email.trim(),
        password,
      });
      // R2-C fix: signup now issues access+refresh tokens (round-1 fix), so
      // the session is live immediately — land straight on the dashboard.
      // The dashboard shows a dismissible verification reminder instead
      // of parking the new admin on the /verify-email interstitial.
      navigate('/dashboard', { state: { justSignedUp: true } });
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Create your school" sub="One account runs the whole school.">
      {error && <ErrorBanner message={error} />}
      <form onSubmit={submit} className="space-y-4">
        <h2 className="text-sm font-semibold text-slate-900">School details</h2>
        <Field label="School name">
          <input className={inputCls} required value={schoolName} onChange={(e) => setSchoolName(e.target.value)} placeholder="e.g. Al-Noor Public School" autoComplete="off" />
        </Field>
        <Field label="Organization type">
          <select className={inputCls} required value={orgType} onChange={(e) => setOrgType(e.target.value)}>
            <option value="">Select…</option>
            {ORG_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="School category">
          <select className={inputCls} required value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Select…</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Address">
          <input className={inputCls} required value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, town/city" autoComplete="off" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tehsil">
            <input className={inputCls} required value={tehsil} onChange={(e) => setTehsil(e.target.value)} placeholder="e.g. Bahawalpur Saddar" autoComplete="off" />
          </Field>
          <Field label="District">
            <input className={inputCls} required value={district} onChange={(e) => setDistrict(e.target.value)} placeholder="e.g. Bahawalpur" autoComplete="off" />
          </Field>
        </div>
        <Field label="Province">
          <select className={inputCls} required value={province} onChange={(e) => setProvince(e.target.value)}>
            <option value="">Select…</option>
            {PROVINCES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </Field>

        <h2 className="pt-2 text-sm font-semibold text-slate-900">Admin details</h2>
        <Field label="Admin name">
          <input className={inputCls} required value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="e.g. Majid Ali" autoComplete="name" />
        </Field>
        <Field label="Admin number" hint="Pakistani mobile number">
          <input className={inputCls} type="tel" required value={adminPhone} onChange={(e) => setAdminPhone(e.target.value)} placeholder="e.g. 03001234567" autoComplete="tel" />
        </Field>
        <Field label="Admin email">
          <input className={inputCls} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@school.pk" autoComplete="email" />
        </Field>

        <h2 className="pt-2 text-sm font-semibold text-slate-900">Account</h2>
        <Field label="Password" hint="At least 8 characters.">
          <input className={inputCls} type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
        </Field>
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Creating…' : 'Create account'}
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-slate-500">
        Already have an account?{' '}
        <Link to="/login" className="text-brand-700 hover:underline">
          Log in
        </Link>
      </p>
    </AuthShell>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const token = params.get('token');
  const sent = params.get('sent');

  useEffect(() => {
    if (!token) return;
    api('/auth/verify-email', { method: 'POST', body: { token } })
      .then(() => {
        setStatus('ok');
        setMessage('Your email is verified. You can now log in.');
      })
      .catch((e: unknown) => {
        setStatus('error');
        setMessage(errText(e));
      });
  }, [token]);

  return (
    <AuthShell title="Verify your email" sub="We sent a verification link to your inbox.">
      {!token && sent && (
        <div className="rounded-lg bg-brand-50 px-4 py-3 text-sm text-brand-700">
          Check your inbox for the verification link. It is valid for 24 hours — if you can't find it, check your spam folder.
        </div>
      )}
      {!token && !sent && <p className="text-sm text-slate-500">No verification token in this link.</p>}
      {token && status === 'idle' && <p className="text-sm text-slate-500">Verifying…</p>}
      {token && status === 'ok' && <p className="text-sm text-brand-700">{message}</p>}
      {token && status === 'error' && <ErrorBanner message={message} />}
      <p className="mt-4 text-center text-sm">
        <Link to="/login" className="text-brand-700 hover:underline">
          Go to login
        </Link>
      </p>
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: { email: email.trim() } });
      setDone(true);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Forgot password" sub="We will send a reset link to your email.">
      {error && <ErrorBanner message={error} />}
      {done ? (
        <div className="rounded-lg bg-brand-50 px-4 py-3 text-sm text-brand-700">
          If that email is registered, a reset link is on its way to your inbox. It is valid for 1 hour — if you can't find it, check your spam folder.
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email">
            <input className={inputCls} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@school.pk" autoComplete="off" />
          </Field>
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
      )}
      <p className="mt-4 text-center text-sm">
        <Link to="/login" className="text-brand-700 hover:underline">
          Back to login
        </Link>
      </p>
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const token = params.get('token') ?? '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, password } });
      setDone(true);
      window.setTimeout(() => navigate('/login'), 1500);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Reset password" sub="Choose a new password for your account.">
      {error && <ErrorBanner message={error} />}
      {done ? (
        <p className="text-sm text-brand-700">Password reset. Redirecting to login…</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="New password" hint="At least 8 characters.">
            <input className={inputCls} type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
          </Field>
          <Button type="submit" disabled={busy || !token} className="w-full">
            {busy ? 'Resetting…' : 'Reset password'}
          </Button>
          {!token && <p className="text-sm text-red-600">This link has no reset token.</p>}
        </form>
      )}
    </AuthShell>
  );
}
