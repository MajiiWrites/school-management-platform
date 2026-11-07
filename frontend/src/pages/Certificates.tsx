// Certificates + ID cards (6C-2) — pick a student, issue a certificate
// (leaving / character / bonafide) or an ID card, then print from the
// backend's printable page.
//
// Module F (Point 9): issuing pre-fills every detail from the SAVED
// student record — the admin reviews and edits the fields below before
// generating, nothing is retyped or guessed. For a School Leaving
// Certificate the admin picks the reason for leaving from exactly four
// options (Other takes free text); the chosen reason is printed on the
// certificate and stored in the student's history.
import { useCallback, useEffect, useState } from 'react';
import { api, apiDownload, apiPrint, ApiClientError } from '../lib/api';
import type { ClassItem, PageResult, Student } from '../lib/types';
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
  leaving_reason: string | null;
  leaving_reason_option: string | null;
  date_of_birth: string | null;
  admission_date: string | null;
}

// The leaving-reason options — EXACTLY these four, same labels as the
// backend (LEAVING_REASON_OPTIONS). 'Other' shows a free-text box.
const LEAVING_REASONS = [
  { key: 'completed_primary', label: 'Completed 5th Grade (Primary)' },
  { key: 'completed_middle', label: 'Completed Middle School' },
  { key: 'completed_class_10', label: 'Completed 10th Class' },
  { key: 'other', label: 'Other' },
] as const;

type LeavingOption = (typeof LEAVING_REASONS)[number]['key'] | '';

interface DetailsForm {
  name: string;
  father_name: string;
  roll_no: string;
  admission_no: string;
  date_of_birth: string;
  admission_date: string;
}

function detailsFromStudent(s: Student): DetailsForm {
  return {
    name: s.name ?? '',
    father_name: s.father_name ?? '',
    roll_no: s.roll_no !== null && s.roll_no !== undefined ? String(s.roll_no) : '',
    admission_no: s.admission_no ?? '',
    date_of_birth: s.date_of_birth ?? '',
    admission_date: s.admission_date ?? '',
  };
}

