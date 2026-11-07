// Certificates + student ID cards (6C-2) — contracts/SCHEMA.md v2 §7,
// API.md "Expenses, announcements, events, certificates".
//
// Certificates: school leaving / character / bonafide, printable HTML +
// real PDF (pdfkit, same pattern as fee receipts). School name/logo come
// from the school row + settings (`logo_url`, see settings extension);
// student details + issue date come from the row.
// Module F (Point 9): issuing pre-fills every detail from the SAVED
// student record (the admin reviews/edits before generating) and freezes
// it on the row as studentSnapshot; School Leaving Certificates carry a
// leaving reason (exactly 4 options, 'Other' with free text) that is
// printed on the certificate. Every issue is logged to change history +
// audit, so the certificate is visible in the student's history.
// CERTIFICATE NUMBER: the v2 `certificates` table has NO certificate_no
// column, so the number is DERIVED deterministically from the row —
// `{SLUG}-{TYPE3}-{first 8 of id, upper}` (e.g. DEMO-LEA-3F9A1C2E) —
// unique per row, stable across re-prints, and documented in
// FEATURES-6C2.md. It is never stored, so it can never drift from the row.
//
// ID cards: POST /students/:id/issue-id-card sets
// students.id_card_issued_at (the schema flag) and returns a printable
// card (photo placeholder — no photo column exists on students — name,
// class, roll no, admission no). Issued cards are immutable history:
// there is no delete endpoint for certificates or ID cards.

