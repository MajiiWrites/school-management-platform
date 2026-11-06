/**
 * Security page (6D, admin only).
 *
 * Five tabs, all using the existing 6A endpoints — no new backend auth
 * endpoints were needed:
 * - Two-factor auth: POST /auth/2fa/setup, /verify, /disable (+ /auth/me
 *   for the current totp_enabled flag).
 * - Roles & permissions: GET /roles/permissions, PATCH /roles/permissions,
 *   GET /users, POST /users/principals.
 * - Data & privacy: POST /export/all (password-confirmed download),
 *   POST /account/delete-request, GET /account/delete-requests,
 *   PATCH /account/delete-requests/:id.
 * - Login alerts: GET /notifications (filtered to type login_alert),
 *   POST /notifications/:id/read.
 * - Backups: GET /backups, POST /backups/run.
 */
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import type { NotificationItem, PageResult } from '../lib/types';
import { fmtDateTime } from '../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, inputCls, Spinner, Tabs, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

interface RolePermission {
  role: string;
  resource: string;
  action: string;
  allowed: boolean;
}

interface UserRow {
  id: string;
  email: string;
  role: string;
  email_verified: boolean;
  last_login_at?: string | null;
}

interface BackupRow {
  id: string;
  file_ref: string;
  size_bytes?: number | null;
  created_at: string;
}

interface DeletionRequest {
  id: string;
  status: string;
  requested_at: string;
  completed_at?: string | null;
}

const ACTIONS = ['view', 'create', 'update', 'delete', 'approve', 'export'];
const ROLES = ['admin', 'clerk', 'principal'];

