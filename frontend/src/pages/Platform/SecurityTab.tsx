// Security tab — recent logins, platform admins with 2FA status,
// and sessions with "Revoke all sessions" per user. Revocation takes
// effect at next refresh and access tokens expire within 15 minutes.
import { useCallback, useEffect, useState } from 'react';
import { platformApi, type PlatformAdminRow, type PlatformLoginRow, type PlatformSessionRow } from '../../lib/platform';
import { fmtDateTime } from '../../lib/utils';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Spinner, inputCls, useToast } from '../../components/ui';
import ConfirmDialog from '../../components/ConfirmDialog';
import { errText } from './shared';

function asItems<T>(v: { items: T[] } | T[]): T[] {
  return Array.isArray(v) ? v : (v.items ?? []);
}

export default function SecurityTab() {
  const { push, view } = useToast();
  const [days, setDays] = useState(7);
  const [logins, setLogins] = useState<PlatformLoginRow[]>([]);
  const [loginsLoading, setLoginsLoading] = useState(true);
  const [loginsError, setLoginsError] = useState('');

  const [admins, setAdmins] = useState<PlatformAdminRow[]>([]);
  const [adminsLoading, setAdminsLoading] = useState(true);
  const [adminsError, setAdminsError] = useState('');

  const [sessions, setSessions] = useState<PlatformSessionRow[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<{ user_id: string; email?: string | null } | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const loadLogins = useCallback(async () => {
    setLoginsLoading(true);
    setLoginsError('');
    try {
      const d = await platformApi.listLogins(days);
      setLogins(asItems(d));
    } catch (e) {
      setLoginsError(errText(e));
    } finally {
      setLoginsLoading(false);
    }
  }, [days]);

  const loadAdmins = useCallback(async () => {
    setAdminsLoading(true);
    setAdminsError('');
    try {
      const d = await platformApi.listPlatformAdmins();
      setAdmins(Array.isArray(d) ? d : (d.admins ?? []));
    } catch (e) {
      setAdminsError(errText(e));
    } finally {
      setAdminsLoading(false);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError('');
    try {
      const d = await platformApi.listSessions();
      setSessions(asItems(d));
    } catch (e) {
      setSessionsError(errText(e));
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLogins();
  }, [loadLogins]);
  useEffect(() => {
    void loadAdmins();
  }, [loadAdmins]);
  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const doRevoke = async () => {
    if (!revokeTarget) return;
    setRevokeBusy(true);
    try {
      await platformApi.revokeSessions(revokeTarget.user_id);
      push('success', `All sessions revoked for ${revokeTarget.email ?? revokeTarget.user_id}.`);
      setRevokeTarget(null);
      await loadSessions();
    } catch (e) {
      push('error', errText(e));
    } finally {
      setRevokeBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">Recent logins</h2>
          <Field label="Days">
            <select className={inputCls} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Login history days">
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </Field>
        </div>
        {loginsError && <ErrorBanner message={loginsError} onRetry={loadLogins} />}
        {loginsLoading ? (
          <Spinner label="Loading recent logins…" />
        ) : logins.length === 0 ? (
          <EmptyState title="No logins recorded" body={`No login attempts in the last ${days} days.`} />
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">When</th>
                    <th className="px-4 py-3">User</th>
                    <th className="px-4 py-3">School</th>
                    <th className="px-4 py-3">IP</th>
                    <th className="px-4 py-3">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {logins.map((l, i) => (
                    <tr key={l.id ?? i} className="border-b border-slate-100">
                      <td className="px-4 py-3 text-slate-600">{fmtDateTime(l.created_at)}</td>
                      <td className="px-4 py-3 font-medium text-slate-900">{l.email ?? l.user_id ?? '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{l.school_name ?? l.school_id ?? '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{l.ip ?? '—'}</td>
                      <td className="px-4 py-3">
                        {l.success === true ? <Badge tone="green">Success</Badge> : l.success === false ? <Badge tone="red">Failed</Badge> : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-base font-semibold text-slate-900">Platform admins</h2>
        {adminsError && <ErrorBanner message={adminsError} onRetry={loadAdmins} />}
        {adminsLoading ? (
          <Spinner label="Loading platform admins…" />
        ) : admins.length === 0 ? (
          <EmptyState title="No platform admins found" body="Only platform admins can see this list." />
        ) : (
          <Card>
            <ul className="divide-y divide-slate-100">
              {admins.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{a.email}</p>
                    <p className="text-xs text-slate-500">{a.school_name ?? 'No school'} · Since {a.created_at ? fmtDateTime(a.created_at) : '—'}</p>
                  </div>
                  {a.totp_enabled ? <Badge tone="green">2FA enabled</Badge> : <Badge tone="red">2FA NOT enabled</Badge>}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-base font-semibold text-slate-900">Sessions</h2>
        <p className="text-sm text-slate-500">
          Revoking a user&apos;s sessions signs them out at their next refresh. Access tokens expire within 15
          minutes, so a revoked session can keep working for up to 15 minutes.
        </p>
        {sessionsError && <ErrorBanner message={sessionsError} onRetry={loadSessions} />}
        {sessionsLoading ? (
          <Spinner label="Loading sessions…" />
        ) : sessions.length === 0 ? (
          <EmptyState title="No active sessions" body="No sessions are recorded right now." />
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">User</th>
                    <th className="px-4 py-3">School</th>
                    <th className="px-4 py-3">Started</th>
                    <th className="px-4 py-3">Last seen</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s, i) => (
                    <tr key={s.id ?? `${s.user_id}-${i}`} className="border-b border-slate-100">
                      <td className="px-4 py-3 font-medium text-slate-900">{s.email ?? s.user_id}</td>
                      <td className="px-4 py-3 text-slate-600">{s.school_name ?? '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{fmtDateTime(s.created_at)}</td>
                      <td className="px-4 py-3 text-slate-600">{s.last_seen_at ? fmtDateTime(s.last_seen_at) : '—'}</td>
                      <td className="px-4 py-3">
                        <Button variant="danger" onClick={() => setRevokeTarget({ user_id: s.user_id, email: s.email })}>
                          Revoke all sessions
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke all sessions for this user?"
        message={
          revokeTarget
            ? `This signs ${revokeTarget.email ?? revokeTarget.user_id} out everywhere at their next refresh. Their access token can keep working for up to 15 minutes.`
            : ''
        }
        confirmLabel="Revoke all sessions"
        tone="danger"
        busy={revokeBusy}
        onConfirm={() => void doRevoke()}
        onCancel={() => setRevokeTarget(null)}
      />
      {view}
    </div>
  );
}
