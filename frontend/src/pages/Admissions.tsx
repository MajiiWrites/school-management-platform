// Admissions pipeline (Gap #2, 2026-11-20) — admin page: inquiry list
// with status moves, Admit (creates the student + first fee voucher in
// one transaction), and the public form link to share with parents.
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { admissionsApi, ApiClientError } from '../lib/api';
import type { AdmissionInquiry, AdmissionStatus, PageResult } from '../lib/types';
import { api } from '../lib/api';
import type { ClassItem } from '../lib/types';
import { Badge, Button, EmptyState, ErrorBanner, Field, inputCls, Modal, Pager, Spinner, Tabs, useToast } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';

function errText(e: unknown): string {
  return e instanceof ApiClientError ? e.message : 'Something went wrong.';
}

const STATUS_LABEL: Record<AdmissionStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  test: 'Test',
  interview: 'Interview',
  admitted: 'Admitted',
  rejected: 'Rejected',
};

const STATUS_TONE: Record<AdmissionStatus, 'slate' | 'blue' | 'amber' | 'green' | 'red'> = {
  new: 'slate',
  contacted: 'blue',
  test: 'amber',
  interview: 'amber',
  admitted: 'green',
  rejected: 'red',
};

/** True when the API answered with a clerk 202 (queued for admin approval). */
function isQueued(res: unknown): boolean {
  return typeof res === 'object' && res !== null && 'approval_request_id' in res;
}

export default function AdmissionsPage() {
  const [status, setStatus] = useState<AdmissionStatus | ''>('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AdmissionInquiry[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [publicFormUrl, setPublicFormUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [admitting, setAdmitting] = useState<AdmissionInquiry | null>(null);
  const { push, view } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    admissionsApi
      .list(status || undefined, page)
      .then((d) => {
        setRows(d.items);
        setTotal(d.total);
        setPages(d.pages);
        setPublicFormUrl(d.public_form_url);
        setError('');
      })
      .catch(() => setError('Could not load admission inquiries.'))
      .finally(() => setLoading(false));
  }, [status, page]);

  useEffect(load, [load]);

  const changeStatus = async (inquiry: AdmissionInquiry, next: AdmissionStatus) => {
    try {
      const res = await admissionsApi.setStatus(inquiry.id, next);
      if (isQueued(res)) {
        push('success', 'Submitted for admin approval — nothing was applied yet.');
      } else {
        push('success', `Inquiry moved to ${STATUS_LABEL[next]}.`);
      }
      load();
    } catch (e) {
      push('error', errText(e));
    }
  };

  const copyLink = async () => {
    if (!publicFormUrl) return;
    try {
      await navigator.clipboard.writeText(publicFormUrl);
      push('success', 'Public admissions link copied — share it with parents.');
    } catch {
      push('error', 'Could not copy — copy the link text manually.');
    }
  };

  if (loading) return <Spinner label="Loading admissions…" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Admissions</h1>
          <p className="text-sm text-slate-500">
            Online inquiries from parents — move them along the pipeline, then Admit to create the student and the first
            fee voucher in one step.
          </p>
        </div>
        {publicFormUrl && (
          <div className="flex items-center gap-2">
            <span className="max-w-xs truncate rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-600">
              {publicFormUrl}
            </span>
            <Button variant="secondary" onClick={copyLink}>Copy public link</Button>
          </div>
        )}
      </div>
      {error && <ErrorBanner message={error} onRetry={load} />}

      <Tabs
        tabs={[
          { key: '', label: 'All' },
          { key: 'new', label: 'New' },
          { key: 'contacted', label: 'Contacted' },
          { key: 'test', label: 'Test' },
          { key: 'interview', label: 'Interview' },
          { key: 'admitted', label: 'Admitted' },
          { key: 'rejected', label: 'Rejected' },
        ]}
        active={status}
        onChange={(k) => { setStatus(k as AdmissionStatus | ''); setPage(1); }}
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No admission inquiries"
          body={publicFormUrl ? 'Share the public admissions link above — inquiries from parents will land here.' : 'No inquiries in this status yet.'}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Student</th>
                <th className="px-4 py-3">Class</th>
                <th className="px-4 py-3">Parent</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-slate-900">{r.student_name}</span>
                    {r.notes && <p className="max-w-xs truncate text-xs text-slate-500">{r.notes}</p>}
                  </td>
                  <td className="px-4 py-2.5">{r.class_name}</td>
                  <td className="px-4 py-2.5">{r.parent_name}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{r.parent_phone_masked ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-2">
                      {r.status !== 'admitted' && r.status !== 'rejected' && (
                        <>
                          <select
                            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
                            value=""
                            onChange={(e) => {
                              const next = e.target.value as AdmissionStatus;
                              if (next) void changeStatus(r, next);
                            }}
                            aria-label={`Move ${r.student_name} to status`}
                          >
                            <option value="">Move to…</option>
                            {(['contacted', 'test', 'interview', 'rejected'] as AdmissionStatus[])
                              .filter((s) => s !== r.status)
                              .map((s) => (
                                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                              ))}
                          </select>
                          <Button variant="secondary" onClick={() => setAdmitting(r)}>Admit</Button>
                        </>
                      )}
                      {r.status === 'admitted' && <span className="text-xs text-slate-500">Admitted ✓</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 0 && <Pager page={page} pages={pages} total={total} itemLabel="inquiries" itemLabelSingular="inquiry" onPage={setPage} />}

      {admitting && (
        <AdmitModal
          inquiry={admitting}
          onClose={() => setAdmitting(null)}
          onAdmitted={(voucherNo) => {
            setAdmitting(null);
            push('success', voucherNo ? `Admitted — student created, first fee voucher ${voucherNo}.` : 'Admitted — student created (no fee structure for this class, so no voucher yet).');
            load();
          }}
          onQueued={() => {
            setAdmitting(null);
            push('success', 'Submitted for admin approval — nothing was applied yet.');
            load();
          }}
          onError={(m) => push('error', m)}
        />
      )}
      {view}
    </div>
  );
}