export default function CertificatesPage() {
  const { title } = useLanguage();
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [classId, setClassId] = useState('');
  const [students, setStudents] = useState<StudentLite[]>([]);
  const [studentId, setStudentId] = useState('');
  const [studentDetail, setStudentDetail] = useState<Student | null>(null);
  const [details, setDetails] = useState<DetailsForm | null>(null);
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [idCardIssuedAt, setIdCardIssuedAt] = useState<string | null>(null);
  const [certType, setCertType] = useState<'leaving' | 'character' | 'bonafide'>('bonafide');
  const [leavingOption, setLeavingOption] = useState<LeavingOption>('');
  const [leavingOther, setLeavingOther] = useState('');
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
        setStudentDetail(null);
        setDetails(null);
        setCerts([]);
        setIdCardIssuedAt(null);
      })
      .catch(() => setError('Could not load students.'));
  }, [classId]);

  useEffect(loadStudents, [loadStudents]);

  // Pre-fill: load the SAVED student record when a student is picked, so
  // the admin reviews the real details instead of retyping them.
  const loadStudentDetail = useCallback(() => {
    if (!studentId) {
      setStudentDetail(null);
      setDetails(null);
      return;
    }
    api<Student>(`/students/${studentId}`)
      .then((s) => {
        setStudentDetail(s);
        setDetails(detailsFromStudent(s));
        setIdCardIssuedAt(s.id_card_issued_at ?? null);
      })
      .catch(() => setError('Could not load student details.'));
  }, [studentId]);

  useEffect(loadStudentDetail, [loadStudentDetail]);

  const loadCerts = useCallback(() => {
    if (!studentId) return;
    api<Certificate[]>(`/students/${studentId}/certificates`)
      .then((d) => setCerts(d))
      .catch(() => undefined);
  }, [studentId]);

  useEffect(loadCerts, [loadCerts]);

  const student = students.find((s) => s.id === studentId);
  const klass = classes.find((c) => c.id === classId);

  const leavingValid =
    certType !== 'leaving' ||
    (leavingOption !== '' && (leavingOption !== 'other' || leavingOther.trim() !== ''));

  const setDetail = (key: keyof DetailsForm, value: string) =>
    setDetails((d) => (d ? { ...d, [key]: value } : d));

  const doIssueCert = async () => {
    if (!studentId || !details) return;
    setBusy(true);
    setConfirming(null);
    try {
      const body: Record<string, unknown> = {
        type: certType,
        details: {
          name: details.name.trim(),
          father_name: details.father_name.trim() || null,
          roll_no: details.roll_no.trim() === '' ? null : Number(details.roll_no),
          admission_no: details.admission_no.trim() || null,
          date_of_birth: details.date_of_birth || null,
          admission_date: details.admission_date || null,
        },
      };
      if (certType === 'leaving') {
        body.leaving_reason_option = leavingOption;
        if (leavingOption === 'other') body.leaving_reason_other = leavingOther.trim();
      }
      const created = await api<Certificate>(`/students/${studentId}/certificates`, { method: 'POST', body });
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

  const leavingLabel = LEAVING_REASONS.find((o) => o.key === leavingOption)?.label;
  const confirmMessage = student
    ? certType === 'leaving'
      ? `This will issue a School Leaving Certificate for ${student.name}${leavingOption ? ` — reason: ${leavingOption === 'other' ? leavingOther.trim() : leavingLabel}` : ''}. Issued certificates cannot be deleted.`
      : `Are you sure? This will issue a ${certType} certificate for ${student.name}. Issued certificates cannot be deleted.`
    : '';

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

        {/* Pre-filled details from the saved student record — review/edit
            before generating. Class/section come from the class record
            and are shown read-only. */}
        {studentId && details && (
          <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <h2 className="text-sm font-semibold text-slate-800">Details on the certificate — pre-filled from the saved record</h2>
            <p className="mt-0.5 text-xs text-slate-500">Check these before issuing. Edits apply to this certificate only; the student record is not changed.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Student name">
                <input className={inputCls} value={details.name} onChange={(e) => setDetail('name', e.target.value)} />
              </Field>
              <Field label="Father's name">
                <input className={inputCls} value={details.father_name} onChange={(e) => setDetail('father_name', e.target.value)} />
              </Field>
              <Field label="Class">
                <input className={inputCls} value={klass ? `Class ${klass.name}-${klass.section}` : '—'} disabled />
              </Field>
              <Field label="Roll number">
                <input className={inputCls} type="number" min={0} value={details.roll_no} onChange={(e) => setDetail('roll_no', e.target.value)} />
              </Field>
              <Field label="Admission number">
                <input className={inputCls} value={details.admission_no} onChange={(e) => setDetail('admission_no', e.target.value)} />
              </Field>
              <Field label="Date of birth">
                <input className={inputCls} type="date" value={details.date_of_birth} onChange={(e) => setDetail('date_of_birth', e.target.value)} />
              </Field>
              <Field label="Admission date">
                <input className={inputCls} type="date" value={details.admission_date} onChange={(e) => setDetail('admission_date', e.target.value)} />
              </Field>
            </div>

            {certType === 'leaving' && (
              <div className="mt-4">
                <span className="text-sm font-medium text-slate-700">Reason for leaving <span className="text-red-600">*</span></span>
                <div className="mt-2 space-y-2">
                  {LEAVING_REASONS.map((o) => (
                    <label key={o.key} className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="radio"
                        name="leaving-reason"
                        value={o.key}
                        checked={leavingOption === o.key}
                        onChange={() => setLeavingOption(o.key)}
                        className="h-4 w-4 accent-emerald-700"
                      />
                      {o.label}
                    </label>
                  ))}
                </div>
                {leavingOption === 'other' && (
                  <div className="mt-3 max-w-md">
                    <Field label="Write the reason">
                      <input
                        className={inputCls}
                        value={leavingOther}
                        onChange={(e) => setLeavingOther(e.target.value)}
                        placeholder="e.g. Family moved to another city"
                      />
                    </Field>
                  </div>
                )}
                <p className="mt-2 text-xs text-slate-500">The chosen reason is printed on the certificate and saved in the student&apos;s history.</p>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            disabled={!studentId || !details || busy || !leavingValid || details.name.trim() === ''}
            onClick={() => setConfirming('cert')}
          >
            Issue certificate
          </Button>
          <Button variant="secondary" disabled={!studentId || busy} onClick={() => setConfirming('idcard')}>Issue ID card</Button>
          {studentId && (
            <Button variant="secondary" onClick={() => apiPrint(`/students/${studentId}/id-card`).catch((e) => setError(errText(e)))}>Print ID card</Button>
          )}
        </div>
        {idCardIssuedAt && <p className="mt-3 text-sm text-slate-600">ID card issued on {fmtDateTz(idCardIssuedAt)}.</p>}
        {studentDetail && <p className="mt-1 text-xs text-slate-400">Student record: {studentDetail.name} · Class {klass ? `${klass.name}-${klass.section}` : '—'}</p>}
      </Card>

      {!studentId ? (
        <EmptyState title="Pick a student" body="Choose a class and a student above to issue a certificate or an ID card." />
      ) : certs.length === 0 ? (
        <EmptyState title="No certificates yet" body={`${student?.name ?? 'This student'} has no certificates yet — issue one above.`} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Certificate no.</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Reason for leaving</th>
                <th className="px-4 py-3">Issued</th>
                <th className="px-4 py-3 text-right">Print</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {certs.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-mono text-xs">{c.certificate_no}</td>
                  <td className="px-4 py-2.5">{c.type_label}</td>
                  <td className="px-4 py-2.5">{c.type === 'leaving' ? (c.leaving_reason ?? '—') : '—'}</td>
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
        message={confirmMessage}
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
