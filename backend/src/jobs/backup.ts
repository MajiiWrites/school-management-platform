/**
 * Automatic per-school backup (6D).
 *
 * Nightly job (`school_backup`, 02:00 UTC tick in the registry): for EACH
 * school, export its full tenant data with the 6A `exportSchoolData`
 * helper (same shape as POST /export/all — phones FULLY decrypted, because
 * it is the school's own backup) and write it to a JSON file under
 * `backend/backups/<school-slug>/<YYYY-MM-DD>.json` (school-local date),
 * then write a `school_backups` row (`school_id`, `file_ref`, `size_bytes`,
 * `created_at`). The row is the durable log; `GET /backups` (hardening
 * routes) lists it.
 *
 * ⚠️ EPHEMERAL-DISK CAVEAT (be honest): on the Render free tier the local
 * disk does not survive a redeploy/restart, so a nightly file written here
 * is NOT a durable backup by itself. The durable copy is the admin's manual
 * export (POST /export/all → download the JSON and keep it somewhere safe).
 * The nightly job exists so a recent copy is always on the server to grab,
 * and so the `school_backups` log shows backup health. On a host with a
 * persistent disk (or with BACKUP_DIR pointed at mounted storage) the files
 * do survive. See SECURITY-6D.md for the restore procedure.
 *
 * No schema change: `school_backups` has no `status` column, so a row
 * existing means the backup succeeded; a failed run writes no row (the
 * failure is recorded in the job run records + server log instead).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { exportSchoolData } from '../modules/hardening/export';
import { localDateString } from './date-utils';
import type { SchoolRow } from './common';
import type { Db } from '../lib/db';

/** Nil UUID — used as the audit actor only when a school has no admin user
 * (cannot happen for a school created via signup — the last admin cannot be
 * deleted — but the job must not crash a whole tick over it). */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Base directory for backup files. Override with BACKUP_DIR (absolute or
 * relative to the backend/ dir) — e.g. a mounted persistent volume. */
export function resolveBackupDir(): string {
  const env = process.env.BACKUP_DIR;
  if (env) return path.resolve(env);
  return path.resolve(__dirname, '../../backups');
}

/** File reference stored in `school_backups.file_ref` (relative to backend/). */
export function backupFileRef(slug: string, dateStr: string): string {
  return `backups/${slug}/${dateStr}.json`;
}

export interface BackupResult {
  ran: boolean;
  school: string;
  file: string;
  sizeBytes: number;
  tables: number;
  exportedAt: string;
  reason?: string;
}

/**
 * Back up ONE school: export → write file → write school_backups row.
 * Idempotent for a given day (same-day re-runs overwrite the same file and
 * add another log row; the file content is a full snapshot either way).
 */
export async function runSchoolBackup(
  db: Db,
  school: SchoolRow,
  opts: { baseDir?: string; now?: Date } = {},
): Promise<BackupResult> {
  const now = opts.now ?? new Date();
  const baseDir = opts.baseDir ?? resolveBackupDir();
  const dateStr = localDateString(now, school.timezone);

  // exportSchoolData writes an audit_logs row; attribute it to the school's
  // first admin (a system job has no user of its own).
  const admin: any = await db.user.findFirst({
    where: { schoolId: school.id, role: 'admin' },
    orderBy: { createdAt: 'asc' },
  });
  const actorId = admin?.id ?? NIL_UUID;

  const data = await exportSchoolData(db, school.id, actorId);
  const json = JSON.stringify(data, null, 2);
  const sizeBytes = Buffer.byteLength(json, 'utf8');

  const dir = path.join(baseDir, school.slug);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${dateStr}.json`);
  fs.writeFileSync(filePath, json, 'utf8');

  await db.schoolBackup.create({
    data: { schoolId: school.id, fileRef: backupFileRef(school.slug, dateStr), sizeBytes },
  });

  return {
    ran: true,
    school: school.slug,
    file: backupFileRef(school.slug, dateStr),
    sizeBytes,
    tables: Object.keys((data as any).tables ?? {}).length,
    exportedAt: (data as any).exported_at,
  };
}

/** Run the nightly backup for every school (used by run-manual.ts and
 * tests). Errors in one school never block the others. */
export async function runNightlyBackups(
  db: Db,
  opts: { baseDir?: string; now?: Date } = {},
): Promise<{ ran: boolean; results: Array<BackupResult | { ran: boolean; school: string; error: string }> }> {
  // NB: load schools directly instead of importing the registry — the
  // registry imports this module, so a static import would be circular.
  const rows: any[] = await db.school.findMany({ orderBy: { createdAt: 'asc' } });
  const schools: SchoolRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    timezone: r.timezone || 'Asia/Karachi',
    settings: (r.settings ?? {}) as SchoolRow['settings'],
  }));
  const results: Array<BackupResult | { ran: boolean; school: string; error: string }> = [];
  for (const school of schools) {
    try {
      results.push(await runSchoolBackup(db, school, opts));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[backup] failed for school ${school.slug}:`, message);
      results.push({ ran: false, school: school.slug, error: message });
    }
  }
  return { ran: true, results };
}
