// Settings tab — registration on/off, maintenance mode (with the
// warning that it blocks all school logins until switched off), and
// the platform notice editor (publish / clear; shown on school
// dashboards).
import { useCallback, useEffect, useState } from 'react';
import { platformApi, type PlatformSettings } from '../../lib/platform';
import { fmtDateTime } from '../../lib/utils';
import { Button, Card, EmptyState, ErrorBanner, Field, Spinner, inputCls, useToast } from '../../components/ui';
import ConfirmDialog from '../../components/ConfirmDialog';
import { errText } from './shared';

export default function SettingsTab() {
  const { push, view } = useToast();
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [noticeText, setNoticeText] = useState('');
  const [noticeDirty, setNoticeDirty] = useState(false);
  const [maintenanceTarget, setMaintenanceTarget] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await platformApi.getSettings();
      setSettings(d);
      setNoticeText(d.notice?.text ?? '');
      setNoticeDirty(false);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: { registration_open?: boolean; maintenance_mode?: boolean; notice?: { text: string } | null }) => {
    setBusy(true);
    try {
      const d = await platformApi.updateSettings(patch);
      setSettings(d);
      setNoticeText(d.notice?.text ?? '');
      setNoticeDirty(false);
      push('success', 'Platform settings saved.');
    } catch (e) {
      push('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner label="Loading platform settings…" />;
  if (error) return <ErrorBanner message={error} onRetry={load} />;
  if (!settings) return <EmptyState title="No platform settings" body="The settings endpoint returned nothing." />;

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <h2 className="text-base font-semibold text-slate-900">Registration</h2>
        <p className="mt-1 text-sm text-slate-500">
          When registration is off, new schools cannot sign up. Existing schools are unaffected.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant={settings.registration_open ? 'secondary' : 'primary'}
            disabled={busy}
            onClick={() => void save({ registration_open: !settings.registration_open })}
          >
            {settings.registration_open ? 'Registration is open — turn it off' : 'Registration is closed — turn it on'}
          </Button>
          <span className="text-sm font-medium text-slate-700">{settings.registration_open ? 'Open' : 'Closed'}</span>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-slate-900">Maintenance mode</h2>
        <p className="mt-1 text-sm text-slate-500">
          When maintenance mode is on, every school login is blocked and schools see a maintenance page instead of
          the portal. Platform admins can still sign in. It stays on until a platform admin switches it off.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant={settings.maintenance_mode ? 'danger' : 'secondary'}
            disabled={busy}
            onClick={() => setMaintenanceTarget(!settings.maintenance_mode)}
          >
            {settings.maintenance_mode ? 'Maintenance mode is ON — turn it off' : 'Turn maintenance mode on'}
          </Button>
          <span className="text-sm font-medium text-slate-700">{settings.maintenance_mode ? 'ON — all school logins blocked' : 'Off'}</span>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-slate-900">Platform notice</h2>
        <p className="mt-1 text-sm text-slate-500">
          Shown as a banner on every school&apos;s dashboard until it is cleared.
          {settings.notice ? ` Currently published ${fmtDateTime(settings.notice.created_at)}.` : ' No notice is published right now.'}
        </p>
        <Field label="Notice text">
          <textarea
            className={inputCls}
            rows={3}
            value={noticeText}
            onChange={(e) => {
              setNoticeText(e.target.value);
              setNoticeDirty(true);
            }}
            placeholder="e.g. Scheduled maintenance on Sunday, 2–4 AM PKT. The portal will be unavailable."
            aria-label="Platform notice text"
          />
        </Field>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy || !noticeText.trim()} onClick={() => void save({ notice: { text: noticeText.trim() } })}>
            Publish notice
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !settings.notice}
            onClick={() => void save({ notice: null })}
          >
            Clear notice
          </Button>
          {noticeDirty && <span className="self-center text-xs text-slate-500">Unsaved changes</span>}
        </div>
      </Card>

      <ConfirmDialog
        open={maintenanceTarget !== null}
        title={maintenanceTarget ? 'Turn maintenance mode on?' : 'Turn maintenance mode off?'}
        message={
          maintenanceTarget
            ? 'This blocks ALL school logins immediately — every school sees a maintenance page instead of the portal. Platform admins can still sign in. It stays on until you switch it off.'
            : 'This restores school logins immediately.'
        }
        confirmLabel={maintenanceTarget ? 'Turn maintenance mode on' : 'Turn maintenance mode off'}
        tone={maintenanceTarget ? 'danger' : 'primary'}
        busy={busy}
        onConfirm={() => {
          const target = maintenanceTarget;
          setMaintenanceTarget(null);
          if (target !== null) void save({ maintenance_mode: target });
        }}
        onCancel={() => setMaintenanceTarget(null)}
      />
      {view}
    </div>
  );
}
