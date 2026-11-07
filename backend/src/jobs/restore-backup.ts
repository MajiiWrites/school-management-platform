/**
 * Restore a 6D backup file — `backend/src/jobs/restore-backup.ts`.
 *
 * Usage:
 *   npx tsx src/jobs/restore-backup.ts <backup-file.json> [--slug=<new-slug>] [--apply]
 *
 * The script NEVER overwrites the source school. It restores the backup as a
 * NEW school (new id, new slug, all row ids remapped) so a restore can be
 * verified without touching live data:
 *
 *   - Default is --dry-run: validates the file, pre-checks the three
 *     globally-unique columns that would collide if the source school's rows
 *     still exist in this database (users.email, message_queue.dedupe_key,
 *     sms_devices.device_id), and prints the per-table row counts it WOULD
 *     restore. Nothing is written.
 *   - --apply performs the restore into the database DATABASE_URL points at.
 *
 * Restore is meant for disaster recovery (the source school is gone) or a
 * scratch database. Restoring alongside the still-existing source school
 * fails on the unique columns above — the script says so plainly instead of
 * silently mangling emails or dedupe keys.
 *
 * Known limits (by design — the export deliberately scrubs secrets):
 *   - Restored users get a RANDOM unusable password hash (the export never
 *     contains passwordHash / token hashes / totpSecretEnc) and totpEnabled
 *     is forced OFF. Every restored login must use "Forgot password" to set
 *     a new password, then re-enable 2FA if wanted.
 *   - `school_backups` rows are NOT restored (the new school starts a fresh
 *     backup log; the nightly job writes its own rows).
 *   - `fee_records.status` is a GENERATED column — it is stripped before
 *     insert and Postgres recomputes it from the amounts.
 *   - JSONB payloads (approval_requests.payload, deleted_records.snapshot,
 *     message_drafts.target_student_ids, …) are remapped by the same
 *     whole-file UUID replacement as the FK columns, so internal references
 *     stay consistent.
 *   - Restored phones stay encrypted exactly as exported (same
 *     PHONE_ENC_KEY must be in effect or they will not decrypt).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { getDb } from '../lib/db';
import type { Db } from '../lib/db';

/** Export-key (from hardening/export.ts TABLES) -> Prisma delegate key. */
const TABLE_DELEGATES: Record<string, keyof Db> = {
  schools: 'school',
  users: 'user',
  classes: 'class',
  students: 'student',
  attendance_days: 'attendanceDay',
  teacher_attendance: 'teacherAttendance',
  fee_structures: 'feeStructure',
  fee_records: 'feeRecord',
  message_templates: 'messageTemplate',
  message_queue: 'messageQueue',
  sms_devices: 'smsDevice',
  holidays: 'holiday',
  academic_sessions: 'academicSession',
  promotions: 'promotion',
  ocr_uploads: 'ocrUpload',
  audit_logs: 'auditLog',
  notifications: 'notification',
  role_permissions: 'rolePermission',
  approval_requests: 'approvalRequest',
  deleted_records: 'deletedRecord',
  change_logs: 'changeLog',
  exams: 'exam',
  grading_scales: 'gradingScale',
  result_sheets: 'resultSheet',
  results: 'result',
  timetable_entries: 'timetableEntry',
  staff: 'staff',
  staff_class_assignments: 'staffClassAssignment',
  salary_records: 'salaryRecord',
  expenses: 'expense',
  announcements: 'announcement',
  events: 'event',
  certificates: 'certificate',
  exam_datesheets: 'examDatesheet',
  fee_vouchers: 'feeVoucher',
  account_deletion_requests: 'accountDeletionRequest',
  message_drafts: 'messageDraft',
  // attendance_records + message_deliveries are keyed differently in the export:
  attendance_records: 'attendanceRecord',
  message_deliveries: 'messageDelivery',
  // school_backups is deliberately NOT restored (fresh log for the new school).
};