import { ApiError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { writeChangeLogs, logCreate } from '../hardening/helpers';
import type { Db } from '../../lib/db';

export type CertificateType = 'leaving' | 'character' | 'bonafide';

const CERT_TYPES: CertificateType[] = ['leaving', 'character', 'bonafide'];

const TYPE_LABEL: Record<CertificateType, string> = {
  leaving: 'School Leaving Certificate',
  character: 'Character Certificate',
  bonafide: 'Bonafide Certificate',
};

const TYPE_CODE: Record<CertificateType, string> = {
  leaving: 'LEA',
  character: 'CHA',
  bonafide: 'BON',
};

// Module F (Point 9) — reason for leaving, School Leaving Certificate
// only. EXACTLY these four options; 'other' takes the admin's free text,
// which is what gets printed on the certificate.
export type LeavingReasonOption = 'completed_primary' | 'completed_middle' | 'completed_class_10' | 'other';

export const LEAVING_REASON_OPTIONS: Array<{ key: LeavingReasonOption; label: string }> = [
  { key: 'completed_primary', label: 'Completed 5th Grade (Primary)' },
  { key: 'completed_middle', label: 'Completed Middle School' },
  { key: 'completed_class_10', label: 'Completed 10th Class' },
  { key: 'other', label: 'Other' },
];

export const LEAVING_REASON_LABEL: Record<LeavingReasonOption, string> = {
  completed_primary: 'Completed 5th Grade (Primary)',
  completed_middle: 'Completed Middle School',
  completed_class_10: 'Completed 10th Class',
  other: 'Other',
};

/**
 * Editable student details the admin reviews (pre-filled from the SAVED
 * student record) before a certificate is generated. Only these fields
 * can be overridden; class/section always come from the class record.
 * Everything here is saved data or an admin edit of it — never guessed.
 */
export interface CertificateDetailsInput {
  name?: string | null;
  father_name?: string | null;
  roll_no?: number | null;
  admission_no?: string | null;
  date_of_birth?: string | null;
  admission_date?: string | null;
}

export interface IssueCertificateOptions {
  /** Required for type 'leaving'; forbidden for the other types. */
  leaving_reason_option?: string;
  /** Required when leaving_reason_option is 'other' — the free-text reason. */
  leaving_reason_other?: string;
  /** Admin-reviewed edits to the pre-filled student details. */
  details?: CertificateDetailsInput;
}

/**
 * Frozen student details as printed on the certificate — taken from the
 * saved student record at issue time, plus any admin-reviewed edits.
 * Stored on the row so a re-print never drifts from what was issued,
 * even if the student record is edited later.
 */
export interface StudentSnapshot {
  name: string;
  father_name: string | null;
  class_name: string;
  section: string | null;
  roll_no: number | null;
  admission_no: string | null;
  date_of_birth: string | null;
  admission_date: string | null;
}

export interface CertificateView {
  id: string;
  certificate_no: string;
  type: CertificateType;
  type_label: string;
  student_id: string;
  student_name: string;
  father_name: string | null;
  roll_no: number | null;
  admission_no: string | null;
  class_name: string;
  section: string | null;
  date_of_birth: string | null;
  admission_date: string | null;
  /** School Leaving Certificate only: the exact reason printed on it. */
  leaving_reason: string | null;
  leaving_reason_option: LeavingReasonOption | null;
  school_name: string;
  school_address: string | null;
  logo_url: string | null;
  issued_at: string;
  issued_by: string | null;
  /** School IANA timezone — printable renderers format the issue date in
   * it (Phase 9 fix: the server renders in UTC, a day behind PKT). */
  timezone: string;
}

export interface IdCardView {
  student_id: string;
  student_name: string;
  father_name: string | null;
  roll_no: number | null;
  admission_no: string | null;
  class_name: string;
  school_name: string;
  logo_url: string | null;
  id_card_issued_at: string | null;
  /** School IANA timezone — see CertificateView.timezone. */
  timezone: string;
}

function certificateNo(schoolSlug: string, type: CertificateType, id: string): string {
  return `${schoolSlug.toUpperCase()}-${TYPE_CODE[type]}-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

function classDisplayName(name: string, section: string): string {
  return `${name}-${section}`;
}

async function loadSchool(db: Db, schoolId: string): Promise<any> {
  const school: any = await db.school.findUnique({ where: { id: schoolId } });
  if (!school) throw ApiError.notFound('School not found');
  return school;
}

async function loadStudent(db: Db, schoolId: string, studentId: string): Promise<any> {
  const student: any = await db.student.findFirst({ where: { id: studentId, schoolId, deletedAt: null } });
  if (!student) throw ApiError.notFound('Student not found');
  return student;
}

function settingsOf(school: any): Record<string, unknown> {
  return (school.settings as Record<string, unknown>) ?? {};
}

function toISODate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return new Date(d).toISOString().slice(0, 10);
}

function snapshotOf(row: any): StudentSnapshot | null {
  const s = row.studentSnapshot as StudentSnapshot | null | undefined;
  if (!s || typeof s !== 'object' || typeof (s as any).name !== 'string') return null;
  return s as StudentSnapshot;
}

/**
 * Build the frozen snapshot from the SAVED student record (+ the class
 * record for class/section), applying the admin's reviewed edits on top.
 * No field is ever invented: an edit may only replace a saved value, and
 * blanking a field stores null, not a guess.
 */
function buildSnapshot(student: any, klass: any, details?: CertificateDetailsInput): StudentSnapshot {
  const d = details ?? {};
  const trim = (v: string | null | undefined): string | null => {
    const t = typeof v === 'string' ? v.trim() : v;
    return t === '' || t === undefined ? null : (t as string);
  };
  return {
    name: trim(d.name ?? undefined) ?? student.name,
    father_name: d.father_name !== undefined ? trim(d.father_name) : (student.fatherName ?? student.parentName ?? null),
    class_name: klass ? classDisplayName(klass.name, klass.section) : '(unknown)',
    section: klass ? klass.section : null,
    roll_no: d.roll_no !== undefined ? d.roll_no : (student.rollNo ?? null),
    admission_no: d.admission_no !== undefined ? trim(d.admission_no) : (student.admissionNo ?? null),
    date_of_birth: d.date_of_birth !== undefined ? trim(d.date_of_birth) : toISODate(student.dateOfBirth),
    admission_date: d.admission_date !== undefined ? trim(d.admission_date) : toISODate(student.admissionDate),
  };
}

/** Resolve the printed leaving reason: preset label, or the admin's text for 'other'. */
function resolveLeavingReason(option: LeavingReasonOption, otherText?: string): string {
  if (option === 'other') return (otherText ?? '').trim();
  return LEAVING_REASON_LABEL[option];
}

async function toCertificateView(db: Db, schoolId: string, school: any, row: any): Promise<CertificateView> {
  const student = await loadStudent(db, schoolId, row.studentId);
  const klass: any = await db.class.findFirst({ where: { id: student.classId, schoolId } });
  const settings = settingsOf(school);
  // Frozen snapshot wins (what was actually printed); rows issued before
  // the Module F migration have no snapshot and fall back to the live record.
  const snap = snapshotOf(row) ?? buildSnapshot(student, klass);
  return {
    id: row.id,
    certificate_no: certificateNo(school.slug, row.type as CertificateType, row.id),
    type: row.type as CertificateType,
    type_label: TYPE_LABEL[row.type as CertificateType],
    student_id: student.id,
    student_name: snap.name,
    father_name: snap.father_name,
    roll_no: snap.roll_no,
    admission_no: snap.admission_no,
    class_name: snap.class_name,
    section: snap.section,
    date_of_birth: snap.date_of_birth,
    admission_date: snap.admission_date,
    leaving_reason: (row.leavingReason as string | null) ?? null,
    leaving_reason_option: (row.leavingReasonOption as LeavingReasonOption | null) ?? null,
    school_name: school.name,
    // Registration profile (2026-11-08): the address lives on the school
    // ROW now — prefer it exactly like getSettings does, with the legacy
    // settings-JSON value only as fallback. Otherwise a newly registered
    // school (which never writes the JSON) prints a missing address, and
    // an edited address prints the stale JSON value.
    school_address: (school as any).address ?? (settings.school_address as string | null) ?? null,
    logo_url: (settings.logo_url as string | null) ?? null,
    issued_at: row.issuedAt ? new Date(row.issuedAt).toISOString() : new Date().toISOString(),
    issued_by: row.issuedBy ?? null,
    timezone: (school.timezone as string | undefined) ?? 'Asia/Karachi',
  };
}

export async function issueCertificate(
  db: Db,
  schoolId: string,
  studentId: string,
  type: string,
  actorId: string,
  opts: IssueCertificateOptions = {},
): Promise<CertificateView> {
  if (!CERT_TYPES.includes(type as CertificateType)) {
    throw ApiError.validation("type must be one of 'leaving', 'character', 'bonafide'");
  }
  // Leaving reason: required for School Leaving Certificates, forbidden
  // for the other types (a reason on a bonafide/character certificate
  // would be meaningless and must not be stored).
  const certType = type as CertificateType;
  let leavingReason: string | null = null;
  let leavingReasonOption: LeavingReasonOption | null = null;
  if (certType === 'leaving') {
    const option = opts.leaving_reason_option as LeavingReasonOption | undefined;
    if (!option || !LEAVING_REASON_OPTIONS.some((o) => o.key === option)) {
      throw ApiError.validation(
        "leaving_reason_option is required for a School Leaving Certificate: one of 'completed_primary', 'completed_middle', 'completed_class_10', 'other'",
      );
    }
    if (option === 'other' && !(opts.leaving_reason_other ?? '').trim()) {
      throw ApiError.validation("leaving_reason_other is required when the leaving reason is 'Other'");
    }
    leavingReasonOption = option;
    leavingReason = resolveLeavingReason(option, opts.leaving_reason_other);
  } else if (opts.leaving_reason_option !== undefined || opts.leaving_reason_other !== undefined) {
    throw ApiError.validation('a leaving reason applies only to School Leaving Certificates');
  }
  // Name is required (the pre-filled saved name) — an admin edit may not
  // blank it; roll_no, when given, must be an integer.
  if (opts.details?.name !== undefined && !opts.details.name?.trim()) {
    throw ApiError.validation('student name cannot be blank');
  }
  if (opts.details?.roll_no !== undefined && opts.details.roll_no !== null && !Number.isInteger(opts.details.roll_no)) {
    throw ApiError.validation('roll_no must be an integer');
  }
  const school = await loadSchool(db, schoolId);
  const student = await loadStudent(db, schoolId, studentId);
  const klass: any = await db.class.findFirst({ where: { id: student.classId, schoolId } });
  const snapshot = buildSnapshot(student, klass, opts.details);
  const created: any = await db.certificate.create({
    data: {
      schoolId,
      studentId: student.id,
      type,
      issuedBy: actorId,
      leavingReason,
      leavingReasonOption,
      studentSnapshot: snapshot,
    },
  });
  const certNo = certificateNo(school.slug, certType, created.id);
  await logCreate(db, {
    schoolId,
    actorId,
    entity: 'certificate',
    entityId: created.id,
    after: {
      student_id: student.id,
      student_name: snapshot.name,
      type,
      certificate_no: certNo,
      ...(leavingReason ? { leaving_reason: leavingReason } : {}),
    },
  });
  await writeAudit(db, {
    schoolId,
    actorId,
    actorType: 'user',
    action: 'certificate.issue',
    entity: 'certificate',
    entityId: created.id,
    details: { student_id: student.id, type, certificate_no: certNo, ...(leavingReason ? { leaving_reason: leavingReason } : {}) },
  });
  return toCertificateView(db, schoolId, school, created);
}

export async function listCertificatesForStudent(db: Db, schoolId: string, studentId: string): Promise<CertificateView[]> {
  const school = await loadSchool(db, schoolId);
  await loadStudent(db, schoolId, studentId);
  const rows: any[] = await db.certificate.findMany({
    where: { schoolId, studentId },
    orderBy: { issuedAt: 'desc' },
  });
  const out: CertificateView[] = [];
  for (const r of rows) out.push(await toCertificateView(db, schoolId, school, r));
  return out;
}

export async function getCertificate(db: Db, schoolId: string, id: string): Promise<CertificateView> {
  const school = await loadSchool(db, schoolId);
  const row: any = await db.certificate.findFirst({ where: { id, schoolId } });
  if (!row) throw ApiError.notFound('Certificate not found');
  return toCertificateView(db, schoolId, school, row);
}

// ---------------------------------------------------------------------------
// ID cards
// ---------------------------------------------------------------------------

export async function issueIdCard(db: Db, schoolId: string, studentId: string, actorId: string): Promise<IdCardView> {
  const school = await loadSchool(db, schoolId);
  const student = await loadStudent(db, schoolId, studentId);
  const before = { id_card_issued_at: student.idCardIssuedAt ? new Date(student.idCardIssuedAt).toISOString() : null };
  const updated: any = await db.student.update({
    where: { id: student.id },
    data: { idCardIssuedAt: new Date() },
  });
  await writeChangeLogs(db, {
    schoolId,
    actorId,
    entity: 'student',
    entityId: student.id,
    before,
    after: { id_card_issued_at: new Date(updated.idCardIssuedAt).toISOString() },
  });
  await writeAudit(db, {
    schoolId,
    actorId,
    actorType: 'user',
    action: 'student.id_card.issue',
    entity: 'student',
    entityId: student.id,
    details: { student_id: student.id },
  });
  return toIdCardView(db, schoolId, school, updated);
}

export async function getIdCard(db: Db, schoolId: string, studentId: string): Promise<IdCardView> {
  const school = await loadSchool(db, schoolId);
  const student = await loadStudent(db, schoolId, studentId);
  return toIdCardView(db, schoolId, school, student);
}

async function toIdCardView(db: Db, schoolId: string, school: any, student: any): Promise<IdCardView> {
  const klass: any = await db.class.findFirst({ where: { id: student.classId, schoolId } });
  const settings = settingsOf(school);
  return {
    student_id: student.id,
    student_name: student.name,
    father_name: student.fatherName ?? student.parentName ?? null,
    roll_no: student.rollNo ?? null,
    admission_no: student.admissionNo ?? null,
    class_name: klass ? classDisplayName(klass.name, klass.section) : '(unknown)',
    school_name: school.name,
    logo_url: (settings.logo_url as string | null) ?? null,
    id_card_issued_at: student.idCardIssuedAt ? new Date(student.idCardIssuedAt).toISOString() : null,
    timezone: (school.timezone as string | undefined) ?? 'Asia/Karachi',
  };
}

// ---------------------------------------------------------------------------
// Printable documents
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderCertificateHtml(c: CertificateView): string {
  // Phase 9: format in the SCHOOL timezone — the server renders in UTC,
  // which showed the issue date a day behind in PKT.
  const tz = c.timezone ?? 'Asia/Karachi';
  const issuedDate = new Date(c.issued_at).toLocaleDateString('en-GB', { timeZone: tz });
  // Module F (Point 9): the leaving reason MUST be printed on a School
  // Leaving Certificate, and the frozen student details (DOB, admission
  // date) print on every certificate.
  const detailLine = [
    c.date_of_birth ? `Date of Birth: <strong>${esc(c.date_of_birth)}</strong>` : '',
    c.admission_date ? `Admission Date: <strong>${esc(c.admission_date)}</strong>` : '',
  ]
    .filter(Boolean)
    .join(' &nbsp;·&nbsp; ');
  const bodyText =
    c.type === 'leaving'
      ? `This is to certify that <strong>${esc(c.student_name)}</strong>, son/daughter of <strong>${esc(c.father_name ?? '—')}</strong>, was a student of this school in Class <strong>${esc(c.class_name)}</strong>${c.roll_no !== null ? ` (Roll No. ${c.roll_no})` : ''}${c.admission_no ? `, Admission No. ${esc(c.admission_no)}` : ''}. The student has left the school and is hereby issued this School Leaving Certificate.${c.leaving_reason ? ` <strong>Reason for leaving: ${esc(c.leaving_reason)}.</strong>` : ''}`
      : c.type === 'character'
        ? `This is to certify that <strong>${esc(c.student_name)}</strong>, son/daughter of <strong>${esc(c.father_name ?? '—')}</strong>, was a student of this school in Class <strong>${esc(c.class_name)}</strong>${c.roll_no !== null ? ` (Roll No. ${c.roll_no})` : ''}. During the student's time at this school, their conduct and character were found to be good.`
        : `This is to certify that <strong>${esc(c.student_name)}</strong>, son/daughter of <strong>${esc(c.father_name ?? '—')}</strong>, is a bonafide student of this school, studying in Class <strong>${esc(c.class_name)}</strong>${c.roll_no !== null ? ` (Roll No. ${c.roll_no})` : ''}${c.admission_no ? `, Admission No. ${esc(c.admission_no)}` : ''}.`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(c.type_label)} — ${esc(c.certificate_no)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #111; margin: 0; padding: 32px; }
  .cert { max-width: 720px; margin: 0 auto; border: 3px double #14532d; border-radius: 4px; padding: 40px; text-align: center; }
  h1 { margin: 0; font-size: 26px; color: #14532d; }
  h2 { margin: 8px 0 24px; font-size: 18px; letter-spacing: 2px; text-transform: uppercase; }
  p.body { font-size: 16px; line-height: 1.8; text-align: justify; }
  .meta { margin-top: 24px; font-size: 13px; color: #555; }
  .sig { margin-top: 48px; display: flex; justify-content: space-between; font-size: 13px; }
  .sig span { border-top: 1px solid #333; padding-top: 4px; }
  .print-btn { margin: 16px auto; display: block; padding: 10px 18px; font-size: 14px; background: #14532d; color: #fff; border: 0; border-radius: 6px; cursor: pointer; font-family: Arial, sans-serif; }
  @media print { .print-btn { display: none; } body { padding: 0; } }
</style>
</head>
<body>
<button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
<div class="cert">
  ${c.logo_url ? `<img src="${esc(c.logo_url)}" alt="School logo" style="max-height:72px;max-width:200px;">` : ''}
  <h1>${esc(c.school_name)}</h1>
  ${c.school_address ? `<p class="meta">${esc(c.school_address)}</p>` : ''}
  <h2>${esc(c.type_label)}</h2>
  <p class="body">${bodyText}</p>
  ${detailLine ? `<p class="meta">${detailLine}</p>` : ''}
  <p class="meta">Certificate No: <strong>${esc(c.certificate_no)}</strong> &nbsp;·&nbsp; Issued on ${esc(issuedDate)}</p>
  <div class="sig"><span>Principal / Head</span><span>Office Seal</span></div>
</div>
</body>
</html>`;
}

export async function renderCertificatePdf(c: CertificateView): Promise<Buffer> {
  const tz = c.timezone ?? 'Asia/Karachi';
  const issuedDate = new Date(c.issued_at).toLocaleDateString('en-GB', { timeZone: tz });
  let PDFDocument: any;
  try {
    const mod = await import('pdfkit');
    PDFDocument = mod.default ?? mod;
  } catch {
    const err = new Error('pdfkit is not installed — use the HTML certificate instead') as Error & { code?: string };
    err.code = 'PDF_UNAVAILABLE';
    throw err;
  }
  const doc = new PDFDocument({ size: 'A4', margin: 64 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.fontSize(22).fillColor('#14532d').text(c.school_name, { align: 'center' });
  if (c.school_address) doc.fontSize(10).fillColor('#555').text(c.school_address, { align: 'center' });
  doc.moveDown();
  doc.fontSize(16).fillColor('#111').text(c.type_label.toUpperCase(), { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).fillColor('#111').text(
    `This is to certify that ${c.student_name}, son/daughter of ${c.father_name ?? '—'}, ` +
      `was/is a student of this school in Class ${c.class_name}` +
      `${c.roll_no !== null ? ` (Roll No. ${c.roll_no})` : ''}` +
      `${c.admission_no ? `, Admission No. ${c.admission_no}` : ''}.`,
    { align: 'justify' },
  );
  // Module F (Point 9): leaving reason + frozen details print on the PDF too.
  if (c.type === 'leaving' && c.leaving_reason) {
    doc.moveDown(0.5);
    doc.fontSize(12).fillColor('#111').text(`Reason for leaving: ${c.leaving_reason}`, { align: 'justify' });
  }
  const pdfDetails = [
    c.date_of_birth ? `Date of Birth: ${c.date_of_birth}` : '',
    c.admission_date ? `Admission Date: ${c.admission_date}` : '',
  ]
    .filter(Boolean)
    .join('  ·  ');
  if (pdfDetails) {
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor('#555').text(pdfDetails);
  }
  doc.moveDown();
  doc.fontSize(11).fillColor('#555').text(`Certificate No: ${c.certificate_no}`);
  doc.text(`Issued on ${issuedDate}`);
  doc.moveDown(3);
  doc.fontSize(11).fillColor('#333').text('Principal / Head: ______________________        Office Seal: ______________________');
  doc.end();
  return done;
}

export function renderIdCardHtml(card: IdCardView): string {
  // Phase 9: format in the SCHOOL timezone (see renderCertificateHtml).
  const tz = card.timezone ?? 'Asia/Karachi';
  const issuedDate = card.id_card_issued_at
    ? new Date(card.id_card_issued_at).toLocaleDateString('en-GB', { timeZone: tz })
    : '—';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Student ID Card — ${esc(card.student_name)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 0; padding: 24px; }
  .card { width: 340px; margin: 0 auto; border: 2px solid #14532d; border-radius: 12px; overflow: hidden; }
  .head { background: #14532d; color: #fff; padding: 12px; text-align: center; font-weight: bold; }
  .body { padding: 16px; display: flex; gap: 14px; }
  .photo { width: 84px; height: 104px; border: 1px dashed #999; border-radius: 6px; display: flex; align-items: center; justify-content: center; color: #888; font-size: 11px; text-align: center; background: #f8fafc; }
  .info { font-size: 13px; line-height: 1.7; }
  .info b { font-size: 15px; }
  .foot { padding: 0 16px 14px; font-size: 11px; color: #666; }
  .print-btn { margin: 16px auto; display: block; padding: 10px 18px; font-size: 14px; background: #14532d; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  @media print { .print-btn { display: none; } body { padding: 0; } }
</style>
</head>
<body>
<button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
<div class="card">
  <div class="head">${esc(card.school_name)} — Student ID Card</div>
  <div class="body">
    <div class="photo">Photo<br>placeholder</div>
    <div class="info">
      <b>${esc(card.student_name)}</b><br>
      Class: ${esc(card.class_name)}<br>
      Roll No: ${card.roll_no !== null ? card.roll_no : '—'}<br>
      Admission No: ${card.admission_no ? esc(card.admission_no) : '—'}<br>
      Father: ${esc(card.father_name ?? '—')}
    </div>
  </div>
  <div class="foot">Issued: ${esc(issuedDate)} · This card is the property of ${esc(card.school_name)}.</div>
</div>
</body>
</html>`;
}
