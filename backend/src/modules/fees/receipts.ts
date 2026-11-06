// Printable fee receipts: print-ready HTML
// Phase 9: paid/issued dates render in Asia/Karachi (school timezone) —
// the server runs in UTC, which showed them a day behind in PKT. (browser "Save as PDF" works)
// and a real PDF via pdfkit when the dependency is installed.
// pdfkit is loaded dynamically so the module works without it — the route
// falls back to HTML in that case (see routes.ts).

import type { ReceiptData } from './types';

export function formatPKR(n: number): string {
  return `Rs. ${n.toLocaleString('en-PK')}`;
}

export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderReceiptHtml(r: ReceiptData): string {
  const statusLabel = r.status === 'paid' ? 'PAID' : r.status === 'partial' ? 'PARTIALLY PAID' : 'UNPAID';
  const statusColor = r.status === 'paid' ? '#14532d' : r.status === 'partial' ? '#92400e' : '#991b1b';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fee Receipt ${esc(r.receipt_no)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 0; padding: 24px; }
  .receipt { max-width: 640px; margin: 0 auto; border: 2px solid #14532d; border-radius: 8px; padding: 24px; }
  h1 { margin: 0; font-size: 20px; color: #14532d; }
  .sub { color: #555; font-size: 13px; margin-top: 2px; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; color: #fff; background: ${statusColor}; font-weight: bold; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 14px; }
  td, th { padding: 8px 4px; border-bottom: 1px solid #ddd; text-align: left; }
  td.num, th.num { text-align: right; }
  tr.total td { font-weight: bold; border-top: 2px solid #14532d; }
  .row { display: flex; justify-content: space-between; margin-top: 6px; font-size: 14px; }
  .sig { margin-top: 36px; display: flex; justify-content: space-between; font-size: 13px; color: #333; }
  .sig span { border-top: 1px solid #333; padding-top: 4px; }
  .foot { margin-top: 20px; font-size: 12px; color: #666; }
  .print-btn { margin: 16px auto; display: block; padding: 10px 18px; font-size: 14px; background: #14532d; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  @media print { .print-btn { display: none; } body { padding: 0; } .receipt { border-width: 1px; } }
</style>
</head>
<body>
<button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
<div class="receipt">
  <div class="row"><div><h1>${esc(r.school_name)}</h1><div class="sub">Fee Receipt</div></div><div><span class="badge">${statusLabel}</span></div></div>
  <div class="row"><span>Receipt No: <strong>${esc(r.receipt_no)}</strong></span><span>Month: <strong>${esc(monthLabel(r.month))}</strong></span></div>
  <div class="row"><span>Student: <strong>${esc(r.student_name)}</strong>${r.roll_no !== null ? ` (Roll ${r.roll_no})` : ''}</span><span>Class: <strong>${esc(r.class_name)}</strong></span></div>
  <table>
    <tr><th>Description</th><th class="num">Amount</th></tr>
    <tr><td>Monthly fee — ${esc(monthLabel(r.month))}</td><td class="num">${formatPKR(r.amount_due)}</td></tr>
    ${r.arrears > 0 ? `<tr><td>Arrears included</td><td class="num">${formatPKR(r.arrears)}</td></tr>` : ''}
    ${r.scholarship_discount > 0 ? `<tr><td>Scholarship discount included</td><td class="num">&minus; ${formatPKR(r.scholarship_discount)}</td></tr>` : ''}
    <tr><td>Discount</td><td class="num">&minus; ${formatPKR(r.discount)}</td></tr>
    <tr><td>Amount paid${r.payment_method ? ` (${esc(r.payment_method)})` : ''}</td><td class="num">${formatPKR(r.amount_paid)}</td></tr>
    <tr class="total"><td>Balance due</td><td class="num">${formatPKR(r.balance)}</td></tr>
  </table>
  <div class="row"><span>Paid on: ${r.paid_at ? esc(new Date(r.paid_at).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi' })) : '—'}</span><span>Issued: ${esc(new Date(r.issued_at).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi' }))}</span></div>
  <div class="sig"><span>Received by</span><span>Parent / Guardian</span></div>
  <div class="foot">This is a computer-generated receipt from ${esc(r.school_name)}. Please keep it for your records.</div>
</div>
</body>
</html>`;
}

/** Real PDF via pdfkit (optional dependency). Throws PDF_UNAVAILABLE if pdfkit is not installed. */
export async function renderReceiptPdf(r: ReceiptData): Promise<Buffer> {
  let PDFDocument: any;
  try {
    const mod = await import('pdfkit');
    PDFDocument = mod.default ?? mod;
  } catch {
    const err = new Error('pdfkit is not installed — use the HTML receipt instead') as Error & { code?: string };
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

  const statusLabel = r.status === 'paid' ? 'PAID' : r.status === 'partial' ? 'PARTIALLY PAID' : 'UNPAID';
  doc.fontSize(18).fillColor('#14532d').text(r.school_name);
  doc.fontSize(11).fillColor('#555').text('Fee Receipt');
  doc.moveDown(0.5);
  doc.fontSize(12).fillColor('#111');
  doc.text(`Receipt No: ${r.receipt_no}`);
  doc.text(`Month: ${monthLabel(r.month)}`);
  doc.text(`Student: ${r.student_name}${r.roll_no !== null ? ` (Roll ${r.roll_no})` : ''}  |  Class: ${r.class_name}`);
  doc.text(`Status: ${statusLabel}`);
  doc.moveDown();
  const rows: Array<[string, string]> = [
    [`Monthly fee — ${monthLabel(r.month)}`, formatPKR(r.amount_due)],
    // 6C-2: arrears / scholarship are already inside amount_due; show them
    // as informational lines so the parent can see the make-up.
    ...(r.arrears > 0 ? ([[`Arrears included`, formatPKR(r.arrears)]] as Array<[string, string]>) : []),
    ...(r.scholarship_discount > 0
      ? ([[`Scholarship discount included`, `- ${formatPKR(r.scholarship_discount)}`]] as Array<[string, string]>)
      : []),
    ['Discount', `- ${formatPKR(r.discount)}`],
    [`Amount paid${r.payment_method ? ` (${r.payment_method})` : ''}`, formatPKR(r.amount_paid)],
    ['Balance due', formatPKR(r.balance)],
  ];
  for (const [label, value] of rows) {
    doc.text(label, { continued: true }).text(value, { align: 'right' });
  }
  doc.moveDown();
  doc.fontSize(10).fillColor('#666').text(`Paid on: ${r.paid_at ? new Date(r.paid_at).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi' }) : '—'}`);
  doc.text(`Issued: ${new Date(r.issued_at).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi' })}`);
  doc.moveDown(2);
  doc.fontSize(11).fillColor('#333').text('Received by: ______________________        Parent / Guardian: ______________________');
  doc.moveDown();
  doc.fontSize(9).fillColor('#666').text(`This is a computer-generated receipt from ${r.school_name}. Please keep it for your records.`);
  doc.end();
  return done;
}