/** FK-safe insert order (parents before children). */
const INSERT_ORDER: string[] = [
  'schools',
  'users',
  'classes',
  'students',
  'staff',
  'exams',
  'grading_scales',
  'result_sheets',
  'results',
  'attendance_days',
  'attendance_records',
  'teacher_attendance',
  'fee_structures',
  'fee_records',
  'fee_vouchers',
  'message_templates',
  'message_queue',
  'message_deliveries',
  'sms_devices',
  'holidays',
  'academic_sessions',
  'promotions',
  'ocr_uploads',
  'audit_logs',
  'notifications',
  'role_permissions',
  'approval_requests',
  'deleted_records',
  'change_logs',
  'timetable_entries',
  'staff_class_assignments',
  'salary_records',
  'expenses',
  'announcements',
  'events',
  'certificates',
  'exam_datesheets',
  'account_deletion_requests',
  'message_drafts',
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseArgs(argv: string[]): { file: string; slug?: string; apply: boolean } {
  const file = argv[2];
  if (!file || file === '--help' || file === '-h') {
    // eslint-disable-next-line no-console
    console.log('Usage: npx tsx src/jobs/restore-backup.ts <backup-file.json> [--slug=<new-slug>] [--apply]\nDefault is --dry-run (validate + print plan, write nothing).');
    process.exit(file ? 0 : 1);
  }
  let slug: string | undefined;
  let apply = false;
  for (const arg of argv.slice(3)) {
    if (arg.startsWith('--slug=')) slug = arg.slice('--slug='.length);
    else if (arg === '--apply') apply = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { file, slug, apply };
}

async function main(): Promise<void> {
  const { file, slug: slugArg, apply } = parseArgs(process.argv);
  const raw = fs.readFileSync(path.resolve(file), 'utf8');
  const backup = JSON.parse(raw) as { school_id?: string; exported_at?: string; tables?: Record<string, any[]> };
  if (!backup.tables || typeof backup.tables !== 'object') throw new Error('Not a backup file: missing "tables" object');
  const sourceSchools = backup.tables.schools ?? [];
  if (sourceSchools.length !== 1) throw new Error(`Expected exactly 1 school row in the backup, found ${sourceSchools.length}`);
  const source = sourceSchools[0];
  const sourceSchoolId: string = backup.school_id ?? source.id;

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const newSlug = slugArg ?? `${source.slug}-restored-${today}`;
  const newSchoolId = crypto.randomUUID();

  const db = getDb();
  try {
    const clash = await db.school.findUnique({ where: { slug: newSlug } });
    if (clash) throw new Error(`Slug "${newSlug}" is already taken — pass --slug=<another-slug>`);

    // Build the old-id -> new-id map (every row id + the school id).
    const idMap = new Map<string, string>();
    idMap.set(sourceSchoolId, newSchoolId);
    for (const key of INSERT_ORDER) {
      for (const row of backup.tables[key] ?? []) {
        if (typeof row?.id === 'string' && !idMap.has(row.id)) idMap.set(row.id, crypto.randomUUID());
      }
    }
    const pattern = new RegExp([...idMap.keys()].map(escapeRegExp).join('|'), 'g');
    const remap = (row: Record<string, unknown>): Record<string, unknown> =>
      JSON.parse(JSON.stringify(row).replace(pattern, (m) => idMap.get(m) ?? m)) as Record<string, unknown>;

    // Dry-run collision pre-checks (globally-unique columns).
    const warnings: string[] = [];
    const emails = (backup.tables.users ?? []).map((u: any) => String(u.email ?? '').toLowerCase()).filter(Boolean);
    for (const email of emails) {
      const existing = await db.user.findFirst({ where: { email } });
      if (existing) warnings.push(`users.email "${email}" already exists in this database`);
    }
    for (const q of backup.tables.message_queue ?? []) {
      if (!q.dedupeKey) continue;
      const existing = await db.messageQueue.findFirst({ where: { dedupeKey: q.dedupeKey } });
      if (existing) warnings.push(`message_queue.dedupe_key "${q.dedupeKey}" already exists`);
    }
    for (const d of backup.tables.sms_devices ?? []) {
      if (!d.deviceId) continue;
      const existing = await db.smsDevice.findFirst({ where: { deviceId: d.deviceId } });
      if (existing) warnings.push(`sms_devices.device_id "${d.deviceId}" already exists`);
    }

    // Transform all rows.
    const unusableHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    const transformed: Record<string, Record<string, unknown>[]> = {};
    for (const key of INSERT_ORDER) {
      const rows = (backup.tables[key] ?? []).map((row) => {
        const r = remap(row as Record<string, unknown>);
        // Export-only decrypted-phone helpers are not Prisma columns.
        delete r.parent_phone;
        delete r.parent2_phone;
        delete r.teacher_phone;
        delete r.phone;
        if (key === 'fee_records') delete r.status; // GENERATED — Postgres recomputes it.
        if (key === 'users') {
          r.passwordHash = unusableHash; // scrubbed by the export — reset via "Forgot password".
          r.totpEnabled = false; // secret was scrubbed; never restore a half-on 2FA.
          r.verifyTokenHash = null;
          r.resetTokenHash = null;
        }
        if (key === 'schools') {
          r.slug = newSlug;
        }
        return r;
      });
      transformed[key] = rows;
    }

    // eslint-disable-next-line no-console
    console.log(`Backup: ${file} (exported ${backup.exported_at ?? 'unknown'}, school "${source.name}", slug "${source.slug}")`);
    // eslint-disable-next-line no-console
    console.log(`Restore target: new school slug "${newSlug}" (id ${newSchoolId})`);
    for (const key of INSERT_ORDER) {
      // eslint-disable-next-line no-console
      console.log(`  ${key}: ${transformed[key].length} rows`);
    }
    if (warnings.length > 0) {
      // eslint-disable-next-line no-console
      console.log('\nWARNINGS — these will fail the restore unless the source school is gone:');
      for (const w of warnings) {
        // eslint-disable-next-line no-console
        console.log(`  - ${w}`);
      }
    }
    if (!apply) {
      // eslint-disable-next-line no-console
      console.log('\nDry run only — nothing was written. Re-run with --apply to restore.');
      // eslint-disable-next-line no-console
      console.log('After --apply: every restored login must use "Forgot password" (passwords are scrubbed from exports) and re-enable 2FA if wanted.');
      return;
    }
    if (warnings.length > 0) {
      throw new Error('Refusing --apply with unresolved unique collisions (see warnings above). Restore into a scratch database, or delete the source school first.');
    }

    for (const key of INSERT_ORDER) {
      const rows = transformed[key];
      if (rows.length === 0) continue;
      const delegate = (db as any)[TABLE_DELEGATES[key]];
      if (!delegate) throw new Error(`No Prisma delegate mapped for export table "${key}"`);
      for (let i = 0; i < rows.length; i += 200) {
        await delegate.createMany({ data: rows.slice(i, i + 200) });
      }
      // eslint-disable-next-line no-console
      console.log(`  restored ${key}: ${rows.length}`);
    }
    // eslint-disable-next-line no-console
    console.log(`\nRestore complete: school "${source.name}" is now live as slug "${newSlug}".`);
    // eslint-disable-next-line no-console
    console.log('Reminder: restored users have unusable passwords — use "Forgot password" for each login, then re-enable 2FA if wanted.');
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('restore-backup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
