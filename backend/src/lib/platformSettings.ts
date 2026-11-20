/**
 * Platform settings reader (Platform Admin Panel, 2026-11-20).
 *
 * Lives in lib/ (not modules/platform/) so modules/auth can read the
 * signup gates without a circular import: platform/service.ts imports
 * auth/service.ts (resendVerification / forgotPassword reuse), so the
 * settings reader cannot live in platform/service.ts.
 *
 * Defaults when the table/rows are absent (fresh DB, pre-migration, or a
 * test fake without the delegate): registration OPEN, maintenance OFF,
 * no notice. Missing rows never close registration by accident.
 */
import type { Db } from './db';

export interface PlatformNotice {
  text: string;
  created_at: string;
  created_by?: string | null;
}

export interface PlatformSettings {
  registration_open: boolean;
  maintenance_mode: boolean;
  notice: PlatformNotice | null;
}

const DEFAULTS: PlatformSettings = { registration_open: true, maintenance_mode: false, notice: null };

export async function readPlatformSettings(db: Db): Promise<PlatformSettings> {
  const delegate = (db as any)?.platformSetting;
  if (!delegate || typeof delegate.findMany !== 'function') return { ...DEFAULTS };
  try {
    const rows: any[] = await delegate.findMany({});
    const out: PlatformSettings = { ...DEFAULTS };
    for (const row of rows) {
      if (row.key === 'registration_open' && typeof row.value === 'boolean') out.registration_open = row.value;
      if (row.key === 'maintenance_mode' && typeof row.value === 'boolean') out.maintenance_mode = row.value;
      if (row.key === 'platform_notice' && row.value && typeof row.value === 'object') {
        const v = row.value as Record<string, unknown>;
        if (typeof v.text === 'string' && v.text.trim()) {
          out.notice = {
            text: v.text,
            created_at: typeof v.created_at === 'string' ? v.created_at : '',
            created_by: typeof v.created_by === 'string' ? v.created_by : null,
          };
        }
      }
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

export async function readPlatformNotice(db: Db): Promise<PlatformNotice | null> {
  return (await readPlatformSettings(db)).notice;
}
