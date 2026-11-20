// Users tab — list + filters, detail, Disable / Enable, Force
// re-verification, Send password reset (existing reset email — never
// a password field), Promote to platform admin (only offered when the
// target has 2FA enabled; the backend enforces it too and its error
// is shown verbatim), Demote.
import { useCallback, useEffect, useState } from 'react';
import { platformApi, type PlatformUser } from '../../lib/platform';
import { fmtDateTime } from '../../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Pager, Spinner, inputCls, useToast } from '../../components/ui';
import ConfirmDialog from '../../components/ConfirmDialog';
import { errText } from './shared';

type Action = 'disable' | 'enable' | 'reverify' | 'reset-password' | 'promote' | 'demote';

const ACTION_LABELS: Record<Action, string> = {
  disable: 'Disable user',
  enable: 'Enable user',
  reverify: 'Force re-verification',
  'reset-password': 'Send password reset',
  promote: 'Promote to platform admin',
  demote: 'Demote to school admin',
};

const ACTION_MESSAGES: Record<Action, string> = {
  disable: 'The user will not be able to sign in until they are enabled again.',
  enable: 'The user will be able to sign in again.',
  reverify: 'The user will have to verify their email again before signing in.',
  'reset-password': 'This sends the existing password-reset email to the user. No password is set or shown here.',
  promote: 'This gives the user full platform-admin access across every school. The backend requires 2FA on the target account.',
  demote: 'This removes platform-admin access. The user keeps their school admin role.',
};

