// Certificates + ID cards routes (6C-2) — mounted in app.ts at /api/v1.
// Certificates: POST /students/:id/certificates, GET /students/:id/certificates,
// GET /certificates/:id (?format=pdf). ID cards: POST /students/:id/issue-id-card,
// GET /students/:id/id-card. Issuing is admin/clerk (clerk via approval
// queue for certificates; ID-card issue is a student update, also queued).

import { Router, type Request } from 'express';
import { getDb } from '../../lib/db';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdminOrClerk } from '../../middleware/rbac';
import { requireQueueable } from '../../middleware/permissions';
import { queueIfClerk } from '../hardening/queueGate';
import {
  getCertificate,
  getIdCard,
  issueCertificate,
  issueIdCard,
  listCertificatesForStudent,
  renderCertificateHtml,
  renderCertificatePdf,
  renderIdCardHtml,
} from './service';

export const certificatesRouter = Router();
certificatesRouter.use(authenticate, requireSchool);

function queryStr(req: Request, key: string): string | undefined {
  const v = req.query[key];
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

certificatesRouter.post(
  '/students/:id/certificates',
  requireAdminOrClerk,
  requireQueueable('certificates', 'create'),
  asyncHandler(async (req, res) => {
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'certificate', payload: { student_id: req.params.id, ...(req.body as object) } })) return;
    const data = await issueCertificate(getDb(), schoolIdOf(req), req.params.id, (req.body as any)?.type, req.user?.sub ?? 'unknown');
    res.status(201).json({ ok: true, data: { ...data, certificate_url: `/api/v1/certificates/${data.id}` } });
  }),
);

certificatesRouter.get(
  '/students/:id/certificates',
  asyncHandler(async (req, res) => {
    const data = await listCertificatesForStudent(getDb(), schoolIdOf(req), req.params.id);
    res.json({ ok: true, data });
  }),
);

certificatesRouter.get(
  '/certificates/:id',
  asyncHandler(async (req, res) => {
    const cert = await getCertificate(getDb(), schoolIdOf(req), req.params.id);
    if (queryStr(req, 'format') === 'pdf') {
      try {
        const pdf = await renderCertificatePdf(cert);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${cert.certificate_no}.pdf"`);
        res.send(pdf);
        return;
      } catch (err) {
        const code = (err as Error & { code?: string }).code;
        if (code !== 'PDF_UNAVAILABLE') throw err;
      }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderCertificateHtml(cert));
  }),
);

certificatesRouter.post(
  '/students/:id/issue-id-card',
  requireAdminOrClerk,
  requireQueueable('students', 'update'),
  asyncHandler(async (req, res) => {
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'student_id_card', payload: { student_id: req.params.id } })) return;
    const data = await issueIdCard(getDb(), schoolIdOf(req), req.params.id, req.user?.sub ?? 'unknown');
    res.json({ ok: true, data });
  }),
);

certificatesRouter.get(
  '/students/:id/id-card',
  asyncHandler(async (req, res) => {
    const card = await getIdCard(getDb(), schoolIdOf(req), req.params.id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderIdCardHtml(card));
  }),
);