export default function SecurityPage() {
  const [tab, setTab] = useState('2fa');
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Security</h1>
        <p className="text-sm text-slate-500">Two-factor authentication, roles &amp; permissions, your data, login alerts and backups. Admin only.</p>
      </div>
      <Tabs
        tabs={[
          { key: '2fa', label: 'Two-factor auth' },
          { key: 'roles', label: 'Roles & permissions' },
          { key: 'data', label: 'Data & privacy' },
          { key: 'alerts', label: 'Login alerts' },
          { key: 'backups', label: 'Backups' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === '2fa' && <TwoFactorTab />}
      {tab === 'roles' && <RolesTab />}
      {tab === 'data' && <DataTab />}
      {tab === 'alerts' && <LoginAlertsTab />}
      {tab === 'backups' && <BackupsTab />}
    </div>
  );
}

/* ---------- Two-factor authentication ---------- */

function TwoFactorTab() {
  const { user } = useAuth();
  const { push, view } = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [setup, setSetup] = useState<{ otpauth_url: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    api<{ user: { totp_enabled?: boolean } }>('/auth/me')
      .then((me) => setEnabled(me.user.totp_enabled ?? false))
      .catch(() => setEnabled(user?.totp_enabled ?? false));
  }, [user]);

  const startSetup = async () => {
    setBusy(true);
    try {
      const data = await api<{ otpauth_url: string; secret: string }>('/auth/2fa/setup', { method: 'POST' });
      setSetup(data);
    } catch (err) {
      push('error', errText(err));
    } finally {
      setBusy(false);
    }
  };

  const verifySetup = async (e: FormEvent) => {
    e.preventDefault();
    if (!setup) return;
    setBusy(true);
    try {
      await api('/auth/2fa/verify', { method: 'POST', body: { code, secret: setup.secret } });
      setEnabled(true);
      setSetup(null);
      setCode('');
      push('success', 'Two-factor authentication is now on.');
    } catch (err) {
      push('error', errText(err));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setConfirmDisable(false);
    setBusy(true);
    try {
      await api('/auth/2fa/disable', { method: 'POST', body: { password } });
      setEnabled(false);
      setPassword('');
      push('success', 'Two-factor authentication is off.');
    } catch (err) {
      push('error', errText(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(''), 2000);
    } catch {
      push('error', 'Could not copy — select the text and copy it manually.');
    }
  };

  if (enabled === null) return <Spinner label="Loading security settings…" />;

  return (
    <div className="space-y-4">
      <Card className="max-w-2xl p-5">
        {enabled ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Badge tone="green">On</Badge>
              <p className="text-sm font-medium text-slate-800">Two-factor authentication is on for your account.</p>
            </div>
            <p className="text-sm text-slate-500">
              Signing in now asks for a 6-digit code from your authenticator app after your password. If you lose the
              authenticator, use “Forgot password” to recover the account, then set 2FA up again.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setConfirmDisable(true);
              }}
              className="space-y-3"
              autoComplete="off"
            >
              <Field label="Your password (to confirm turning 2FA off)">
                <input className={inputCls} type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
              </Field>
              <Button variant="danger" type="submit" disabled={busy || !password}>
                Turn off two-factor authentication
              </Button>
            </form>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Badge tone="amber">Off</Badge>
              <p className="text-sm font-medium text-slate-800">Two-factor authentication is off.</p>
            </div>
            <p className="text-sm text-slate-500">
              With 2FA on, signing in asks for a 6-digit code from an authenticator app (Google Authenticator, Authy,
              1Password) after your password — so a stolen password alone cannot open your school.
            </p>
            {!setup ? (
              <Button onClick={startSetup} disabled={busy}>
                {busy ? 'Starting…' : 'Set up two-factor authentication'}
              </Button>
            ) : (
              <form onSubmit={verifySetup} className="space-y-4" autoComplete="off">
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  Add this account to your authenticator app, then enter the 6-digit code it shows. The secret is
                  shown once — keep it somewhere safe in case you need to set the app up again.
                </div>
                <Field label="Secret (enter manually in your authenticator app)">
                  <div className="flex gap-2">
                    <input className={inputCls} readOnly value={setup.secret} autoComplete="off" onFocus={(e) => e.target.select()} />
                    <Button variant="secondary" onClick={() => copy('secret', setup.secret)}>
                      {copied === 'secret' ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                </Field>
                <Field label="Setup link (otpauth URL)">
                  <div className="flex gap-2">
                    <input className={inputCls} readOnly value={setup.otpauth_url} autoComplete="off" onFocus={(e) => e.target.select()} />
                    <Button variant="secondary" onClick={() => copy('url', setup.otpauth_url)}>
                      {copied === 'url' ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                </Field>
                <Field label="6-digit code from your authenticator app">
                  <input className={inputCls} type="text" inputMode="numeric" required pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" autoComplete="off" />
                </Field>
                <div className="flex gap-3">
                  <Button type="submit" disabled={busy || code.length !== 6}>
                    {busy ? 'Verifying…' : 'Verify & turn on 2FA'}
                  </Button>
                  <Button variant="secondary" onClick={() => setSetup(null)}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={confirmDisable}
        title="Turn off two-factor authentication?"
        message="Are you sure? Your account will be protected by password alone until you set 2FA up again."
        confirmLabel="Turn off 2FA"
        tone="danger"
        busy={busy}
        onConfirm={disable}
        onCancel={() => setConfirmDisable(false)}
      />
      {view}
    </div>
  );
}

/* ---------- Roles & permissions ---------- */

function RolesTab() {
  const { push, view } = useToast();
  const [perms, setPerms] = useState<RolePermission[] | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmPrincipal, setConfirmPrincipal] = useState(false);
  // D2: clerk creation lives here next to the Principal form (the backend
  // user record is email + password only — there is no name field on users,
  // so no name is collected or stored).
  const [clerkEmail, setClerkEmail] = useState('');
  const [clerkPassword, setClerkPassword] = useState('');
  const [confirmClerk, setConfirmClerk] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [p, u] = await Promise.all([
        api<PageResult<RolePermission>>('/roles/permissions'),
        api<PageResult<UserRow>>('/users'),
      ]);
      setPerms(p.items);
      setUsers(u.items);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async (role: string, resource: string, action: string, allowed: boolean) => {
    try {
      await api('/roles/permissions', { method: 'PATCH', body: { role, resource, action, allowed } });
      setPerms((prev) => (prev ?? []).map((p) => (p.role === role && p.resource === resource && p.action === action ? { ...p, allowed } : p)));
      push('success', `Permission ${allowed ? 'granted' : 'revoked'}: ${role} — ${resource} ${action}.`);
    } catch (err) {
      push('error', errText(err));
    }
  };

  const createClerk = async () => {
    setConfirmClerk(false);
    setBusy(true);
    try {
      await api('/users/clerks', { method: 'POST', body: { email: clerkEmail.trim(), password: clerkPassword } });
      push('success', `Clerk account created for ${clerkEmail.trim()}. Their creates, updates and deletes go to the Approval Queue — nothing applies until an admin approves it.`);
      setClerkEmail('');
      setClerkPassword('');
      await load();
    } catch (err) {
      push('error', errText(err));
    } finally {
      setBusy(false);
    }
  };

  const createPrincipal = async () => {
    setConfirmPrincipal(false);
    setBusy(true);
    try {
      await api('/users/principals', { method: 'POST', body: { email, password } });
      setEmail('');
      setPassword('');
      push('success', `Principal account created for ${email}. They can view, never change, school data.`);
      await load();
    } catch (err) {
      push('error', errText(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner label="Loading roles…" />;
  if (!perms) return <ErrorBanner message={error || 'Roles unavailable.'} />;

  const resources = [...new Set(perms.map((p) => p.resource))].sort();
  const cell = (role: string, resource: string, action: string) => perms.find((p) => p.role === role && p.resource === resource && p.action === action);

  return (
    <div className="space-y-5">
      {error && <ErrorBanner message={error} />}
      <Card className="p-5">
        <h2 className="text-base font-semibold text-slate-900">Permission matrix</h2>
        <p className="mt-1 text-sm text-slate-500">
          Admin permissions cannot be changed. Principals are view-only by design. Clerk creates, updates and deletes
          go to the approval queue instead of applying directly — an admin approves them first.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-2 py-2">Resource</th>
                {ROLES.map((r) => (
                  <th key={r} className="px-2 py-2 text-center capitalize">{r}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {resources.map((resource) => (
                <tr key={resource} className="border-b border-slate-100">
                  <td className="px-2 py-2 font-medium text-slate-800">{resource}</td>
                  {ROLES.map((role) => (
                    <td key={role} className="px-2 py-2 text-center">
                      <div className="flex flex-wrap items-center justify-center gap-1">
                        {ACTIONS.map((action) => {
                          const p = cell(role, resource, action);
                          if (!p) return null;
                          return (
                            <label key={action} title={`${role} — ${resource}: ${action}`} className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-slate-200 px-1.5 py-0.5 text-xs text-slate-600 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
                              <input
                                type="checkbox"
                                checked={p.allowed}
                                disabled={role === 'admin'}
                                onChange={(e) => void toggle(role, resource, action, e.target.checked)}
                              />
                              {action}
                            </label>
                          );
                        })}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="max-w-2xl p-5">
        <h2 className="text-base font-semibold text-slate-900">Create a Clerk account</h2>
        <p className="mt-1 text-sm text-slate-500">
          Clerks can view records and submit changes, but every create, update and delete goes to the Approval Queue
          instead of applying directly — an admin approves it first.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setConfirmClerk(true);
          }}
          className="mt-4 space-y-3"
          autoComplete="off"
        >
          <Field label="Clerk email">
            <input className={inputCls} type="email" required value={clerkEmail} onChange={(e) => setClerkEmail(e.target.value)} placeholder="clerk@school.pk" autoComplete="off" />
          </Field>
          <Field label="Temporary password">
            <input className={inputCls} type="password" required minLength={8} value={clerkPassword} onChange={(e) => setClerkPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" />
          </Field>
          <Button type="submit" disabled={busy || !clerkEmail || clerkPassword.length < 8}>
            Create Clerk account
          </Button>
        </form>
      </Card>

      <Card className="max-w-2xl p-5">
        <h2 className="text-base font-semibold text-slate-900">Create a Principal account</h2>
        <p className="mt-1 text-sm text-slate-500">Principals sign in like clerks but can only view — every change is blocked.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setConfirmPrincipal(true);
          }}
          className="mt-4 space-y-3"
          autoComplete="off"
        >
          <Field label="Principal email">
            <input className={inputCls} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="principal@school.pk" autoComplete="off" />
          </Field>
          <Field label="Temporary password">
            <input className={inputCls} type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" />
          </Field>
          <Button type="submit" disabled={busy || !email || password.length < 8}>
            Create Principal account
          </Button>
        </form>
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-slate-900">Logins for this school</h2>
        {users.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="No logins found" body="Only this admin account exists." />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {users.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="font-medium text-slate-800">{u.email}</span>
                <Badge tone={u.role === 'admin' ? 'blue' : u.role === 'principal' ? 'amber' : 'slate'}>{u.role}</Badge>
                {u.email_verified ? <Badge tone="green">email verified</Badge> : <Badge tone="red">email not verified</Badge>}
                {u.last_login_at && <span className="ml-auto text-xs text-slate-500">Last login {fmtDateTime(u.last_login_at)}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ConfirmDialog
        open={confirmClerk}
        title="Create a Clerk account?"
        message={`Are you sure? This creates a clerk login for ${clerkEmail.trim() || '—'}. Clerk creates, updates and deletes go to the Approval Queue — nothing applies until an admin approves it.`}
        confirmLabel="Create Clerk account"
        tone="primary"
        busy={busy}
        onConfirm={() => void createClerk()}
        onCancel={() => setConfirmClerk(false)}
      />
      <ConfirmDialog
        open={confirmPrincipal}
        title="Create a Principal account?"
        message={`Are you sure? This creates a view-only login for ${email}. Principals can see school data but cannot change, approve or delete anything.`}
        confirmLabel="Create Principal account"
        tone="primary"
        busy={busy}
        onConfirm={() => void createPrincipal()}
        onCancel={() => setConfirmPrincipal(false)}
      />
      {view}
    </div>
  );
}

/* ---------- Data & privacy ---------- */

function DataTab() {
  const { push, view } = useToast();
  const [requests, setRequests] = useState<DeletionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exportPassword, setExportPassword] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmExport, setConfirmExport] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [statusTarget, setStatusTarget] = useState<DeletionRequest | null>(null);
  const [statusValue, setStatusValue] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = await api<PageResult<DeletionRequest>>('/account/delete-requests');
      setRequests(data.items);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doExport = async () => {
    setConfirmExport(false);
    setBusy(true);
    try {
      const data = await api<unknown>('/export/all', { method: 'POST', body: { password: exportPassword } });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `school-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportPassword('');
      push('success', 'Full school export downloaded.');
    } catch (err) {
      push('error', errText(err));
    } finally {
      setBusy(false);
    }
  };

  const requestDeletion = async () => {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await api('/account/delete-request', { method: 'POST', body: { password: deletePassword } });
      setDeletePassword('');
      push('success', 'Account-deletion request filed. It is pending review.');
      await load();
    } catch (err) {
      push('error', errText(err));
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async () => {
    if (!statusTarget) return;
    const target = statusTarget;
    setStatusTarget(null);
    setBusy(true);
    try {
      await api(`/account/delete-requests/${target.id}`, { method: 'PATCH', body: { status: statusValue } });
      push('success', `Deletion request marked ${statusValue}.`);
      await load();
    } catch (err) {
      push('error', errText(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner label="Loading data requests…" />;

  return (
    <div className="space-y-5">
      {error && <ErrorBanner message={error} />}
      <Card className="max-w-2xl p-5">
        <h2 className="text-base font-semibold text-slate-900">Export all school data</h2>
        <p className="mt-1 text-sm text-slate-500">
          Downloads a JSON file with every table for this school — the same export the nightly backup writes. Parent
          phone numbers are included decrypted: this is your own data, so store the file somewhere safe and never share
          it. Your password is asked to confirm it is really you.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setConfirmExport(true);
          }}
          className="mt-4 space-y-3"
          autoComplete="off"
        >
          <Field label="Your password (to confirm the export)">
            <input className={inputCls} type="password" required value={exportPassword} onChange={(e) => setExportPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
          </Field>
          <Button type="submit" disabled={busy || !exportPassword}>
            Download full export
          </Button>
        </form>
      </Card>

      <Card className="max-w-2xl p-5">
        <h2 className="text-base font-semibold text-slate-900">Request account deletion</h2>
        <p className="mt-1 text-sm text-slate-500">
          Filing a request only records it — nothing is deleted automatically. A person reviews the request and carries
          out the deletion, then marks it completed. This protects the school from an accidental or malicious wipe.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setConfirmDelete(true);
          }}
          className="mt-4 space-y-3"
          autoComplete="off"
        >
          <Field label="Your password (to confirm the request)">
            <input className={inputCls} type="password" required value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
          </Field>
          <Button variant="danger" type="submit" disabled={busy || !deletePassword}>
            Request account deletion
          </Button>
        </form>
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-slate-900">Deletion requests</h2>
        {requests.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="No deletion requests" body="Nobody has asked for the school account to be deleted." />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="text-slate-700">Requested {fmtDateTime(r.requested_at)}</span>
                <Badge tone={r.status === 'completed' ? 'green' : r.status === 'rejected' ? 'red' : r.status === 'approved' ? 'blue' : 'amber'}>{r.status}</Badge>
                {r.completed_at && <span className="text-xs text-slate-500">Completed {fmtDateTime(r.completed_at)}</span>}
                <span className="ml-auto flex items-center gap-2">
                  <select
                    className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
                    value={r.status}
                    onChange={(e) => {
                      setStatusValue(e.target.value);
                      setStatusTarget(r);
                    }}
                    aria-label="Change request status"
                  >
                    {['pending', 'approved', 'completed', 'rejected'].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ConfirmDialog
        open={confirmExport}
        title="Download the full school export?"
        message="Are you sure? The file contains every record for this school, including parent phone numbers in full. Store it somewhere safe and never share it."
        confirmLabel="Download export"
        tone="primary"
        busy={busy}
        onConfirm={() => void doExport()}
        onCancel={() => setConfirmExport(false)}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="File an account-deletion request?"
        message="Are you sure? This only files the request — nothing is deleted until a person reviews it and carries the deletion out."
        confirmLabel="File deletion request"
        tone="danger"
        busy={busy}
        onConfirm={() => void requestDeletion()}
        onCancel={() => setConfirmDelete(false)}
      />
      <ConfirmDialog
        open={statusTarget !== null}
        title="Change this deletion request?"
        message={`Are you sure? This marks the request as “${statusValue}”. Marking it completed means the deletion was actually carried out.`}
        confirmLabel={`Mark ${statusValue}`}
        tone="primary"
        busy={busy}
        onConfirm={() => void changeStatus()}
        onCancel={() => setStatusTarget(null)}
      />
      {view}
    </div>
  );
}

/* ---------- Login alerts ---------- */

function LoginAlertsTab() {
  const { push, view } = useToast();
  const [alerts, setAlerts] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = await api<PageResult<NotificationItem>>('/notifications?limit=100');
      setAlerts(data.items.filter((n) => n.type === 'login_alert'));
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markRead = async (id: string) => {
    try {
      await api(`/notifications/${id}/read`, { method: 'POST' });
      setAlerts((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)));
    } catch (err) {
      push('error', errText(err));
    }
  };

  if (loading) return <Spinner label="Loading login alerts…" />;

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} />}
      <Card className="p-5">
        <h2 className="text-base font-semibold text-slate-900">Login alerts</h2>
        <p className="mt-1 text-sm text-slate-500">
          An alert is created whenever your account signs in from a different IP address than the last login. If you
          see a login you do not recognise, change your password and turn on two-factor authentication.
        </p>
        {alerts.length === 0 ? (
          <div className="mt-4">
            <EmptyState title="No login alerts" body="No sign-in from a new IP address has been seen." />
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-slate-100">
            {alerts.map((n) => (
              <li key={n.id} className="flex flex-wrap items-start gap-2 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-800">{n.title}</p>
                  <p className="text-sm text-slate-500">{n.body}</p>
                  <p className="mt-0.5 text-xs text-slate-400">{fmtDateTime(n.created_at)}</p>
                </div>
                {n.is_read ? (
                  <Badge tone="slate">read</Badge>
                ) : (
                  <Button variant="secondary" onClick={() => void markRead(n.id)}>
                    Mark read
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {view}
    </div>
  );
}

/* ---------- Backups ---------- */

function BackupsTab() {
  const { push, view } = useToast();
  const [rows, setRows] = useState<BackupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRun, setConfirmRun] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api<PageResult<BackupRow>>('/backups');
      setRows(data.items);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runNow = async () => {
    setConfirmRun(false);
    setBusy(true);
    try {
      const data = await api<{ file: string; sizeBytes: number }>('/backups/run', { method: 'POST' });
      push('success', `Backup written: ${data.file} (${formatBytes(data.sizeBytes)}).`);
      await load();
    } catch (err) {
      push('error', errText(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner label="Loading backups…" />;

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} />}
      <Card className="max-w-2xl p-5">
        <h2 className="text-base font-semibold text-slate-900">Automatic nightly backup</h2>
        <p className="mt-1 text-sm text-slate-500">
          Every night at 02:00 UTC the server writes a full backup of this school (same contents as the manual export,
          phones included) to the server and records it here. Honest limit: on the free hosting plan the server disk
          does not survive a redeploy, so a nightly file alone is not a durable backup — download the manual export
          from the Data &amp; privacy tab and keep it somewhere safe for the copy that must survive.
        </p>
        <div className="mt-4">
          <Button onClick={() => setConfirmRun(true)} disabled={busy}>
            {busy ? 'Backing up…' : 'Run a backup now'}
          </Button>
        </div>
      </Card>
      <Card className="p-5">
        <h2 className="text-base font-semibold text-slate-900">Backup history</h2>
        {rows.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              title="No backups yet"
              body="No nightly backup has run for this school yet. Run one now, or wait for tonight's automatic backup."
              actionLabel="Run a backup now"
              onAction={() => setConfirmRun(true)}
            />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="font-mono text-xs text-slate-700">{r.file_ref}</span>
                <Badge tone="green">{formatBytes(r.size_bytes)}</Badge>
                <span className="ml-auto text-xs text-slate-500">{fmtDateTime(r.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ConfirmDialog
        open={confirmRun}
        title="Run a backup now?"
        message="Are you sure? This writes a fresh full backup of this school to the server right now (same contents as the manual export)."
        confirmLabel="Run backup"
        tone="primary"
        busy={busy}
        onConfirm={() => void runNow()}
        onCancel={() => setConfirmRun(false)}
      />
      {view}
    </div>
  );
}