export default function UsersTab() {
  const { push, view } = useToast();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [verified, setVerified] = useState('');
  const [disabled, setDisabled] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<PlatformUser[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<PlatformUser | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<Action | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await platformApi.listUsers({
        search: search || undefined,
        role: role || undefined,
        verified: verified || undefined,
        disabled: disabled || undefined,
        page,
        limit: 20,
      });
      setRows(d.items);
      setTotal(d.total);
      setPages(d.pages);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [search, role, verified, disabled, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (u: PlatformUser) => {
    setSelected(u);
    setDetailLoading(true);
    try {
      const d = await platformApi.getUser(u.id);
      setSelected(d);
    } catch (e) {
      push('error', errText(e));
    } finally {
      setDetailLoading(false);
    }
  };

  const refreshDetail = async (id: string) => {
    try {
      const d = await platformApi.getUser(id);
      setSelected(d);
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...d } : r)));
    } catch {
      await load();
    }
  };

  const runAction = async (action: Action) => {
    if (!selected) return;
    const id = selected.id;
    const label = ACTION_LABELS[action];
    setBusy(true);
    try {
      if (action === 'disable') await platformApi.disableUser(id);
      else if (action === 'enable') await platformApi.enableUser(id);
      else if (action === 'reverify') await platformApi.reverifyUser(id);
      else if (action === 'reset-password') await platformApi.resetPasswordUser(id);
      else if (action === 'promote') await platformApi.promoteUser(id);
      else await platformApi.demoteUser(id);
      push('success', `${label}: done for ${selected.email}.`);
      setPendingAction(null);
      await refreshDetail(id);
    } catch (e) {
      // The backend's own message (e.g. the 2FA requirement on promote)
      // is shown verbatim — never replaced with a guess.
      push('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const canPromote = selected !== null && selected.role !== 'platform_admin';
  const promoteBlockedBy2fa = canPromote && selected?.totp_enabled !== true;

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Search users">
          <input className={inputCls} value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Email or name" aria-label="Search users" />
        </Field>
        <Field label="Role">
          <select className={inputCls} value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }} aria-label="Filter by role">
            <option value="">All roles</option>
            <option value="admin">School admin</option>
            <option value="clerk">Clerk</option>
            <option value="principal">Principal</option>
            <option value="platform_admin">Platform admin</option>
          </select>
        </Field>
        <Field label="Verification">
          <select className={inputCls} value={verified} onChange={(e) => { setVerified(e.target.value); setPage(1); }} aria-label="Filter by verification">
            <option value="">All</option>
            <option value="true">Verified</option>
            <option value="false">Unverified</option>
          </select>
        </Field>
        <Field label="Account status">
          <select className={inputCls} value={disabled} onChange={(e) => { setDisabled(e.target.value); setPage(1); }} aria-label="Filter by disabled status">
            <option value="">All</option>
            <option value="true">Disabled</option>
            <option value="false">Enabled</option>
          </select>
        </Field>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}
      {loading ? (
        <Spinner label="Loading users…" />
      ) : rows.length === 0 ? (
        <EmptyState title="No users found" body="Try widening the search or clearing a filter." />
      ) : (
        <>
          <Pager page={page} pages={pages} total={total} itemLabel="users" itemLabelSingular="user" onPage={setPage} />
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">User</th>
                    <th className="px-4 py-3">Role</th>
                    <th className="px-4 py-3">School</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => (
                    <tr key={u.id} className="cursor-pointer border-b border-slate-100 hover:bg-slate-50" onClick={() => void openDetail(u)}>
                      <td className="px-4 py-3 font-medium text-slate-900">{u.email}</td>
                      <td className="px-4 py-3 text-slate-600">{u.role}</td>
                      <td className="px-4 py-3 text-slate-600">{u.school_name ?? '—'}</td>
                      <td className="px-4 py-3">
                        <span className="flex flex-wrap gap-1">
                          {u.disabled ? <Badge tone="red">Disabled</Badge> : <Badge tone="green">Enabled</Badge>}
                          {u.email_verified === true ? <Badge tone="green">Verified</Badge> : u.email_verified === false ? <Badge tone="amber">Unverified</Badge> : null}
                          {u.totp_enabled ? <Badge tone="blue">2FA on</Badge> : null}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{u.created_at ? fmtDateTime(u.created_at) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {selected && (
        <Card className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">{selected.email}</h2>
              <p className="text-sm text-slate-500">
                {selected.role} {selected.school_name ? `· ${selected.school_name}` : ''}
              </p>
            </div>
            <Button variant="secondary" onClick={() => setSelected(null)}>Close</Button>
          </div>
          {detailLoading ? (
            <Spinner label="Loading user details…" />
          ) : (
            <>
              <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
                <div><dt className="text-slate-500">Email verified</dt><dd className="font-medium text-slate-900">{selected.email_verified === true ? 'Yes' : selected.email_verified === false ? 'No' : 'Unknown'}</dd></div>
                <div><dt className="text-slate-500">2FA enabled</dt><dd className="font-medium text-slate-900">{selected.totp_enabled === true ? 'Yes' : selected.totp_enabled === false ? 'No' : 'Unknown'}</dd></div>
                <div><dt className="text-slate-500">Account</dt><dd className="font-medium text-slate-900">{selected.disabled ? 'Disabled' : 'Enabled'}</dd></div>
                <div><dt className="text-slate-500">Last login</dt><dd className="font-medium text-slate-900">{selected.last_login_at ? fmtDateTime(selected.last_login_at) : '—'}</dd></div>
              </dl>
              <div className="mt-4 flex flex-wrap gap-2">
                {selected.disabled ? (
                  <Button variant="success" disabled={busy} onClick={() => setPendingAction('enable')}>Enable user</Button>
                ) : (
                  <Button variant="secondary" disabled={busy} onClick={() => setPendingAction('disable')}>Disable user</Button>
                )}
                <Button variant="secondary" disabled={busy} onClick={() => setPendingAction('reverify')}>Force re-verification</Button>
                <Button variant="secondary" disabled={busy} onClick={() => setPendingAction('reset-password')}>Send password reset</Button>
                {selected.role === 'platform_admin' ? (
                  <Button variant="secondary" disabled={busy} onClick={() => setPendingAction('demote')}>Demote to school admin</Button>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={busy || promoteBlockedBy2fa}
                    title={promoteBlockedBy2fa ? 'The target must have 2FA enabled before they can be promoted to platform admin.' : undefined}
                    onClick={() => setPendingAction('promote')}
                  >
                    Promote to platform admin
                  </Button>
                )}
              </div>
              {promoteBlockedBy2fa && (
                <p className="mt-2 text-xs text-amber-700">
                  Promote is unavailable: this account does not have 2FA enabled. The backend enforces the same rule.
                </p>
              )}
            </>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={pendingAction !== null && selected !== null}
        title={pendingAction ? ACTION_LABELS[pendingAction] : ''}
        message={selected && pendingAction ? `${ACTION_LABELS[pendingAction]} for ${selected.email}? ${ACTION_MESSAGES[pendingAction]}` : ''}
        confirmLabel={pendingAction ? ACTION_LABELS[pendingAction] : 'Confirm'}
        tone={pendingAction === 'disable' || pendingAction === 'demote' ? 'danger' : 'primary'}
        busy={busy}
        onConfirm={() => {
          const a = pendingAction;
          if (a) void runAction(a);
        }}
        onCancel={() => setPendingAction(null)}
      />
      {view}
    </div>
  );
}
