// Fee vouchers / challans (6C-2) — contracts/API.md "Fees (extensions)".
// A voucher is a printable bill for one fee_record + month: voucher no,
// student, class, month, amount payable (remaining balance), due date.
// Money is integer PKR. Every query is scoped to `schoolId` from the JWT.
//
// Voucher number: `{school_slug}-{YYYYMM}-V{seq:03d}` per school+month,
// sequential. Status mirrors the fee record's GENERATED status: it is
// re-derived on read and re-synced by payFee after every payment, so a
// voucher never claims "unpaid" for a paid record (or vice versa).

import { ApiError } from '../../lib/errors';
import { isValidDateString, isValidMonthKey } from '../../jobs/date-utils';
import { monthRange } from '../../lib/dates';
import { writeAudit } from '../../lib/audit';
import { balanceOf, computeFeeStatus } from './service';
import type { Db } from '../../lib/db';

export interface VoucherView {
  id: string;
  voucher_no: string;
  fee_record_id: string;
  student_id: string;
  student_name: string;
  roll_no: number | null;
  class_name: string;
  month: string;
  amount_due: number;
  amount_paid: number;
  discount: number;
  balance: number;
  due_date: string;
  status: string;
  school_name: string;
  school_slug: string;
  created_at: string;
}

function toISODate(d: Date | string): string {
  return new Date(d).toISOString().slice(0, 10);
}

function classDisplayName(name: string, section: string): string {
  return `${name}-${section}`;
}

async function nextVoucherNo(db: Db, schoolId: string, schoolSlug: string, month: string): Promise<string> {
  const prefix = `${schoolSlug}-${month.replace('-', '')}-V`;
  const latest = await db.feeVoucher.findFirst({
    where: { schoolId, voucherNo: { startsWith: prefix } },
    orderBy: { voucherNo: 'desc' },
    select: { voucherNo: true },
  });
  let seq = 0;
  if (latest?.voucherNo) {
    const n = Number(latest.voucherNo.slice(prefix.length));
    if (Number.isInteger(n)) seq = n;
  }
  return `${prefix}${String(seq + 1).padStart(3, '0')}`;
}

export async function generateVoucher(
  db: Db,
  schoolId: string,
  input: { fee_record_id: string; month: string; due_date?: string },
  actorId: string,
): Promise<VoucherView> {
  if (!isValidMonthKey(input.month)) throw ApiError.validation('month must be YYYY-MM');
  const dueDate = input.due_date ?? monthRange(input.month).end;
  if (!isValidDateString(dueDate)) throw ApiError.validation('due_date must be a valid YYYY-MM-DD date');
  const school: any = await db.school.findUnique({ where: { id: schoolId } });
  if (!school) throw ApiError.notFound('School not found');

  const record: any = await db.feeRecord.findFirst({
    where: { id: input.fee_record_id, schoolId, month: input.month, deletedAt: null },
  });
  if (!record) throw ApiError.notFound('Fee record not found for this month');
  // One voucher per record+month: re-issue returns the existing voucher
  // (same number) instead of minting a duplicate bill.
  const existing: any = await db.feeVoucher.findFirst({
    where: { schoolId, feeRecordId: record.id, month: input.month },
  });
  if (existing) return toVoucherView(db, schoolId, school, existing);

  const balance = balanceOf(record.amountDue, record.amountPaid, record.discount);
  const voucherNo = await nextVoucherNo(db, schoolId, school.slug, input.month);
  const created: any = await db.feeVoucher.create({
    data: {
      schoolId,
      feeRecordId: record.id,
      voucherNo,
      month: input.month,
      amountDue: balance,
      dueDate: new Date(`${dueDate}T00:00:00Z`),
      status: computeFeeStatus(record.amountDue, record.amountPaid, record.discount),
    },
  });
  await writeAudit(db, {
    schoolId,
    actorId,
    actorType: 'user',
    action: 'fee.voucher.create',
    entity: 'fee_voucher',
    entityId: created.id,
    details: { voucher_no: voucherNo, student_id: record.studentId, month: input.month, amount_due: balance, due_date: dueDate },
  });
  return toVoucherView(db, schoolId, school, created);
}

