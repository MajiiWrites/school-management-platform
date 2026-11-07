/**
 * Module F (Point 9) — Certificates & Cards.
 * Service-level tests with an in-memory fake DB (no live DB).
 * Covers: pre-filled details from the SAVED student record, admin
 * review/edit overrides, leaving-reason options + Other textbox +
 * reason printed on the PDF/HTML, certificate saved in history
 * (Certificate record + change-log rows), and cross-tenant isolation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { inflateSync } from 'node:zlib';
import {
  issueCertificate,
  listCertificatesForStudent,
  getCertificate,
  renderCertificateHtml,
  renderCertificatePdf,
  LEAVING_REASON_OPTIONS,
} from '../service';
import { FakeDb, seedCertDemo } from './fake-db';

const ACTOR = 'admin-1';

/**
 * Extract the visible text of a pdfkit PDF: content streams are
 * FlateDecode-compressed, and text is written as hex strings in TJ
 * arrays, split into word fragments (`<526561736f6e2066> 30
 * <6f72206c6561> …`). Inflate the streams, decode every hex string and
 * join the fragments — that reconstructs the printed text. Proves the
 * reason is really printed in the PDF, not just in the HTML fallback.
 */
function pdfText(buf: Buffer): string {
  const raw = buf.toString('latin1');
  const parts: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    let text: string;
    try {
      text = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      text = m[1];
    }
    const hexes = [...text.matchAll(/<([0-9a-fA-F]+)>/g)].map((h) => Buffer.from(h[1], 'hex').toString('latin1'));
    parts.push(hexes.join(''));
  }
  return parts.join('\n');
}