function AdmitModal({
  inquiry,
  onClose,
  onAdmitted,
  onQueued,
  onError,
}: {
  inquiry: AdmissionInquiry;
  onClose: () => void;
  onAdmitted: (voucherNo: string | null) => void;
  onQueued: () => void;
  onError: (message: string) => void;
}) {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [classId, setClassId] = useState(inquiry.class_id ?? '');
  const [rollNo, setRollNo] = useState('');
  const [admissionNo, setAdmissionNo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    api<PageResult<ClassItem>>('/classes')
      .then((d) => setClasses(d.items))
      .catch(() => setError('Could not load classes.'));
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!classId) {
      setError('Choose the class to admit into.');
      return;
    }
    setConfirming(true);
  };

  const doAdmit = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      const res = await admissionsApi.admit(inquiry.id, {
        class_id: classId,
        roll_no: rollNo.trim() ? Number(rollNo) : null,
        admission_no: admissionNo.trim() || null,
      });
      if (isQueued(res)) onQueued();
      else onAdmitted(res.voucher_no);
    } catch (err) {
      onError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const chosen = classes.find((c) => c.id === classId);

  return (
    <Modal title={`Admit ${inquiry.student_name}`} onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <form onSubmit={submit} className="space-y-4" autoComplete="off">
        <p className="text-sm text-slate-600">
          This creates the student (parent {inquiry.parent_name}) and the first fee record + voucher for the current
          month, in one step — and marks the inquiry admitted.
        </p>
        <Field label="Admit into class">
          <select className={inputCls} value={classId} onChange={(e) => setClassId(e.target.value)} required>
            <option value="">Choose a class…</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                Class {c.name}-{c.section}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Roll no. (optional)" hint="Leave blank to assign later.">
          <input className={inputCls} type="number" min={1} value={rollNo} onChange={(e) => setRollNo(e.target.value)} />
        </Field>
        <Field label="Admission no. (optional)">
          <input className={inputCls} value={admissionNo} onChange={(e) => setAdmissionNo(e.target.value)} maxLength={50} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Admitting…' : 'Admit student'}</Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirming}
        title={`Admit ${inquiry.student_name}${chosen ? ` into Class ${chosen.name}-${chosen.section}` : ''}?`}
        message="This creates the student and the first fee voucher in one step. It cannot be undone except by deleting the student."
        confirmLabel="Admit student"
        tone="primary"
        busy={busy}
        onConfirm={doAdmit}
        onCancel={() => setConfirming(false)}
      />
    </Modal>
  );
}