export async function generateVoucherForStudent(
  db: Db,
  schoolId: string,
  studentId: string,
  month: string,
  dueDate: string | undefined,
  actorId: string,
): Promise<VoucherView> {
  const student: any = await db.student.findFirst({ where: { id: studentId, schoolId, deletedAt: null } });
  if (!student) throw ApiError.notFound('Student not found');
  const record: any = await db.feeRecord.findFirst({ where: { schoolId, studentId, month, deletedAt: null } });
  if (!record) {
    throw ApiError.conflict('No fee record exists for this student/month yet — record a payment or run the month rollover first');
  }
  return generateVoucher(db, schoolId, { fee_record_id: record.id, month, due_date: dueDate }, actorId);
}

export async function listVouchers(
  db: Db,
  schoolId: string,
  query: { month?: string; status?: string; page?: number; limit?: number },
): Promise<{ items: VoucherView[]; total: number; page: number; pages: number }> {
  const where: Record<string, unknown> = { schoolId };
  if (query.month) {
    if (!isValidMonthKey(query.month)) throw ApiError.validation('month must be YYYY-MM');
    where.month = query.month;
  }
  if (query.status) {
    if (!['unpaid', 'partial', 'paid'].includes(query.status)) throw ApiError.validation('status must be unpaid, partial or paid');
    where.status = query.status;
  }
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(200, Math.max(1, query.limit ?? 50));
  const school: any = await db.school.findUnique({ where: { id: schoolId } });
  if (!school) throw ApiError.notFound('School not found');
  const [rows, total] = await Promise.all([
    db.feeVoucher.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    db.feeVoucher.count({ where }),
  ]);
  const items: VoucherView[] = [];
  for (const r of rows) items.push(await toVoucherView(db, schoolId, school, r));
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getVoucherByNo(db: Db, schoolId: string, voucherNo: string): Promise<VoucherView> {
  const school: any = await db.school.findUnique({ where: { id: schoolId } });
  if (!school) throw ApiError.notFound('School not found');
  const row: any = await db.feeVoucher.findFirst({ where: { schoolId, voucherNo } });
  if (!row) throw ApiError.notFound('Voucher not found');
  return toVoucherView(db, schoolId, school, row);
}

async function toVoucherView(db: Db, schoolId: string, school: any, row: any): Promise<VoucherView> {
  const record: any = await db.feeRecord.findFirst({ where: { id: row.feeRecordId, schoolId } });
  if (!record) throw ApiError.notFound('Fee record not found');
  const student: any = await db.student.findFirst({ where: { id: record.studentId, schoolId } });
  if (!student) throw ApiError.notFound('Student not found');
  const klass: any = await db.class.findFirst({ where: { id: student.classId, schoolId } });
  // Status is derived from the live record so a voucher printed after a
  // payment shows the paid state even if the sync lagged.
  const status = computeFeeStatus(record.amountDue, record.amountPaid, record.discount);
  const balance = balanceOf(record.amountDue, record.amountPaid, record.discount);
  return {
    id: row.id,
    voucher_no: row.voucherNo,
    fee_record_id: row.feeRecordId,
    student_id: student.id,
    student_name: student.name,
    roll_no: student.rollNo ?? null,
    class_name: klass ? classDisplayName(klass.name, klass.section) : '(unknown)',
    month: row.month,
    amount_due: balance,
    amount_paid: record.amountPaid,
    discount: record.discount,
    balance,
    due_date: toISODate(row.dueDate),
    status,
    school_name: school.name,
    school_slug: school.slug,
    created_at: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Printable voucher (HTML + real PDF via pdfkit, same pattern as receipts)
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatPKR(n: number): string {
  return `Rs. ${n.toLocaleString('en-PK')}`;
}

export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function renderVoucherHtml(v: VoucherView): string {
  const statusLabel = v.status === 'paid' ? 'PAID' : v.status === 'partial' ? 'PARTIALLY PAID' : 'UNPAID';
  const statusColor = v.status === 'paid' ? '#14532d' : v.status === 'partial' ? '#92400e' : '#991b1b';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fee Voucher ${esc(v.voucher_no)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 0; padding: 24px; }
  .voucher { max-width: 640px; margin: 0 auto; border: 2px solid #14532d; border-radius: 8px; padding: 24px; }
  h1 { margin: 0; font-size: 20px; color: #14532d; }
  .sub { color: #555; font-size: 13px; margin-top: 2px; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; color: #fff; background: ${statusColor}; font-weight: bold; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 14px; }
  td, th { padding: 8px 4px; border-bottom: 1px solid #ddd; text-align: left; }
  td.num, th.num { text-align: right; }
  tr.total td { font-weight: bold; border-top: 2px solid #14532d; }
  .row { display: flex; justify-content: space-between; margin-top: 6px; font-size: 14px; }
  .foot { margin-top: 20px; font-size: 12px; color: #666; }
  .print-btn { margin: 16px auto; display: block; padding: 10px 18px; font-size: 14px; background: #14532d; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  @media print { .print-btn { display: none; } body { padding: 0; } .voucher { border-width: 1px; } }
</style>
</head>
<body>
<button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
<div class="voucher">
  <div class="row"><div><h1>${esc(v.school_name)}</h1><div class="sub">Fee Voucher (Challan)</div></div><div><span class="badge">${statusLabel}</span></div></div>
  <div class="row"><span>Voucher No: <strong>${esc(v.voucher_no)}</strong></span><span>Month: <strong>${esc(monthLabel(v.month))}</strong></span></div>
  <div class="row"><span>Student: <strong>${esc(v.student_name)}</strong>${v.roll_no !== null ? ` (Roll ${v.roll_no})` : ''}</span><span>Class: <strong>${esc(v.class_name)}</strong></span></div>
  <div class="row"><span>Due date: <strong>${esc(v.due_date)}</strong></span><span>Issued: <strong>${esc(v.created_at.slice(0, 10))}</strong></span></div>
  <table>
    <tr><th>Description</th><th class="num">Amount</th></tr>
    <tr><td>Monthly fee — ${esc(monthLabel(v.month))}</td><td class="num">${formatPKR(v.amount_due + v.amount_paid + v.discount)}</td></tr>
    <tr><td>Discount</td><td class="num">&minus; ${formatPKR(v.discount)}</td></tr>
    <tr><td>Already paid</td><td class="num">&minus; ${formatPKR(v.amount_paid)}</td></tr>
    <tr class="total"><td>Amount payable</td><td class="num">${formatPKR(v.balance)}</td></tr>
  </table>
  <div class="foot">Please pay by the due date and keep this voucher for your records. This is a computer-generated voucher from ${esc(v.school_name)}.</div>
</div>
</body>
</html>`;
}

export async function renderVoucherPdf(v: VoucherView): Promise<Buffer> {
  let PDFDocument: any;
  try {
    const mod = await import('pdfkit');
    PDFDocument = mod.default ?? mod;
  } catch {
    const err = new Error('pdfkit is not installed — use the HTML voucher instead') as Error & { code?: string };
    err.code = 'PDF_UNAVAILABLE';
    throw err;
  }
  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.fontSize(18).fillColor('#14532d').text(v.school_name);
  doc.fontSize(11).fillColor('#555').text('Fee Voucher (Challan)');
  doc.moveDown(0.5);
  doc.fontSize(12).fillColor('#111');
  doc.text(`Voucher No: ${v.voucher_no}`);
  doc.text(`Month: ${monthLabel(v.month)}`);
  doc.text(`Student: ${v.student_name}${v.roll_no !== null ? ` (Roll ${v.roll_no})` : ''}`);
  doc.text(`Class: ${v.class_name}`);
  doc.text(`Due date: ${v.due_date}`);
  doc.text(`Status: ${v.status.toUpperCase()}`);
  doc.moveDown(0.5);
  doc.text(`Amount payable: ${formatPKR(v.balance)}`);
  doc.text(`Already paid: ${formatPKR(v.amount_paid)}  ·  Discount: ${formatPKR(v.discount)}`);
  doc.moveDown(2);
  doc.fontSize(9).fillColor('#666').text(`Computer-generated voucher from ${v.school_name}.`);
  doc.end();
  return done;
}
