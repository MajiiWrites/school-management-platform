import { Router } from 'express';
import { getDb } from '../../lib/db';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool } from '../../middleware/tenant';
import { incomeVsExpense } from '../expenses/service';
import * as service from './service';

export const reportsRouter = Router();
reportsRouter.use(authenticate, requireSchool);

function sendExport(res: any, format: string | undefined, title: string, headers: string[], rows: (string | number | null)[][], filename: string): Promise<void> {
  if (format === 'pdf') {
    return service.exportPdf(title, headers, rows).then((buf) => {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
      res.send(buf);
    });
  }
  if (format === 'xlsx') {
    return service.exportXlsx(title, headers, rows).then((buf) => {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
      res.send(buf);
    });
  }
  if (format === 'csv') {
    const buf = service.exportCsv(title, headers, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    res.send(buf);
    return Promise.resolve();
  }
  return Promise.resolve();
}

function exportFormat(req: any): string {
  return String(req.query.format ?? '');
}

async function maybeExport(req: any, res: any, report: Record<string, unknown>, kind: string, filename: string): Promise<boolean> {
  const format = exportFormat(req);
  if (format === 'pdf' || format === 'xlsx' || format === 'csv') {
    const exp = service.buildExportRows(report, kind);
    await sendExport(res, format, exp.title, exp.headers, exp.rows, filename);
    return true;
  }
  return false;
}

reportsRouter.get(
  '/attendance/daily',
  asyncHandler(async (req, res) => {
    const report = await service.attendanceDaily(getDb(), req.schoolId!, req.query as Record<string, any>);
    if (await maybeExport(req, res, report, 'attendance', `attendance-daily-${report.date}`)) return;
    res.json({ ok: true, data: report });
  }),
);

reportsRouter.get(
  '/attendance/weekly',
  asyncHandler(async (req, res) => {
    const report = await service.attendanceWeekly(getDb(), req.schoolId!, req.query as Record<string, any>);
    if (await maybeExport(req, res, report, 'attendance', `attendance-weekly-${report.week_start}`)) return;
    res.json({ ok: true, data: report });
  }),
);

reportsRouter.get(
  '/attendance/monthly',
  asyncHandler(async (req, res) => {
    const report = await service.attendanceMonthly(getDb(), req.schoolId!, req.query as Record<string, any>);
    if (await maybeExport(req, res, report, 'attendance', `attendance-monthly-${report.month}`)) return;
    res.json({ ok: true, data: report });
  }),
);

reportsRouter.get(
  '/fees/monthly',
  asyncHandler(async (req, res) => {
    const report = await service.feesMonthly(getDb(), req.schoolId!, req.query as Record<string, any>);
    const format = String(req.query.format ?? '');
    if (format === 'pdf' || format === 'xlsx' || format === 'csv') {
      const exp = service.buildExportRows(report, 'fees');
      await sendExport(res, format, exp.title, exp.headers, exp.rows, `fees-monthly-${report.month}`);
      return;
    }
    res.json({ ok: true, data: report });
  }),
);

// ---- 6C-2 reports (all exportable: ?format=pdf|xlsx|csv) --------------------
reportsRouter.get(
  '/fees/defaulters',
  asyncHandler(async (req, res) => {
    const report = await service.feeDefaulters(getDb(), req.schoolId!, req.query as Record<string, any>);
    if (await maybeExport(req, res, report, 'defaulters', `fee-defaulters-${report.month}`)) return;
    res.json({ ok: true, data: report });
  }),
);

reportsRouter.get(
  '/results/summary',
  asyncHandler(async (req, res) => {
    const report = await service.resultsSummary(getDb(), req.schoolId!, req.query as Record<string, any>);
    if (await maybeExport(req, res, report, 'results-summary', 'results-summary')) return;
    res.json({ ok: true, data: report });
  }),
);

reportsRouter.get(
  '/classes/strength',
  asyncHandler(async (req, res) => {
    const report = await service.classStrength(getDb(), req.schoolId!);
    if (await maybeExport(req, res, report, 'class-strength', 'class-strength')) return;
    res.json({ ok: true, data: report });
  }),
);

reportsRouter.get(
  '/messages/history',
  asyncHandler(async (req, res) => {
    const report = await service.messageHistory(getDb(), req.schoolId!, req.query as Record<string, any>);
    if (await maybeExport(req, res, report, 'message-history', 'message-history')) return;
    res.json({ ok: true, data: report });
  }),
);

reportsRouter.get(
  '/income-expense',
  asyncHandler(async (req, res) => {
    const month = String(req.query.month ?? '');
    const report = await incomeVsExpense(getDb(), req.schoolId!, month);
    if (await maybeExport(req, res, report as unknown as Record<string, unknown>, 'income-expense', `income-expense-${month}`)) return;
    res.json({ ok: true, data: report });
  }),
);
