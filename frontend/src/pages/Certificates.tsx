// Certificates + ID cards (6C-2) — pick a student, issue a certificate
// (leaving / character / bonafide) or an ID card, then print from the
// backend's printable page.
import { useCallback, useEffect, useState } from 'react';
import { api, apiDownload, apiPrint, ApiClientError } from '../lib/api';
import type { ClassItem, PageResult } from '../lib/types';
import { Button, Card, EmptyState, ErrorBanner, Field, inputCls, Spinner, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';
import { useLanguage } from '../lib/i18n';
import { fmtDateTz } from '../lib/utils';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

interface StudentLite {
  id: string;
  name: string;
  roll_no: number | null;
  class_id: string;
}

interface Certificate {
  id: string;
  certificate_no: string;
  type: string;
  type_label: string;
  student_name: string;
  class_name: string;
  issued_at: string;
}

export default function CertificatesPage() {
  const { title } = useLanguage();
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [classId, setClassId] = useState('');
  const [students, setStudents] = useState<StudentLite[]>([]);
  const [studentId, setStudentId] = useState('');
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [idCardIssuedAt, setIdCardIssuedAt] = useState<string | null>(null);
  const [certType, setCertType] = useState<'leaving' | 'character' | 'bonafide'>('bonafide');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<'cert' | 'idcard' | null>(null);
  const { push, view } = useToast();

  useEffect(() => {
    api<PageResult<ClassItem>>('/classes')
      .then((d) => {
        setClasses(d.items);
        if (d.items[0]) setClassId(d.items[0].id);
      })
      .catch(() => setError('Could not load classes.'))
      .finally(() => setLoading(false));
  }, []);

  const loadStudents = useCallback(() => {
    if (!classId) return;
    api<PageResult<StudentLite>>(`/classes/${classId}/students?limit=200`)
      .then((d) => {
        setStudents(d.items);
        setStudentId('');
        setCerts([]);
        setIdCardIssuedAt(null);
      })
      .catch(() => setError('Could not load students.'));
  }, [classId]);

  useEffect(loadStudents, [loadStudents]);

  const loadCerts = useCallback(() => {
    if (!studentId) return;
    api<Certificate[]>(`/students/${studentId}/certificates`)
      .then((d) => setCerts(d))
      .catch(() => undefined);
  }, [studentId]);

  useEffect(loadCerts, [loadCerts]);

  const student = students.find((s) => s.id === studentId);

  const doIssueCert = async () => {
    if (!studentId) return;
    setBusy(true);
    setConfirming(null);
    try {
      const created = await api<Certificate>(`/students/${studentId}/certificates`, { method: 'POST', body: { type: certType } });
      push('success', `Certificate issued — ${created.certificate_no}.`);
      loadCerts();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const doIssueIdCard = async () => {
    if (!studentId) return;
    setBusy(true);
    setConfirming(null);
    try {
      const card = await api<{ id_card_issued_at: string | null }>(`/students/${studentId}/issue-id-card`, { method: 'POST' });
      push('success', 'ID card issued.');
      setIdCardIssuedAt(card.id_card_issued_at);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner label="Loading certificates…" />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{title('certificates')}</h1>
        <p className="text-sm text-slate-500">Issue leaving, character or bonafide certificates, and student ID cards — then print them.</p>
      </div>

      {error && <ErrorBanner message={error} />}

      <Card className="p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Class">
            <select className={inputCls} value={classId} onChange={(e) => setClassId(e.target.value)}>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>Class {c.name}-{c.section}</option>
              ))}
            </select>
          </Field>
          <Field label="Student">
            <select className={inputCls} value={studentId} onChange={(e) => setStudentId(e.target.value)}>
              <option value="">Pick a student</option>
              {students.map((s) => (
                <option key={s.id} value={s.id}>{s.name}{s.roll_no !== null ? ` (Roll ${s.roll_no})` : ''}</option>
              ))}
            </select>
          </Field>
          <Field label="Certificate type">
            <select className={inputCls} value={certType} onChange={(e) => setCertType(e.target.value as typeof certType)}>
              <option value="bonafide">Bonafide</option>
              <option value="character">Character</option>
              <option value="leaving">School Leaving</option>
            </select>
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button disabled={!studentId || busy} onClick={() => setConfirming('cert')}>Issue certificate</Button>
          <Button variant="secondary" disabled={!studentId || busy} onClick={() => setConfirming('idcard')}>Issue ID card</Button>
          {studentId && (
            <Button variant="secondary" onClick={() => apiPrint(`/students/${studentId}/id-card`).catch((e) => setError(errText(e)))}>Print ID card</Button>
          )}
        </div>
        {idCardIssuedAt && <p className="mt-3 text-sm text-slate-600">ID card issued on {fmtDateTz(idCardIssuedAt)}.</p>}
      </Card>

      {!studentId ? (
        <EmptyState title="Pick a student" body="Choose a class and a student above to issue a certificate or an ID card." />
      ) : certs.length === 0 ? (
        <EmptyState title="No certificates yet" body={`${student?.name ?? 'This student'} has no certificates yet — issue one above.`} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Certificate no.</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Issued</th>
                <th className="px-4 py-3 text-right">Print</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {certs.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-mono text-xs">{c.certificate_no}</td>
                  <td className="px-4 py-2.5">{c.type_label}</td>
                  <td className="px-4 py-2.5">{fmtDateTz(c.issued_at)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button className="font-medium text-brand-700 hover:underline" onClick={() => apiPrint(`/certificates/${c.id}`).catch((e) => setError(errText(e)))}>View</button>
                    {' · '}
                    <button className="font-medium text-brand-700 hover:underline" onClick={() => apiDownload(`/certificates/${c.id}?format=pdf`, `${c.certificate_no}.pdf`).catch((e) => setError(errText(e)))}>PDF</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={confirming === 'cert'}
        title="Issue this certificate?"
        message={student ? `Are you sure? This will issue a ${certType} certificate for ${student.name}. Issued certificates cannot be deleted.` : ''}
        confirmLabel="Issue certificate"
        tone="primary"
        busy={busy}
        onConfirm={doIssueCert}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmDialog
        open={confirming === 'idcard'}
        title="Issue an ID card?"
        message={student ? `Are you sure? This will mark an ID card as issued for ${student.name} (photo is a placeholder — print the card from the link).` : ''}
        confirmLabel="Issue ID card"
        tone="primary"
        busy={busy}
        onConfirm={doIssueIdCard}
        onCancel={() => setConfirming(null)}
      />
      {view}
    </div>
  );
}
