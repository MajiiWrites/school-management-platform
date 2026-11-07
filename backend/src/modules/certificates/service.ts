// Certificates + student ID cards (6C-2) — contracts/SCHEMA.md v2 §7,
// API.md "Expenses, announcements, events, certificates".
//
// Certificates: school leaving / character / bonafide, printable HTML +
// real PDF (pdfkit, same pattern as fee receipts). School name/logo come
// from the school row + settings (`logo_url`, see settings extension);
// student details + issue date come from the row.
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

async function toCertificateView(db: Db, schoolId: string, school: any, row: any): Promise<CertificateView> {
  const student = await loadStudent(db, schoolId, row.studentId);
  const klass: any = await db.class.findFirst({ where: { id: student.classId, schoolId } });
  const settings = settingsOf(school);
  return {
    id: row.id,
    certificate_no: certificateNo(school.slug, row.type as CertificateType, row.id),
    type: row.type as CertificateType,
    type_label: TYPE_LABEL[row.type as CertificateType],
    student_id: student.id,
    student_name: student.name,
    father_name: student.fatherName ?? student.parentName ?? null,
    roll_no: student.rollNo ?? null,
    admission_no: student.admissionNo ?? null,
    class_name: klass ? classDisplayName(klass.name, klass.section) : '(unknown)',
    school_name: school.name,
    school_address: (settings.school_address as string | null) ?? null,
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
): Promise<CertificateView> {
  if (!CERT_TYPES.includes(type as CertificateType)) {
    throw ApiError.validation("type must be one of 'leaving', 'character', 'bonafide'");
  }
  const school = await loadSchool(db, schoolId);
  const student = await loadStudent(db, schoolId, studentId);
  const created: any = await db.certificate.create({
    data: { schoolId, studentId: student.id, type, issuedBy: actorId },
  });
  await logCreate(db, {
    schoolId,
    actorId,
    entity: 'certificate',
    entityId: created.id,
    after: { student_id: student.id, type, certificate_no: certificateNo(school.slug, type as CertificateType, created.id) },
  });
  await writeAudit(db, {
    schoolId,
    actorId,
    actorType: 'user',
    action: 'certificate.issue',
    entity: 'certificate',
    entityId: created.id,
    details: { student_id: student.id, type, certificate_no: certificateNo(school.slug, type as CertificateType, created.id) },
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
  const bodyText =
    c.type === 'leaving'
      ? `This is to certify that <strong>${esc(c.student_name)}</strong>, son/daughter of <strong>${esc(c.father_name ?? '—')}</strong>, was a student of this school in Class <strong>${esc(c.class_name)}</strong>${c.roll_no !== null ? ` (Roll No. ${c.roll_no})` : ''}${c.admission_no ? `, Admission No. ${esc(c.admission_no)}` : ''}. The student has left the school and is hereby issued this School Leaving Certificate.`
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