describe('certificates — Module F Point 9', () => {
  let db: FakeDb;
  let schoolId: string;
  let studentId: string;

  beforeEach(() => {
    db = new FakeDb();
    const seeded = seedCertDemo(db);
    schoolId = seeded.school.id;
    studentId = seeded.student.id;
  });

  it('pre-fills every detail from the saved student record (no retyping, no guessing)', async () => {
    const cert = await issueCertificate(db as any, schoolId, studentId, 'bonafide', ACTOR);
    expect(cert.student_name).toBe('Ahmed Raza');
    expect(cert.father_name).toBe('Raza Hussain');
    expect(cert.class_name).toBe('5-A');
    expect(cert.roll_no).toBe(12);
    expect(cert.admission_no).toBe('ADM-2024-011');
    expect(cert.date_of_birth).toBe('2015-03-04');
    expect(cert.admission_date).toBe('2024-04-01');
    expect(cert.leaving_reason).toBeNull();
    expect(cert.leaving_reason_option).toBeNull();
    // Frozen snapshot stored on the row.
    const row = db.certificate.findFirst({ where: { id: cert.id } })!;
    expect(row.studentSnapshot).toMatchObject({
      name: 'Ahmed Raza',
      father_name: 'Raza Hussain',
      class_name: '5-A',
      section: 'A',
      roll_no: 12,
      admission_no: 'ADM-2024-011',
      date_of_birth: '2015-03-04',
      admission_date: '2024-04-01',
    });
  });

  it('admin review/edit overrides are applied to the snapshot, untouched fields stay saved', async () => {
    const cert = await issueCertificate(db as any, schoolId, studentId, 'character', ACTOR, {
      details: { name: 'Ahmed Raza (corrected)', roll_no: 7 },
    });
    expect(cert.student_name).toBe('Ahmed Raza (corrected)');
    expect(cert.roll_no).toBe(7);
    // Not overridden → still the saved value.
    expect(cert.father_name).toBe('Raza Hussain');
    expect(cert.admission_no).toBe('ADM-2024-011');
    expect(cert.date_of_birth).toBe('2015-03-04');
  });

  it('blank student name edit is rejected', async () => {
    await expect(
      issueCertificate(db as any, schoolId, studentId, 'bonafide', ACTOR, { details: { name: '   ' } }),
    ).rejects.toThrow('student name cannot be blank');
  });

  it('leaving certificate without a reason is rejected', async () => {
    await expect(issueCertificate(db as any, schoolId, studentId, 'leaving', ACTOR)).rejects.toThrow(
      'leaving_reason_option is required',
    );
    await expect(
      issueCertificate(db as any, schoolId, studentId, 'leaving', ACTOR, {
        leaving_reason_option: 'not_a_reason',
      }),
    ).rejects.toThrow('leaving_reason_option is required');
  });

  it.each(LEAVING_REASON_OPTIONS.filter((o) => o.key !== 'other'))(
    'leaving reason "$label" is stored and printed on the certificate',
    async ({ key, label }) => {
      const cert = await issueCertificate(db as any, schoolId, studentId, 'leaving', ACTOR, {
        leaving_reason_option: key,
      });
      expect(cert.leaving_reason_option).toBe(key);
      expect(cert.leaving_reason).toBe(label);
      const row = db.certificate.findFirst({ where: { id: cert.id } })!;
      expect(row.leavingReason).toBe(label);
      expect(row.leavingReasonOption).toBe(key);
      const html = renderCertificateHtml(cert);
      expect(html).toContain(`Reason for leaving: ${label}.`);
      const pdf = await renderCertificatePdf(cert);
      expect(pdf.length).toBeGreaterThan(0);
      expect(pdfText(pdf)).toContain(`Reason for leaving: ${label}`);
    },
  );

  it("leaving reason 'Other' requires free text and prints exactly that text", async () => {
    await expect(
      issueCertificate(db as any, schoolId, studentId, 'leaving', ACTOR, { leaving_reason_option: 'other' }),
    ).rejects.toThrow("leaving_reason_other is required when the leaving reason is 'Other'");
    await expect(
      issueCertificate(db as any, schoolId, studentId, 'leaving', ACTOR, {
        leaving_reason_option: 'other',
        leaving_reason_other: '   ',
      }),
    ).rejects.toThrow("leaving_reason_other is required when the leaving reason is 'Other'");

    const cert = await issueCertificate(db as any, schoolId, studentId, 'leaving', ACTOR, {
      leaving_reason_option: 'other',
      leaving_reason_other: 'Family moved to Lahore',
    });
    expect(cert.leaving_reason_option).toBe('other');
    expect(cert.leaving_reason).toBe('Family moved to Lahore');
    expect(renderCertificateHtml(cert)).toContain('Reason for leaving: Family moved to Lahore.');
    const pdf = await renderCertificatePdf(cert);
    expect(pdfText(pdf)).toContain('Reason for leaving: Family moved to Lahore');
  });

  it('a leaving reason is forbidden on bonafide / character certificates', async () => {
    await expect(
      issueCertificate(db as any, schoolId, studentId, 'bonafide', ACTOR, {
        leaving_reason_option: 'completed_middle',
      }),
    ).rejects.toThrow('a leaving reason applies only to School Leaving Certificates');
  });

  it('the certificate is saved in the student history (record + change log)', async () => {
    const leaving = await issueCertificate(db as any, schoolId, studentId, 'leaving', ACTOR, {
      leaving_reason_option: 'completed_class_10',
    });
    await issueCertificate(db as any, schoolId, studentId, 'bonafide', ACTOR);

    const history = await listCertificatesForStudent(db as any, schoolId, studentId);
    expect(history).toHaveLength(2);
    expect(history.map((c) => c.type)).toEqual(['bonafide', 'leaving']);
    const saved = history.find((c) => c.id === leaving.id)!;
    expect(saved.leaving_reason).toBe('Completed 10th Class');
    expect(saved.student_name).toBe('Ahmed Raza');

    // Change history: one entity='certificate' entry per issued certificate,
    // with the leaving reason logged for the leaving certificate.
    const logs = db.changeLog.findMany({ where: { entity: 'certificate' } });
    expect(logs.length).toBeGreaterThanOrEqual(2);
    const leavingLogs = logs.filter((l) => l.entityId === leaving.id);
    expect(leavingLogs.some((l) => l.field === 'leaving_reason' && l.newValue === 'Completed 10th Class')).toBe(true);
    expect(leavingLogs.some((l) => l.field === 'certificate_no')).toBe(true);

    // Re-fetch by id keeps the frozen details + reason.
    const refetched = await getCertificate(db as any, schoolId, leaving.id);
    expect(refetched.leaving_reason).toBe('Completed 10th Class');
    expect(refetched.date_of_birth).toBe('2015-03-04');
  });

  it('pre-migration rows (no snapshot) fall back to the live student record', async () => {
    const old = db.certificate.create({
      data: { schoolId, studentId, type: 'bonafide', issuedBy: ACTOR },
    });
    // Simulate the pre-migration shape: no new columns at all.
    delete old.studentSnapshot;
    delete old.leavingReason;
    delete old.leavingReasonOption;
    const view = await getCertificate(db as any, schoolId, old.id);
    expect(view.student_name).toBe('Ahmed Raza');
    expect(view.father_name).toBe('Raza Hussain');
    expect(view.roll_no).toBe(12);
    expect(view.leaving_reason).toBeNull();
  });

  it('cross-tenant: a certificate cannot be issued for another school’s student', async () => {
    const other = db.school.create({
      data: { id: 'school-other', name: 'Other School', slug: 'other', timezone: 'Asia/Karachi', settings: {} },
    });
    const otherClass = db.class.create({ data: { id: 'class-o', schoolId: other.id, name: '1', section: 'B' } });
    const otherStudent = db.student.create({
      data: { id: 'stu-other', schoolId: other.id, classId: otherClass.id, name: 'Other Kid', status: 'active' },
    });
    await expect(issueCertificate(db as any, schoolId, otherStudent.id, 'bonafide', ACTOR)).rejects.toThrow(
      'Student not found',
    );
    await expect(listCertificatesForStudent(db as any, schoolId, otherStudent.id)).rejects.toThrow('Student not found');
  });

  it('invalid type is rejected', async () => {
    await expect(issueCertificate(db as any, schoolId, studentId, 'transfer', ACTOR)).rejects.toThrow(
      "type must be one of 'leaving', 'character', 'bonafide'",
    );
  });
});
